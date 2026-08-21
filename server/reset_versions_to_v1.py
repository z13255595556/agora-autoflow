"""版本号归零：每条已发布的流程重新从 v1 开始。**一次性脚本，会删数据。**

在这之前，发布是"点一下就生一版"（那个 bug 已经修了），于是线上的 v7 里
有五版内容完全一样 —— 版本号记的是按钮被点过几次，不是线上跑过哪几份。
从现在起版本要开始认真记（每一版带变更说明、能切回去），所以先把计数归零。

**做了什么**（只动没归档的、且已经发布过的流程）：

  1. 删掉这条流程的全部运行记录（runs → steps / run_events 级联）
  2. 删掉它的全部版本行，含调试快照（负数版本）
  3. 把**当前生效那一版的定义**重新写成 v1，active_version 指向它

**为什么第 1 步躲不开**：runs 用 (flow_id, flow_version) 复合外键钉着
flow_versions。版本行还被引用着就删不掉，而不删就没法让编号从 1 重新开始。

**第 3 步用的是"当前生效那一版"，不是草稿。** 这件事只改版本号，不改线上
跑的东西 —— 拿草稿去发会把某个人还没发布的改动直接推上线，而且悄无声息。

**没动的东西**：
  · usage_daily（用量看板的按天统计）—— 它不外键任何版本，跑过多少次、
    谁在用、成功失败多少，全都还在。丢的是明细（每个节点的输入输出）。
  · 从没发布过的流程 —— 给它们发一版会**把定时和 webhook 接上**，
    而那是没人要求过的副作用。它们第一次发布时自然就是 v1。
  · 已归档（用户删掉）的流程 —— 界面上本来就看不见，不值得为它们冒风险。

**跑法**（默认只看不改）：

    cd server
    DATABASE_URL=postgresql://... .venv/bin/python reset_versions_to_v1.py
    DATABASE_URL=postgresql://... .venv/bin/python reset_versions_to_v1.py --yes

重复跑是安全的：已经是"只有一个 v1 且它生效中"的流程会被跳过。
"""
import os
import sys

if not os.getenv("DATABASE_URL", "").strip():
    print("需要 DATABASE_URL —— 这个脚本直接改库，不能猜连的是哪个环境。")
    sys.exit(1)

from sql_service import db, flowdef  # noqa: E402
from sql_service.flowstore import _audit, _one, _rows  # noqa: E402

try:
    from psycopg.types.json import Jsonb  # noqa: E402
except ImportError:  # pragma: no cover - 和 flowstore 同一条依赖
    print("缺少 psycopg。pip install 'psycopg[binary,pool]'")
    sys.exit(1)

APPLY = "--yes" in sys.argv
ACTOR = os.getenv("RESET_ACTOR") or "reset_versions_to_v1"
BASELINE_NOTE = "基线版本：重置版本号时由当时生效的那一版生成"


def plan(conn):
    """要动哪些流程。返回 [(flow, 待删版本数, 待删运行数)]，已经归零的不在内。"""
    flows = _rows(
        conn,
        "SELECT id, name, active_version FROM flows"
        " WHERE archived_at IS NULL AND active_version IS NOT NULL"
        " ORDER BY name",
    )
    out = []
    for f in flows:
        versions = _rows(
            conn, "SELECT version FROM flow_versions WHERE flow_id = %s", (f["id"],)
        )
        nums = sorted(v["version"] for v in versions)
        # 已经归零过：只有一个 v1，而且它就是生效的那一版
        if nums == [1] and f["active_version"] == 1:
            continue
        runs = _one(
            conn, "SELECT count(*) AS n FROM runs WHERE flow_id = %s", (f["id"],)
        )["n"]
        out.append((f, len(nums), runs))
    return out


