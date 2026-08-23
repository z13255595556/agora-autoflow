"""流程存储的集成测试。**需要一个真的 Postgres。**

    docker compose up -d
    cd server
    DATABASE_URL=postgresql://workflow:workflow@localhost:5433/workflow \
      .venv/bin/python test_flowstore.py

没设 DATABASE_URL 就跳过并明确说出来 —— 不能让"没跑"看起来像"跑过了"。
纯校验逻辑在 test_flowdef.py，那个不需要数据库。

跑完会把自己造的数据删掉，但它建的表会留下（就是正常的迁移结果）。
"""
import sys
import uuid

from sql_service import db, flowstore  # noqa: E402
from sql_service.flowdef import FlowDefError  # noqa: E402

# **判据用 db.configured()，不是只看 DATABASE_URL。** 生产那台用的是 libpq
# 那套 PG* 环境（见 db.configured），只认 DATABASE_URL 的话它会打印"跳过"
# 然后 exit 0 —— 而这个文件开头那句"不能让『没跑』看起来像『跑过了』"
# 说的正是这件事，结果自己先踩了一次。
if not db.configured():
    print("跳过：没配数据库。这些用例需要真的 Postgres —— docker compose up -d，")
    print("      或 libpq 那套 PGHOST/PGUSER/PGPASSWORD（宿主机部署在 deploy/app.env）。")
    sys.exit(0)

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

published = flowstore.publish(fid, "alice")
ok("发布后生效版本是 1", published["activeVersion"], 1)
ok("发布后版本列表有一条", len(flowstore.list_versions(fid)), 1)
ok("版本记了是谁发的", flowstore.list_versions(fid)[0]["createdBy"], "alice")

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

flowstore.publish(fid, "alice")
ok("再发布版本号递增", flowstore.get_flow(fid)["activeVersion"], 2)
ok("发布后不再显示有未发布改动", flowstore.get_flow(fid)["hasUnpublishedChanges"], False)
ok("旧版本仍然读得到", flowstore.get_version(fid, 1)["definition"]["nodes"][1]["params"]["sql"], "SELECT 2")

# 只挪了下节点位置不该算"有未发布的改动"
moved = definition(sql="SELECT 3")
moved["layout"]["n2"] = {"x": 400, "y": 80}
flowstore.save_draft(fid, moved, "alice")
ok("只改布局不算未发布改动", flowstore.get_flow(fid)["hasUnpublishedChanges"], False)

# 节点上的备注和拖位置同类 —— 不参与执行，改了不算"有未发布的改动"；
# 暂停（disabled）会改变线上跑出来的结果，必须算
noted = definition(sql="SELECT 3")
noted["nodes"][1]["note"] = "这条 SQL 只看昨天"
flowstore.save_draft(fid, noted, "alice")
ok("只改备注不算未发布改动", flowstore.get_flow(fid)["hasUnpublishedChanges"], False)
paused = definition(sql="SELECT 3")
paused["nodes"][1]["disabled"] = True
flowstore.save_draft(fid, paused, "alice")
ok("暂停节点算未发布改动", flowstore.get_flow(fid)["hasUnpublishedChanges"], True)
flowstore.save_draft(fid, definition(sql="SELECT 3"), "alice")

# ★ 版本号是"线上跑的是哪一份"，不是"这个按钮被点过几次"。连点五下发布
#   产生五个内容相同的版本之后，版本列表和运行记录里的版本号就不说明任何事了
same = flowstore.publish(fid, "alice")
ok("★★ 没有实际改动，发布不生新版本", same["activeVersion"], 2)
ok("★ 版本列表也没多出一条", len(flowstore.list_versions(fid)), 2)
ok("★ 只挪了节点位置同样不生版本（和 hasUnpublishedChanges 同一把尺子）",
   flowstore.publish(fid, "alice")["activeVersion"], 2)
with db.pool().connection() as conn:
    n_pub = conn.execute(
        "SELECT count(*) FROM audit WHERE target_id = %s AND action = 'flow.publish'", (fid,)
    ).fetchone()[0]
ok("★ 空发布不写审计 —— 审计记的是真的发生过的事", n_pub, 2)

