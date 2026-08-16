"""流程的读写。薄薄一层 SQL —— 真正的规则在 flowdef.py（纯函数，可脱库测试）。"""
import json
from typing import Any, Dict, List, Optional

from psycopg.types.json import Jsonb

from . import db, flowdef


class NotFound(LookupError):
    pass


class FlowArchived(RuntimeError):
    pass


def _rows(conn, sql: str, args=()) -> List[Dict[str, Any]]:
    cur = conn.execute(sql, args)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def _one(conn, sql: str, args=()) -> Optional[Dict[str, Any]]:
    got = _rows(conn, sql, args)
    return got[0] if got else None


def _audit(conn, actor: Optional[str], action: str, target_id: str, detail: Any = None) -> None:
    conn.execute(
        "INSERT INTO audit (actor, action, target_type, target_id, detail)"
        " VALUES (%s, %s, 'flow', %s, %s)",
        (actor, action, target_id, Jsonb(detail) if detail else None),
    )


def _summary(row: Dict[str, Any]) -> Dict[str, Any]:
    draft = row["draft"]
    published = row.get("published_definition")
    return {
        "id": row["id"],
        "name": row["name"],
        "activeVersion": row["active_version"],
        "updatedAt": row["updated_at"].isoformat() if row.get("updated_at") else None,
        "archivedAt": row["archived_at"].isoformat() if row.get("archived_at") else None,
        "nodeCount": len(draft.get("nodes") or []),
        "nodeTypes": flowdef.node_types(draft),
        "triggerKind": (draft.get("trigger") or {}).get("kind", "manual"),
        # 「草稿和线上不一致」：定时和 webhook 跑的是已发布那一版，
        # 改了不发布线上不会变 —— 这件事必须能在列表页看见，否则
        # "我明明改了怎么没生效" 是一定会发生的
        "hasUnpublishedChanges": (
            row["active_version"] is not None and published is not None and _differs(draft, published)
        ),
    }


def _differs(draft: Any, published: Any) -> bool:
    # 只比逻辑，不比布局：拖了一下节点位置不该显示成"有未发布的改动"
    def logic(d: Any) -> str:
        rest = {k: v for k, v in (d or {}).items() if k not in {"layout", "version"}}
        return json.dumps(rest, ensure_ascii=False, sort_keys=True)

    return logic(draft) != logic(published)


def list_flows(include_archived: bool = False) -> List[Dict[str, Any]]:
    with db.pool().connection() as conn:
        rows = _rows(
            conn,
            "SELECT f.id, f.name, f.draft, f.active_version, f.updated_at, f.archived_at,"
            "       v.definition AS published_definition"
            "  FROM flows f"
            "  LEFT JOIN flow_versions v"
            "    ON v.flow_id = f.id AND v.version = f.active_version"
            + ("" if include_archived else " WHERE f.archived_at IS NULL")
            + " ORDER BY f.updated_at DESC",
        )
    return [_summary(r) for r in rows]


def get_flow(flow_id: str) -> Dict[str, Any]:
    with db.pool().connection() as conn:
        row = _one(
            conn,
            "SELECT f.id, f.name, f.draft, f.active_version, f.updated_at, f.archived_at,"
            "       v.definition AS published_definition"
            "  FROM flows f"
            "  LEFT JOIN flow_versions v"
            "    ON v.flow_id = f.id AND v.version = f.active_version"
            " WHERE f.id = %s",
            (flow_id,),
        )
    if not row:
        raise NotFound(f"流程 {flow_id} 不存在")
    out = _summary(row)
    out["draft"] = row["draft"]
    return out


def create_flow(flow_id: str, definition: Any, actor: Optional[str]) -> Dict[str, Any]:
    # 版本 0 = 还没发布过。发布后才有 1
    draft = flowdef.for_storage(definition, flow_id, 0)
    with db.pool().connection() as conn:
        exists = _one(conn, "SELECT id FROM flows WHERE id = %s", (flow_id,))
        if exists:
            raise FileExistsError(f"流程 {flow_id} 已存在")
        conn.execute(
            "INSERT INTO flows (id, name, draft) VALUES (%s, %s, %s)",
            (flow_id, draft["name"], Jsonb(draft)),
        )
        _audit(conn, actor, "flow.create", flow_id, {"name": draft["name"]})
        conn.commit()
    return get_flow(flow_id)


