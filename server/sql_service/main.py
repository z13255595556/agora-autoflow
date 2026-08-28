"""SQL 节点服务。

给工作流引擎提供一个节点类型：注册表、动态选项、提交/轮询/取消、输出结构探测。

**异步节点协议**：submit 秒回 handle，引擎按 pollIntervalMs 轮询。
这不是为了好看 —— Hive 慢查询跑几分钟，同步等待必然撞网关的
proxy_read_timeout（nginx 默认 60s），而且每个慢查询占死一个 worker。
"""
import os
from typing import Any, Dict, List, Optional

import psycopg
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from . import code_python, datalego, db, errors, flowdef, flowstore, http_request, identity, manifest, robot, runstore, sqlparams, webhooks, usage, wecom, workspace

app = FastAPI(title="workflow sql node", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    # 开发期前端在 5273，正式部署由网关同源转发，这里就不用开了
    allow_origins=[o for o in os.getenv("CORS_ORIGINS", "http://localhost:5273").split() if o],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 假身份开着这件事必须**在启动时就吵一次**。它在界面上和真登录一模一样，
# 唯一能提醒人的时机就是这里 —— 否则某天有人拿本地看到的权限样子去下结论，
# 而那个结论错在哪没有任何线索。
if identity.dev_user() is not None:
    _dev = identity.dev_user()
    print("=" * 72, flush=True)
    print(f"⚠ 本地开发身份已开启：所有请求都会被当成 {_dev.email}"
          f"{'（管理员）' if _dev.is_admin else ''}", flush=True)
    print("  这不是真的登录。去掉 server/.env 里的 DEV_IDENTITY_EMAIL 即可关闭。", flush=True)
    print("=" * 72, flush=True)

# 本地子进程模式执行用户 Python 这件事，同样必须在启动时吵一次 —— 它和
# 未来的沙箱容器在界面上看起来一模一样，而隔离程度天差地别。
if code_python.mode() == "local":
    print("=" * 72, flush=True)
    print("⚠ Python 代码节点以本地子进程模式执行：环境变量已清空，但**没有**", flush=True)
    print("  文件系统/内存隔离，仅限本地开发。生产请部署沙箱服务并配 SANDBOX_URL。", flush=True)
    print("=" * 72, flush=True)

PROBE_LIMIT = 1


@app.exception_handler(Exception)
def unhandled_exception(request: Request, exc: Exception) -> JSONResponse:
    """兜底：**没接住的异常也必须回 JSON。**

    默认行为是 Starlette 的 text/plain "Internal Server Error"。引擎（浏览器里的
    和 worker 里的都一样）收到响应第一件事是解析 JSON，于是节点上显示的错误变成

        Unexpected token 'I', "Internal S"... is not valid JSON

    真正的原因一个字都没传到用户面前，连"这是 500"都看不出来。这里只统一格式，
    不改变行为：Starlette 在调完这个 handler 之后照样把异常抛给 uvicorn 打完整栈，
    所以服务端日志里该有的一行不会少。

    错误码 INTERNAL 不在 errors.RETRYABLE 里 —— 认不出的错误码当作不可重试，
    这正是我们要的：没接住的异常重试一次多半还是同样的异常。
    """
    return JSONResponse(
        status_code=500,
        content={"detail": errors.payload(
            "INTERNAL",
            f"服务端内部错误（{type(exc).__name__}）：{str(exc)[:200] or '无异常信息'}。完整堆栈见服务端日志",
        )},
    )


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
        raise HTTPException(400, errors.payload("BAD_REQUEST", f"非法的任务 handle: {handle!r}"))


def _token() -> str:
    try:
        return robot.get_token()
    except robot.RobotError as exc:
        # 服务端配置问题，不是调用方能解决的 —— 503 而不是 400
        raise HTTPException(503, errors.payload("SERVICE_UNAVAILABLE", f"机器人账号不可用：{exc}"))


def _build_sql(
    params: Dict[str, Any],
    creator: Optional[str] = None,
    limit_override: Optional[int] = None,
) -> Dict[str, Any]:
    """把节点参数渲染成最终 SQL。参数不合法直接 400，附上人能看懂的原因。"""
    sql = str(params.get("sql") or "")
    binds = params.get("params") or {}
    if not isinstance(binds, dict):
        raise HTTPException(400, errors.payload("BAD_REQUEST", "params 必须是对象（占位符名 → 值）"))

    engine = str(params.get("engine") or "hive")
    if engine not in datalego.ENGINES:
        raise HTTPException(400, errors.payload("BAD_REQUEST", f"不支持的引擎 {engine!r}，可选：{'、'.join(datalego.ENGINES)}"))

    raw_limit = params.get("limit")
    limit = limit_override if limit_override is not None else (
        int(raw_limit) if isinstance(raw_limit, (int, float, str)) and str(raw_limit).strip().isdigit() else 1000
    )

    try:
        rendered = sqlparams.render(sql, binds)
    except sqlparams.SqlParamError as exc:
        raise HTTPException(400, errors.payload("SQL_PARAM_ERROR", str(exc)))

    return {
        "sql": sqlparams.apply_limit(rendered, limit),
        "engine": engine,
        "limit": limit,
        "queue": str(params.get("queue") or "share"),
        # creator **只从登录态来**，params 里带的一律不认（旧流程定义里可能还
        # 留着一个手填的 creator）。它决定的是用谁的数据权限，而 params 是
        # 编流程的人随手填的字符串 —— 信它等于谁都能以别人的权限查数
        "creator": creator,
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
            raise HTTPException(502, errors.payload("PLATFORM_AUTH", "数据平台不接受机器人账号的票，请检查服务端凭证配置"))
        except datalego.PlatformTimeout as exc:
            raise HTTPException(504, errors.payload("UPSTREAM_TIMEOUT", str(exc)))
        except datalego.PlatformError as exc:
            # 平台自己坏了，不消耗上面那次换票重试 —— 换张新票也一样连不上
            raise HTTPException(502, errors.payload("PLATFORM_UNAVAILABLE", str(exc)))
        except datalego.QueryError as exc:
            raise HTTPException(400, errors.payload("SQL_QUERY_ERROR", str(exc)))
    raise HTTPException(500, "unreachable")


def _idempotent(key: Optional[str], run):
    """有副作用的节点：同 key 24 小时内只真正执行一次。

    没配数据库时直接执行 —— 幂等是加强项，不该让节点因为没有库就不能跑。
    """
    if not key or not db.configured():
        return run()
    try:
        with db.pool().connection() as conn:
            hit = conn.execute(
                "SELECT response FROM node_idempotency WHERE key = %s"
                "  AND created_at > now() - interval '24 hours'",
                (key,),
            ).fetchone()
            if hit:
                return hit[0]
    except Exception:  # noqa: BLE001
        return run()

    out = run()
    try:
        with db.pool().connection() as conn:
            conn.execute(
                "INSERT INTO node_idempotency (key, response) VALUES (%s,%s)"
                " ON CONFLICT (key) DO NOTHING",
                (key, Jsonb(out)),
            )
            conn.commit()
    except Exception:  # noqa: BLE001
        pass
    return out


@app.get("/health")
def health() -> Dict[str, Any]:
    missing = robot.missing_credentials()
    return {
        "ok": not missing,
        "endpoint": datalego.endpoint(),
        "missingCredentials": missing,
        # 数据库是独立的一档能力：没有它节点照样跑，只是流程存在浏览器本地。
        # 前端据此决定用 API 还是 localStorage，所以必须如实上报而不是并进 ok
        "storage": db.status(),
        # 定时触发到底会不会跑。前端据此决定挂不挂"不会自动运行"的提示
        "scheduler": db.scheduler_status(),
    }


@app.get("/whoami")
def whoami(request: Request) -> Dict[str, Any]:
    """这次请求会以谁的权限查数。

    单独一个接口而不是并进 /health：health 前端每隔一会儿探一次，而这个要读
    cookie，两者的缓存语义不一样。它存在的理由只有一个 —— 平台回"无权限"时，
    第一个要回答的问题是"这次到底用的谁"，靠猜会浪费很久。
    """
    user = identity.current_user_for(request)
    creator = user.email if user else identity.creator_for(request)
    return {
        "creator": creator,
        "source": identity.source_of(request),
        # 和每个接口用来放行的**是同一个函数**。前端如果自己去 user.isAdmin
        # 里推，两边就有两条判定路径，将来只要有一条变了就会出现
        # "界面上有按钮、点了 403" 或者更糟的反过来
        "isAdmin": identity.is_admin(request),
        "user": None if user is None else {
            "id": user.id,
            "email": user.email,
            "displayName": user.display_name,
            "permissions": list(user.permissions),
            "isAdmin": user.is_admin,
        },
        # 认不出身份不报错，但要把后果说清楚：走机器人账号 = 没有按人隔离。
        # dev 身份也要说 —— 它在界面上和真登录一模一样，不说的话很容易拿本地
        # 看到的样子去推断线上的样子
        "note": (
            "认不出登录身份，查询将使用服务端机器人账号的权限" if not creator
            else "本地开发身份（DEV_IDENTITY_EMAIL），不是真的登录用户"
            if identity.source_of(request) == "dev" else None
        ),
    }


# ---------------------------------------------------------------- 流程（控制面）
#
# 与 /nodes/* 分开：那些是**节点执行面**，由引擎调用；这些是控制面，由编辑器调用。
# 将来引擎搬到独立 worker 进程后，两者的调用方彻底不同。


class FlowBody(BaseModel):
    definition: Dict[str, Any]
    id: Optional[str] = None


class PublishBody(BaseModel):
    """发布。**整个 body 可以不传** —— 变更说明是选填的，老前端也不带它。"""
    note: Optional[str] = None


def _actor(request: Request, header: Optional[str]) -> Optional[str]:
    """谁在操作 —— 流程归属、可见性、审计三件事共用同一个身份。

    邮箱优先（athena 的 HCIAuthToken），取不到才回退反向代理注入的用户名。
    **必须是同一个身份**：owner 用邮箱而 SQL 用另一个身份的话，"这条流程是我的"
    和"它用我的权限查数"会在某天对不上，而且是静默的。

    都取不到 = 匿名。匿名不是一个人：它只看得见同样无主的流程（见 flowstore）。
    """
    return identity.user_for(request, header)


def _viewer(request: Request, header: Optional[str] = None) -> Any:
    """这次请求用谁的**视角**看数据。

    和 _actor 是两件事，不能合并：管理员编辑别人的流程时，视角是"全部"，
    但 actor 仍然是他本人 —— 审计和归属记的必须是真的动手的那个人。

    管理员身份来自 athena 校验过的 /api/me，**不看任何请求头** ——
    否则加一个头就能看到全公司的查询结果。
    """
    return flowstore.ANY if identity.is_admin(request) else _actor(request, header)


def _guard(fn, *args, **kwargs):
    """把存储层的异常翻译成 HTTP。每一类都要能让调用方知道该怎么办。"""
    try:
        return fn(*args, **kwargs)
    except db.DbUnavailable as exc:
        # 503 而不是 500：这是服务端配置问题，调用方改什么都没用；
        # 前端据此退回 localStorage
        raise HTTPException(503, str(exc))
    except flowdef.FlowDefError as exc:
        raise HTTPException(400, str(exc))
    except flowstore.NotFound as exc:
        raise HTTPException(404, str(exc))
    except flowstore.FlowExists as exc:
        # 带 code 的结构化 409：前端要据此分出"恢复归档"和"换个 id 建副本"
        # 两条完全不同的出路，靠匹配文案迟早会漂
        raise HTTPException(409, {"code": exc.code, "message": str(exc)})
    except FileExistsError as exc:
        raise HTTPException(409, str(exc))
    except flowstore.FlowArchived as exc:
        # 结构化 409：前端要据此**清掉本地那份缓存**（这条已经被删了），
        # 而不是当成一次普通的保存失败留着重试 —— 留着就是下一张「只在本机」。
        # 靠匹配文案分支迟早会漂，所以给 code
        raise HTTPException(409, {"code": "flow_archived", "message": str(exc)})
    except runstore.NotFound as exc:
        raise HTTPException(404, str(exc))
    except runstore.NotPublished as exc:
        raise HTTPException(409, str(exc))
    except webhooks.WebhookError as exc:
        raise HTTPException(exc.status, str(exc))
    except psycopg.errors.ForeignKeyViolation as exc:
        # 目前唯一走到这里的是 redrive 指定了一个不存在的版本号。
        # 400 而不是 500：这是调用方给错了参数，不是服务端坏了
        raise HTTPException(400, f"引用了不存在的记录：{exc}")


@app.get("/api/flows")
def list_flows(
    request: Request,
    includeArchived: bool = False,
    scope: str = "mine",
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """流程列表。scope=mine（默认）是**我的**工作台，别人的流程在这里就不存在；
    scope=all 是管理台，要管理员权限。"""
    # scope 是**显式**的：管理员身份不会悄悄把默认列表撑大成全公司的流程。
    # 隐式放大最难受的地方在于，管理员从此再也看不到"我自己的工作台"长什么样，
    # 而那正是他每天真正在用的那一屏
    if scope == "all":
        _require_admin(request)
        viewer = flowstore.ANY
    else:
        viewer = _actor(request, x_forwarded_user)
    return {"flows": _guard(flowstore.list_flows, includeArchived, viewer)}


@app.post("/api/flows")
def create_flow(
    body: FlowBody,
    request: Request,
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    flow_id = (body.id or "").strip() or str(body.definition.get("id") or "").strip()
    if not flow_id:
        raise HTTPException(400, "缺少流程 id")
    # **这里刻意不用 _viewer。**
    #
    # create_flow 的 viewer 只有一个用途：id 撞上时判断"你为什么在列表里看不到它"。
    # 那个"列表"就是首页默认那一屏（scope=mine），而它用的是 _actor。
    # 传 _viewer 的话管理员的视角是 ANY，于是"看得见"恒为真 ——
    # 「归属其他人」那一支对管理员永远不触发，他拿到的是「刷新一下就看得到」，
    # 而刷新一百次也不会看到。判定和被解释的那张列表必须用同一个视角。
    return _guard(flowstore.create_flow, flow_id, body.definition,
                  _actor(request, x_forwarded_user))


@app.get("/api/flows/{flow_id}")
def get_flow(
    flow_id: str,
    request: Request,
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    out = _guard(flowstore.get_flow, flow_id, _viewer(request, x_forwarded_user))
    # 这条在**默认列表**（scope=mine）里看得到吗。
    #
    # 管理员用 ANY 视角**读得到**别人的流程（从管理台点进去要能打开），
    # 但那份定义不该被浏览器当成"我的"缓存下来 —— 列表用的是 _actor，
    # 缓存下来的东西永远不会出现在列表里，于是变成一条**删了又回来**的
    # 「只在本机」：删掉本地缓存 → 再打开一次 → 又写回去。
    #
    # 判定放在服务端：VISIBLE 那条规则已经有两处实现了，前端再抄一份必漂。
    out["mine"] = flowstore.owner_visible(out.get("owner"), _actor(request, x_forwarded_user))
    return out


@app.put("/api/flows/{flow_id}")
def save_flow(
    flow_id: str,
    body: FlowBody,
    request: Request,
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    return _guard(flowstore.save_draft, flow_id, body.definition,
                  _actor(request, x_forwarded_user), _viewer(request, x_forwarded_user))


@app.post("/api/flows/{flow_id}/publish")
def publish_flow(
    flow_id: str,
    request: Request,
    body: Optional[PublishBody] = None,
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """发布。**无主流程由第一个发布的人认领** —— 谁发布的谁是 owner，
    定时和 webhook 触发也以这个人的名义去数据平台查数。"""
    return _guard(flowstore.publish, flow_id,
                  _actor(request, x_forwarded_user), _viewer(request, x_forwarded_user),
                  note=body.note if body else None)


@app.post("/api/flows/{flow_id}/versions/{version}/activate")
def activate_version(
    flow_id: str,
    version: int,
    request: Request,
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """切回某一个历史版本。**立刻改变线上行为** —— 定时和 webhook 下一次
    触发就跑这一版，同时编辑器里的草稿也被覆盖成它（理由见 flowstore.rollback）。

    不是 PUT /api/flows/{id}：那条是存草稿，语义完全不同。这里改的是
    "线上跑哪一版"，而且不产生新版本。
    """
    out = _guard(flowstore.rollback, flow_id, version,
                 _actor(request, x_forwarded_user), _viewer(request, x_forwarded_user))
    # 和 GET /api/flows/{id} 同一件事：这个返回也会被前端写进本地缓存
    # （rollbackFlow 拿 draft 重画画布并落 localStorage）。不带 mine 的话，
    # 管理员给**别人的**流程切版本，那份就落进他的本机 —— 又是一张「只在本机」
    out["mine"] = flowstore.owner_visible(out.get("owner"), _actor(request, x_forwarded_user))
    return out


@app.get("/api/flows/{flow_id}/versions")
def flow_versions(
    flow_id: str,
    request: Request,
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    return {"versions": _guard(flowstore.list_versions, flow_id, _viewer(request, x_forwarded_user))}


@app.get("/api/flows/{flow_id}/versions/{version}")
def flow_version(
    flow_id: str,
    version: int,
    request: Request,
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    return _guard(flowstore.get_version, flow_id, version, _viewer(request, x_forwarded_user))


@app.post("/api/flows/{flow_id}/restore")
def restore_flow(
    flow_id: str,
    request: Request,
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """取消归档。归档过的流程在界面上是彻底消失的，却仍占着 id ——
    没有这条路，"删掉了想找回来"和"同名重建"两件事都是死胡同。"""
    return _guard(flowstore.restore, flow_id,
                  _actor(request, x_forwarded_user), _viewer(request, x_forwarded_user))


@app.delete("/api/flows/{flow_id}")
def archive_flow(
    flow_id: str,
    request: Request,
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    _guard(flowstore.archive, flow_id,
           _actor(request, x_forwarded_user), _viewer(request, x_forwarded_user))
    return {"archived": True}


@app.get("/registry/nodes")
def registry() -> Dict[str, Any]:
    return {"nodes": manifest.ALL}


@app.get("/options/{key}")
def options(key: str) -> Dict[str, Any]:
    if key == "sql.engines":
        return {"options": [{"value": e, "label": e} for e in datalego.ENGINES]}
    raise HTTPException(404, f"没有这个选项集：{key}")


@app.post("/nodes/notify.wecom/execute")
def execute_wecom(
    body: SubmitBody,
    idempotency_key: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """同步节点：发一条就返回，不用轮询。调用即真发。

    带 Idempotency-Key 时同 key 24 小时内只真正发一次 ——
    没有它，重试和崩溃恢复都会变成"群里收到三条一样的日报"。
    """
    return _idempotent(idempotency_key, lambda: _do_wecom(body))


def _do_wecom(body: SubmitBody) -> Dict[str, Any]:
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


@app.post("/nodes/http.request/execute")
def execute_http_request(body: SubmitBody) -> Dict[str, Any]:
    """Execute a generic HTTP request on behalf of the workflow."""
    try:
        return {"output": http_request.execute(body.params)}
    except http_request.HttpStatusError as exc:
        raise HTTPException(502, str(exc))
    except http_request.HttpRequestError as exc:
        raise HTTPException(400, str(exc))


@app.post("/nodes/code.python/execute")
def execute_code_python(body: SubmitBody) -> Dict[str, Any]:
    """同步执行一段用户 Python。**故意不走 _idempotent** —— 节点是纯计算
    （policy.idempotent: true），重跑无害，而把最大 10MB 的结果缓存进
    node_idempotency 才是成本（http.request 同理也没走）。重试语义由错误码
    控制：只有 CODE_SANDBOX_UNAVAILABLE 可重试。
    """
    try:
        return {"output": code_python.execute(body.params)}
    except code_python.CodeNodeError as exc:
        raise HTTPException(exc.status, errors.payload(exc.code, str(exc)))


@app.post("/nodes/postgres.workspace/execute")
def execute_postgres_workspace(
    body: SubmitBody,
    request: Request,
    idempotency_key: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """Run one statement in the caller's isolated PostgreSQL workspace."""
    email = identity.creator_for(request)
    if not email:
        raise HTTPException(403, errors.payload("WORKSPACE_IDENTITY", "无法识别登录邮箱，不能使用自建 PostgreSQL 工作区"))

    def run() -> Dict[str, Any]:
        try:
            return {"output": workspace.execute(email, body.params)}
        except workspace.WorkspaceError as exc:
            raise HTTPException(exc.status, errors.payload(exc.code, str(exc)))

    return _idempotent(idempotency_key, run)


@app.post("/nodes/sql.query/submit")
def submit_node(body: SubmitBody, request: Request) -> Dict[str, Any]:
    return _submit(_build_sql(body.params, identity.creator_for(request)))


@app.post("/nodes/sql.query/probe")
def probe_node(body: SubmitBody, request: Request) -> Dict[str, Any]:
    """探测输出结构：跑一行拿 schema，下游变量提示就有真实列名了。"""
    return _submit(_build_sql(body.params, identity.creator_for(request), limit_override=PROBE_LIMIT))


@app.get("/nodes/sql.query/poll")
def poll_node(handle: str, limit: int = 1000) -> Dict[str, Any]:
    _check_handle(handle)
    try:
        result = datalego.poll(_token(), handle)
    except datalego.AuthError:
        robot.invalidate()
        # 必须带错误码：引擎读 detail.code 决定要不要重试，裸字符串等于"认不出"，
        # 而认不出一律不重试 —— 于是一次续票就能好的问题被判成了永久失败
        raise HTTPException(502, errors.payload("PLATFORM_AUTH", "数据平台不接受机器人账号的票，请检查服务端凭证配置"))
    except datalego.ExpiredError as exc:
        raise HTTPException(410, errors.payload("RESULT_EXPIRED", str(exc)))
    except datalego.PlatformTimeout as exc:
        raise HTTPException(504, errors.payload("UPSTREAM_TIMEOUT", str(exc)))
    except datalego.PlatformError as exc:
        # **不能返回 {done:true, failed:true}** —— 那是"查询失败"，会把一个还在
        # 平台上好好跑着的 job 判死。平台抖一下只该让引擎下一轮再来问一次
        raise HTTPException(502, errors.payload("PLATFORM_UNAVAILABLE", str(exc)))
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
        raise HTTPException(400, errors.payload("BAD_REQUEST", str(exc)))
    except Exception as exc:  # 取消失败不该让中止流程本身失败
        return {"cancelled": False, "detail": str(exc)}
    return {"cancelled": True}


# ---------------------------------------------------------------- 运行
#
# 执行本身由 Node worker 做。这里只入队和查询 —— worker 和 api 之间
# 不直接通信，只通过 Postgres。


class RunBody(BaseModel):
    inputs: Dict[str, Any] = Field(default_factory=dict)
    mode: str = "manual"
    triggerKind: str = "manual"
    version: Optional[int] = None


@app.post("/api/flows/{flow_id}/runs")
def create_run(
    flow_id: str,
    body: RunBody,
    request: Request,
    idempotency_key: Optional[str] = Header(default=None),
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    # 先按归属验一道：不是我的流程，"跑一次"和"读一次"一样不该成立。
    # 管理员的视角是"全部"，但下面 actor 传的仍是他本人 —— 快照的 created_by
    # 记的是真的按下运行的那个人，查数也以他的权限去
    _guard(flowstore.get_flow, flow_id, _viewer(request, x_forwarded_user))
    if body.version is not None and body.version <= 0:
        # 负数是调试快照的内部编号。让它可以被指定，等于把一个符号约定
        # 外泄成 API 语义，之后就再也改不动了
        raise HTTPException(400, "version 必须是已发布的版本号（正整数）")
    return _guard(
        runstore.create_run,
        flow_id,
        inputs=body.inputs,
        mode=body.mode,
        trigger_kind=body.triggerKind,
        version=body.version,
        idempotency_key=idempotency_key,
        # 调试快照记在点运行的这个人名下 —— worker 就以他的名义去数据平台查数
        actor=_actor(request, x_forwarded_user),
    )


# 运行记录同样按流程归属过滤。**这一层比流程定义更要紧**：
# steps 里存的是查询结果本身 —— 流程只泄露"我在查什么"，运行记录直接是那些数据。


@app.get("/api/runs")
def list_runs(
    request: Request,
    flowId: Optional[str] = None,
    limit: int = 50,
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    return {"runs": _guard(runstore.list_runs, flowId, limit, _viewer(request, x_forwarded_user))}


@app.get("/api/runs/{run_id}")
def get_run(
    run_id: str,
    request: Request,
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    return _guard(runstore.get_run, run_id, _viewer(request, x_forwarded_user))


@app.get("/api/runs/{run_id}/events")
def run_events(
    run_id: str,
    request: Request,
    fromSeq: int = 0,
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """增量取事件。SSE 的轮询降级版：断线重连带上最后收到的 seq，不丢也不重。"""
    return {"events": _guard(runstore.events_since, run_id, fromSeq, _viewer(request, x_forwarded_user))}


# ---------------------------------------------------------------- 管理员
#
# 管理员身份来自 athena 校验过的 /api/me（identity.is_admin），**不看请求头**。
# 越权返回 403 而不是 404：这里和流程不一样 —— 流程用 404 是为了不泄露"这条 id
# 存在"，而"有没有管理台"本来就不是秘密，含糊其辞只会让人反复试。


def _require_admin(request: Request) -> None:
    if not identity.is_admin(request):
        raise HTTPException(403, "需要管理员权限")


@app.get("/api/admin/usage")
def admin_usage(request: Request, days: int = 30, top: int = 20) -> Dict[str, Any]:
    """用量看板。读的是按天聚合表，不是 runs —— 明细只留 14 天，统计永久。"""
    _require_admin(request)
    return _guard(usage.overview, days, top)


@app.post("/api/runs/{run_id}/cancel")
def cancel_run(
    run_id: str,
    request: Request,
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    return _guard(runstore.request_cancel, run_id, _viewer(request, x_forwarded_user))


# ---------------------------------------------------------------- Webhook
#
# 入口不在 /api 下：认证方式完全不同（token 在路径里 + 密钥在头里，
# 而不是反向代理带进来的 SSO 用户）。


class WebhookSettings(BaseModel):
    authMode: Optional[str] = None
    rateLimitPerMin: Optional[int] = None
    responseMode: Optional[str] = None
    responseTimeoutSeconds: Optional[int] = None
    enabled: Optional[bool] = None


# webhook 面板里回显的是**可直接触发这条流程的密钥**，归属检查一个都不能少。
# 每个入口先 get_flow(viewer) 探一道：不是我的流程 → 404，和不存在同形


@app.get("/api/flows/{flow_id}/webhook")
def get_webhook(
    flow_id: str,
    request: Request,
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    _guard(flowstore.get_flow, flow_id, _viewer(request, x_forwarded_user))
    hook = _guard(webhooks.get, flow_id)
    return {
        "webhook": hook,
        "deliveries": _guard(webhooks.deliveries, flow_id) if hook else [],
        # 没发布的流程 webhook 打过来是 409。面板要提前说，而不是等上游试出来
        "activeVersion": _guard(webhooks.active_version, flow_id),
    }


@app.post("/api/flows/{flow_id}/webhook")
def create_webhook(
    flow_id: str,
    request: Request,
    body: Optional[WebhookSettings] = None,
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """建一个 webhook。管理接口可持续回显密钥，认证仍使用不可逆 hash。

    认证方式和限流上限从画布上那个节点的参数带过来 —— 不带就用默认值。
    """
    _guard(flowstore.get_flow, flow_id, _viewer(request, x_forwarded_user))
    b = body or WebhookSettings()
    return _guard(
        webhooks.ensure,
        flow_id,
        b.authMode if b.authMode is not None else "secret",
        b.rateLimitPerMin if b.rateLimitPerMin is not None else 60,
        b.responseMode if b.responseMode is not None else "lastNode",
        b.responseTimeoutSeconds if b.responseTimeoutSeconds is not None else 300,
    )


@app.put("/api/flows/{flow_id}/webhook")
def update_webhook(
    flow_id: str,
    body: WebhookSettings,
    request: Request,
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """改认证方式 / 限流 / 启停。**改认证方式会让上游当前的调用立刻 401**，
    所以它是一次明确的动作，不跟着流程保存走。"""
    _guard(flowstore.get_flow, flow_id, _viewer(request, x_forwarded_user))
    return _guard(
        webhooks.update,
        flow_id,
        body.authMode,
        body.rateLimitPerMin,
        body.responseMode,
        body.responseTimeoutSeconds,
        body.enabled,
    )


class NotifyConfigBody(BaseModel):
    """失败时通知到哪。webhook 为空 = 关掉。"""
    webhook: Optional[str] = None


@app.get("/api/flows/{flow_id}/notify")
def get_notify(
    flow_id: str,
    request: Request,
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    flow = _guard(flowstore.get_flow, flow_id, _viewer(request, x_forwarded_user))
    return {"notifyConfig": flow.get("notifyConfig")}


@app.put("/api/flows/{flow_id}/notify")
def set_notify(
    flow_id: str,
    body: NotifyConfigBody,
    request: Request,
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """失败告警的入口。**不挂在 PUT /api/flows/{id} 上**：那是编辑器每几秒一次的
    草稿自动保存，body 只有 definition 且不记审计；运维配置不该跟着击键走。"""
    viewer = _viewer(request, x_forwarded_user)
    _guard(flowstore.get_flow, flow_id, viewer)
    config = {"webhook": body.webhook} if body.webhook else None
    return _guard(flowstore.set_notify_config, flow_id, config, _actor(request, x_forwarded_user), viewer)


# ---------------------------------------------------------------- 用户级失败通知
#
# 上面那对是「这条流程发到哪个群」；这一对是「我名下的流程失败了通知我」。
# 分成两个资源而不是给 /notify 加个 scope 参数：它们的**身份来源不一样** ——
# 流程级按 flow_id 鉴权（_guard + _viewer），用户级只认 cookie 解出来的那个人。


def _me_or_403(request: Request, x_forwarded_user: Optional[str]) -> str:
    """这次请求是谁。认不出就 403。

    **绝不接受调用方传 email。** 这一列存的是等同凭证的群机器人地址，
    按参数取行等于谁都能读别人的；而"读到了"这件事在界面上和正常使用没有区别。

    匿名（本地开发没有 cookie）不是一个人，不能有自己的通知设置 ——
    给匿名留一行的话，同一台机器上所有认不出身份的人会共用一个地址。
    """
    email = _actor(request, x_forwarded_user)
    if not email:
        raise HTTPException(403, errors.payload("NOTIFY_IDENTITY", "无法识别登录邮箱，不能设置失败通知"))
    return email


@app.get("/api/me/notify")
def get_my_notify(
    request: Request,
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    email = _me_or_403(request, x_forwarded_user)
    return {"notifyConfig": _guard(flowstore.get_user_notify, email)}


@app.put("/api/me/notify")
def set_my_notify(
    body: NotifyConfigBody,
    request: Request,
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """我名下所有流程失败时通知到哪。webhook 为空 = 关掉。

    流程自己配了地址的话，**以流程的为准**（合并在 worker/alerts.ts）——
    语义是"这条关键流程单独发到值班群，其余都进我的个人群"。
    """
    email = _me_or_403(request, x_forwarded_user)
    return _guard(flowstore.set_user_notify, email, body.webhook, email)


@app.post("/api/flows/{flow_id}/webhook/rotate")
def rotate_webhook(
    flow_id: str,
    request: Request,
    x_forwarded_user: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    _guard(flowstore.get_flow, flow_id, _viewer(request, x_forwarded_user))
    return _guard(webhooks.rotate, flow_id)


@app.post("/hooks/{token}")
async def trigger_webhook(token: str, request: Request) -> Response:
    """上游系统打的就是这个。

    **读 raw body 而不是让 FastAPI 解析** —— HMAC 必须对原始字节算签名，
    parse 后重新序列化会因为 key 顺序和空格差异导致签名对不上。
    """
    raw = await request.body()
    ip = request.client.host if request.client else None
    try:
        # 同步响应会按 Webhook 配置等待，放进线程池，不能阻塞 FastAPI 的事件循环。
        status, body = await run_in_threadpool(webhooks.handle, token, raw, dict(request.headers), ip)
    except webhooks.WebhookError as exc:
        return JSONResponse({"error": str(exc)}, status_code=exc.status)
    except db.DbUnavailable as exc:
        return JSONResponse({"error": str(exc)}, status_code=503)
    except (runstore.NotFound, runstore.NotPublished) as exc:
        return JSONResponse({"error": str(exc)}, status_code=409)
    return JSONResponse(body, status_code=status)
