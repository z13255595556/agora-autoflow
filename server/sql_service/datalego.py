"""datalego 查询客户端。

只做三件事：提交、轮询、取消。**不在服务端阻塞等结果** —— Hive 慢查询会跑
几分钟，同步等待必然撞网关超时，而且每个慢查询占住一个 worker。工作流引擎
自己拿 job_id 轮询，每次 HTTP 往返都在秒级。

判完成看 schema 不看进度：进度不是单调的，多阶段任务会走到 100 再掉回去重爬。

**平台坏了和 SQL 写错必须分开抛。** 这个模块里没有一条出网调用允许把
requests 的原始异常漏出去 —— 理由见 PlatformError。
"""
import os
import re
from typing import Any, Dict, List, Optional

import requests

ENDPOINT_DEFAULT = "https://datalego.agoralab.co/api/v1"

HTTP_TIMEOUT = 30
JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
FAILED_STATUSES = {"failed", "error", "cancel", "canceled", "cancelled", "killed", "aborted"}

ENGINES = ("hive", "doris", "clickhouse")

# 上游原文带回去多少字。够看出"这是个 nginx 502 页"或"这是登录页"就行
SNIPPET_CHARS = 200


class QueryError(RuntimeError):
    """查询本身失败（语法错、表不存在、被 kill）。"""


class AuthError(RuntimeError):
    """平台不认这张票，或这个账号没权限。服务端配置问题，不是用户能解决的。"""


class ExpiredError(QueryError):
    """job 在平台上找不到了 —— 结果被清理是正常现象，不是故障。"""


class PlatformError(RuntimeError):
    """数据平台这一侧坏了：5xx、连不上、返回的不是 JSON。**等一会儿可能就好。**

    以前没有这一类，requests 的异常直接从这个模块漏出去。FastAPI 兜底回一个
    text/plain 的 "Internal Server Error"，引擎那头第一件事是 JSON.parse 它，
    于是节点上显示的错误是

        Unexpected token 'I', "Internal S"... is not valid JSON

    两个信息一起丢了：既看不出是平台挂了还是自己 SQL 写错了，也丢掉了"这次
    可以重试"—— 引擎按错误码判重试，而纯文本 500 里根本没有错误码，认不出的
    一律当作不可重试，于是一次平台抖动被判成永久失败。
    """


class PlatformTimeout(PlatformError):
    """等平台响应超时。单独一类只为让上层回 504/UPSTREAM_TIMEOUT 而不是 502。"""


def endpoint() -> str:
    return os.getenv("DATALEGO_ENDPOINT", ENDPOINT_DEFAULT).rstrip("/")


def _headers(token: str) -> Dict[str, str]:
    return {"Content-Type": "application/json", "accessToken": token}


def _snippet(resp: Any) -> str:
    """上游响应体截一段。空的也要说出来 —— "(空响应)" 和一段 HTML 是不同的线索。"""
    text = " ".join((getattr(resp, "text", "") or "").split())
    return text[:SNIPPET_CHARS] if text else "(空响应)"


def _request(method: str, url: str, **kw: Any) -> Any:
    """所有出网请求的唯一出口。连不上、超时一律转成 PlatformError。"""
    try:
        return getattr(requests, method)(url, **kw)
    except requests.Timeout as exc:
        raise PlatformTimeout(
            f"等数据平台响应超过 {kw.get('timeout', HTTP_TIMEOUT)} 秒：{exc}"
        )
    except requests.RequestException as exc:
        raise PlatformError(f"连不上数据平台（{endpoint()}）：{exc}")


def _check_auth(resp: requests.Response) -> None:
    if resp.status_code in (401, 403):
        # 把上游原话带出来 —— "token has expired" 和 "无权限" 是两件事，
        # 吞掉就没法排查了
        detail = ""
        try:
            detail = (resp.json() or {}).get("message") or ""
        except ValueError:
            detail = resp.text[:120]
        raise AuthError(f"数据平台拒绝了这次请求（HTTP {resp.status_code}）"
                        + (f"：{detail}" if detail else ""))
    # SSO 网关常见行为：票失效时 302 到登录页而不是返回 401
    if resp.status_code in (302, 303) and "oauth" in resp.headers.get("location", "").lower():
        raise AuthError("数据平台把请求重定向到了登录页，说明这张票没被接受")


