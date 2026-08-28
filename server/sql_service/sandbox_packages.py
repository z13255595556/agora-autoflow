"""预装包清单与沙箱 venv 的对账。

**sandbox_packages 表是唯一正本，venv 是它的投影**（为什么进库不进
requirements.txt，见 migrations/015 的头注释）。对账 = 把 venv 收敛成表的样子：

    pending / failed / installed 且 venv 里版本不符 → pip install name==version
    removing → pip uninstall → 删行

对账串行跑在后台线程里（进程内锁），启动时一次 + 管理员每次增删后一次。
装包期间节点照常执行：包还没装好时用户代码 import 会得到 ImportError，
错误消息指引去「Python 依赖」页看状态 —— 不存在"装包锁住执行"的耦合。

**pip 是受信任的安装阶段**，跑在 api 自己的环境里（要联网、要 PIP_INDEX_URL）。
它和用户代码的"环境清空"是两回事：用户代码永远碰不到 pip，能改清单的只有
管理员（接口全在 _require_admin 后面）。

生产目前是单 api 实例；多实例同时对账会互相踩（两个 pip 写同一个 venv）。
真到多实例那天再上 advisory lock，现在先不背这个复杂度。
"""
import json
import os
import re
import subprocess
import threading
from typing import Any, Dict, List, Optional, Tuple

import requests

from . import code_python, db

# pip 单个包的安装上限。pandas 冷装两三分钟是正常的，10 分钟还没完多半是
# 源不通 —— 挂着不放的话对账线程会永远占住锁
PIP_TIMEOUT_SECONDS = 600
LOG_TAIL_CHARS = 4000


class PackageError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def norm(name: str) -> str:
    """PEP503 规范化：pip 眼里 python_dateutil / Python.Dateutil 是同一个包，
    不归一的话同一个包能在表里存三行，venv 里却只有一份。"""
    return re.sub(r"[-_.]+", "-", (name or "").strip()).lower()


_NAME_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")
# 钉死的版本号：2.2.3 / 2.9.0.post0 / 1.26.4 这类。范围（>=、~=）一律拒 ——
# 不钉版本，同一条流程今天跑和上月跑结果就可能不同
_VERSION_RE = re.compile(r"^[0-9]+(\.[0-9]+)*([.\-]?(a|b|rc|post|dev)[0-9]*)?$")


def validate(name: str, version: str) -> Tuple[str, str]:
    n = norm(name)
    if not n or not _NAME_RE.match(n):
        raise PackageError(400, f"包名不合法：{name!r}。只认 PyPI 包名（字母数字和连字符）")
    v = (version or "").strip()
    if not v:
        raise PackageError(400, "必须钉死版本号（如 2.2.3）—— 不钉版本，流程重跑结果会漂")
    if not _VERSION_RE.match(v):
        raise PackageError(400, f"版本号不合法：{version!r}。要钉死的版本（如 2.2.3），不收 >= 这类范围")
    return n, v


# ---------------------------------------------------------------- 读写

def _rows(conn, sql: str, args=()) -> List[Dict[str, Any]]:
    cur = conn.execute(sql, args)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def overview() -> Dict[str, Any]:
    with db.pool().connection() as conn:
        rows = _rows(conn, "SELECT name, version, status, pip_log, added_by, updated_at"
                           " FROM sandbox_packages ORDER BY name")
    return {
        "packages": [{
            "name": r["name"], "version": r["version"], "status": r["status"],
            "pipLog": r["pip_log"], "addedBy": r["added_by"],
            "updatedAt": r["updated_at"].isoformat() if r["updated_at"] else None,
        } for r in rows],
        "mode": code_python.mode(),
        "interpreter": code_python.sandbox_python(),
        "reconciling": _lock.locked(),
    }


def add(name: str, version: str, actor: Optional[str]) -> Dict[str, Any]:
    n, v = validate(name, version)
    with db.pool().connection() as conn:
        conn.execute(
            "INSERT INTO sandbox_packages (name, version, status, pip_log, added_by, updated_at)"
            " VALUES (%s, %s, 'pending', NULL, %s, now())"
            " ON CONFLICT (name) DO UPDATE SET version = EXCLUDED.version,"
            "   status = 'pending', pip_log = NULL, added_by = EXCLUDED.added_by, updated_at = now()",
            (n, v, actor))
    kick()
    return {"name": n, "version": v, "status": "pending"}


def remove(name: str) -> Dict[str, Any]:
    n = norm(name)
    with db.pool().connection() as conn:
        cur = conn.execute("UPDATE sandbox_packages SET status = 'removing', updated_at = now()"
                           " WHERE name = %s", (n,))
        if cur.rowcount == 0:
            raise PackageError(404, f"没有这个包：{n}")
    kick()
    return {"name": n, "status": "removing"}


# ---------------------------------------------------------------- 对账

_lock = threading.Lock()
_rerun = False


def kick() -> None:
    """踢一次后台对账。已经在跑就标记重跑 —— 对账每轮全量重读表，
    不需要知道这次踢它的是哪个包。"""
    threading.Thread(target=_worker, daemon=True).start()


