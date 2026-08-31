"""code.python 执行模块的测试。不需要数据库，不需要沙箱 venv ——
沙箱解释器直接用跑测试的这个 python（runner 只用 stdlib）。

    cd server && .venv/bin/python test_code_python.py
"""
import os
import sys
import time
import types

# 闸门要求：显式开关 + 非生产形态（无 PGHOST）。测试进程里先摆好
os.environ["CODE_NODE_LOCAL_EXEC"] = "1"
os.environ.pop("PGHOST", None)
os.environ.pop("SANDBOX_URL", None)
os.environ["SANDBOX_PYTHON"] = sys.executable

from sql_service import code_python
from sql_service.code_python import CodeNodeError, execute

PASS, FAIL = [], []


def ok(name, cond, detail=""):
    (PASS if cond else FAIL).append((name, detail or cond, True))


def run(code, inputs=None, timeout=None):
    params = {"code": code, "inputs": inputs or {}}
    if timeout is not None:
        params["timeoutSeconds"] = timeout
    return execute(params)


def raises(name, fn, code_name, fragment=""):
    try:
        fn()
    except CodeNodeError as exc:
        if exc.code != code_name:
            FAIL.append((name, f"错误码 {exc.code}: {exc}", code_name))
        elif fragment and fragment not in str(exc):
            FAIL.append((name, f"报错但内容不符: {exc}", f"包含 {fragment!r}"))
        else:
            PASS.append((name, exc.code, exc.code))
        return exc
    except Exception as exc:  # noqa: BLE001
        FAIL.append((name, f"抛了 {type(exc).__name__}: {exc}", "CodeNodeError"))
    else:
        FAIL.append((name, "没有报错", "CodeNodeError"))
    return None


# ---------------------------------------------------------------- 正常路径
out = run('def main(inputs):\n    return {"total": inputs["a"] + inputs["b"]}', {"a": 1, "b": 2})
ok("返回值 spread 成输出字段", out.get("total") == 3, out)
ok("耗时是数字", isinstance(out.get("durationMs"), int), out.get("durationMs"))

out = run('def main(inputs):\n    print("hello")\n    return {"x": 1}')
ok("print 进 logs", "hello" in out["logs"], out["logs"])
ok("print 不污染结果 —— 结果走独立 fd，绝不解析 stdout", out.get("x") == 1, out)

out = run('import sys\ndef main(inputs):\n    print("to out")\n    print("to err", file=sys.stderr)\n    return {}')
ok("stderr 也进 logs", "to err" in out["logs"] and "stderr" in out["logs"], out["logs"])

# ---------------------------------------------------------------- ★ 红线（服务端半边）
code = 'def main(inputs):\n    return {"raw": "{{ $.trigger.x }}"}'
out = run(code)
ok("★ code 里的 {{ }} 是普通字面量，服务端也没人动它", out.get("raw") == "{{ $.trigger.x }}", out)

# ---------------------------------------------------------------- ★ 环境变量清空
os.environ["OAUTH_CLIENT_SECRET"] = "canary-secret-123"
out = run('import os\ndef main(inputs):\n    print(dict(os.environ))\n    return {"n": len(os.environ)}')
ok("★ 凭证 canary 不出现在子进程环境里", "canary-secret-123" not in out["logs"], out["logs"])
ok("★ 环境里没有任何 OAUTH_*", "OAUTH" not in out["logs"], out["logs"])
del os.environ["OAUTH_CLIENT_SECRET"]

# 数值库线程池必须钉成单线程：线上容器 pids/rlimit 收紧后，OpenBLAS 起线程
# 失败会给自己 raise(SIGINT)，用户看到的是 import 行的 KeyboardInterrupt——
# 而 mac 上 numpy 走 Accelerate，这条路本地永远测不出来，只能靠这里钉住 env
out = run("import os\n"
          "def main(inputs):\n"
          "    return {'blas': os.environ.get('OPENBLAS_NUM_THREADS'),"
          " 'omp': os.environ.get('OMP_NUM_THREADS')}")
ok("★ OpenBLAS/OMP 线程池钉成 1", out.get("blas") == "1" and out.get("omp") == "1", out)

# ---------------------------------------------------------------- ★ 超时
t0 = time.monotonic()
raises("★ 死循环到点被 SIGKILL", lambda: run("def main(inputs):\n    while True:\n        pass", timeout=1),
       "CODE_TIMEOUT", "1s")
ok("★ 超时是真掐死，不是等它自己完", time.monotonic() - t0 < 5, f"{time.monotonic() - t0:.1f}s")

# 孙进程连坐：起个后台 sleep 再死循环。NPROC 闸把 fork 拦掉也算过 ——
# 两条路殊途同归，都证明"跑完之后不留进程"
t0 = time.monotonic()
raises("★ 用户 fork 的子孙也被收掉（或被 NPROC 闸拦下）",
       lambda: run("import subprocess\n"
                   "def main(inputs):\n"
                   "    try:\n"
                   "        subprocess.Popen(['/bin/sleep', '30'])\n"
                   "    except OSError:\n"
                   "        pass\n"
                   "    while True:\n"
                   "        pass", timeout=1),
       "CODE_TIMEOUT")
