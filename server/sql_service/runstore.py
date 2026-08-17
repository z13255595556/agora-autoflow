"""运行的读写。执行本身由 Node worker 做，这里只负责入队和查询。

worker 和 api 之间不直接通信，只通过 Postgres —— 这样 worker 可以随时重启、
可以起多个、崩了也不会让 api 跟着挂。
"""
import json
import secrets
from typing import Any, Dict, List, Optional

from psycopg.types.json import Jsonb

from . import db, flowstore


class NotFound(LookupError):
    pass


class NotPublished(RuntimeError):
    pass


def _rows(conn, sql: str, args=()) -> List[Dict[str, Any]]:
    cur = conn.execute(sql, args)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def _one(conn, sql: str, args=()) -> Optional[Dict[str, Any]]:
    got = _rows(conn, sql, args)
    return got[0] if got else None


def new_run_id() -> str:
    return f"run_{secrets.token_hex(6)}"


def create_run(
    flow_id: str,
    *,
    inputs: Dict[str, Any],
    mode: str = "manual",
    trigger_kind: str = "manual",
    version: Optional[int] = None,
    idempotency_key: Optional[str] = None,
) -> Dict[str, Any]:
    """入队一条运行。**不执行** —— worker 会来认领。

    version 不传时取已发布的那一版。**手动调试可以跑草稿，定时和 webhook 不行**
    —— 草稿改坏了不该影响线上，这是 flows.active_version 存在的全部理由。
    """
    with db.pool().connection() as conn:
        flow = _one(conn, "SELECT active_version, draft, archived_at FROM flows WHERE id = %s", (flow_id,))
        if not flow:
            raise NotFound(f"流程 {flow_id} 不存在")

        v = version if version is not None else flow["active_version"]
        if v is None:
            if trigger_kind != "manual":
                raise NotPublished(f"流程 {flow_id} 尚未发布，{trigger_kind} 触发只跑已发布的版本")
            # 手动跑草稿：临时发一版，否则 runs.flow_version 没有可指向的快照，
            # 而"运行记录钉住当时那份定义"这条不能为了方便就破例
            flowstore.publish(flow_id, None)
            v = _one(conn, "SELECT active_version FROM flows WHERE id = %s", (flow_id,))["active_version"]

        if idempotency_key:
            existing = _one(
                conn,
                "SELECT id, status FROM runs WHERE flow_id = %s AND idempotency_key = %s",
                (flow_id, idempotency_key),
            )
            if existing:
                return {"runId": existing["id"], "status": existing["status"], "deduplicated": True}

        run_id = new_run_id()
        conn.execute(
            "INSERT INTO runs (id, flow_id, flow_version, mode, trigger_kind, trigger_input, idempotency_key)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s)",
            (run_id, flow_id, v, mode, trigger_kind, Jsonb(inputs), idempotency_key),
        )
        conn.execute(
            "INSERT INTO run_events (run_id, seq, type, payload) VALUES (%s, 1, 'run.queued', %s)",
            (run_id, Jsonb({"triggerKind": trigger_kind, "mode": mode})),
        )
        conn.commit()
    return {"runId": run_id, "status": "queued", "flowVersion": v}


def _run_json(r: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": r["id"],
        "flowId": r["flow_id"],
        "flowVersion": r["flow_version"],
        "status": r["status"],
        "mode": r["mode"],
        "triggerKind": r["trigger_kind"],
        "triggerInput": r["trigger_input"],
        "scheduledTime": r["scheduled_time"].isoformat() if r.get("scheduled_time") else None,
        "createdAt": r["created_at"].isoformat(),
        "startedAt": r["started_at"].isoformat() if r.get("started_at") else None,
        "finishedAt": r["finished_at"].isoformat() if r.get("finished_at") else None,
        "error": r.get("error"),
        "attempt": r.get("attempt", 0),
    }


def _assert_visible(conn, run_id: str, viewer: Optional[str]) -> None:
    """这条运行记录当前用户看得见吗 —— 看的是它所属流程的归属。

    看不见和不存在给同一个 404，和流程那边同一个理由（见 flowstore.VISIBLE）。
    """
    if viewer is flowstore.ANY:
        return
    sql = ("SELECT r.id FROM runs r JOIN flows f ON f.id = r.flow_id"
           " WHERE r.id = %s AND " + flowstore.VISIBLE)
    if not _one(conn, sql, (run_id, viewer)):
        raise NotFound(f"运行 {run_id} 不存在")