# 改回真有内容的改动，后面的用例照旧
flowstore.save_draft(fid, definition(sql="SELECT 4"), "alice")
ok("再有真改动时又能发了", flowstore.publish(fid, "alice")["activeVersion"], 3)

# ---------------------------------------------------------------- 变更说明

flowstore.save_draft(fid, definition(sql="SELECT 5"), "alice")
flowstore.publish(fid, "alice", note="  改成按天分区，之前扫全表超时  ")
v4 = flowstore.list_versions(fid)[0]
ok("变更说明记在那一版上", (v4["version"], v4["note"]), (4, "改成按天分区，之前扫全表超时"))
ok("★ 老版本的说明是 None，不是空串 —— 界面要能分出「没填」和「填了」",
   flowstore.list_versions(fid)[1]["note"], None)

flowstore.save_draft(fid, definition(sql="SELECT 6"), "alice")
flowstore.publish(fid, "alice", note="   ")
ok("★ 只填空白等于没填", flowstore.list_versions(fid)[0]["note"], None)

flowstore.save_draft(fid, definition(sql="SELECT 7"), "alice")
flowstore.publish(fid, "alice", note="唠" * 800)
ok("超长说明截断到上限", len(flowstore.list_versions(fid)[0]["note"]), flowstore.NOTE_MAX)

# ---------------------------------------------------------------- 切回历史版本

ok("当前生效的是 v6", flowstore.get_flow(fid)["activeVersion"], 6)
back = flowstore.rollback(fid, 2, "alice")
ok("★★ 切回 v2：线上就是 v2 了", back["activeVersion"], 2)
ok("★★ 草稿也被覆盖成 v2 —— 只切线上不动草稿的话，下一次发布就原路发回去了",
   flowstore.get_flow(fid)["draft"]["nodes"][1]["params"]["sql"], "SELECT 3")
ok("★ 切换不生新版本：版本列表还是那 6 条", len(flowstore.list_versions(fid)), 6)
ok("★ 切完草稿和线上一致，不该显示有未发布改动",
   flowstore.get_flow(fid)["hasUnpublishedChanges"], False)
ok("★ 切回去之后再点发布也不生版本（内容没变）",
   flowstore.publish(fid, "alice")["activeVersion"], 2)

raises("★★ 切不到调试快照（负数）—— 那不是发布过的版本，而且随时会被保留期清掉",
       flowstore.NotFound, lambda: flowstore.rollback(fid, -1, "alice"))
raises("切不到不存在的版本", flowstore.NotFound, lambda: flowstore.rollback(fid, 99, "alice"))

# 切回最新那一版，后面的用例照旧
flowstore.rollback(fid, 6, "alice")
ok("切回 v6", flowstore.get_flow(fid)["activeVersion"], 6)

raises("读不存在的版本报 NotFound", flowstore.NotFound, lambda: flowstore.get_version(fid, 99))

# ---------------------------------------------------------------- 列表

listed = {f["id"]: f for f in flowstore.list_flows(viewer="alice")}
ok("列表里有它", fid in listed, True)
ok("列表带生效版本号", listed[fid]["activeVersion"], 6)

# ---------------------------------------------------------------- 归档

flowstore.archive(fid, "alice")
ok("归档后默认列表里不出现", fid in {f["id"] for f in flowstore.list_flows(viewer="alice")}, False)
ok("显式要归档的能看到", fid in {f["id"] for f in flowstore.list_flows(True, viewer="alice")}, True)
ok("归档后仍然读得到（运行记录要靠它解释历史）", flowstore.get_flow(fid)["id"], fid)
raises("归档后不能发布", flowstore.FlowArchived, lambda: flowstore.publish(fid, "alice"))
# ★ 写得进去比写不进去糟得多：草稿更新了、updated_at 也动了、保存报成功，
#   可它在任何人的列表里都不出现 —— 而浏览器那边会留下一份本地缓存，
#   于是它以「只在本机」的样子回到首页，删一次、回来一次
raises("★ 归档后不能存草稿", flowstore.FlowArchived,
       lambda: flowstore.save_draft(fid, definition("删了还改"), "alice"))
ok("★ 草稿真的没被改动", flowstore.get_flow(fid)["draft"]["name"] != "删了还改", True)

# ---------------------------------------------------------------- 审计

