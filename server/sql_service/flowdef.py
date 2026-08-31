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
# 入参能落成的 JSON Schema 类型。前端的「日期」「下拉」是 string 加 format / enum
INPUT_TYPES = {"string", "integer", "number", "boolean"}

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
        # 节点设置（备注 / 暂停 / 重试覆盖）。只判类型 —— 语义（暂停的节点下游引用
        # 报错、控制节点不能暂停）在引擎里，这里不重复一份会漂移的规则
        if node.get("note") is not None and not isinstance(node["note"], str):
            raise FlowDefError(f"nodes[{i}].note 必须是字符串")
        if node.get("disabled") is not None and not isinstance(node["disabled"], bool):
            raise FlowDefError(f"nodes[{i}].disabled 必须是布尔值")
        if "retry" in node and node["retry"] is not None:
            retry = _obj(node["retry"], f"nodes[{i}].retry")
            for key in ("maxAttempts", "initialMs"):
                v = retry.get(key)
                if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float))):
                    raise FlowDefError(f"nodes[{i}].retry.{key} 必须是数字")

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
        inputs = _obj(raw["inputs"], "inputs")
        props = inputs.get("properties")
        if props is not None:
            # 入参的种类（日期 / 下拉 / 小数）落到这里是 string + format / enum / number。
            # type 必须是 JSON Schema 认得的，否则 webhook 的类型转换会静默把它当字符串
            for key, schema in _obj(props, "inputs.properties").items():
                schema = _obj(schema, f"inputs.properties.{key}")
                t = schema.get("type")
                if t is not None and t not in INPUT_TYPES:
                    raise FlowDefError(
                        f"inputs.properties.{key}.type 只能是 {' / '.join(sorted(INPUT_TYPES))}，收到 {t!r}"
                    )
                if schema.get("enum") is not None and not isinstance(schema["enum"], list):
                    raise FlowDefError(f"inputs.properties.{key}.enum 必须是数组")
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


def trigger_kind(value: Any) -> str:
    """这条流程怎么触发。**正本是画布上的入口节点，顶层 trigger.kind 只是推导缓存。**

    老版编辑器把节点推导成顶层字段时漏了 webhook 那一支（落进 else 写成
    manual）。前端早修好了，但**修复前存下的草稿顶层字段一直是错的** ——
    不重新打开保存一次就永远不会自愈，而受害的流程恰恰是"配完就不再动"的
    那种。症状全部静默且全在列表页：标签写「手动触发」、按 Webhook 筛不出、
    启停开关不出现；webhook 本身照常触发（handle 显式传 trigger_kind 给
    create_run，从不读这个字段），所以没人会从运行侧发现。

    所以读取时一律从节点推导，顶层字段只作没有触发节点时的兜底。
    不改存量数据：改数据要在迁移里重演一遍前端的推导规则，那份规则漂了
    才有的这个坑。
    """
    for node in (value or {}).get("nodes", []) or []:
        if isinstance(node, dict):
            t = node.get("type")
            if isinstance(t, str) and t.startswith("trigger."):
                kind = t.split(".", 1)[1]
                # 后缀不是已知 kind（将来新增触发器类型时）就继续走兜底，
                # 别把一个界面认不得的值塞给列表页
                if kind in TRIGGER_KINDS:
                    return kind
    return ((value or {}).get("trigger") or {}).get("kind") or "manual"


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