def prepare(conn, flow):
    """算出这条流程的 v1 定义。**纯计算，不写库。**

    放在所有写入之前做：这一步可能因为老定义过不了今天的校验而抛，
    而那时候如果已经删过东西，事务里就留下了一批"删了但没重建"的流程。
    整批要么都成，要么一个不动。
    """
    live = _one(
        conn,
        "SELECT definition FROM flow_versions WHERE flow_id = %s AND version = %s",
        (flow["id"], flow["active_version"]),
    )
    if not live:
        # active_version 指向一个不存在的版本。这条流程本来就坏了（所有触发
        # 都取不到定义），归零解决不了它，跳过并说出来
        raise LookupError(f"active_version = {flow['active_version']}，但那一版不存在")
    draft = _one(conn, "SELECT draft FROM flows WHERE id = %s", (flow["id"],))["draft"]
    return (
        flowdef.for_storage(live["definition"], flow["id"], 1),
        # 草稿只重打版本号，内容一个字不动 —— 别人没发布的改动不该在这里丢掉
        flowdef.for_storage(draft, flow["id"], 1),
    )


def reset_one(conn, flow, definition, draft) -> None:
    """一条流程归零。调用方负责事务，定义由 prepare 先算好。"""
    # 顺序不能反：版本行被 runs 外键钉着，先收运行记录才删得掉版本
    conn.execute("DELETE FROM runs WHERE flow_id = %s", (flow["id"],))
    conn.execute("DELETE FROM flow_versions WHERE flow_id = %s", (flow["id"],))
    conn.execute(
        "INSERT INTO flow_versions (flow_id, version, definition, created_by, kind, note)"
        " VALUES (%s, 1, %s, %s, 'published', %s)",
        (flow["id"], Jsonb(definition), ACTOR, BASELINE_NOTE),
    )
    conn.execute(
        "UPDATE flows SET active_version = 1, draft = %s WHERE id = %s",
        (Jsonb(draft), flow["id"]),
    )
    _audit(conn, ACTOR, "flow.reset_versions", flow["id"],
           {"from": flow["active_version"], "to": 1})


def main() -> int:
    try:
        conn_pool = db.pool()
    except db.DbUnavailable as exc:
        # 连不上库时给一句人话，而不是一整段 traceback ——
        # 这个脚本最常见的用错方式就是 DATABASE_URL 指错了环境
        print(str(exc))
        return 1
    with conn_pool.connection() as conn:
        todo = plan(conn)
        if not todo:
            print("没有需要处理的流程 —— 已发布的都已经是 v1 了。")
            return 0

        print(f"{'流程':<28} {'当前':>6} {'删版本':>7} {'删运行记录':>10}")
        print("-" * 58)
        runs_total = 0
        for f, n_versions, n_runs in todo:
            runs_total += n_runs
            name = f["name"] if len(f["name"]) <= 26 else f["name"][:25] + "…"
            print(f"{name:<28} {'v' + str(f['active_version']):>6} {n_versions:>7} {n_runs:>10}")
        print("-" * 58)
        print(f"共 {len(todo)} 条流程，会删掉 {runs_total} 条运行记录的明细。")
        print("用量看板的统计（usage_daily）不受影响；线上跑的内容也不变，只是重新叫 v1。")

        if not APPLY:
            print("\n这是预演，什么都没改。确认无误后加 --yes 再跑一次。")
            return 0

        # 先全部算好，再统一写。算的这一步可能抛（老定义过不了今天的校验），
        # 而抛在写到一半的时候会留下一批删了没重建的流程
        ready, failed = [], []
        for f, _n, _r in todo:
            try:
                definition, draft = prepare(conn, f)
                ready.append((f, definition, draft))
            except Exception as exc:  # noqa: BLE001
                failed.append((f["name"], str(exc)))

        if failed and not ready:
            print("\n一条都处理不了：")
            for name, why in failed:
                print(f"  「{name}」{why}")
            return 1

        for f, definition, draft in ready:
            reset_one(conn, f, definition, draft)
        # 整批一个事务：中途失败不留半套编号
        conn.commit()

        print(f"\n完成：{len(ready)} 条流程已重置为 v1。")
        for name, why in failed:
            print(f"跳过「{name}」：{why}")
        return 0


if __name__ == "__main__":
    sys.exit(main())
