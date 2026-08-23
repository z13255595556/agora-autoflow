"""流程定义服务端校验的测试。

    cd server && .venv/bin/python test_flowdef.py

这层是完整性边界：M0 之后流程从各人的 localStorage 搬到共享服务器，
一份写坏的定义会让所有人的编辑器加载时炸掉，而那时候已经看不出是谁写坏的。

**它只拒绝、不修复** —— 前端的 normalizeFlowDefinition 会补默认值，那是给
编辑器用的；服务端补默认值等于悄悄存下一份和用户以为的不一样的定义。
"""
import copy
import sys

from sql_service import flowdef
from sql_service.flowdef import FlowDefError

PASS, FAIL = [], []


def ok(name, got, want):
    (PASS if got == want else FAIL).append((name, got, want))


def rejects(name, value, fragment=""):
    try:
        flowdef.validate(value)
    except FlowDefError as exc:
        if fragment and fragment not in str(exc):
            FAIL.append((name, f"拒了但内容不符: {exc}", f"包含 {fragment!r}"))
        else:
            PASS.append((name, "rejected", "rejected"))
    except Exception as exc:  # noqa: BLE001
        FAIL.append((name, f"抛了 {type(exc).__name__}: {exc}", "FlowDefError"))
    else:
        FAIL.append((name, "放行了", "FlowDefError"))


def accepts(name, value):
    try:
        flowdef.validate(value)
    except Exception as exc:  # noqa: BLE001
        FAIL.append((name, f"被拒: {exc}", "放行"))
    else:
        PASS.append((name, "accepted", "accepted"))


GOOD = {
    "id": "flow_a",
    "version": 3,
    "name": "每日报表",
    "inputs": {"type": "object", "properties": {"vid": {"type": "integer"}}},
    "trigger": {"kind": "schedule", "mode": "daily", "at": "09:00"},
    "nodes": [
        {"id": "n1", "type": "trigger.schedule", "typeVersion": "1.0.0", "name": "每天 09:00",
         "params": {"mode": "daily", "at": "09:00"}, "onError": "fail"},
        {"id": "n2", "type": "sql.query", "typeVersion": "2.0.0", "name": "SQL 查询",
         "params": {"sql": "SELECT 1"}, "onError": "continue"},
    ],
    "edges": [{"from": "n1", "to": "n2"}],
    "layout": {"n1": {"x": 0, "y": 0}, "n2": {"x": 200, "y": 0}},
    "pinData": {"n2": {"rows": [{"a": 1}]}},
}


def mutate(**patch):
    out = copy.deepcopy(GOOD)
    for k, v in patch.items():
        if v is flowdef:      # 哨兵：表示删掉这个键
            out.pop(k, None)
        else:
            out[k] = v
    return out


DEL = flowdef  # 可读性别名

# ---------------------------------------------------------------- 放行

accepts("完整定义放行", GOOD)
accepts("没有 edges 也行（单节点流程）", mutate(edges=[], nodes=[GOOD["nodes"][0]], pinData={}, layout={}))
accepts("没有 trigger 也行（旧定义）", mutate(trigger=DEL))
accepts("没有 pinData 也行", mutate(pinData=DEL))

# ---------------------------------------------------------------- 结构

rejects("不是对象", ["nope"], "必须是对象")
rejects("name 为空", mutate(name="  "), "name")
rejects("nodes 不是数组", mutate(nodes={}), "nodes")
rejects("nodes 为空", mutate(nodes=[]), "nodes")

rejects(
    "节点 id 重复",
    mutate(nodes=[GOOD["nodes"][0], dict(GOOD["nodes"][1], id="n1")]),
    "重复",
)
rejects("节点缺 type", mutate(nodes=[{"id": "n1", "typeVersion": "1.0.0"}]), "type")
rejects(
    "节点缺 typeVersion",
    mutate(nodes=[{"id": "n1", "type": "trigger.manual"}]),
    "typeVersion",
)
rejects(
    "params 不是对象",
    mutate(nodes=[dict(GOOD["nodes"][0], params=[])]),
    "params",
)
accepts("节点设置：备注 / 暂停 / 重试覆盖 / 明确不重试",
        mutate(nodes=[dict(GOOD["nodes"][0], note="先别发", disabled=True, retry={"maxAttempts": 2, "initialMs": 500}),
                      dict(GOOD["nodes"][1], retry=None)]))