with db.pool().connection() as conn:
    got = conn.execute(
        "SELECT action, actor FROM audit WHERE target_id = %s ORDER BY id", (fid,)
    ).fetchall()
ok("审计记下了建 / 六次发布 / 两次切版本 / 归档",
   [r[0] for r in got],
   ["flow.create"] + ["flow.publish"] * 6 + ["flow.rollback"] * 2 + ["flow.archive"])
ok("审计记下了是谁", [r[1] for r in got], ["alice"] * 10)
# 编辑器防抖自动保存几秒一次，每次记一条会把审计表变成击键日志
ok("存草稿不进审计", "flow.save" in [r[0] for r in got], False)

# ---------------------------------------------------------------- 失败通知
#
# 这一列 worker 一直在读（alerts.ts），但在此之前没有任何接口能写它

nfid = new_id()
flowstore.create_flow(nfid, definition("要告警的流程"), "alice")
ok("默认没有通知配置", flowstore.get_flow(nfid)["notifyConfig"], None)
ok("列表里也带着这个字段",
   next(f for f in flowstore.list_flows(viewer="alice") if f["id"] == nfid)["notifyConfig"], None)
good_hook = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh-1234"
ok("设置企微地址", flowstore.set_notify_config(nfid, {"webhook": good_hook}, "alice"),
   {"notifyConfig": {"webhook": good_hook}})
ok("读回来是存进去的", flowstore.get_flow(nfid)["notifyConfig"], {"webhook": good_hook})
raises("★ 不是企微机器人地址一律拒绝 —— 填错了告警会静默发不出去", FlowDefError,
       lambda: flowstore.set_notify_config(nfid, {"webhook": "https://example.com/hook"}, "alice"))
raises("空地址拒绝", FlowDefError,
       lambda: flowstore.set_notify_config(nfid, {"webhook": "   "}, "alice"))
ok("传 None 关掉", flowstore.set_notify_config(nfid, None, "alice"), {"notifyConfig": None})
ok("关掉后读回 None", flowstore.get_flow(nfid)["notifyConfig"], None)
raises("别人的流程设不了", flowstore.NotFound,
       lambda: flowstore.set_notify_config(nfid, {"webhook": good_hook}, "bob", viewer="bob"))
with db.pool().connection() as conn:
    nrows = conn.execute(
        "SELECT detail FROM audit WHERE target_id = %s AND action = 'flow.notify' ORDER BY id", (nfid,)
    ).fetchall()
ok("改通知配置记审计（开、关各一条）", [r[0]["enabled"] for r in nrows], [True, False])
ok("★ 审计里不存整条地址 —— 它等同凭证", "abcdefgh-1234" in str(nrows[0][0]), False)
with db.pool().connection() as conn:
    conn.execute("DELETE FROM audit WHERE target_id = %s", (nfid,))
    conn.execute("DELETE FROM flows WHERE id = %s", (nfid,))
    conn.commit()

# ---------------------------------------------------------------- 归属与隔离
#
# 每个人是自己的工作台。别人的流程在这里不是"看得到点不动"，而是**不存在** ——
# 404 而不是 403：403 等于承认这条在，把别人的流程 id 和存在性透出去了。

mine = new_id()
flowstore.create_flow(mine, definition("alice 的流程"), "alice@agora.io")
ok("建流程时就写好归属", flowstore.get_flow(mine)["owner"], "alice@agora.io")
ok("自己看得见", mine in {f["id"] for f in flowstore.list_flows(viewer="alice@agora.io")}, True)
ok("别人的工作台里没有它", mine in {f["id"] for f in flowstore.list_flows(viewer="bob@agora.io")}, False)
ok("匿名也看不见（不是看到全部）", mine in {f["id"] for f in flowstore.list_flows()}, False)

raises("别人读不到", flowstore.NotFound, lambda: flowstore.get_flow(mine, "bob@agora.io"))
raises("别人存不了草稿", flowstore.NotFound,
       lambda: flowstore.save_draft(mine, definition("被改了"), "bob@agora.io"))
raises("别人发布不了", flowstore.NotFound, lambda: flowstore.publish(mine, "bob@agora.io"))
raises("别人归档不了", flowstore.NotFound, lambda: flowstore.archive(mine, "bob@agora.io"))
raises("别人翻不到版本列表", flowstore.NotFound, lambda: flowstore.list_versions(mine, "bob@agora.io"))

