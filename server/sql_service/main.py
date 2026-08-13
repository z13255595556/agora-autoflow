"""SQL 节点服务。

给工作流引擎提供一个节点类型：注册表、动态选项、提交/轮询/取消、输出结构探测。

**异步节点协议**：submit 秒回 handle，引擎按 pollIntervalMs 轮询。
这不是为了好看 —— Hive 慢查询跑几分钟，同步等待必然撞网关的
proxy_read_timeout（nginx 默认 60s），而且每个慢查询占死一个 worker。
"""
import os
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import datalego, manifest, robot, sqlparams, wecom

app = FastAPI(title="workflow sql node", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    # 开发期前端在 5273，正式部署由网关同源转发，这里就不用开了
    allow_origins=[o for o in os.getenv("CORS_ORIGINS", "http://localhost:5273").split() if o],
    allow_methods=["*"],
    allow_headers=["*"],
)

PROBE_LIMIT = 1


class SubmitBody(BaseModel):
    params: Dict[str, Any] = Field(default_factory=dict)


class CancelBody(BaseModel):
    handle: str


def _check_handle(handle: str) -> None:
    """handle 会拼进平台的 URL 路径，格式不对是调用方的 bug，不是查询失败。

    这两件事必须分开：查询失败（语法错、表不存在）会显示成"你的 SQL 有问题"
    让用户去改，而 handle 不合法改 SQL 是没用的。
    """
    if not datalego.JOB_ID_RE.match(handle or ""):
        raise HTTPException(400, f"非法的任务 handle: {handle!r}")


def _token() -> str:
    try:
        return robot.get_token()
    except robot.RobotError as exc:
        # 服务端配置问题，不是调用方能解决的 —— 503 而不是 400
        raise HTTPException(503, f"机器人账号不可用：{exc}")


def _build_sql(params: Dict[str, Any], limit_override: Optional[int] = None) -> Dict[str, Any]:
    """把节点参数渲染成最终 SQL。参数不合法直接 400，附上人能看懂的原因。"""
    sql = str(params.get("sql") or "")
    binds = params.get("params") or {}
    if not isinstance(binds, dict):
        raise HTTPException(400, "params 必须是对象（占位符名 → 值）")

    engine = str(params.get("engine") or "hive")
    if engine not in datalego.ENGINES:
        raise HTTPException(400, f"不支持的引擎 {engine!r}，可选：{'、'.join(datalego.ENGINES)}")

    raw_limit = params.get("limit")
    limit = limit_override if limit_override is not None else (
        int(raw_limit) if isinstance(raw_limit, (int, float, str)) and str(raw_limit).strip().isdigit() else 1000
    )

    try:
        rendered = sqlparams.render(sql, binds)
    except sqlparams.SqlParamError as exc:
        raise HTTPException(400, str(exc))

    return {
        "sql": sqlparams.apply_limit(rendered, limit),
        "engine": engine,
        "limit": limit,
        "queue": str(params.get("queue") or "share"),
        "creator": (str(params.get("creator") or "").strip() or None),
    }


def _submit(plan: Dict[str, Any]) -> Dict[str, Any]:
    """提交并返回 handle。401 时作废票重试一次 —— 票是服务端自己的，用户改不了。"""
    for attempt in (1, 2):
        try:
            job_id = datalego.submit(
                _token(), plan["sql"], plan["engine"],
                creator=plan["creator"], queue=plan["queue"],
            )
            return {"handle": job_id, "renderedSql": plan["sql"], "limit": plan["limit"]}
        except datalego.AuthError:
            if attempt == 1:
                robot.invalidate()
                continue
            raise HTTPException(502, "数据平台不接受机器人账号的票，请检查服务端凭证配置")
        except datalego.QueryError as exc:
            raise HTTPException(400, str(exc))
    raise HTTPException(500, "unreachable")


@app.get("/health")
def health() -> Dict[str, Any]:
    missing = robot.missing_credentials()
    return {
        "ok": not missing,
        "endpoint": datalego.endpoint(),
        "missingCredentials": missing,
    }


@app.get("/registry/nodes")
def registry() -> Dict[str, Any]:
    return {"nodes": manifest.ALL}


@app.get("/options/{key}")
def options(key: str) -> Dict[str, Any]:
    if key == "sql.engines":
        return {"options": [{"value": e, "label": e} for e in datalego.ENGINES]}
    raise HTTPException(404, f"没有这个选项集：{key}")


@app.post("/nodes/notify.wecom/execute")
def execute_wecom(body: SubmitBody) -> Dict[str, Any]:
    """同步节点：发一条就返回，不用轮询。调用即真发。"""
    p = body.params
    mentioned = [m.strip() for m in str(p.get("mentioned") or "").split(",") if m.strip()]
    try:
        return {
            "output": wecom.send(
                webhook=str(p.get("webhook") or ""),
                msgtype=str(p.get("msgtype") or "markdown_v2"),
                content=str(p.get("content") or ""),
                mentioned=mentioned,
            )
        }
    except wecom.WecomError as exc:
        raise HTTPException(400, str(exc))


@app.post("/nodes/sql.query/submit")
def submit_node(body: SubmitBody) -> Dict[str, Any]:
    return _submit(_build_sql(body.params))


@app.post("/nodes/sql.query/probe")
def probe_node(body: SubmitBody) -> Dict[str, Any]:
    """探测输出结构：跑一行拿 schema，下游变量提示就有真实列名了。"""
    return _submit(_build_sql(body.params, limit_override=PROBE_LIMIT))


@app.get("/nodes/sql.query/poll")
def poll_node(handle: str, limit: int = 1000) -> Dict[str, Any]:
    _check_handle(handle)
    try:
        result = datalego.poll(_token(), handle)
    except datalego.AuthError:
        robot.invalidate()
        raise HTTPException(502, "数据平台不接受机器人账号的票，请检查服务端凭证配置")
    except datalego.ExpiredError as exc:
        raise HTTPException(410, str(exc))
    except datalego.QueryError as exc:
        # 查询本身失败（语法错、表不存在）—— 这是用户能改的，原文带回去
        return {"done": True, "failed": True, "progress": 100.0, "error": str(exc)}

    if not result["done"]:
        return {"done": False, "failed": False, "progress": result["progress"],
                "status": result.get("status")}

    rows = result["rows"]
    return {
        "done": True,
        "failed": False,
        "progress": 100.0,
        "output": {
            "rows": rows,
            "rowCount": len(rows),
            "columns": result["columns"],
            # 正好顶到上限，说明很可能还有更多数据没取回来
            "truncated": len(rows) >= limit > 0,
            "jobId": handle,
            "renderedSql": result.get("sql"),
        },
    }


@app.post("/nodes/sql.query/cancel")
def cancel_node(body: CancelBody) -> Dict[str, Any]:
    """流程中止时必须调 —— 不撤的话 Hive 那边继续白烧集群资源。"""
    _check_handle(body.handle)
    try:
        datalego.cancel(_token(), body.handle)
    except datalego.QueryError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:  # 取消失败不该让中止流程本身失败
        return {"cancelled": False, "detail": str(exc)}
    return {"cancelled": True}