def _worker() -> None:
    global _rerun
    if not _lock.acquire(blocking=False):
        _rerun = True
        return
    try:
        while True:
            _rerun = False
            try:
                _reconcile()
            except Exception as exc:  # noqa: BLE001 —— 后台线程炸了没人看得见，至少打一行
                print(f"⚠ 沙箱依赖对账失败：{type(exc).__name__}: {exc}", flush=True)
            if not _rerun:
                return
    finally:
        _lock.release()


def plan(desired: List[Dict[str, Any]], installed: Dict[str, str]) -> List[Tuple[str, Dict[str, Any]]]:
    """算出要执行的动作。纯函数，测试不用碰 pip。

    failed 的行版本没对上也会再试一次 install —— 对账只由启动和管理员操作触发，
    不是循环，不会变成无限重试；而"改对了源之后自动痊愈"值得这一次尝试。
    """
    acts: List[Tuple[str, Dict[str, Any]]] = []
    for row in desired:
        if row["status"] == "removing":
            acts.append(("uninstall", row))
        elif installed.get(row["name"]) != row["version"]:
            acts.append(("install", row))
        elif row["status"] != "installed":
            acts.append(("mark_installed", row))  # venv 里已经是对的，只差表里的状态
    return acts


def _installed(interp: str) -> Dict[str, str]:
    out = subprocess.run([interp, "-m", "pip", "list", "--format", "json",
                          "--disable-pip-version-check"],
                         capture_output=True, timeout=120, check=True)
    return {norm(p["name"]): p["version"] for p in json.loads(out.stdout)}


def _pip(interp: str, *args: str) -> Tuple[bool, str]:
    # 受信任阶段：继承 api 的环境（pip 自己会读 PIP_INDEX_URL），和用户代码的
    # 环境清空无关。--no-input 防交互卡死对账线程
    proc = subprocess.run([interp, "-m", "pip", *args, "--no-input", "--disable-pip-version-check"],
                          capture_output=True, timeout=PIP_TIMEOUT_SECONDS)
    log = (proc.stdout + b"\n" + proc.stderr).decode("utf-8", errors="replace")
    return proc.returncode == 0, log[-LOG_TAIL_CHARS:]


def _reconcile() -> None:
    if code_python.mode() == "remote":
        _reconcile_remote()
        return
    interp = code_python.sandbox_python()
    if not interp:
        return  # 解释器都没有，装了也没处放。界面上 interpreter 为空就是提示
    installed = _installed(interp)
    _apply(plan(_desired(), installed),
           install=lambda name, version: _pip(interp, "install", f"{name}=={version}"),
           uninstall=lambda name: _pip(interp, "uninstall", "-y", name))


def _reconcile_remote() -> None:
    """远程沙箱：pip 跑在沙箱容器里，这边只发指令、收结果、写状态。
    协议的另一半在 sandbox/service.py，改任何一边必须同步另一边。"""
    base = os.getenv("SANDBOX_URL", "").strip().rstrip("/")
    try:
        resp = requests.get(f"{base}/packages", timeout=120)
        resp.raise_for_status()
        installed = {p["name"]: p["version"] for p in resp.json().get("packages", [])}
    except (requests.RequestException, ValueError, KeyError) as exc:
        # 沙箱没起来时静默失败会让包永远停在待安装且无从查起 —— 至少打一行。
        # 不写 failed：沙箱一恢复，下一次 kick（启动/增删）就会自然补齐
        print(f"⚠ 沙箱服务不可达，预装包对账跳过：{exc}", flush=True)
        return

    def _call(path: str, payload: Dict[str, Any]) -> Tuple[bool, str]:
        try:
            r = requests.post(f"{base}{path}", json=payload, timeout=PIP_TIMEOUT_SECONDS + 60)
            body = r.json()
        except (requests.RequestException, ValueError) as exc:
            return False, f"沙箱服务调用失败：{exc}"
        if r.status_code != 200:
            return False, str(body.get("message") or f"HTTP {r.status_code}")
        return bool(body.get("ok")), str(body.get("log") or "")

    _apply(plan(_desired(), installed),
           install=lambda name, version: _call("/packages/install", {"name": name, "version": version}),
           uninstall=lambda name: _call("/packages/uninstall", {"name": name}))


def _desired() -> List[Dict[str, Any]]:
    with db.pool().connection() as conn:
        return _rows(conn, "SELECT name, version, status FROM sandbox_packages ORDER BY name")


def _apply(actions, install, uninstall) -> None:
    """执行对账计划并写回状态。本地/远程只差 install/uninstall 怎么跑。"""
    for action, row in actions:
        name, version = row["name"], row["version"]
        if action == "mark_installed":
            _set(name, "installed", None)
            continue
        if action == "uninstall":
            ok, log = uninstall(name)
            if ok:
                with db.pool().connection() as conn:
                    conn.execute("DELETE FROM sandbox_packages WHERE name = %s AND status = 'removing'", (name,))
            else:
                _set(name, "failed", f"卸载失败：\n{log}")
            continue
        ok, log = install(name, version)
        _set(name, "installed" if ok else "failed", log)


def _set(name: str, status: str, log: Optional[str]) -> None:
    with db.pool().connection() as conn:
        conn.execute("UPDATE sandbox_packages SET status = %s, pip_log = %s, updated_at = now()"
                     " WHERE name = %s", (status, log, name))