def list_runs(flow_id: Optional[str] = None, limit: int = 50,
              viewer: Optional[str] = None) -> List[Dict[str, Any]]:
    """运行记录列表。**按流程归属过滤** —— steps 里装的是查询结果本身，
    比流程定义更敏感：流程只泄露"我在查什么"，运行记录直接是那些数据。"""
    with db.pool().connection() as conn:
        rows = _rows(
            conn,
            "SELECT r.* FROM runs r JOIN flows f ON f.id = r.flow_id"
            " WHERE " + flowstore.VISIBLE
            + (" AND r.flow_id = %s" if flow_id else "")
            + " ORDER BY r.created_at DESC LIMIT " + str(max(1, min(limit, 200))),
            (viewer, flow_id) if flow_id else (viewer,),
        )
    return [_run_json(r) for r in rows]


def get_run(run_id: str, viewer: Optional[str] = flowstore.ANY) -> Dict[str, Any]:
    """一次运行的完整状态：run 行 + 全部 steps。

    steps 是执行状态的**当前真相**（decide 读它算下一步）；
    事件流是"发生过什么"，给 SSE 和事后回放用。两者职责不同，都要有。
    """
    with db.pool().connection() as conn:
        _assert_visible(conn, run_id, viewer)
        r = _one(conn, "SELECT * FROM runs WHERE id = %s", (run_id,))
        if not r:
            raise NotFound(f"运行 {run_id} 不存在")
        steps = _rows(
            conn,
            "SELECT node_id, loop_path, status, attempt, input, output, error, failure_kind,"
            "       wait_kind, matched, fanout, progress, skip_reason, seq,"
            "       started_at, finished_at"
            "  FROM steps WHERE run_id = %s ORDER BY seq",
            (run_id,),
        )
    out = _run_json(r)
    out["steps"] = [
        {
            "nodeId": s["node_id"],
            "loopPath": s["loop_path"],
            "status": s["status"],
            "attempt": s["attempt"],
            "input": s["input"],
            "output": s["output"],
            "error": s["error"],
            "failureKind": s["failure_kind"],
            "waitKind": s["wait_kind"],
            "matched": s["matched"],
            "fanout": s["fanout"],
            # handle 是内部断点，不外泄；只说有没有在等平台
            "hasHandle": bool((s["progress"] or {}).get("handle")),
            "skipReason": s["skip_reason"],
            "seq": s["seq"],
            "startedAt": s["started_at"].isoformat() if s["started_at"] else None,
            "finishedAt": s["finished_at"].isoformat() if s["finished_at"] else None,
        }
        for s in steps
    ]
    return out


def events_since(run_id: str, from_seq: int = 0, viewer: Optional[str] = flowstore.ANY) -> List[Dict[str, Any]]:
    """增量取事件。SSE 断线重连时带上最后收到的 seq，不丢也不重。"""
    with db.pool().connection() as conn:
        _assert_visible(conn, run_id, viewer)
        rows = _rows(
            conn,
            "SELECT seq, ts, type, node_id, loop_path, payload FROM run_events"
            " WHERE run_id = %s AND seq > %s ORDER BY seq",
            (run_id, from_seq),
        )
    return [
        {
            "seq": r["seq"],
            "ts": r["ts"].isoformat(),
            "type": r["type"],
            "nodeId": r["node_id"],
            "loopPath": r["loop_path"],
            "payload": r["payload"],
        }
        for r in rows
    ]


def request_cancel(run_id: str, viewer: Optional[str] = flowstore.ANY) -> Dict[str, Any]:
    """请求取消。**不直接改成 canceled** —— 正在跑的节点要先撤掉。

    worker 下一轮 decide 会看到 cancel_requested_at，把在跑的 http-async
    任务 cancel 掉（不撤的话平台那边继续跑完，白烧集群资源），
    然后才收尾。取消是一个过程，不是一个瞬间。
    """
    with db.pool().connection() as conn:
        _assert_visible(conn, run_id, viewer)
        r = _one(conn, "SELECT status FROM runs WHERE id = %s", (run_id,))
        if not r:
            raise NotFound(f"运行 {run_id} 不存在")
        if r["status"] in ("success", "error", "canceled"):
            return {"status": r["status"], "alreadyFinished": True}
        conn.execute(
            "UPDATE runs SET cancel_requested_at = COALESCE(cancel_requested_at, now()),"
            "  status = CASE WHEN status = 'queued' THEN 'canceling' ELSE status END"
            " WHERE id = %s",
            (run_id,),
        )
        conn.execute(
            "INSERT INTO run_events (run_id, seq, type, payload)"
            " VALUES (%s, (SELECT COALESCE(MAX(seq),0)+1 FROM run_events WHERE run_id=%s),"
            "         'run.cancel_requested', '{}'::jsonb)",
            (run_id, run_id),
        )
        conn.commit()
    return {"status": "canceling"}
