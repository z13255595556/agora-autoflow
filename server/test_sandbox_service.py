"""sandbox/service.py 的测试。不起 HTTP、不跑真 pip —— 直接调端点函数。

    cd server && .venv/bin/python test_sandbox_service.py
"""
import json
import os
import sys

os.environ["SANDBOX_PYTHON"] = sys.executable

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sandbox"))
import service  # noqa: E402

PASS, FAIL = [], []


def ok(name, cond, detail=""):
    (PASS if cond else FAIL).append((name, detail or cond, True))


def body_of(resp):
    return json.loads(bytes(resp.body))


# ---------------------------------------------------------------- /execute
out = service.execute(service.ExecuteBody(
    code='def main(inputs):\n    print("svc log")\n    return {"total": inputs["a"] + 1}',
    inputs={"a": 2}))
ok("成功时 result 单独一层（_forward 的约定）", out["result"] == {"total": 3}, out)
ok("logs/durationMs 拆到顶层", "svc log" in out["logs"] and isinstance(out["durationMs"], int), out)

resp = service.execute(service.ExecuteBody(code="def main(inputs)\n    return {}"))
ok("用户错按 {code, message} 返回且状态码对", resp.status_code == 400, resp.status_code)
ok("错误码原样透传", body_of(resp)["code"], body_of(resp)["code"] == "CODE_SYNTAX_ERROR")

resp = service.execute(service.ExecuteBody(code="   "))
ok("空代码 400", resp.status_code == 400, resp.status_code)

# ---------------------------------------------------------------- 参数注入防线
resp = service.install_package(service.PackageBody(name="-r", version="1.0"))
ok("以 - 开头的包名被拒（会被 pip 当选项）", resp.status_code == 400, resp.status_code)
resp = service.install_package(service.PackageBody(name="evil/pkg", version="1.0"))
ok("带 / 的包名被拒（会被 pip 当路径）", resp.status_code == 400, resp.status_code)
resp = service.install_package(service.PackageBody(name="requests", version="git+https://x"))
ok("带 : 的版本被拒（会被 pip 当 URL）", resp.status_code == 400, resp.status_code)
resp = service.uninstall_package(service.PackageBody(name="--yes"))
ok("卸载同样设防", resp.status_code == 400, resp.status_code)

ok("包名归一和 api 侧同规则", service._norm("Python_dateUtil"), service._norm("Python_dateUtil") == "python-dateutil")

# ----------------------------------------------------------------
for name, got, want in FAIL:
    print(f"✗ {name}\n    实际: {got!r}\n    期望: {want!r}")
print(f"\n{len(PASS)} 通过, {len(FAIL)} 失败")
sys.exit(1 if FAIL else 0)
