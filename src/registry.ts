import type { NodeType } from './types'

/**
 * 节点注册表（空壳期写死在前端）。
 * 正式版本由各个内部服务自行上报 manifest，前端只从 GET /registry/nodes 拉。
 */
export const NODE_TYPES: NodeType[] = [
  // ---------------------------------------------------------------- 触发器
  {
    type: 'trigger.manual',
    typeVersion: '1.0.0',
    name: '手动触发',
    category: '触发器',
    icon: '▶',
    description: '按流程入参表单手动发起一次运行',
    hasInput: false,
    input: { type: 'object', properties: {} },
    output: {
      type: 'object',
      properties: {
        runId: { type: 'string', title: '运行 ID' },
        startedAt: { type: 'string', title: '开始时间' },
      },
    },
  },

  {
    type: 'trigger.schedule',
    typeVersion: '1.0.0',
    name: '定时触发',
    category: '触发器',
    icon: '⏰',
    description: '按固定时间自动发起运行，不用人盯着',
    hasInput: false,
    input: {
      type: 'object',
      required: ['mode'],
      properties: {
        mode: {
          type: 'string',
          title: '执行频率',
          default: 'daily',
          enum: ['daily', 'hourly', 'interval', 'cron'],
          description: '大多数报表选「每天」就够了',
          'x-ui': { widget: 'select' },
        },
        at: {
          type: 'string',
          title: '每天几点',
          default: '09:00',
          description: '24 小时制，服务器时区',
          'x-show': { mode: ['daily'] },
          'x-ui': { placeholder: '09:00' },
        },
        minute: {
          type: 'integer',
          title: '每小时第几分钟',
          default: 0,
          minimum: 0,
          maximum: 59,
          'x-show': { mode: ['hourly'] },
        },
        everyMinutes: {
          type: 'integer',
          title: '间隔分钟数',
          default: 30,
          minimum: 1,
          maximum: 1440,
          'x-show': { mode: ['interval'] },
        },
        cron: {
          type: 'string',
          title: 'Cron 表达式',
          description: '五段式：分 时 日 月 周。例：0 9 * * 1 = 每周一 09:00',
          'x-show': { mode: ['cron'] },
          'x-ui': { placeholder: '0 9 * * 1' },
        },
      },
    },
    output: {
      type: 'object',
      properties: {
        runId: { type: 'string', title: '运行 ID' },
        startedAt: { type: 'string', title: '开始时间' },
        scheduledFor: { type: 'string', title: '计划执行时间' },
      },
    },
  },

  // ---------------------------------------------------------------- 数据查询
  // 后端在线时这份会被 GET /registry/nodes 上报的 manifest 整个覆盖。
  // 字段必须和 server/sql_service/manifest.py 对齐 —— 不一致的话离线配出来的
  // 参数会被原样存进流程定义，等后端一上线就成了它不认识的字段。
  {
    type: 'sql.query',
    typeVersion: '2.0.0',
    name: 'SQL 查询',
    category: '数据查询',
    icon: '▤',
    description: '在数据平台上跑只读 SQL，参数由服务端按类型渲染，不做字符串拼接',
    input: {
      type: 'object',
      required: ['engine', 'sql'],
      properties: {
        engine: {
          type: 'string',
          title: '引擎',
          default: 'hive',
          enum: ['hive', 'doris', 'clickhouse'],
          'x-ui': { widget: 'select', optionsFrom: 'sql.engines' },
        },
        sql: {
          type: 'string',
          title: 'SQL',
          description: '只读语句。占位符写 {{name}} 或 :name，同名流程入参会自动代入',
          'x-placeholders': { valuesFrom: 'params' },
          'x-ui': {
            widget: 'code',
            language: 'sql',
            rows: 8,
            placeholder: 'SELECT vid, name FROM ods.vendor WHERE vid = {{vid}}',
          },
        },
        params: {
          type: 'object',
          title: '占位符参数',
          description: '只在需要覆盖时填。留空则同名流程入参自动代入',
          additionalProperties: true,
          'x-ui': { widget: 'kv' },
        },
        limit: {
          type: 'integer',
          title: '行数上限',
          default: 1000,
          minimum: 1,
          maximum: 100000,
          description: '外面套一层 LIMIT，防止 SELECT * 打满引擎',
        },
        queue: { type: 'string', title: '队列', default: 'share', 'x-show': { engine: ['hive'] }, 'x-ui': { widget: 'text' } },
        creator: {
          type: 'string',
          title: '记账邮箱',
          description: '只影响平台上的执行人显示，不影响查询权限',
          'x-ui': { placeholder: 'someone@agora.io' },
        },
      },
    },
    output: {
      type: 'object',
      'x-dynamic': 'probe',
      properties: {
        rows: { type: 'array', title: '结果行', items: { type: 'object' }, 'x-large': true },
        rowCount: {
          type: 'integer',
          title: '返回行数',
          description: '实际取回的行数（已受行数上限截断），不是匹配总数',
        },
        columns: { type: 'array', title: '列信息', items: { type: 'object' } },
        truncated: { type: 'boolean', title: '是否触到行数上限' },
        jobId: { type: 'string', title: '平台任务 ID' },
        renderedSql: { type: 'string', title: '实际执行的 SQL' },
      },
    },
    policy: {
      idempotent: true,
      cancellable: true,
      retry: { maxAttempts: 2, backoff: 'exponential', initialMs: 2000 },
    },
  },
  // Kibana 检索 / Grafana 指标暂时下架（按需求临时移除）。
  // 要恢复的话，节点定义在 git 历史里，engine.mockOutput 的对应分支也一起删了。

  // ---------------------------------------------------------------- 控制
  {
    type: 'flow.if',
    typeVersion: '1.0.0',
    name: '条件分支',
    category: '控制',
    icon: '◇',
    description: '按表达式结果走 true / false 两个出口',
    ports: [
      { id: 'true', label: '真' },
      { id: 'false', label: '假' },
    ],
    input: {
      type: 'object',
      required: ['condition'],
      properties: {
        condition: {
          type: 'string',
          title: '条件表达式',
          'x-ui': { widget: 'text', placeholder: '{{ $.nodes.n1.output.rowCount > 0 }}' },
        },
      },
    },
    output: { type: 'object', properties: { matched: { type: 'boolean', title: '命中分支' } } },
  },
  {
    type: 'flow.foreach',
    typeVersion: '1.0.0',
    name: '循环遍历',
    category: '控制',
    icon: '↻',
    description: '对数组逐项执行下游，必须设并发上限',
    ports: [
      { id: 'each', label: '每一项' },
      { id: 'done', label: '完成' },
    ],
    input: {
      type: 'object',
      required: ['items'],
      properties: {
        items: {
          type: 'string',
          title: '遍历对象',
          'x-ui': { widget: 'text', placeholder: '{{ $.nodes.n1.output.rows }}' },
        },
        concurrency: { type: 'integer', title: '并发上限', default: 5, minimum: 1, maximum: 50 },
        batchSize: { type: 'integer', title: '批大小', default: 1, minimum: 1 },
        continueOnItemError: { type: 'boolean', title: '单项失败继续', default: true, 'x-ui': { widget: 'switch' } },
      },
    },
    output: {
      type: 'object',
      properties: {
        results: { type: 'array', title: '各项结果', items: { type: 'object' }, 'x-large': true },
        okCount: { type: 'integer', title: '成功数' },
        failCount: { type: 'integer', title: '失败数' },
      },
    },
  },
  {
    type: 'flow.merge',
    typeVersion: '1.0.0',
    name: '汇合',
    category: '控制',
    icon: '⋈',
    description: '等待多条分支到齐后继续',
    input: {
      type: 'object',
      properties: {
        mode: { type: 'string', title: '模式', enum: ['all', 'any'], default: 'all', 'x-ui': { widget: 'select' } },
      },
    },
    output: { type: 'object', properties: { branches: { type: 'array', title: '各分支输出', items: { type: 'object' } } } },
  },

  // ---------------------------------------------------------------- 处理
  {
    type: 'transform.map',
    typeVersion: '1.0.0',
    name: '数据整形',
    category: '处理',
    icon: '⇄',
    description: '用表达式把上游输出改成下游要的形状',
    input: {
      type: 'object',
      required: ['expression'],
      properties: {
        expression: {
          type: 'string',
          title: '表达式',
          'x-ui': { widget: 'code', language: 'cel', rows: 6, placeholder: '{ "vids": $.nodes.n1.output.rows.map(r, r.vid) }' },
        },
      },
    },
    output: { type: 'object', properties: { value: { type: 'object', title: '整形结果' } } },
  },
  {
    type: 'http.request',
    typeVersion: '1.0.0',
    name: 'HTTP 调用',
    category: '处理',
    icon: '↗',
    description: '兜底节点，调用尚未包成节点的接口',
    input: {
      type: 'object',
      required: ['method', 'url'],
      properties: {
        method: {
          type: 'string', title: '方法', default: 'GET',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
          'x-ui': { widget: 'select' },
        },
        url: { type: 'string', title: 'URL', 'x-ui': { placeholder: 'https://svc.internal/api/...' } },
        headers: { type: 'object', title: '请求头', additionalProperties: true, 'x-ui': { widget: 'kv' } },
        body: {
          type: 'string', title: '请求体',
          'x-ui': { widget: 'code', language: 'json', rows: 6 },
          // n8n displayOptions.show 语义：method 是这三个之一才显示
          'x-show': { method: ['POST', 'PUT', 'PATCH'] },
        },
        timeoutMs: { type: 'integer', title: '超时(ms)', default: 30000 },
      },
    },
    output: {
      type: 'object',
      properties: {
        status: { type: 'integer', title: '状态码' },
        body: { type: 'object', title: '响应体' },
        headers: { type: 'object', title: '响应头' },
      },
    },
    policy: { idempotent: false },
  },

  // ---------------------------------------------------------------- 输出
  // 同样要和 server/sql_service/manifest.py 的 NOTIFY_WECOM 对齐
  {
    type: 'notify.wecom',
    typeVersion: '1.0.0',
    name: '企微通知',
    category: '输出',
    icon: '✉',
    description: '推到企微群。填群机器人的 webhook 地址',
    ports: [],
    input: {
      type: 'object',
      required: ['webhook', 'msgtype', 'content'],
      properties: {
        webhook: {
          type: 'string',
          title: 'Webhook 地址',
          description: '群设置 → 群机器人 → 添加后复制。等同凭证，流程定义要当凭证管',
          'x-ui': { placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx' },
        },
        msgtype: {
          type: 'string',
          title: '消息类型',
          default: 'markdown_v2',
          enum: ['text', 'markdown', 'markdown_v2'],
          description: '要发表格必须用 markdown_v2；要 @人只能用 text 或 markdown',
          'x-ui': { widget: 'select' },
        },
        content: {
          type: 'string',
          title: '内容',
          description: '点下面的「插入表格」把查询结果放进来，不用手写表达式',
          'x-ui': {
            widget: 'textarea',
            rows: 10,
            inserters: ['table', 'message'],
            placeholder: '## 卡顿排查结果\n共 {{ $.nodes.n2.output.rowCount }} 条\n\n{{ $.nodes.n2.output.rows | table(uid, avg_dc, cnt_dc) }}',
          },
        },
        mentioned: {
          type: 'string',
          title: '@成员',
          description: 'userid 或手机号，逗号分隔；@all 是全体。markdown_v2 不支持',
          'x-hide': { msgtype: ['markdown_v2'] },
          'x-ui': { placeholder: 'zhangsan, 13800001111' },
        },
      },
    },
    output: {
      type: 'object',
      properties: {
        sent: { type: 'boolean', title: '是否已发出' },
        bytes: { type: 'integer', title: '内容字节数' },
        target: { type: 'string', title: '目标（key 已打码）' },
      },
    },
    policy: { idempotent: false },
  },
]

/** 动态下拉的假数据。正式版走 GET /options/{key} */
export const MOCK_OPTIONS: Record<string, string[]> = {
  'sql.engines': ['hive', 'doris', 'clickhouse'],
}

/**
 * 生效的注册表。后端在线时用它上报的 manifest 覆盖同名的本地 mock —— 加节点
 * 靠服务发一份 JSON，不用改前端。这个 Map 是可变的，加载完由 store 里的
 * registryVersion 计数器触发重渲染。
 */
export const NODE_TYPE_MAP = new Map(NODE_TYPES.map((t) => [t.type, t]))

/** 后端上报的 manifest 覆盖进注册表，返回被覆盖/新增的类型名 */
export function applyBackendNodes(nodes: NodeType[]): string[] {
  const applied: string[] = []
  for (const t of nodes) {
    if (!t?.type) continue
    NODE_TYPE_MAP.set(t.type, t)
    const idx = NODE_TYPES.findIndex((x) => x.type === t.type)
    if (idx >= 0) NODE_TYPES[idx] = t
    else NODE_TYPES.push(t)
    applied.push(t.type)
  }
  return applied
}

/** 动态下拉的实际候选项：后端拉到的优先，否则退回 mock */
const optionCache = new Map<string, string[]>()

export function cachedOptions(key: string): string[] {
  return optionCache.get(key) ?? MOCK_OPTIONS[key] ?? []
}

export function setOptions(key: string, values: string[]) {
  optionCache.set(key, values)
}

export const CATEGORY_ORDER = ['触发器', '数据查询', '控制', '处理', '输出']

export const CATEGORY_COLOR: Record<string, string> = {
  触发器: '#d97706',
  数据查询: '#2563eb',
  控制: '#7c3aed',
  处理: '#0d9488',
  输出: '#e11d48',
}

export function portsOf(t: NodeType) {
  return t.ports ?? [{ id: 'out', label: '' }]
}