def _json(resp: Any, what: str) -> Dict[str, Any]:
    """取 JSON 响应体。**5xx 和非 JSON 都归平台故障** —— 都不是改 SQL 能解决的。

    非 JSON 单独判而不是让它冒成 ValueError：SSO 网关票过期时会回一个 HTTP 200
    的登录页，那时状态码是好的、body 是 HTML，只有这里能看出来。
    """
    if resp.status_code >= 500:
        raise PlatformError(
            f"数据平台{what}失败（HTTP {resp.status_code}）：{_snippet(resp)}"
        )
    try:
        data = resp.json()
    except ValueError:
        raise PlatformError(
            f"数据平台{what}返回的不是 JSON（HTTP {resp.status_code}）：{_snippet(resp)}"
        )
    if data is None:
        return {}
    if not isinstance(data, dict):
        # 是 JSON 但不是对象。往下每一处都是 result.get(...)，放过去就是
        # 一个 AttributeError 冒成 500 —— 那又回到了纯文本错误体那条老路
        raise PlatformError(
            f"数据平台{what}返回的不是对象（{type(data).__name__}）：{_snippet(resp)}"
        )
    return data


def submit(token: str, sql: str, engine: str = "hive",
           creator: Optional[str] = None, queue: str = "share") -> str:
    """提交 SQL，秒级返回 job_id。不等结果。"""
    if engine not in ENGINES:
        raise QueryError(f"不支持的引擎 {engine!r}，可选：{'、'.join(ENGINES)}")
    resp = _request(
        "post",
        f"{endpoint()}/datainsight/job/trigger",
        headers=_headers(token),
        params={"creator": creator} if creator else {},
        json={"engine": engine, "sql": sql, "queue": queue},
        timeout=HTTP_TIMEOUT,
    )
    _check_auth(resp)
    result = _json(resp, "提交查询")
    if not resp.ok:
        # 4xx：平台看了这条 SQL 之后拒绝的（语法、库表、队列）—— 用户能改
        raise QueryError(
            f"数据平台拒绝了这条查询（HTTP {resp.status_code}）："
            + (result.get("message") or result.get("error") or _snippet(resp))
        )
    job_id = result.get("id")
    if not job_id:
        raise QueryError(f"平台返回里没有 job id：{resp.text[:200]}")
    return str(job_id)


def poll(token: str, job_id: str) -> Dict[str, Any]:
    """查一次状态。

    返回 {done, progress, columns, rows, sql, created_at}。
    done=False 时 columns/rows 为空，由调用方决定什么时候再来一次。
    """
    if not JOB_ID_RE.match(job_id):
        # job_id 会拼进 URL 路径，格式不对直接拒
        raise QueryError(f"非法的 job_id: {job_id!r}")

    resp = _request(
        "get",
        f"{endpoint()}/datainsight/jobs/{job_id}/status",
        headers=_headers(token),
        timeout=HTTP_TIMEOUT,
    )
    _check_auth(resp)
    if resp.status_code in (400, 404):
        raise ExpiredError("查询结果已不在数据平台上（可能已过期或被清理）")
    result = _json(resp, "查询状态")
    if not resp.ok:
        # 剩下的 4xx（429 之类）都不是这条 SQL 的问题，归平台侧
        raise PlatformError(
            f"数据平台查询状态失败（HTTP {resp.status_code}）：{_snippet(resp)}"
        )

    status = str(result.get("status") or "").lower()
    if status in FAILED_STATUSES:
        raise QueryError(result.get("error") or f"任务状态 {status}")

    # progress 是 0-100 浮点（实测会返回 85.013824 这种值），且不单调 ——
    # 多阶段任务会走到 100 再掉回去。所以完成的判据是 schema 不为 None。
    try:
        progress = float(result.get("progress") or 0)
    except (TypeError, ValueError):
        # 进度读不出来只影响进度条，不该让整条查询失败 —— 当作 0 继续轮询，
        # 完成与否本来就不看它
        progress = 0.0
    meta = {"sql": result.get("sql"), "created_at": result.get("createdAt"), "status": status}

    schema = result.get("schema")
    if progress < 100 or schema is None:
        return {"done": False, "progress": progress, "columns": [], "rows": [], **meta}

    # 平台换了结果结构（列表变字典、少个 name）时给一句能定位的话，
    # 而不是让 KeyError/TypeError 冒成 500
    try:
        columns = [{"name": c["name"], "type": c.get("type")} for c in schema]
        names = [c["name"] for c in columns]
        rows: List[Dict[str, Any]] = [dict(zip(names, row)) for row in (result.get("data") or [])]
    except (TypeError, KeyError, IndexError) as exc:
        raise PlatformError(f"看不懂数据平台返回的结果结构（{type(exc).__name__}: {exc}）")
    return {"done": True, "progress": 100.0, "columns": columns, "rows": rows, **meta}


def cancel(token: str, job_id: str) -> None:
    """撤掉任务。流程被中止时必须调 —— 不撤的话 Hive 那边继续白烧集群资源。"""
    if not JOB_ID_RE.match(job_id):
        raise QueryError(f"非法的 job_id: {job_id!r}")
    _request(
        "put",
        f"{endpoint()}/datainsight/jobs/{job_id}/cancel",
        headers={"accessToken": token},
        timeout=10,
    )
