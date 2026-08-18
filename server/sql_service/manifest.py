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
    "name": "DataLego SQL",
    "category": "数据查询",
    "icon": "▤",
    "description": "在 DataLego 数据平台上跑只读 SQL，参数由服务端按类型渲染，不做字符串拼接",
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
                "description": "键入 \"/\" 增加变量",
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
            # 这里曾经有个「记账邮箱」输入框（creator）。**故意删掉的**：
            # 平台按 creator 裁决数据权限，而节点参数是编流程的人随手填的字符串，
            # 留着它等于任何人都能以任何人的权限查数。现在由服务端从登录 cookie
            # 里解出来（identity.py），前端既看不到也改不了。
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

HTTP_REQUEST: Dict[str, Any] = {
    "type": "http.request",
    "typeVersion": "1.0.0",
    "name": "HTTP 调用",
    "category": "处理",
    "icon": "↗",
    "description": "由节点服务发起真实 HTTP 请求",
    "input": {
        "type": "object",
        "required": ["method", "url"],
        "properties": {
            "method": {
                "type": "string",
                "title": "方法",
                "default": "GET",
                "enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
                "x-ui": {"widget": "select"},
            },
            "url": {
                "type": "string",
                "title": "URL",
                "x-ui": {"placeholder": "https://svc.internal/api/..."},
            },
            "query": {
                "type": "object", "title": "查询参数", "additionalProperties": True,
                "x-ui": {"widget": "kv"},
            },
            "authType": {
                "type": "string", "title": "认证", "default": "none",
                "enum": ["none", "bearer", "basic", "header"],
                "x-ui": {"widget": "select", "labels": {
                    "none": "无", "bearer": "Bearer Token", "basic": "Basic Auth", "header": "自定义请求头",
                }},
            },
            "bearerToken": {"type": "string", "title": "Token", "x-ui": {"secret": True}, "x-show": {"authType": ["bearer"]}},
            "basicUsername": {"type": "string", "title": "用户名", "x-show": {"authType": ["basic"]}},
            "basicPassword": {"type": "string", "title": "密码", "x-ui": {"secret": True}, "x-show": {"authType": ["basic"]}},
            "authHeaderName": {"type": "string", "title": "认证请求头名", "x-show": {"authType": ["header"]}},
            "authHeaderValue": {"type": "string", "title": "认证请求头值", "x-ui": {"secret": True}, "x-show": {"authType": ["header"]}},
            "headers": {
                "type": "object",
                "title": "请求头",
                "additionalProperties": True,
                "x-ui": {"widget": "kv", "sensitiveKeys": True},
            },
            "bodyType": {
                "type": "string", "title": "请求体类型", "default": "none",
                "enum": ["none", "json", "raw", "form-urlencoded"],
                "x-ui": {"widget": "select", "labels": {
                    "none": "无", "json": "JSON", "raw": "纯文本", "form-urlencoded": "表单 URL 编码",
                }},
            },
            "body": {
                "type": "string",
                "title": "请求体",
                "x-ui": {"widget": "code", "language": "json", "rows": 6},
                "x-show": {"bodyType": ["json", "raw"]},
            },
            "formBody": {
                "type": "object", "title": "表单字段", "additionalProperties": True,
                "x-ui": {"widget": "kv"},
                "x-show": {"bodyType": ["form-urlencoded"]},
            },
            "timeoutMs": {
                "type": "integer",
                "title": "默认超时(ms)",
                "default": 30000,
                "minimum": 1,
                "maximum": 120000,
                "description": "连接和读取未单独设置时使用",
            },
            "connectTimeoutMs": {
                "type": "integer", "title": "连接超时(ms)", "minimum": 1, "maximum": 120000,
            },
            "readTimeoutMs": {
                "type": "integer", "title": "读取超时(ms)", "minimum": 1, "maximum": 120000,
            },
            "allowHttpErrors": {
                "type": "boolean",
                "title": "接受错误状态码",
                "default": False,
                "description": "打开后，4xx / 5xx 仍作为正常输出交给下游处理",
                "x-ui": {"widget": "switch"},
            },
            "verifySsl": {
                "type": "boolean", "title": "校验 SSL 证书", "default": True,
                "description": "仅在调用自签名证书服务时关闭", "x-ui": {"widget": "switch"},
            },
            "retryEnabled": {
                "type": "boolean", "title": "失败后重试", "default": False,
                "description": "仅重试网络错误、429 和常见 5xx；POST 等非幂等请求请谨慎开启",
                "x-ui": {"widget": "switch"},
            },
            "maxRetries": {
                "type": "integer", "title": "最多重试次数", "default": 2, "minimum": 1, "maximum": 5,
                "x-show": {"retryEnabled": [True]},
            },
            "retryIntervalMs": {
                "type": "integer", "title": "重试间隔(ms)", "default": 500, "minimum": 0, "maximum": 10000,
                "x-show": {"retryEnabled": [True]},
            },
        },
    },
    "output": {
        "type": "object",
        "x-dynamic": "run",
        "properties": {
            "status": {"type": "integer", "title": "状态码"},
            # JSON 响应是对象/数组，非 JSON 响应是字符串，因此不限定 type。
            "body": {"title": "响应体"},
            "headers": {"type": "object", "title": "响应头"},
            "url": {"type": "string", "title": "最终 URL"},
            "attempts": {"type": "integer", "title": "请求尝试次数"},
        },
    },
    "runtime": {
        "kind": "http",
        "execute": "POST /nodes/http.request/execute",
    },
    "policy": {"idempotent": False},
}

POSTGRES_WORKSPACE: Dict[str, Any] = {
    "type": "postgres.workspace",
    "typeVersion": "1.0.0",
    "name": "自建 PostgreSQL",
    "category": "数据查询",
    "icon": "▤",
    "description": "在你自己的隔离 PostgreSQL 工作区建表、增删改查；不访问 AutoFlow 系统数据库",
    "input": {
        "type": "object", "required": ["sql"],
        "properties": {
            "sql": {
                "type": "string", "title": "SQL",
                "description": "一次执行一条 SQL；可在个人工作区创建、查询和修改表",
                "x-placeholders": {"valuesFrom": "params"},
                "x-ui": {"widget": "code", "language": "sql", "rows": 8,
                           "placeholder": "CREATE TABLE report (id bigint, name text)"},
            },
            "params": {"type": "object", "title": "占位符参数", "additionalProperties": True, "x-ui": {"widget": "kv"}},
            "limit": {"type": "integer", "title": "返回行数上限", "default": 1000, "minimum": 1, "maximum": 1000},
        },
    },
    "output": {
        "type": "object",
        "properties": {
            "rows": {"type": "array", "title": "结果行", "items": {"type": "object"}, "x-large": True},
            "columns": {"type": "array", "title": "列信息", "items": {"type": "object"}},
            "rowCount": {"type": "integer", "title": "返回行数"},
            "affectedRows": {"type": "integer", "title": "影响行数"},
            "truncated": {"type": "boolean", "title": "是否截断"},
            "renderedSql": {"type": "string", "title": "实际执行的 SQL"},
        },
    },
    "runtime": {"kind": "http", "execute": "POST /nodes/postgres.workspace/execute"},
    "policy": {"idempotent": False},
}

ALL = [SQL_QUERY, POSTGRES_WORKSPACE, NOTIFY_WECOM, HTTP_REQUEST]
