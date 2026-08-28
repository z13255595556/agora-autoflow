"""Python 代码节点（code.python）的执行模块。

它是全系统唯一"按用户输入执行任意代码"的地方，而 Webhook 让任意人都能触发。
三条边界，按重要性排：

1. **code 字段绝不做模板插值** —— 那是前端/worker 引擎的红线（x-no-template，
   见 src/lib/engine.ts 的 resolveParams），这里收到的 code 就是用户写的原文。
   服务端这一侧的对应义务是：**绝不对 code 做任何求值式加工**，收到什么执行什么。
2. **子进程环境变量绝不继承**（_child_env）。server/.env 的 OAUTH_* 就在本进程
   环境里，而用户代码是可以联网的 —— 继承一次就是可外传的全套机器人凭证。
3. **默认闸死**（_mode）。SANDBOX_URL 和本地开关都没配时直接拒绝执行，
   生产环境不会因为"忘了配"而多出一个代码执行口。

联网这件事是**有意放开**的（2026-08 决策，推翻了 server-runtime-design §10.5
的原案）：用户代码可以直接访问内外网。代价说在明处 —— http.request 节点那套
SSRF 白名单和"URL/凭证在流程定义里可审计"对本节点不成立，兜底是内部工具 +
SSO + flows.owner 按邮箱可追溯到人。HTTP 调用仍建议走 http.request 节点
（可审计、有重试语义），代码里联网留给 SDK/签名这类 http.request 表达不了的场景。

本地子进程模式（_run_local）是"尽力而为"：环境变量清空、rlimit、超时 SIGKILL，
但没有文件系统/内存/网络隔离 —— 所以它只在显式开了 CODE_NODE_LOCAL_EXEC 且
非生产形态（无 PGHOST）时可用。真正的隔离属于未来的沙箱容器（SANDBOX_URL 转发）。
"""
import json
import os
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import requests

# 超时与大小的唯一出处。manifest.py 引用这两个常量下发给前端；执行侧在
# _clamp_timeout 里无条件夹一遍 —— 界面上的 maximum 挡不住导入的 JSON。
# 上限 120s 卡在 nginx proxy_read_timeout（130s，deploy/nginx.conf）之下：
# 同步节点的响应必须先于网关超时返回，worker 的 fetch 没有超时，全靠这里封顶。
TIMEOUT_DEFAULT_SECONDS = 30
TIMEOUT_MAX_SECONDS = 120
CODE_MAX_BYTES = 1_048_576  # 1MB。代码内嵌在流程定义里，再大就该怀疑用错了地方
LOG_KEEP_BYTES = 64 * 1024  # stdout/stderr 各留这么多进 logs，多的边读边丢

_HERE = Path(__file__).resolve().parent
_RUNNER = _HERE / "code_runner.py"
_DEFAULT_VENV_PYTHON = _HERE.parent / ".venv-sandbox" / "bin" / "python"


class CodeNodeError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


def mode() -> str:
    """'remote' | 'local' | 'off'。remote 优先：两个都配了按生产语义走沙箱服务。"""
    if os.getenv("SANDBOX_URL", "").strip():
        return "remote"
    if _local_exec_enabled():
        return "local"
    return "off"


def _local_exec_enabled() -> bool:
    # 两道闸缺一不认（fail closed），仿 identity.dev_user 的前两道：
    # ① CODE_NODE_LOCAL_EXEC=1 显式写了；② PGHOST 没设 —— 生产容器一律走
    #   libpq 的 PG* 那套（见 identity.py 同款判断），PGHOST 在就是生产形态，
    #   本地开关一律不认。不抄第三道（cookie）：执行面没有"真身份优先"的问题
    return (os.getenv("CODE_NODE_LOCAL_EXEC", "").strip() == "1"
            and not os.getenv("PGHOST", "").strip())