flowstore.publish(mine, "alice@agora.io")
raises("别人取不到版本快照", flowstore.NotFound,
       lambda: flowstore.get_version(mine, 1, "bob@agora.io"))
ok("自己取得到", flowstore.get_version(mine, 1, "alice@agora.io")["version"], 1)
# worker / webhook 这类内部路径没有"当前用户"，必须能拿到定义，否则定时任务全跑不了
ok("内部路径不做归属过滤", flowstore.get_version(mine, 1)["version"], 1)

# ---------------------------------------------------------------- 无主流程谁发布归谁
#
# 008 之前建的流程 owner 是 NULL。不批量指派 —— 指派错了比没指派更难发现；
# 让归属通过"谁发布一次"自然长出来。

orphan = new_id()
flowstore.create_flow(orphan, definition("历史遗留"), None)
ok("无主流程谁都看得见", 
   all(orphan in {f["id"] for f in flowstore.list_flows(viewer=v)}
       for v in [None, "alice@agora.io", "bob@agora.io"]), True)

flowstore.publish(orphan, "bob@agora.io")
ok("谁发布的谁是 owner", flowstore.get_flow(orphan)["owner"], "bob@agora.io")
ok("认领之后别人就看不见了",
   orphan in {f["id"] for f in flowstore.list_flows(viewer="alice@agora.io")}, False)
raises("认领之后别人也改不了", flowstore.NotFound,
       lambda: flowstore.save_draft(orphan, definition("抢过来"), "alice@agora.io"))

# 再发布一次不会易主 —— COALESCE 只在没主时写
flowstore.publish(orphan, "bob@agora.io")
ok("已有主的不会被后来者顶掉", flowstore.get_flow(orphan)["owner"], "bob@agora.io")

# ---------------------------------------------------------------- 运行记录也按归属
#
# 这一层比流程定义更要紧：steps 里存的是**查询结果本身**。
# 流程只泄露"我在查什么"，运行记录直接是那些数据。

from sql_service import runstore  # noqa: E402

run = runstore.create_run(mine, inputs={})
rid = run["runId"]
ok("自己列得到自己的运行", rid in {r["id"] for r in runstore.list_runs(viewer="alice@agora.io")}, True)
ok("别人列不到", rid in {r["id"] for r in runstore.list_runs(viewer="bob@agora.io")}, False)
ok("匿名也列不到", rid in {r["id"] for r in runstore.list_runs()}, False)
raises("别人按 id 也读不到", runstore.NotFound, lambda: runstore.get_run(rid, "bob@agora.io"))
raises("别人取不到事件流", runstore.NotFound, lambda: runstore.events_since(rid, 0, "bob@agora.io"))
raises("别人取消不了", runstore.NotFound, lambda: runstore.request_cancel(rid, "bob@agora.io"))
ok("自己读得到", runstore.get_run(rid, "alice@agora.io")["id"], rid)

# ---------------------------------------------------------------- 手动运行 = 调试 = 跑草稿
#
# 在此之前手动运行跑的是**已发布版本**：改完图点运行结果没变；而流程从未发布时
# 第一次手动运行还会隐式发一版 —— 用户没点发布，线上就已经换了。


def draft_count(flow_id):
    with db.pool().connection() as conn:
        return conn.execute(
            "SELECT count(*) FROM flow_versions WHERE flow_id = %s AND version < 0", (flow_id,)
        ).fetchone()[0]


d = new_id()
flowstore.create_flow(d, definition("调试", "SELECT 1"), "alice@agora.io")

r1 = runstore.create_run(d, inputs={}, actor="alice@agora.io")
ok("★ 手动运行不再隐式发布", flowstore.get_flow(d)["activeVersion"], None)
ok("★ 跑的是负数版本的调试快照", r1["flowVersion"], -1)
ok("★ 快照记在点运行的人名下", flowstore.get_version(d, -1)["createdBy"], "alice@agora.io")
ok("快照钉的是草稿内容",
   flowstore.get_version(d, -1)["definition"]["nodes"][1]["params"]["sql"], "SELECT 1")

