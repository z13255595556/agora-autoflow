"""用量看板。**只读 usage_daily，不读 runs。**

运行明细只留 14 天，而「今年一共跑了多少次」这类问题不该跟着一起消失。
worker 每小时把最近若干天汇总进 usage_daily（见 worker/store.ts 的 rollUpUsage），
这里只负责把那张表按几个维度切开。

不从 runs 现算的理由不只是性能：那样看板的时间范围会被保留期悄悄封顶，
而界面上不会有任何迹象 —— 用户会以为「三个月前确实没人用」。
"""
from typing import Any, Dict, List, Optional

from . import db


def _rows(conn, sql: str, args=()) -> List[Dict[str, Any]]:
    cur = conn.execute(sql, args)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


# 看板一次最多切多少天。放开到任意值的话，一个 ?days=100000 就是一次全表扫描
MAX_DAYS = 365


def _avg_ms(duration_ms: Optional[int], timed: Optional[int]) -> Optional[int]:
    """均值在**读的时候**才算。存的是总和 —— 均值不可加，先平均再合并是另一个数。"""
    return round(duration_ms / timed) if duration_ms and timed else None


def overview(days: int = 30, top: int = 20) -> Dict[str, Any]:
    """用量总览。days 从今天往回数（含今天）。"""
    days = max(1, min(days, MAX_DAYS))
    top = max(1, min(top, 100))
    since = f"CURRENT_DATE - {days - 1}"

    with db.pool().connection() as conn:
        total = _rows(
            conn,
            "SELECT COALESCE(sum(runs),0) AS runs, COALESCE(sum(succeeded),0) AS succeeded,"
            "       COALESCE(sum(failed),0) AS failed, COALESCE(sum(canceled),0) AS canceled,"
            "       COALESCE(sum(steps),0) AS steps,"
            "       COALESCE(sum(duration_ms),0) AS duration_ms, COALESCE(sum(timed_runs),0) AS timed_runs,"
            "       count(DISTINCT flow_id) AS flows, count(DISTINCT owner) AS owners"
            "  FROM usage_daily WHERE day >= " + since,
        )[0]

        by_day = _rows(
            conn,
            "SELECT day, sum(runs) AS runs, sum(succeeded) AS succeeded, sum(failed) AS failed"
            "  FROM usage_daily WHERE day >= " + since + " GROUP BY day ORDER BY day",
        )

        by_flow = _rows(
            conn,
            "SELECT flow_id, max(flow_name) AS flow_name, max(owner) AS owner,"
            "       sum(runs) AS runs, sum(succeeded) AS succeeded, sum(failed) AS failed,"
            "       sum(duration_ms) AS duration_ms, sum(timed_runs) AS timed_runs"
            "  FROM usage_daily WHERE day >= " + since
            + " GROUP BY flow_id ORDER BY sum(runs) DESC LIMIT %s",
            (top,),
        )

        by_owner = _rows(
            conn,
            "SELECT owner, sum(runs) AS runs, count(DISTINCT flow_id) AS flows,"
            "       sum(failed) AS failed"
            "  FROM usage_daily WHERE day >= " + since
            + " GROUP BY owner ORDER BY sum(runs) DESC LIMIT %s",
            (top,),
        )

        by_trigger = _rows(
            conn,
            "SELECT trigger_kind, sum(runs) AS runs"
            "  FROM usage_daily WHERE day >= " + since
            + " GROUP BY trigger_kind ORDER BY sum(runs) DESC",
        )

        # 统计从哪天开始有数。看板上要写出来 —— 否则「最近 365 天」在一个
        # 上线两周的系统上会让人以为前面 351 天真的没人用
        first = _rows(conn, "SELECT min(day) AS day FROM usage_daily")[0]["day"]

    return {
        "days": days,
        "since": (str(first) if first else None),
        "totals": {
            "runs": int(total["runs"]),
            "succeeded": int(total["succeeded"]),
            "failed": int(total["failed"]),
            "canceled": int(total["canceled"]),
            "steps": int(total["steps"]),
            "flows": int(total["flows"]),
            "owners": int(total["owners"]),
            "avgDurationMs": _avg_ms(int(total["duration_ms"]), int(total["timed_runs"])),
        },
        "byDay": [
            {"day": str(r["day"]), "runs": int(r["runs"]),
             "succeeded": int(r["succeeded"]), "failed": int(r["failed"])}
            for r in by_day
        ],
        "byFlow": [
            {"flowId": r["flow_id"], "flowName": r["flow_name"], "owner": r["owner"],
             "runs": int(r["runs"]), "succeeded": int(r["succeeded"]), "failed": int(r["failed"]),
             "avgDurationMs": _avg_ms(int(r["duration_ms"]), int(r["timed_runs"]))}
            for r in by_flow
        ],
        "byOwner": [
            {"owner": r["owner"], "runs": int(r["runs"]),
             "flows": int(r["flows"]), "failed": int(r["failed"])}
            for r in by_owner
        ],
        "byTrigger": [
            {"triggerKind": r["trigger_kind"], "runs": int(r["runs"])} for r in by_trigger
        ],
    }
