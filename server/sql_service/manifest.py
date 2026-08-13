"""sql.query 的节点定义。

服务自己持有 manifest，工作流引擎从 GET /registry/nodes 拉 —— 加一个节点
不用改引擎、不用重启、不用发版。

注意跟早期草稿的两处出入，都是被平台的真实行为逼出来的：
- 参数不叫「数据源」叫「引擎」：平台的概念就是 hive/doris/clickhouse。
- 「绑定参数」的说法收回了：平台不支持绑定，SQL 是拼出来的，服务端按类型
  渲染成字面量（见 sqlparams.py）。对用户来说写法不变，但这不是数据库的
  bind，所以描述里要说实话。
"""
from typing import Any, Dict

from . import wecom
from .datalego import ENGINES

SQL_QUERY: Dict[str, Any] = {
    "type": "sql.query",
    "typeVersion": "2.0.0",
    "name": "SQL 查询",
    "category": "数据查询",
    "icon": "▤",
    "description": "在数据平台上跑只读 SQL，参数由服务端按类型渲染，不做字符串拼接",
    "input": {
        "type": "object",
        "required": ["engine", "sql"],
        "properties": {
            "engine": {
                "type": "string",
                "title": "引擎",
                "default": "hive",
                "enum": list(ENGINES),
                "x-ui": {"widget": "select", "optionsFrom": "sql.engines"},
            },
            "sql": {
                "type": "string",
                "title": "SQL",
                "description": "只读语句。占位符写 {{name}} 或 :name，同名流程入参会自动代入",
                # 裸 {{name}} 由本服务渲染，前端别碰；值从兄弟字段 params 取
                "x-placeholders": {"valuesFrom": "params"},
                "x-ui": {
                    "widget": "code",
                    "language": "sql",
                    "rows": 8,
                    "placeholder": "SELECT vid, name FROM ods.vendor WHERE vid = {{vid}}",
                },
            },
            "params": {
                "type": "object",
                "title": "占位符参数",
                "description": "只在需要覆盖时填。留空则同名流程入参自动代入",
                "additionalProperties": True,
                "x-ui": {"widget": "kv"},
            },
            "limit": {
                "type": "integer",
                "title": "行数上限",
                "default": 1000,
                "minimum": 1,
                "maximum": 100000,
                "description": "外面套一层 LIMIT，防止 SELECT * 打满引擎",
            },
            "queue": {
                "type": "string",
                "title": "队列",
                "default": "share",
                "x-ui": {"widget": "text"},
                # Hive 才有队列概念，另外两个引擎不用显示这个字段
                "x-show": {"engine": ["hive"]},
            },
            "creator": {
                "type": "string",
                "title": "记账邮箱",
                "description": "只影响平台上的执行人显示，不影响查询权限",
                "x-ui": {"placeholder": "someone@agora.io"},
            },
        },
    },
    "output": {
        "type": "object",
        # 列名运行时才知道 —— 试运行探测一次，把真实列缓存到节点实例供下游提示
        "x-dynamic": "probe",
        "properties": {
            "rows": {"type": "array", "title": "结果行", "items": {"type": "object"}, "x-large": True},
            # 名字要说实话：SQL 是被包了一层 LIMIT 才执行的，平台永远不会返回
            # 超过上限的行，所以这是"取回了几行"，不是"匹配了几行"。想拿真实
            # 总数得再发一个 COUNT 任务。用户拿它写"共 N 条"发群前得知道这点。
            "rowCount": {
                "type": "integer",
                "title": "返回行数",
                "description": "实际取回的行数（已受行数上限截断），不是匹配总数。truncated 为真时二者不相等",
            },
            "columns": {"type": "array", "title": "列信息", "items": {"type": "object"}},
            "truncated": {"type": "boolean", "title": "是否触到行数上限"},
            "jobId": {"type": "string", "title": "平台任务 ID"},
            "renderedSql": {"type": "string", "title": "实际执行的 SQL"},
        },
    },
    "runtime": {
        # 异步节点：submit 秒回 handle，引擎自己轮询。
        # Hive 慢查询跑几分钟，同步等必然撞网关超时，也会占死 worker。
        "kind": "http-async",
        "submit": "POST /nodes/sql.query/submit",
        "poll": "GET /nodes/sql.query/poll",
        "cancel": "POST /nodes/sql.query/cancel",
        "probe": "POST /nodes/sql.query/probe",
        "pollIntervalMs": 3000,
    },
    "policy": {
        "idempotent": True,
        "dryRunnable": True,
        "cancellable": True,
        "retry": {"maxAttempts": 2, "backoff": "exponential", "initialMs": 2000},
    },
}

NOTIFY_WECOM: Dict[str, Any] = {
    "type": "notify.wecom",
    "typeVersion": "1.0.0",
    "name": "企微通知",
    "category": "输出",
    "icon": "✉",
    "description": "推到企微群。填群机器人的 webhook 地址",
    "ports": [],
    "input": {
        "type": "object",
        "required": ["webhook", "msgtype", "content"],
        "properties": {
            "webhook": {
                "type": "string",
                "title": "Webhook 地址",
                "description": "群设置 → 群机器人 → 添加后复制。等同凭证，流程定义要当凭证管",
                "x-ui": {
                    "placeholder": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx",
                },
            },
            "msgtype": {
                "type": "string",
                "title": "消息类型",
                "default": "markdown_v2",
                "enum": list(wecom.MSGTYPES),
                "description": "要发表格必须用 markdown_v2；要 @人只能用 text 或 markdown",
                "x-ui": {"widget": "select"},
            },
            "content": {
                "type": "string",
                "title": "内容",
                # 描述写给新手看：先说怎么用，别一上来甩一串过滤器语法。
                # 过滤器的完整清单在下面的选列器和预览里都能看到。
                "description": "点下面的「插入表格」把查询结果放进来，不用手写表达式",
                "x-ui": {
                    "widget": "textarea",
                    "rows": 10,
                    # 选列器 + 实时预览。用户不用手敲节点 id、路径和过滤器名 ——
                    # 那三样是手敲最容易错的地方，而且错了都是静默的
                    "inserters": ["table", "message"],
                    "placeholder": (
                        "## 卡顿排查结果\n"
                        "共 {{ $.nodes.n2.output.rowCount }} 条\n\n"
                        "{{ $.nodes.n2.output.rows | table(uid, avg_dc, cnt_dc) }}"
                    ),
                },
            },
            "mentioned": {
                "type": "string",
                "title": "@成员",
                "description": "userid 或手机号，逗号分隔；@all 是全体。markdown_v2 不支持",
                "x-hide": {"msgtype": ["markdown_v2"]},
                "x-ui": {"placeholder": "zhangsan, 13800001111"},
            },
        },
    },
    "output": {
        "type": "object",
        "properties": {
            "sent": {"type": "boolean", "title": "是否已发出"},
            "bytes": {"type": "integer", "title": "内容字节数"},
            "target": {"type": "string", "title": "目标（key 已打码）"},
        },
    },
    "runtime": {
        # 发消息是秒级的，一次请求拿结果，不用轮询
        "kind": "http",
        "execute": "POST /nodes/notify.wecom/execute",
    },
    "policy": {
        # 非幂等：重试会重复发。真实引擎重试前必须带幂等键。
        # 也没有 dryRun 了 —— 跑到这个节点就是真发，编辑器里的实时预览
        # 负责"发之前先看看"。
        "idempotent": False,
    },
}

ALL = [SQL_QUERY, NOTIFY_WECOM]