ok("连坐用时正常", time.monotonic() - t0 < 5, f"{time.monotonic() - t0:.1f}s")

# ---------------------------------------------------------------- 用户侧错误
exc = raises("语法错带行号", lambda: run("def main(inputs)\n    return {}"), "CODE_SYNTAX_ERROR", "第 1 行")

exc = raises("运行时异常带用户行号", lambda: run('def main(inputs):\n    x = 1\n    return {"y": x + inputs["nope"]}'),
             "CODE_RUNTIME_ERROR", "第 3 行")
if exc:
    ok("栈里没有沙箱包装层", "code_runner" not in str(exc), str(exc))

raises("import 不存在的包 → 指引去依赖页", lambda: run("import surely_not_installed\ndef main(inputs):\n    return {}"),
       "CODE_RUNTIME_ERROR", "Python 依赖")

raises("缺 main 是调用方问题", lambda: run("x = 1"), "BAD_REQUEST", "def main(inputs)")
raises("返回 list 点名类型", lambda: run("def main(inputs):\n    return [1, 2]"), "CODE_BAD_RETURN", "list")
raises("返回不可序列化的点名键路径和类型",
       lambda: run("def main(inputs):\n    return {'a': {'b': object()}}"), "CODE_BAD_RETURN", "a.b")
raises("撞保留键", lambda: run("def main(inputs):\n    return {'logs': 1, 'x': 2}"), "CODE_BAD_RETURN", "logs")
raises("空代码", lambda: run("   "), "BAD_REQUEST", "为空")
raises("用户 sys.exit 按运行时错报，不误判成沙箱挂了",
       lambda: run("import sys\ndef main(inputs):\n    sys.exit(3)"), "CODE_RUNTIME_ERROR", "SystemExit")
# KeyboardInterrupt == 收到 SIGINT，不是代码写得出来的错。光报
# 「第 N 行：KeyboardInterrupt:」用户会盯着那行找自己的毛病 —— 必须说明是信号
raises("KeyboardInterrupt 要说明是信号不是代码问题",
       lambda: run("def main(inputs):\n    raise KeyboardInterrupt"), "CODE_RUNTIME_ERROR", "SIGINT")

# ---------------------------------------------------------------- ★ matplotlib 字体缓存
# 线上沙箱 pids/NPROC 顶着时，matplotlib 冷缓存构建前的提示线程起不来，
# import matplotlib.pyplot 当场 can't start new thread；而 HOME=每次新建的
# tmpdir 意味着每次执行都是冷缓存 —— 必炸不是偶发。两道防线：子进程
# MPLCONFIGDIR 指持久母本 + 执行前受信任侧预热（_ensure_mpl_warm）。
# mac 线程限额不同源，这条和 OpenBLAS 一样本地测不出爆炸本身，只能钉环境
out = run("import os\ndef main(inputs):\n    return {'mpl': os.environ.get('MPLCONFIGDIR', '')}")
ok("★ 子进程 MPLCONFIGDIR 指向持久 mpl-cache", out.get("mpl", "").endswith("mpl-cache"), out)

raises("线程起不来要说明是沙箱限额不是代码问题",
       lambda: run("def main(inputs):\n    raise RuntimeError(\"can't start new thread\")"),
       "CODE_RUNTIME_ERROR", "线程数有上限")

_warm_calls = []
_real_sub_run = code_python.subprocess.run
code_python.subprocess.run = lambda *a, **k: (_warm_calls.append(1), _real_sub_run(*a, **k))[1]
code_python.reset_mpl_warm()
code_python._ensure_mpl_warm(sys.executable)
code_python._ensure_mpl_warm(sys.executable)
ok("★ 预热幂等：done 后不再起探测子进程", len(_warm_calls) == 1, _warm_calls)
code_python.reset_mpl_warm()
code_python._ensure_mpl_warm(sys.executable)
ok("装/卸包 reset 后会重新预热", len(_warm_calls) == 2, _warm_calls)
code_python.subprocess.run = _real_sub_run

# 失败时 print 的内容要能看到 —— worker 的失败路径只带 message
exc = raises("失败消息带 stdout 尾部", lambda: run('def main(inputs):\n    print("debug mark 42")\n    raise ValueError("boom")'),
             "CODE_RUNTIME_ERROR", "boom")
if exc:
    ok("stdout 尾部在错误消息里", "debug mark 42" in str(exc), str(exc))

# ---------------------------------------------------------------- 友好转换
out = run("from datetime import datetime\n"
          "def main(inputs):\n"
          "    return {'ts': datetime(2026, 8, 28, 9, 0, 0)}")