rejects("note 不是字符串", mutate(nodes=[dict(GOOD["nodes"][0], note=3)]), "note")
accepts("入参：日期 / 下拉 / 小数落成 string+format / enum / number",
        mutate(inputs={"type": "object", "properties": {
            "date": {"type": "string", "format": "date", "default": "2026-08-21", "title": "日期"},
            "engine": {"type": "string", "enum": ["hive", "doris"]},
            "ratio": {"type": "number"},
        }}))
rejects("入参 type 不是 JSON Schema 类型（date 不能直接写成 type）",
        mutate(inputs={"type": "object", "properties": {"d": {"type": "date"}}}), "inputs.properties.d.type")
rejects("入参 enum 不是数组", mutate(inputs={"type": "object", "properties": {"e": {"type": "string", "enum": "hive"}}}), "enum")
rejects("disabled 不是布尔", mutate(nodes=[dict(GOOD["nodes"][0], disabled="yes")]), "disabled")
rejects("retry 不是对象", mutate(nodes=[dict(GOOD["nodes"][0], retry=3)]), "retry")
rejects("retry.maxAttempts 不是数字", mutate(nodes=[dict(GOOD["nodes"][0], retry={"maxAttempts": "x"})]), "maxAttempts")
rejects(
    "onError 取值非法",
    mutate(nodes=[dict(GOOD["nodes"][0], onError="ignore")]),
    "onError",
)

# ---------------------------------------------------------------- 引用完整性
#
# 悬空引用必须拒绝：存进去之后画布加载会炸，而那时候已经看不出是谁写坏的

rejects("edge.from 指向不存在的节点", mutate(edges=[{"from": "nope", "to": "n2"}]), "不存在")
rejects("edge.to 指向不存在的节点", mutate(edges=[{"from": "n1", "to": "nope"}]), "不存在")
rejects("pinData 的键不是本流程的节点", mutate(pinData={"n9": {}}), "不是这条流程的节点")

# ---------------------------------------------------------------- 触发方式

rejects("trigger.kind 非法", mutate(trigger={"kind": "cron"}), "trigger.kind")
for kind in ["manual", "schedule", "webhook"]:
    accepts(f"trigger.kind={kind} 放行", mutate(trigger={"kind": kind}))

# ---------------------------------------------------------------- 体积上限
#
# 未认证的接口收 JSONB，没有上限就是一个内存放大器

rejects(
    "单条 pin 数据超 256KB",
    mutate(pinData={"n2": {"blob": "x" * (300 * 1024)}}),
    "pinData[n2]",
)
rejects(
    "整份定义超 1MB",
    mutate(nodes=[dict(GOOD["nodes"][0], params={"sql": "x" * (1100 * 1024)})]),
    "流程定义",
)
rejects(
    "节点数超上限",
    mutate(nodes=[{"id": f"n{i}", "type": "t", "typeVersion": "1.0.0"} for i in range(600)]),
    "节点数",
)

# ---------------------------------------------------------------- 只拒绝，不修复

before = copy.deepcopy(GOOD)
after = flowdef.validate(GOOD)
ok("validate 不改动输入", GOOD, before)
ok("validate 原样返回，不是清洗过的副本", after, before)

# 缺 onError 不会被补成 'fail' —— 补了就等于服务端悄悄存下一份和用户以为的不一样的定义
lean = mutate(nodes=[{"id": "n1", "type": "trigger.manual", "typeVersion": "1.0.0"}], edges=[], pinData={}, layout={})
ok("缺省字段不被补齐", "onError" in flowdef.validate(lean)["nodes"][0], False)

# ---------------------------------------------------------------- id 与版本由服务端说了算

stored = flowdef.for_storage(GOOD, "flow_real", 7)
ok("for_storage 钉住服务端的 id", stored["id"], "flow_real")
ok("for_storage 钉住服务端的版本号", stored["version"], 7)
ok("客户端提交的 version 不作数", GOOD["version"] != 7, True)
ok("for_storage 不改动输入", GOOD["id"], "flow_a")

# ---------------------------------------------------------------- node_types

ok("node_types 去重且保持出现顺序",
   flowdef.node_types({"nodes": [{"type": "b"}, {"type": "a"}, {"type": "b"}]}),
   ["b", "a"])
ok("node_types 容忍脏数据", flowdef.node_types({"nodes": [None, {"nope": 1}, {"type": ""}]}), [])
ok("node_types 容忍空定义", flowdef.node_types({}), [])

# ---------------------------------------------------------------- 结果

for name, got, want in FAIL:
    print(f"✗ {name}\n    实际: {got!r}\n    期望: {want!r}")
print(f"\n{len(PASS)} 通过, {len(FAIL)} 失败")
sys.exit(1 if FAIL else 0)