r2 = runstore.create_run(d, inputs={}, actor="alice@agora.io")
ok("★ 画布没动就复用同一份快照", r2["flowVersion"], -1)
ok("连点两次只有一份快照", draft_count(d), 1)

moved = definition("调试", "SELECT 1")
moved["layout"]["n2"] = {"x": 999, "y": 999}
flowstore.save_draft(d, moved, "alice@agora.io")
ok("只挪了位置仍复用旧快照",
   runstore.create_run(d, inputs={}, actor="alice@agora.io")["flowVersion"], -1)

flowstore.save_draft(d, definition("调试", "SELECT 2"), "alice@agora.io")
r3 = runstore.create_run(d, inputs={}, actor="alice@agora.io")
ok("★ 改了草稿就是一份新快照", r3["flowVersion"], -2)
ok("跑的是改后的草稿",
   flowstore.get_version(d, -2)["definition"]["nodes"][1]["params"]["sql"], "SELECT 2")

# ★★ 这条钉的是 publish 里那个 AND version > 0。没有它，MAX 是负数，
#    算出来的"下一版"会是 0 或负数，而 active_version 指向 0 之后
#    所有触发都取不到定义，全程没有任何报错
ok("★★ 调试跑过之后，第一次发布仍然是 v1", flowstore.publish(d, "alice@agora.io")["activeVersion"], 1)

flowstore.save_draft(d, definition("调试", "SELECT 3"), "alice@agora.io")
runstore.create_run(d, inputs={}, actor="alice@agora.io")
ok("★★ 调试运行不动 active_version", flowstore.get_flow(d)["activeVersion"], 1)
ok("★★ 再发布接着在正数域递增", flowstore.publish(d, "alice@agora.io")["activeVersion"], 2)

ok("版本历史里没有调试快照", [v["version"] for v in flowstore.list_versions(d)], [2, 1])
ok("但按号取得到（排查一次运行时要看得见它跑的是什么）",
   flowstore.get_version(d, -1)["version"], -1)

# ---------------------------------------------------------------- 线上只认已发布的那一版
flowstore.save_draft(d, definition("调试", "SELECT 999"), "alice@agora.io")
before = draft_count(d)
ok("★★ 定时跑的是 active_version，不是刚存的草稿",
   runstore.create_run(d, inputs={}, mode="production", trigger_kind="schedule")["flowVersion"], 2)
ok("★★ webhook 同理",
   runstore.create_run(d, inputs={}, mode="production", trigger_kind="webhook")["flowVersion"], 2)
ok("★★ 非手动触发不产生调试快照", draft_count(d), before)

nev = new_id()
flowstore.create_flow(nev, definition("没发布过"), "alice@agora.io")
raises("★ 未发布的流程定时触发仍然拒绝", runstore.NotPublished,
       lambda: runstore.create_run(nev, inputs={}, mode="production", trigger_kind="schedule"))
ok("被拒之后也不留快照", draft_count(nev), 0)

# ---------------------------------------------------------------- 归档 / 幂等
flowstore.archive(d, "alice@agora.io")
raises("★ 归档的流程手动也不能跑", flowstore.FlowArchived,
       lambda: runstore.create_run(d, inputs={}, actor="alice@agora.io"))

k = new_id()
flowstore.create_flow(k, definition("幂等"), "alice@agora.io")
runstore.create_run(k, inputs={}, actor="alice@agora.io", idempotency_key="same")
again = runstore.create_run(k, inputs={}, actor="alice@agora.io", idempotency_key="same")
ok("同一个幂等键只产生一条 run", again.get("deduplicated"), True)
# 幂等原先排在版本解析之后，命中去重时已经白发了一版 —— 去重的意义正是没有副作用
ok("★ 命中去重时不产生第二份快照", draft_count(k), 1)

# ---------------------------------------------------------------- 管理员视角
#
# 管理员的"看得见全部"走的是 flowstore.ANY 这个哨兵。它和"认不出身份"
# （viewer=None，只看得见无主流程）**必须泾渭分明** —— 混起来的话，SSO 抽风
# 会静默变成"所有人看到所有人的查询结果"，而且没有任何迹象。

adm_a = new_id()
adm_b = new_id()
flowstore.create_flow(adm_a, definition("alice 的"), "alice@agora.io")
flowstore.create_flow(adm_b, definition("bob 的"), "bob@agora.io")