ok("datetime 自动转 ISO", out.get("ts") == "2026-08-28T09:00:00", out.get("ts"))
ok("转换记录进 logs", "ISO" in out["logs"], out["logs"])

# ---------------------------------------------------------------- 限额
raises("结果超 10MB", lambda: run("def main(inputs):\n    return {'big': 'x' * (11 * 1024 * 1024)}"),
       "CODE_OUTPUT_TOO_LARGE", "10MB")
raises("代码超 1MB", lambda: run("# " + "x" * code_python.CODE_MAX_BYTES + "\ndef main(inputs):\n    return {}"),
       "BAD_REQUEST", "1MB")
ok("超时钳位：999 → 120", code_python._clamp_timeout(999) == 120)
ok("超时钳位：0 → 1", code_python._clamp_timeout(0) == 1)
ok("超时钳位：非数字 → 默认", code_python._clamp_timeout("abc") == code_python.TIMEOUT_DEFAULT_SECONDS)

out = run("def main(inputs):\n"
          "    for _ in range(1100):\n"
          "        print('x' * 1024)\n"
          "    return {'done': True}")
ok("stdout 刷 1MB 只留 64KB，不挂死", "已截断" in out["logs"] or "只保留前" in out["logs"], out["logs"][-120:])
ok("刷屏不影响结果", out.get("done") is True, out.get("done"))

# ---------------------------------------------------------------- 输入往返
out = run("def main(inputs):\n    return {'echo': inputs}",
          {"rows": [{"vid": 1}], "中文": "值", "n": None})
ok("inputs 原样进沙箱（含中文和 None）", out["echo"] == {"rows": [{"vid": 1}], "中文": "值", "n": None}, out["echo"])

# ---------------------------------------------------------------- 运行环境探测
ver = code_python.interpreter_version()
ok("解释器版本探测到真实版本",
   isinstance(ver, str) and ver.startswith(f"{sys.version_info.major}.{sys.version_info.minor}"), ver)
ok("版本按解释器路径缓存", code_python.interpreter_version() is ver or code_python.interpreter_version() == ver)

# ---------------------------------------------------------------- 闸门
del os.environ["CODE_NODE_LOCAL_EXEC"]
raises("两条路都没配 → 沙箱未配置", lambda: run("def main(inputs):\n    return {}"),
       "CODE_SANDBOX_UNCONFIGURED", "CODE_NODE_LOCAL_EXEC")
os.environ["CODE_NODE_LOCAL_EXEC"] = "1"

os.environ["PGHOST"] = "postgres"
raises("PGHOST 在（生产形态）时本地开关不认", lambda: run("def main(inputs):\n    return {}"),
       "CODE_SANDBOX_UNCONFIGURED")
del os.environ["PGHOST"]

_bad = os.environ.get("SANDBOX_PYTHON")
os.environ["SANDBOX_PYTHON"] = "/nonexistent/python"
raises("解释器不存在 → 沙箱不可用（可重试）", lambda: run("def main(inputs):\n    return {}"),
       "CODE_SANDBOX_UNAVAILABLE", "解释器")
os.environ["SANDBOX_PYTHON"] = _bad

# ---------------------------------------------------------------- SANDBOX_URL 转发
os.environ["SANDBOX_URL"] = "http://sandbox.internal:9000"
_captured = {}


class _FakeResp:
    status_code = 200

    def json(self):
        return {"result": {"total": 9}, "logs": "remote log", "durationMs": 5}


def _fake_post(url, json=None, timeout=None):
    _captured.update({"url": url, "json": json, "timeout": timeout})
    return _FakeResp()


_real_requests = code_python.requests
code_python.requests = types.SimpleNamespace(post=_fake_post, RequestException=Exception)
out = run("def main(inputs):\n    return {}", {"a": 1}, timeout=45)
ok("配了 SANDBOX_URL 走转发", _captured.get("url") == "http://sandbox.internal:9000/execute", _captured)
ok("转发 payload 完整", _captured.get("json", {}).get("timeoutSeconds") == 45
   and _captured.get("json", {}).get("inputs") == {"a": 1}, _captured.get("json"))
ok("转发结果原样回来", out.get("total") == 9 and out.get("logs") == "remote log", out)


def _dead_post(url, **kw):
    raise code_python.requests.RequestException("connection refused")


code_python.requests = types.SimpleNamespace(post=_dead_post, RequestException=Exception)
raises("沙箱服务连不上 → 可重试", lambda: run("def main(inputs):\n    return {}"),
       "CODE_SANDBOX_UNAVAILABLE", "无法访问")
code_python.requests = _real_requests
del os.environ["SANDBOX_URL"]

# ----------------------------------------------------------------
for name, got, want in FAIL:
    print(f"✗ {name}\n    实际: {got!r}\n    期望: {want!r}")
print(f"\n{len(PASS)} 通过, {len(FAIL)} 失败")
sys.exit(1 if FAIL else 0)