def execute(params: Dict[str, Any]) -> Dict[str, Any]:
    code, inputs, timeout_s = _validated(params)
    m = mode()
    if m == "remote":
        return _forward(code, inputs, timeout_s)
    if m == "local":
        return _run_local(code, inputs, timeout_s)
    raise CodeNodeError(503, "CODE_SANDBOX_UNCONFIGURED",
                        "Python 代码节点未启用：本地开发在 server/.env 配 CODE_NODE_LOCAL_EXEC=1"
                        "（子进程执行，无容器隔离）；生产需部署沙箱服务并配 SANDBOX_URL")


def execute_local(params: Dict[str, Any]) -> Dict[str, Any]:
    """校验 + 子进程执行，**不看闸门**。沙箱服务（sandbox/service.py）的入口 ——
    它就是闸门后面的那个执行方，再判一次 mode 会把自己判死。api 进程内
    不要调这个，走 execute()。"""
    code, inputs, timeout_s = _validated(params)
    return _run_local(code, inputs, timeout_s)


def _validated(params: Dict[str, Any]):
    code = params.get("code")
    if not isinstance(code, str) or not code.strip():
        raise CodeNodeError(400, "BAD_REQUEST", "「代码」为空。入口是固定的：def main(inputs) -> dict")
    if len(code.encode("utf-8")) > CODE_MAX_BYTES:
        kb = len(code.encode("utf-8")) // 1024
        raise CodeNodeError(400, "BAD_REQUEST", f"代码有 {kb}KB，上限 1MB —— 再大就不该内嵌在流程里了")
    inputs = params.get("inputs") or {}
    if not isinstance(inputs, dict):
        raise CodeNodeError(400, "BAD_REQUEST", "「输入变量」必须是键值对")
    return code, inputs, _clamp_timeout(params.get("timeoutSeconds"))


def _clamp_timeout(raw: Any) -> int:
    try:
        t = int(raw)
    except (TypeError, ValueError):
        return TIMEOUT_DEFAULT_SECONDS
    return max(1, min(TIMEOUT_MAX_SECONDS, t))


# ---------------------------------------------------------------- 本地子进程

def sandbox_python() -> Optional[str]:
    """沙箱解释器。SANDBOX_PYTHON 覆盖 > server/.venv-sandbox。

    独立 venv 而不是复用 server/.venv：那边装着 psycopg/fastapi，共用等于把
    服务端的依赖面整个递给用户代码；预装白名单也要独立锁版本（sandbox_packages）。
    """
    override = os.getenv("SANDBOX_PYTHON", "").strip()
    if override:
        # 就地转绝对路径：子进程的 cwd 是每次执行的临时目录，相对路径在那里
        # 解析必然找不到 —— 症状是「沙箱进程启动失败 No such file」，而且
        # 只有配了相对路径的环境才炸
        p = os.path.abspath(override)
        return p if os.access(p, os.X_OK) else None
    p = str(_DEFAULT_VENV_PYTHON)
    return p if os.access(p, os.X_OK) else None


def _child_env(tmpdir: str) -> Dict[str, str]:
    # ★ 显式白名单，**绝不继承** —— server/.env 的 OAUTH_* 全在本进程环境里，
    # 用户代码又能联网，继承一次就是可外传的全套凭证。
    # 刻意不给 PATH：用户代码起子进程只能写绝对路径，少一条顺手摸到系统工具的路
    return {
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONIOENCODING": "utf-8",
        "HOME": tmpdir,
        "TMPDIR": tmpdir,
    }


def _drain(stream, keep: int) -> Tuple[bytes, int]:
    """收集流的前 keep 字节，之后**边读边丢** —— 停读的话话痨脚本会卡在
    write() 上等管道腾地方，然后被误判成超时。返回 (保留的, 总字节数)。"""
    kept = bytearray()
    total = 0
    while True:
        chunk = stream.read(65536)
        if not chunk:
            return bytes(kept), total
        total += len(chunk)
        if len(kept) < keep:
            kept.extend(chunk[: keep - len(kept)])