mine = [f["id"] for f in flowstore.list_flows(viewer="alice@agora.io")]
ok("★ 普通用户看不到别人的流程", adm_b in mine, False)
ok("普通用户看得到自己的", adm_a in mine, True)

allof = [f["id"] for f in flowstore.list_flows(viewer=flowstore.ANY)]
ok("★ 管理员两条都看得到", (adm_a in allof, adm_b in allof), (True, True))
ok("★ 管理员列表带得出归属", 
   next(f["owner"] for f in flowstore.list_flows(viewer=flowstore.ANY) if f["id"] == adm_b),
   "bob@agora.io")

raises("★ 普通用户读不到别人的流程", flowstore.NotFound,
       lambda: flowstore.get_flow(adm_b, "alice@agora.io"))
ok("★ 管理员读得到", flowstore.get_flow(adm_b, flowstore.ANY)["id"], adm_b)

# 认不出身份 ≠ 管理员。这一条是整段里最要紧的
anon = [f["id"] for f in flowstore.list_flows(viewer=None)]
ok("★★ 认不出身份时看不到任何有主的流程", (adm_a in anon, adm_b in anon), (False, False))

# 写路径：actor 记的是真的动手的人，viewer 只决定能不能碰
raises("★ 普通用户改不了别人的流程", flowstore.NotFound,
       lambda: flowstore.save_draft(adm_b, definition("被改了"), "alice@agora.io"))
flowstore.save_draft(adm_b, definition("bob 的", "SELECT 管理员改的"), "alice@agora.io", flowstore.ANY)
ok("★ 管理员改得了别人的流程",
   flowstore.get_flow(adm_b, flowstore.ANY)["draft"]["nodes"][1]["params"]["sql"], "SELECT 管理员改的")
flowstore.publish(adm_b, "alice@agora.io", flowstore.ANY)
ok("★ 管理员发布别人的流程，owner 不会被顶掉",
   next(f["owner"] for f in flowstore.list_flows(viewer=flowstore.ANY) if f["id"] == adm_b),
   "bob@agora.io")

# 运行记录的可见性必须和流程完全同一条规则
runstore.create_run(adm_b, inputs={}, actor="bob@agora.io")
ok("★ 普通用户看不到别人的运行记录",
   any(r["flowId"] == adm_b for r in runstore.list_runs(viewer="alice@agora.io")), False)
ok("★ 管理员看得到",
   any(r["flowId"] == adm_b for r in runstore.list_runs(viewer=flowstore.ANY)), True)

# ------------------------------------------------- id 被占用：得说清是哪一种
#
# 首页那句"只存在这台机器上"是**推断**出来的：本地列表减去服务端列表。
# 而服务端那份列表是过滤过的 —— 归档的不在里面，归属别人的也不在里面。
# 于是"服务器上没有"和"已存在"会同时成立，用户点上传撞一个 409 就走不下去了。
# 409 必须带上原因，因为两种原因的出路完全不同：一个是恢复，一个是换 id。


def code_of(fn):
    try:
        fn()
    except flowstore.FlowExists as exc:
        return exc.code
    except Exception as exc:  # noqa: BLE001
        return f"抛了 {type(exc).__name__}: {exc}"
    return "没有抛错"


ex_arch = new_id()
flowstore.create_flow(ex_arch, definition("归档过的"), "alice@agora.io")
flowstore.archive(ex_arch, "alice@agora.io")
ok("★ 归档的流程不在列表里",
   any(f["id"] == ex_arch for f in flowstore.list_flows(viewer="alice@agora.io")), False)
ok("★★ 但同 id 重建撞得上，而且要说清是「归档了」不是「不存在」",
   code_of(lambda: flowstore.create_flow(ex_arch, definition(), "alice@agora.io")),
   "flow_exists_archived")

# 归档可逆 —— 不可逆的话首页那个删除按钮就不是"归档"而是"删除"了
flowstore.restore(ex_arch, "alice@agora.io")
ok("★ 恢复之后回到列表里",
   any(f["id"] == ex_arch for f in flowstore.list_flows(viewer="alice@agora.io")), True)
