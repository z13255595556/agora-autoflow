"""独立沙箱服务：Python 代码节点在生产环境的执行方。

api 通过 SANDBOX_URL 把两件事转发过来，协议的另一半在
server/sql_service/code_python.py（_forward）和 sandbox_packages.py
（_reconcile_remote），**改任何一边必须同步另一边**：

    POST /execute                  {code, inputs, timeoutSeconds}
        → 200 {result, logs, durationMs} / 4xx|5xx {code, message}
    GET  /packages                 → {packages: [{name, version}]}   已装清单
    POST /packages/install         {name, version} → {ok, log}
    POST /packages/uninstall       {name}          → {ok, log}
    GET  /health

**这个容器里没有任何凭证**：不挂 secrets、不给 env_file、不连数据库。
预装包清单的正本在 api 那边的 sandbox_packages 表里，这里只是被推着跑 pip
的哑执行方 —— 所以装/卸接口不做业务校验（那是 api 的事），只挡明显的
参数注入（见 _guard_arg）。

分层：服务层跑在镜像的系统 python（fastapi/uvicorn/requests）；用户代码
和它的包在 SANDBOX_PYTHON 指向的独立 venv —— 用户装的包再怎么冲突也
带不崩服务本身。执行细节（结果走独立 fd、环境清空、超时 killpg）全部
复用 code_python.execute_local，不另写一份。
"""
import json
import re
import subprocess
from typing import Any, Dict, Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from sql_service import code_python
from sql_service.code_python import CodeNodeError

app = FastAPI(title="autoflow sandbox", version="1.0.0")

PIP_TIMEOUT_SECONDS = 600
LOG_TAIL_CHARS = 4000


class ExecuteBody(BaseModel):
    code: str = ""
    inputs: Dict[str, Any] = Field(default_factory=dict)
    timeoutSeconds: Optional[int] = None


class PackageBody(BaseModel):
    name: str
    version: str = ""


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"ok": True, "interpreter": code_python.sandbox_python()}


@app.post("/execute")
def execute(body: ExecuteBody):
    try:
        out = code_python.execute_local(
            {"code": body.code, "inputs": body.inputs, "timeoutSeconds": body.timeoutSeconds})
    except CodeNodeError as exc:
        # 状态码与错误码原样交给 api 的 _forward 转译，不在这层再包一遍
        return JSONResponse(status_code=exc.status, content={"code": exc.code, "message": str(exc)})
    # execute_local 返回的是拼好的 {**用户结果, logs, durationMs}；协议里 result
    # 要单独一层。保留键冲突在 runner 里已经拒过，这里拆开是无损的
    logs = out.pop("logs", "")
    duration = out.pop("durationMs", 0)
    return {"result": out, "logs": logs, "durationMs": duration}


# ---------------------------------------------------------------- 预装包


def _norm(name: str) -> str:
    # 和 sql_service/sandbox_packages.norm 同一条规则（这边不能 import 它 ——
    # 那个模块连着 psycopg，沙箱镜像里没有数据库驱动，也不该有）
    return re.sub(r"[-_.]+", "-", (name or "").strip()).lower()


def _guard_arg(value: str) -> Optional[JSONResponse]:
    """业务校验在 api 侧；这里只挡参数注入：以 - 开头会被 pip 当选项，
    带 / 或 : 会被当路径/URL —— 哑执行方也不执行任意参数。"""
    if not value or value.startswith("-") or any(c in value for c in "/:@ "):
        return JSONResponse(status_code=400, content={"message": f"非法参数：{value!r}"})
    return None


def _interp() -> str:
    interp = code_python.sandbox_python()
    if not interp:
        raise RuntimeError("SANDBOX_PYTHON 未配置或不可执行 —— 镜像坏了，这不该发生")
    return interp


def _pip(*args: str):
    proc = subprocess.run(
        [_interp(), "-m", "pip", *args, "--no-input", "--disable-pip-version-check"],
        capture_output=True, timeout=PIP_TIMEOUT_SECONDS)
    log = (proc.stdout + b"\n" + proc.stderr).decode("utf-8", errors="replace")
    return proc.returncode == 0, log[-LOG_TAIL_CHARS:]


@app.get("/packages")
def list_packages() -> Dict[str, Any]:
    out = subprocess.run(
        [_interp(), "-m", "pip", "list", "--format", "json", "--disable-pip-version-check"],
        capture_output=True, timeout=120, check=True)
    return {"packages": [{"name": _norm(p["name"]), "version": p["version"]}
                         for p in json.loads(out.stdout)]}


@app.post("/packages/install")
def install_package(body: PackageBody):
    bad = _guard_arg(body.name) or _guard_arg(body.version)
    if bad:
        return bad
    ok, log = _pip("install", f"{_norm(body.name)}=={body.version}")
    return {"ok": ok, "log": log}


@app.post("/packages/uninstall")
def uninstall_package(body: PackageBody):
    bad = _guard_arg(body.name)
    if bad:
        return bad
    ok, log = _pip("uninstall", "-y", _norm(body.name))
    return {"ok": ok, "log": log}
