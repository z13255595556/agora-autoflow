"""datalego 查询客户端。

只做三件事：提交、轮询、取消。**不在服务端阻塞等结果** —— Hive 慢查询会跑
几分钟，同步等待必然撞网关超时，而且每个慢查询占住一个 worker。工作流引擎
自己拿 job_id 轮询，每次 HTTP 往返都在秒级。

判完成看 schema 不看进度：进度不是单调的，多阶段任务会走到 100 再掉回去重爬。
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


class QueryError(RuntimeError):
    """查询本身失败（语法错、表不存在、被 kill）。"""


class AuthError(RuntimeError):
    """平台不认这张票，或这个账号没权限。服务端配置问题，不是用户能解决的。"""


class ExpiredError(QueryError):
    """job 在平台上找不到了 —— 结果被清理是正常现象，不是故障。"""


def endpoint() -> str:
    return os.getenv("DATALEGO_ENDPOINT", ENDPOINT_DEFAULT).rstrip("/")


def _headers(token: str) -> Dict[str, str]:
    return {"Content-Type": "application/json", "accessToken": token}


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


def submit(token: str, sql: str, engine: str = "hive",
           creator: Optional[str] = None, queue: str = "share") -> str:
    """提交 SQL，秒级返回 job_id。不等结果。"""
    if engine not in ENGINES:
        raise QueryError(f"不支持的引擎 {engine!r}，可选：{'、'.join(ENGINES)}")
    resp = requests.post(
        f"{endpoint()}/datainsight/job/trigger",
        headers=_headers(token),
        params={"creator": creator} if creator else {},
        json={"engine": engine, "sql": sql, "queue": queue},
        timeout=HTTP_TIMEOUT,
    )
    _check_auth(resp)
    resp.raise_for_status()
    job_id = (resp.json() or {}).get("id")
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

    resp = requests.get(
        f"{endpoint()}/datainsight/jobs/{job_id}/status",
        headers=_headers(token),
        timeout=HTTP_TIMEOUT,
    )
    _check_auth(resp)
    if resp.status_code in (400, 404):
        raise ExpiredError("查询结果已不在数据平台上（可能已过期或被清理）")
    resp.raise_for_status()
    result = resp.json() or {}

    status = str(result.get("status") or "").lower()
    if status in FAILED_STATUSES:
        raise QueryError(result.get("error") or f"任务状态 {status}")

    # progress 是 0-100 浮点（实测会返回 85.013824 这种值），且不单调 ——
    # 多阶段任务会走到 100 再掉回去。所以完成的判据是 schema 不为 None。
    progress = float(result.get("progress") or 0)
    meta = {"sql": result.get("sql"), "created_at": result.get("createdAt"), "status": status}

    schema = result.get("schema")
    if progress < 100 or schema is None:
        return {"done": False, "progress": progress, "columns": [], "rows": [], **meta}

    columns = [{"name": c["name"], "type": c.get("type")} for c in schema]
    names = [c["name"] for c in columns]
    rows: List[Dict[str, Any]] = [dict(zip(names, row)) for row in (result.get("data") or [])]
    return {"done": True, "progress": 100.0, "columns": columns, "rows": rows, **meta}


def cancel(token: str, job_id: str) -> None:
    """撤掉任务。流程被中止时必须调 —— 不撤的话 Hive 那边继续白烧集群资源。"""
    if not JOB_ID_RE.match(job_id):
        raise QueryError(f"非法的 job_id: {job_id!r}")
    requests.put(
        f"{endpoint()}/datainsight/jobs/{job_id}/cancel",
        headers={"accessToken": token},
        timeout=10,
    )