ok("恢复之后 archivedAt 清空", flowstore.get_flow(ex_arch)["archivedAt"], None)
ok("恢复之后再重建，报的是普通的「已存在」",
   code_of(lambda: flowstore.create_flow(ex_arch, definition(), "alice@agora.io")), "flow_exists")

# 归属别人 → 这个 id 要不回来了。**不能报「归档」**：那会让前端提示用户去恢复
# 一条他根本碰不到的流程
ok("★★ id 被别人占着，报的是「归属其他人」",
   code_of(lambda: flowstore.create_flow(adm_b, definition(), "alice@agora.io")),
   "flow_exists_other_owner")
ok("★ 消息里不带别人的邮箱",
   "bob@agora.io" in code_of(lambda: str(flowstore.create_flow(adm_b, definition(), "alice@agora.io"))),
   False)
# ★★ 判定必须和「被解释的那张列表」用同一个视角。
#
# create_flow 的 viewer 默认是 SELF（= actor 本人），路由**刻意不传 _viewer**：
# 管理员的 _viewer 是 ANY，于是"看得见"恒为真，「归属其他人」这一支对他
# 永远不触发 —— 他拿到的是"刷新一下就看得到"，而首页默认那屏也是 scope=mine，
# 刷新一百次也不会看到。下面这条钉住的就是"传 ANY 会分不出来"这件事本身。
ok("传 ANY 就分不出「归属其他人」了 —— 路由别这么干（理由见 main.py）",
   code_of(lambda: flowstore.create_flow(adm_b, definition(), "alice@agora.io", flowstore.ANY)),
   "flow_exists")

# 恢复走的是和归档同一条可见性规则
ex_other = new_id()
flowstore.create_flow(ex_other, definition("bob 的"), "bob@agora.io")
flowstore.archive(ex_other, "bob@agora.io")
raises("★ 普通用户恢复不了别人的流程", flowstore.NotFound,
       lambda: flowstore.restore(ex_other, "alice@agora.io"))
ok("★ 管理员恢复得了", flowstore.restore(ex_other, "alice@agora.io", flowstore.ANY)["archivedAt"], None)
ok("★ 管理员恢复别人的流程，owner 不会被顶掉", flowstore.get_flow(ex_other)["owner"], "bob@agora.io")

# ------------------------------------------------- 单条读的视角不能比列表宽
#
# 管理员用 ANY 视角**读得到**别人的流程（管理台点进去要能打开），但首页列表
# 用的是 actor 视角。前端拿单条读的结果写本地缓存时，必须知道"这条会不会
# 出现在我的列表里" —— 不知道的话，缓存下来的就是一张删了又回来的
# 「只在本机」卡片：删掉本地那份 → 再打开一次 → 又写回去。线上真发生过。
#
# 判定只有 owner_visible 这一个出处，前端不自己抄一份。
ok("★★ 别人的流程：读得到，但不在我的默认列表里",
   (flowstore.get_flow(adm_b, flowstore.ANY)["id"],
    flowstore.owner_visible("bob@agora.io", "alice@agora.io")),
   (adm_b, False))
ok("我自己的在", flowstore.owner_visible("alice@agora.io", "alice@agora.io"), True)
ok("无主的对谁都在", flowstore.owner_visible(None, "alice@agora.io"), True)
ok("★ 认不出身份时，有主的一律不算我的",
   flowstore.owner_visible("alice@agora.io", None), False)

# ---------------------------------------------------------------- 收拾

with db.pool().connection() as conn:
    for made in MADE:
        conn.execute("DELETE FROM audit WHERE target_id = %s", (made,))
        # runs → flow_versions 有外键，先收运行记录再删流程
        conn.execute("DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE flow_id = %s)", (made,))
        conn.execute("DELETE FROM steps WHERE run_id IN (SELECT id FROM runs WHERE flow_id = %s)", (made,))
        conn.execute("DELETE FROM runs WHERE flow_id = %s", (made,))
        conn.execute("DELETE FROM flow_versions WHERE flow_id = %s", (made,))
        conn.execute("DELETE FROM flows WHERE id = %s", (made,))
    conn.commit()

for name, got, want in FAIL:
    print(f"✗ {name}\n    实际: {got!r}\n    期望: {want!r}")
print(f"\n{len(PASS)} 通过, {len(FAIL)} 失败")
sys.exit(1 if FAIL else 0)