def _run_local(code: str, inputs: Dict[str, Any], timeout_s: int) -> Dict[str, Any]:
    interp = sandbox_python()
    if not interp:
        raise CodeNodeError(503, "CODE_SANDBOX_UNAVAILABLE",
                            "沙箱解释器不存在（server/.venv-sandbox）。跑一次 scripts/dev.sh 会自动建；"
                            "或用 SANDBOX_PYTHON 指定解释器")

    tmpdir = tempfile.mkdtemp(prefix="codepy-")
    read_fd, write_fd = os.pipe()
    started = time.monotonic()
    try:
        try:
            proc = subprocess.Popen(
                [interp, str(_RUNNER), str(write_fd)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                pass_fds=(write_fd,),  # 结果 fd 以原号继承，fd 号通过 argv 告知。
                # 不用 preexec_fn 把它 dup2 到 3：uvicorn 是多线程进程，
                # preexec_fn 在多线程下有 fork 死锁风险（官方文档明说 not thread-safe）
                env=_child_env(tmpdir),
                cwd=tmpdir,
                start_new_session=True,  # 新进程组：SIGKILL 连带用户 fork 出的子孙
            )
        except OSError as exc:
            os.close(read_fd)
            raise CodeNodeError(503, "CODE_SANDBOX_UNAVAILABLE", f"沙箱进程启动失败：{exc}")
        finally:
            os.close(write_fd)  # 父进程必须关掉写端，否则子进程死了管道也读不到 EOF

        results: Dict[str, Tuple[bytes, int]] = {}

        def _read_result() -> None:
            # 结果通道多留 1MB 余量：10MB 上限由 runner 自己执行，这里只防协议坏掉
            with os.fdopen(read_fd, "rb") as f:
                results["res"] = _drain(f, 11 * 1024 * 1024)

        readers = [
            threading.Thread(target=lambda: results.__setitem__("out", _drain(proc.stdout, LOG_KEEP_BYTES)), daemon=True),
            threading.Thread(target=lambda: results.__setitem__("err", _drain(proc.stderr, LOG_KEEP_BYTES)), daemon=True),
            threading.Thread(target=_read_result, daemon=True),
        ]
        for t in readers:
            t.start()

        try:
            proc.stdin.write(json.dumps(
                {"code": code, "inputs": inputs, "timeoutSeconds": timeout_s},
                ensure_ascii=False).encode("utf-8"))
            proc.stdin.close()
        except (BrokenPipeError, OSError):
            pass  # 子进程秒死的话由下面"无协议输出"统一判

        timed_out = False
        try:
            proc.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            timed_out = True
            _kill_group(proc)
            proc.wait()
        for t in readers:
            t.join(timeout=5)

        duration_ms = int((time.monotonic() - started) * 1000)
        out_bytes, out_total = results.get("out", (b"", 0))
        err_bytes, err_total = results.get("err", (b"", 0))
        res_bytes, _ = results.get("res", (b"", 0))
        stdout_text = _decode(out_bytes, out_total, "stdout")
        stderr_text = _decode(err_bytes, err_total, "stderr")

        if timed_out:
            raise CodeNodeError(408, "CODE_TIMEOUT", _with_stdout_tail(
                f"执行超过 {timeout_s}s，沙箱被强制结束（SIGKILL）。"
                f"默认 {TIMEOUT_DEFAULT_SECONDS}s，节点「高级设置」最多可调到 {TIMEOUT_MAX_SECONDS}s",
                stdout_text))

        if not res_bytes:
            # runner 的约定是"只要能报告就 exit 0 并写协议结果"。走到这儿说明它
            # 连报告的机会都没有 —— 解释器坏了、被 OOM killer 干掉之类，可重试
            sig = -proc.returncode if (proc.returncode or 0) < 0 else None
            hint = "（收到信号 %s，可能是内存超限被杀）" % sig if sig else f"（退出码 {proc.returncode}）"
            raise CodeNodeError(503, "CODE_SANDBOX_UNAVAILABLE", _with_stdout_tail(
                f"沙箱进程异常退出且没有产出结果{hint}", stderr_text or stdout_text))

        try:
            report = json.loads(res_bytes.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise CodeNodeError(503, "CODE_SANDBOX_UNAVAILABLE", f"沙箱结果通道内容损坏：{exc}")

        if not report.get("ok"):
            raise CodeNodeError(*_map_kind(report.get("kind")), _with_stdout_tail(
                str(report.get("message") or "执行失败"), stdout_text))

        result = report.get("result") or {}
        logs = _assemble_logs(stdout_text, stderr_text, report.get("converted") or [])
        return {**result, "logs": logs, "durationMs": duration_ms}
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _kill_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)  # start_new_session 后 pgid == pid
    except (ProcessLookupError, PermissionError):
        proc.kill()


def _decode(kept: bytes, total: int, name: str) -> str:
    text = kept.decode("utf-8", errors="replace")
    if total > len(kept):
        text += f"\n……（{name} 共 {total // 1024}KB，只保留前 {LOG_KEEP_BYTES // 1024}KB）"
    return text


def _with_stdout_tail(message: str, stdout_text: str) -> str:
    # worker 的失败路径只带 message 不带 output —— print 调试的内容不塞进错误
    # 消息里，用户就永远看不到它了
    tail = stdout_text.strip()[-2048:]
    return f"{message}\n—— 输出尾部 ——\n{tail}" if tail else message


def _assemble_logs(stdout_text: str, stderr_text: str, converted: list) -> str:
    parts = []
    if stdout_text:
        parts.append(stdout_text.rstrip("\n"))
    if stderr_text:
        parts.append("--- stderr ---\n" + stderr_text.rstrip("\n"))
    if converted:
        parts.append("--- 自动转换 ---\n" + "\n".join(str(c) for c in converted))
    return "\n".join(parts)


def _map_kind(kind: Any) -> Tuple[int, str]:
    return {
        "syntax": (400, "CODE_SYNTAX_ERROR"),
        # 缺入口函数是保存期就该被前端拦下的调用方问题，归 BAD_REQUEST
        "no_main": (400, "BAD_REQUEST"),
        "runtime": (400, "CODE_RUNTIME_ERROR"),
        "bad_return": (400, "CODE_BAD_RETURN"),
        "output_too_large": (400, "CODE_OUTPUT_TOO_LARGE"),
    }.get(kind, (503, "CODE_SANDBOX_UNAVAILABLE"))


# ---------------------------------------------------------------- 沙箱服务转发

def _forward(code: str, inputs: Dict[str, Any], timeout_s: int) -> Dict[str, Any]:
    """转发给独立沙箱服务（尚未实现，缝先留好）。

    协议：POST {SANDBOX_URL}/execute，body {"code","inputs","timeoutSeconds"}；
    成功回 {"result": dict, "logs": str, "durationMs": int}；
    失败回 {"code": 本表错误码, "message": str}，HTTP 状态与错误码一致。
    """
    url = os.getenv("SANDBOX_URL", "").strip().rstrip("/") + "/execute"
    try:
        resp = requests.post(url, json={"code": code, "inputs": inputs, "timeoutSeconds": timeout_s},
                             timeout=timeout_s + 10)
    except requests.RequestException as exc:
        raise CodeNodeError(503, "CODE_SANDBOX_UNAVAILABLE", f"沙箱服务无法访问：{exc}")
    try:
        body = resp.json()
    except ValueError:
        raise CodeNodeError(503, "CODE_SANDBOX_UNAVAILABLE",
                            f"沙箱服务返回了非 JSON（HTTP {resp.status_code}）")
    if resp.status_code != 200:
        code_name = str(body.get("code") or "CODE_SANDBOX_UNAVAILABLE")
        raise CodeNodeError(resp.status_code, code_name, str(body.get("message") or "沙箱执行失败"))
    result = body.get("result") or {}
    return {**result, "logs": str(body.get("logs") or ""), "durationMs": int(body.get("durationMs") or 0)}
