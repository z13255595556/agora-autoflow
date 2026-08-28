"""sandbox_packages 的测试。校验和对账计划是纯函数不用库；
增删两条要 DATABASE_URL（migrations 会自动建表），没有就跳过并打出来。

    cd server && DATABASE_URL=postgresql://$USER@127.0.0.1:5432/workflow .venv/bin/python test_sandbox_packages.py
"""
import os
import sys

from sql_service import sandbox_packages as sp
from sql_service.sandbox_packages import PackageError, norm, plan, validate

PASS, FAIL = [], []


def ok(name, got, want):
    (PASS if got == want else FAIL).append((name, got, want))


def raises(name, fn, fragment=""):
    try:
        fn()
    except PackageError as exc:
        if fragment and fragment not in str(exc):
            FAIL.append((name, f"报错但内容不符: {exc}", f"包含 {fragment!r}"))
        else:
            PASS.append((name, "raised", "raised"))
    except Exception as exc:  # noqa: BLE001
        FAIL.append((name, f"抛了 {type(exc).__name__}: {exc}", "PackageError"))
    else:
        FAIL.append((name, "没有报错", "PackageError"))


# ---------------------------------------------------------------- 归一与校验
ok("PEP503 归一：下划线/点/大写都是同一个包", norm("Python_dateUtil"), "python-dateutil")
ok("归一幂等", norm("python-dateutil"), "python-dateutil")
ok("合法包名+钉死版本", validate("Pandas", "2.2.3"), ("pandas", "2.2.3"))
ok("post 版本", validate("python-dateutil", "2.9.0.post0"), ("python-dateutil", "2.9.0.post0"))
raises("空名被拒", lambda: validate("", "1.0"), "包名不合法")
raises("带路径的名被拒（防 pip install ../evil）", lambda: validate("../evil", "1.0"), "包名不合法")
raises("带 URL 的名被拒", lambda: validate("git+https://x/y.git", "1.0"), "包名不合法")
raises("空版本被拒", lambda: validate("pandas", ""), "钉死版本")
raises("范围版本被拒 —— 不钉版本流程重跑结果会漂", lambda: validate("pandas", ">=2.0"), "版本号不合法")
raises("带分号的版本被拒（防命令注入式参数）", lambda: validate("pandas", "2.0; rm -rf /"), "版本号不合法")

# ---------------------------------------------------------------- 对账计划（纯函数）
desired = [
    {"name": "pandas", "version": "2.2.3", "status": "pending"},
    {"name": "numpy", "version": "2.0.2", "status": "installed"},
    {"name": "orjson", "version": "3.10.15", "status": "failed"},
    {"name": "requests", "version": "2.32.3", "status": "removing"},
    {"name": "python-dateutil", "version": "2.9.0.post0", "status": "pending"},
]
installed = {"numpy": "2.0.2", "orjson": "3.9.0", "python-dateutil": "2.9.0.post0"}
acts = plan(desired, installed)
ok("待装的装", ("install", desired[0]) in acts, True)
ok("装好且版本一致的不动", all(r is not desired[1] for _, r in acts), True)
ok("failed 且版本不符的再试一次（改好源之后自动痊愈）", ("install", desired[2]) in acts, True)
ok("removing 的卸", ("uninstall", desired[3]) in acts, True)
ok("venv 已对但表里还是 pending 的只改状态", ("mark_installed", desired[4]) in acts, True)
ok("没有多余动作", len(acts), 4)

# ---------------------------------------------------------------- 增删 + 远程对账（要库）
if os.getenv("DATABASE_URL", "").strip() or os.getenv("PGHOST", "").strip():
    _real_kick = sp.kick
    sp.kick = lambda: None  # 测试别真的去 pip 装包
    try:
        row = sp.add("Test_Pkg_Autoflow", "0.0.1", "tester@agora.io")
        ok("add 归一后落表", row, {"name": "test-pkg-autoflow", "version": "0.0.1", "status": "pending"})
        names = [p["name"] for p in sp.overview()["packages"]]
        ok("overview 能看到", "test-pkg-autoflow" in names, True)
        row = sp.remove("test_pkg_autoflow")
        ok("remove 置 removing", row["status"], "removing")
        raises("删不存在的包 404", lambda: sp.remove("no-such-pkg-xyz"), "没有这个包")

        # ---- 远程对账：pip 跑在沙箱容器里，这边只发指令。假 requests 断言协议 ----
        import types

        calls = []

        class _Resp:
            def __init__(self, body, status=200):
                self._body, self.status_code = body, status

            def json(self):
                return self._body

            def raise_for_status(self):
                pass

        def _fake_get(url, timeout=None):
            calls.append(("GET", url, None))
            return _Resp({"packages": []})  # 沙箱是空 venv

        def _fake_post(url, json=None, timeout=None):
            calls.append(("POST", url, json))
            return _Resp({"ok": True, "log": "Successfully installed"})

        os.environ["SANDBOX_URL"] = "http://sandbox:9000"
        # 上面 remove 把行置成了 removing —— 远程对账应该发 uninstall 然后删行
        sp.add("Test_Pkg_Remote", "1.2.3", "tester@agora.io")
        _real_requests = sp.requests
        sp.requests = types.SimpleNamespace(get=_fake_get, post=_fake_post,
                                            RequestException=Exception)
        try:
            sp._reconcile_remote()
        finally:
            sp.requests = _real_requests
            del os.environ["SANDBOX_URL"]

        ok("远程对账先拉沙箱已装清单",
           calls[0], ("GET", "http://sandbox:9000/packages", None))
        ok("待装的包发 install 且带钉死版本",
           ("POST", "http://sandbox:9000/packages/install",
            {"name": "test-pkg-remote", "version": "1.2.3"}) in calls, True)
        ok("removing 的包发 uninstall",
           ("POST", "http://sandbox:9000/packages/uninstall",
            {"name": "test-pkg-autoflow"}) in calls, True)
        statuses = {p["name"]: p["status"] for p in sp.overview()["packages"]}
        ok("装完写回 installed", statuses.get("test-pkg-remote"), "installed")
        ok("卸完整行消失", "test-pkg-autoflow" in statuses, False)
    finally:
        sp.kick = _real_kick
        from sql_service import db
        with db.pool().connection() as conn:
            conn.execute("DELETE FROM sandbox_packages WHERE name IN ('test-pkg-autoflow', 'test-pkg-remote')")
else:
    print("跳过：没有 DATABASE_URL/PGHOST，增删与远程对账没测到（本机有 workflow 库的话带上再跑）")

# ----------------------------------------------------------------
for name, got, want in FAIL:
    print(f"✗ {name}\n    实际: {got!r}\n    期望: {want!r}")
print(f"\n{len(PASS)} 通过, {len(FAIL)} 失败")
sys.exit(1 if FAIL else 0)
