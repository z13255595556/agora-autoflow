"""流程存储的集成测试。**需要一个真的 Postgres。**

    docker compose up -d
    cd server
    DATABASE_URL=postgresql://workflow:workflow@localhost:5433/workflow \
      .venv/bin/python test_flowstore.py

没设 DATABASE_URL 就跳过并明确说出来 —— 不能让"没跑"看起来像"跑过了"。
纯校验逻辑在 test_flowdef.py，那个不需要数据库。

跑完会把自己造的数据删掉，但它建的表会留下（就是正常的迁移结果）。
"""
import os
import sys
import uuid

if not os.getenv("DATABASE_URL", "").strip():
    print("跳过：没有 DATABASE_URL。这些用例需要真的 Postgres —— docker compose up -d")
    sys.exit(0)

from sql_service import db, flowstore  # noqa: E402
from sql_service.flowdef import FlowDefError  # noqa: E402

PASS, FAIL = [], []
MADE = []


def ok(name, got, want):
    (PASS if got == want else FAIL).append((name, got, want))


def raises(name, exc_type, fn):
    try:
        fn()
    except exc_type:
        PASS.append((name, "raised", "raised"))
    except Exception as exc:  # noqa: BLE001
        FAIL.append((name, f"抛了 {type(exc).__name__}: {exc}", exc_type.__name__))
    else:
        FAIL.append((name, "没有抛错", exc_type.__name__))


def definition(name="测试流程", sql="SELECT 1"):
    return {
        "name": name,
        "version": 999,          # 客户端瞎报的版本号，服务端不该采信
        "inputs": {"type": "object", "properties": {}},
        "trigger": {"kind": "manual"},
        "nodes": [
            {"id": "n1", "type": "trigger.manual", "typeVersion": "1.0.0", "name": "手动",
             "params": {}, "onError": "fail"},
            {"id": "n2", "type": "sql.query", "typeVersion": "2.0.0", "name": "查询",
             "params": {"sql": sql}, "onError": "fail"},
        ],
        "edges": [{"from": "n1", "to": "n2"}],
        "layout": {"n1": {"x": 0, "y": 0}, "n2": {"x": 200, "y": 0}},
    }


def new_id():
    fid = f"test_{uuid.uuid4().hex[:12]}"
    MADE.append(fid)
    return fid


# ---------------------------------------------------------------- 建 + 读

fid = new_id()
created = flowstore.create_flow(fid, definition(), "alice")
ok("新建后能读回来", created["id"], fid)
ok("新建时还没有生效版本", created["activeVersion"], None)
ok("客户端瞎报的 version 不作数", created["draft"]["version"], 0)
ok("id 由服务端钉住", created["draft"]["id"], fid)
ok("节点数统计正确", created["nodeCount"], 2)
ok("节点类型列出来了", created["nodeTypes"], ["trigger.manual", "sql.query"])

raises("同 id 再建报冲突", FileExistsError, lambda: flowstore.create_flow(fid, definition(), "alice"))
raises("读不存在的流程报 NotFound", flowstore.NotFound, lambda: flowstore.get_flow("nope_xxx"))
raises("提交非法定义被拒", FlowDefError,
       lambda: flowstore.create_flow(new_id(), {"name": "坏的", "nodes": []}, None))

# ---------------------------------------------------------------- 存草稿不产生版本

flowstore.save_draft(fid, definition(sql="SELECT 2"), "alice")
ok("存草稿不产生版本", flowstore.list_versions(fid), [])
ok("草稿内容确实更新了",
   flowstore.get_flow(fid)["draft"]["nodes"][1]["params"]["sql"], "SELECT 2")

# ---------------------------------------------------------------- 发布

published = flowstore.publish(fid, "bob")
ok("发布后生效版本是 1", published["activeVersion"], 1)
ok("发布后版本列表有一条", len(flowstore.list_versions(fid)), 1)
ok("版本记了是谁发的", flowstore.list_versions(fid)[0]["createdBy"], "bob")

v1 = flowstore.get_version(fid, 1)
ok("版本快照存的是发布那一刻的内容",
   v1["definition"]["nodes"][1]["params"]["sql"], "SELECT 2")
ok("版本快照里的 version 是服务端分配的", v1["definition"]["version"], 1)

# ---------------------------------------------------------------- 改草稿 ≠ 改线上
#
# 定时和 webhook 跑的是已发布那一版。改了不发布线上不会变，
# 这件事必须能看见 —— 否则"我明明改了怎么没生效"一定会发生

flowstore.save_draft(fid, definition(sql="SELECT 3"), "alice")
after = flowstore.get_flow(fid)
ok("改草稿后标出有未发布改动", after["hasUnpublishedChanges"], True)
ok("已发布的那一版没被改动",
   flowstore.get_version(fid, 1)["definition"]["nodes"][1]["params"]["sql"], "SELECT 2")

flowstore.publish(fid, "bob")
ok("再发布版本号递增", flowstore.get_flow(fid)["activeVersion"], 2)
ok("发布后不再显示有未发布改动", flowstore.get_flow(fid)["hasUnpublishedChanges"], False)
ok("旧版本仍然读得到", flowstore.get_version(fid, 1)["definition"]["nodes"][1]["params"]["sql"], "SELECT 2")

# 只挪了下节点位置不该算"有未发布的改动"
moved = definition(sql="SELECT 3")
moved["layout"]["n2"] = {"x": 400, "y": 80}
flowstore.save_draft(fid, moved, "alice")
ok("只改布局不算未发布改动", flowstore.get_flow(fid)["hasUnpublishedChanges"], False)

raises("读不存在的版本报 NotFound", flowstore.NotFound, lambda: flowstore.get_version(fid, 99))

# ---------------------------------------------------------------- 列表

listed = {f["id"]: f for f in flowstore.list_flows()}
ok("列表里有它", fid in listed, True)
ok("列表带生效版本号", listed[fid]["activeVersion"], 2)

# ---------------------------------------------------------------- 归档

flowstore.archive(fid, "carol")
ok("归档后默认列表里不出现", fid in {f["id"] for f in flowstore.list_flows()}, False)
ok("显式要归档的能看到", fid in {f["id"] for f in flowstore.list_flows(True)}, True)
ok("归档后仍然读得到（运行记录要靠它解释历史）", flowstore.get_flow(fid)["id"], fid)
raises("归档后不能发布", flowstore.FlowArchived, lambda: flowstore.publish(fid, "carol"))

# ---------------------------------------------------------------- 审计

with db.pool().connection() as conn:
    got = conn.execute(
        "SELECT action, actor FROM audit WHERE target_id = %s ORDER BY id", (fid,)
    ).fetchall()
ok("审计记下了建/发布/发布/归档",
   [r[0] for r in got], ["flow.create", "flow.publish", "flow.publish", "flow.archive"])
ok("审计记下了是谁", [r[1] for r in got], ["alice", "bob", "bob", "carol"])
# 编辑器防抖自动保存几秒一次，每次记一条会把审计表变成击键日志
ok("存草稿不进审计", "flow.save" in [r[0] for r in got], False)

# ---------------------------------------------------------------- 收拾

with db.pool().connection() as conn:
    for made in MADE:
        conn.execute("DELETE FROM audit WHERE target_id = %s", (made,))
        conn.execute("DELETE FROM flows WHERE id = %s", (made,))
    conn.commit()

for name, got, want in FAIL:
    print(f"✗ {name}\n    实际: {got!r}\n    期望: {want!r}")
print(f"\n{len(PASS)} 通过, {len(FAIL)} 失败")
sys.exit(1 if FAIL else 0)
