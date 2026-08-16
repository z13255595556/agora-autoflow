"""流程定义的服务端校验。

**服务端不信任客户端提交的定义。** 前端有一份 normalizeFlowDefinition
（src/lib/flowImport.ts），但那是**给编辑器用的**：它的职责是"把外部 JSON 补齐
成能安全加载的样子"，缺字段就补默认值。

这里的职责不同 —— 它是完整性边界，**只拒绝，不修复**：

- 修复会静默改变用户提交的东西。前端补一个默认值用户马上就能在界面上看见；
  服务端补一个默认值则是悄悄存下一份和用户以为的不一样的定义。
- 两份"修复"逻辑必然漂移，而漂移的表现是"本地能存、线上存出来是另一个样"。
  types.ts 里已经为同一类问题写过一段注释：manifest 全量覆盖 registry 的注解
  "一上线就没，而且只在线上没，本地永远测不出来"。

所以这里的每条规则都是判定，不是转换。唯一的例外是 `version` —— 版本号由
服务端分配，客户端提交的一律忽略（否则谁都能声称自己是第 99 版）。
"""
import json
from typing import Any, Dict, List, Set

TRIGGER_KINDS = {"manual", "schedule", "webhook"}
ON_ERROR = {"fail", "continue"}

# 未认证的接口收 JSONB，必须有上限。
# 一条正常流程的定义是几十 KB 量级；1 MB 已经宽得离谱。
MAX_DEFINITION_BYTES = 1024 * 1024
# 单条 pin 数据的上限。pin 是**手写的调试数据**，不是查询结果 ——
# 大结果应该走试运行，而不是塞进流程定义跟着每次读写搬来搬去。
MAX_PIN_BYTES = 256 * 1024
MAX_NODES = 500


class FlowDefError(ValueError):
    """定义不合法。报文直接回给调用方，要能看懂是哪一处。"""


def _obj(value: Any, path: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise FlowDefError(f"{path} 必须是对象")
    return value


def _text(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise FlowDefError(f"{path} 必须是非空字符串")
    return value.strip()


def _sized(value: Any, limit: int, path: str) -> int:
    try:
        size = len(json.dumps(value, ensure_ascii=False).encode("utf-8"))
    except (TypeError, ValueError) as exc:
        raise FlowDefError(f"{path} 无法序列化成 JSON：{exc}")
    if size > limit:
        raise FlowDefError(f"{path} 有 {size // 1024} KB，超过 {limit // 1024} KB 上限")
    return size


def validate(value: Any) -> Dict[str, Any]:
    """校验一份流程定义，原样返回（不做任何修补）。

    返回的是**同一份数据**，不是清洗过的副本 —— 存进库里的必须就是用户提交的
    那一份，否则导出再导入会得到不同的东西。
    """
    _sized(value, MAX_DEFINITION_BYTES, "流程定义")
    raw = _obj(value, "流程定义")

    _text(raw.get("name"), "name")

    nodes = raw.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        raise FlowDefError("nodes 必须是非空数组")
    if len(nodes) > MAX_NODES:
        raise FlowDefError(f"节点数 {len(nodes)} 超过 {MAX_NODES} 上限")

    ids: Set[str] = set()
    for i, item in enumerate(nodes):
        node = _obj(item, f"nodes[{i}]")
        nid = _text(node.get("id"), f"nodes[{i}].id")
        if nid in ids:
            raise FlowDefError(f"nodes[{i}].id 与已有节点重复：{nid}")
        ids.add(nid)
        _text(node.get("type"), f"nodes[{i}].type")
        _text(node.get("typeVersion"), f"nodes[{i}].typeVersion")
        if node.get("params") is not None:
            _obj(node["params"], f"nodes[{i}].params")
        on_error = node.get("onError")
        if on_error is not None and on_error not in ON_ERROR:
            raise FlowDefError(
                f"nodes[{i}].onError 只能是 {' / '.join(sorted(ON_ERROR))}，收到 {on_error!r}"
            )

    edges = raw.get("edges", [])
    if not isinstance(edges, list):
        raise FlowDefError("edges 必须是数组")
    for i, item in enumerate(edges):
        edge = _obj(item, f"edges[{i}]")
        src = _text(edge.get("from"), f"edges[{i}].from")
        dst = _text(edge.get("to"), f"edges[{i}].to")
        # 悬空引用必须拒绝：存进去之后画布加载会炸，而那时候已经看不出是谁写坏的
        if src not in ids:
            raise FlowDefError(f"edges[{i}].from 引用了不存在的节点：{src}")
        if dst not in ids:
            raise FlowDefError(f"edges[{i}].to 引用了不存在的节点：{dst}")

    trigger = raw.get("trigger")
    if trigger is not None:
        kind = _obj(trigger, "trigger").get("kind")
        if kind not in TRIGGER_KINDS:
            raise FlowDefError(
                f"trigger.kind 只能是 {' / '.join(sorted(TRIGGER_KINDS))}，收到 {kind!r}"
            )

    if raw.get("inputs") is not None:
        _obj(raw["inputs"], "inputs")
    if raw.get("layout") is not None:
        _obj(raw["layout"], "layout")

    pin = raw.get("pinData")
    if pin is not None:
        for key, item in _obj(pin, "pinData").items():
            if key not in ids:
                raise FlowDefError(f"pinData 里的 {key} 不是这条流程的节点")
            _sized(item, MAX_PIN_BYTES, f"pinData[{key}]")

    return raw


def for_storage(value: Any, flow_id: str, version: int) -> Dict[str, Any]:
    """校验并钉上服务端分配的 id 与版本号。

    id 和 version **由服务端说了算**：客户端提交什么都不作数，否则谁都能声称
    自己是第 99 版，或者把定义写进别人的流程里。
    """
    raw = dict(validate(value))
    raw["id"] = flow_id
    raw["version"] = version
    return raw


def node_types(value: Any) -> List[str]:
    """定义里用到的节点类型，去重后按出现顺序。列表页展示和影响面分析都要用。"""
    out: List[str] = []
    seen: Set[str] = set()
    for node in (value or {}).get("nodes", []) or []:
        if not isinstance(node, dict):
            continue
        t = node.get("type")
        if isinstance(t, str) and t and t not in seen:
            seen.add(t)
            out.append(t)
    return out