def save_draft(flow_id: str, definition: Any, actor: Optional[str]) -> Dict[str, Any]:
    """存草稿。**不产生版本** —— 发布才产生。

    编辑器防抖自动保存打的就是这个接口，几秒一次；每次都记一条审计会把
    audit 表变成击键日志，所以这里不写审计（发布才写）。
    """
    with db.pool().connection() as conn:
        row = _one(conn, "SELECT active_version FROM flows WHERE id = %s", (flow_id,))
        if not row:
            raise NotFound(f"流程 {flow_id} 不存在")
        draft = flowdef.for_storage(definition, flow_id, row["active_version"] or 0)
        conn.execute(
            "UPDATE flows SET draft = %s, name = %s, updated_at = now() WHERE id = %s",
            (Jsonb(draft), draft["name"], flow_id),
        )
        conn.commit()
    return get_flow(flow_id)


def publish(flow_id: str, actor: Optional[str]) -> Dict[str, Any]:
    """草稿 → 新版本 → 设为生效。整件事在一个事务里。

    分两次提交的话，中间崩溃会留下一个"版本写进去了但没生效"或者更糟的
    "active_version 指向一个不存在的版本"——后者会让所有触发都取不到定义。
    """
    with db.pool().connection() as conn:
        row = _one(conn, "SELECT draft, archived_at FROM flows WHERE id = %s FOR UPDATE", (flow_id,))
        if not row:
            raise NotFound(f"流程 {flow_id} 不存在")
        if row["archived_at"] is not None:
            raise FlowArchived(f"流程 {flow_id} 已归档，不能发布")

        nxt = _one(
            conn,
            "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM flow_versions WHERE flow_id = %s",
            (flow_id,),
        )["v"]
        definition = flowdef.for_storage(row["draft"], flow_id, nxt)
        conn.execute(
            "INSERT INTO flow_versions (flow_id, version, definition, created_by)"
            " VALUES (%s, %s, %s, %s)",
            (flow_id, nxt, Jsonb(definition), actor),
        )
        # 草稿也跟着更新版本号，这样导出的草稿能看出它对应第几版
        conn.execute(
            "UPDATE flows SET active_version = %s, draft = %s, updated_at = now() WHERE id = %s",
            (nxt, Jsonb(definition), flow_id),
        )
        _audit(conn, actor, "flow.publish", flow_id, {"version": nxt})
        conn.commit()
    return get_flow(flow_id)


def list_versions(flow_id: str) -> List[Dict[str, Any]]:
    with db.pool().connection() as conn:
        if not _one(conn, "SELECT id FROM flows WHERE id = %s", (flow_id,)):
            raise NotFound(f"流程 {flow_id} 不存在")
        rows = _rows(
            conn,
            "SELECT version, created_at, created_by FROM flow_versions"
            " WHERE flow_id = %s ORDER BY version DESC",
            (flow_id,),
        )
    return [
        {
            "version": r["version"],
            "createdAt": r["created_at"].isoformat(),
            "createdBy": r["created_by"],
        }
        for r in rows
    ]


def get_version(flow_id: str, version: int) -> Dict[str, Any]:
    """取某一版的定义快照。

    运行记录必须读这里（按 runs.flow_version），**不能读 active_version** ——
    否则流程一改，历史运行记录就再也解释不通了。
    """
    with db.pool().connection() as conn:
        row = _one(
            conn,
            "SELECT definition, created_at, created_by FROM flow_versions"
            " WHERE flow_id = %s AND version = %s",
            (flow_id, version),
        )
    if not row:
        raise NotFound(f"流程 {flow_id} 没有第 {version} 版")
    return {
        "version": version,
        "definition": row["definition"],
        "createdAt": row["created_at"].isoformat(),
        "createdBy": row["created_by"],
    }


def archive(flow_id: str, actor: Optional[str]) -> None:
    """归档，不物理删。

    运行记录会指向流程版本，删掉之后历史就没法解释了 —— 而"这条流程为什么
    昨天发了那个数"恰恰是最常被问到的问题。
    """
    with db.pool().connection() as conn:
        if not _one(conn, "SELECT id FROM flows WHERE id = %s", (flow_id,)):
            raise NotFound(f"流程 {flow_id} 不存在")
        conn.execute("UPDATE flows SET archived_at = now() WHERE id = %s AND archived_at IS NULL", (flow_id,))
        _audit(conn, actor, "flow.archive", flow_id)
        conn.commit()
