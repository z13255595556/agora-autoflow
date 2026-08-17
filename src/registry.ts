import type { NodeType } from './types'
// 带 .ts：outputShape.ts 要能被 node --test 跑，而它的值导入链要经过这里。
// 见 outputShape.ts 顶部的说明。
import { DATE_FORMATS, DATE_MODES, DATE_MODE_LABELS, dateFormatLabels } from './lib/datefn.ts'

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
          'x-ui': {
            widget: 'select',
            labels: { daily: '每天', hourly: '每小时', interval: '按间隔', cron: 'Cron 表达式' },
          },
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


  {
    type: 'trigger.webhook',
    typeVersion: '1.0.0',
    name: 'Webhook 触发',
    category: '触发器',
    icon: '🔗',
    description: '外部系统 POST 一下就运行，body 里的同名字段自动当流程入参',
    hasInput: false,
    input: {
      type: 'object',
      required: ['authMode'],
      properties: {
        authMode: {
          type: 'string',
          title: '认证方式',
          default: 'secret',
          enum: ['secret', 'hmac', 'none'],
          description: '路径里的 token 不是认证 —— 它会进日志、进上游配置文件',
          'x-ui': {
            widget: 'select',
            labels: {
              secret: '密钥请求头（推荐）',
              hmac: 'HMAC 签名（上游能算签名时用）',
              none: '不认证（仅限内网可信调用方）',
            },
          },
        },
        responseMode: {
          type: 'string',
          title: '响应方式',
          default: 'lastNode',
          enum: ['lastNode', 'immediate'],
          description: '等待模式直接返回「结束」节点配置的流程结果；超时后返回 runId，流程继续运行',
          'x-ui': {
            widget: 'select',
            labels: {
              lastNode: '等待并返回流程结果',
              immediate: '立即返回运行 ID',
            },
          },
        },
        responseTimeoutSeconds: {
          type: 'integer',
          title: '最多等待（秒）',
          default: 300,
          minimum: 1,
          maximum: 1800,
          description: '超过后返回 202 和运行 ID，工作流仍会继续执行',
          'x-show': { responseMode: ['lastNode'] },
        },
        rateLimitPerMin: {
          type: 'integer',
          title: '每分钟最多触发',
          default: 60,
          minimum: 1,
          maximum: 600,
          description: '任何能 POST 的人都能触发一条 Hive 查询，这道闸不能不设',
        },
      },
    },
    output: {
      type: 'object',
      properties: {
        body: { type: 'object', title: '请求体（原样）' },
        headers: { type: 'object', title: '请求头', 'x-output-ui': { group: 'advanced' } },
        remoteIp: { type: 'string', title: '来源 IP', 'x-output-ui': { group: 'run' } },
        receivedAt: { type: 'string', title: '接收时间', 'x-output-ui': { group: 'run' } },
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
          description: '键入 "/" 增加变量',
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
        // 这里曾经有个「记账邮箱」(creator)。**故意删掉的**：数据平台按 creator
        // 裁决查询权限，而节点参数是编流程的人随手填的字符串，留着它等于谁都能
        // 以别人的权限查数。现在由服务端从登录 cookie 解出来（identity.py），
        // 前端既看不到也改不了 —— 后端 manifest 那份也一并去掉了，两边必须一致。
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
    description: '按条件判定走 true / false 两个出口',
    ports: [
      { id: 'true', label: '真' },
      { id: 'false', label: '假' },
    ],
    // 条件不走 required：它有两种合法写法（条件行 / 老的表达式），
    // 通用的必填校验表达不了"两个里有一个就行"，交给 validateNode 单独查
    input: {
      type: 'object',
      properties: {
        conditions: {
          type: 'object',
          title: '条件',
          // expressionFrom：这个控件顺带编辑 condition 那个兄弟字段
          //（和 x-placeholders.valuesFrom 一个套路），SchemaForm 据此不再单独画它
          'x-ui': { widget: 'conditions', expressionFrom: 'condition' },
        },
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
    output: {
      type: 'object',
      properties: {
        // 分支按**入边顺序**显示来源节点名，用户不用面对 branches[0]。
        // 前提是 engine 那边用 map 不是 flatMap（没跑的分支留 null 占位），
        // 否则下标和入边对不上，名字会贴到别人的数据上。
        branches: {
          type: 'array', title: '各分支输出', items: { type: 'object' },
          'x-output-ui': { itemLabelFrom: 'sourceNodeName' },
        },
      },
    },
  },
  {
    type: 'flow.end',
    typeVersion: '1.0.0',
    name: '结束',
    category: '控制',
    icon: '■',
    description: '结束当前分支，并把指定内容作为流程结果',
    ports: [],
    input: {
      type: 'object',
      properties: {
        result: {
          type: 'string',
          title: '流程结果',
          description: '可以输入固定文本，也可以输入 / 引用上游变量',
          'x-ui': { widget: 'textarea', rows: 5, placeholder: '/ 选择上游输出' },
        },
      },
    },
    // ports: [] 已经让它连不出去，upstreamNodes 永远到不了它；
    // notASource 是给全流程「变量」通讯录那种不按边走的清单用的
    output: {
      type: 'object',
      properties: { result: { title: '流程结果' } },
      'x-output-ui': { notASource: true },
    },
    policy: { idempotent: true },
  },

  // ---------------------------------------------------------------- 处理
  //
  // 纯前端节点：算日期不需要任何服务，所以没有 runtime，后端上线后也一样跑
  // mock 分支（见 engine.mockOutput）。
  {
    type: 'date.compute',
    typeVersion: '1.0.0',
    name: '日期计算',
    category: '处理',
    icon: '📅',
    description: '选出昨天 / 本月 1 号这类日期，一次给出 yyyyMMdd、时间戳等各种格式，下游直接引用',
    input: {
      type: 'object',
      required: ['mode', 'format'],
      'x-ui': { preview: 'date' },
      properties: {
        mode: {
          type: 'string',
          title: '要哪个时间',
          default: 'yesterday',
          enum: DATE_MODES,
          description: '基准是本次运行的开始时刻，一条流程里所有日期节点同源，不会跨零点算差一天',
          'x-ui': { widget: 'select', labels: DATE_MODE_LABELS },
        },
        days: {
          type: 'integer',
          title: '几天前',
          default: 7,
          minimum: 1,
          maximum: 3650,
          'x-show': { mode: ['daysAgo'] },
        },
        hours: {
          type: 'integer',
          title: '几小时前',
          default: 1,
          minimum: 1,
          maximum: 8760,
          'x-show': { mode: ['hoursAgo'] },
        },
        expr: {
          type: 'string',
          title: '自定义偏移',
          default: 'now-1d/d',
          description:
            'Grafana / Kibana 同款写法：now-1d 昨天此刻，now-1d/d 昨天零点，now/w 本周一，now-1M/M 上月 1 号。单位 s/m/h/d/w/M/y（m 是分钟，M 是月）',
          'x-show': { mode: ['custom'] },
          'x-ui': { widget: 'text', placeholder: 'now-1d/d' },
        },
        format: {
          type: 'string',
          title: '输出格式',
          default: 'compact',
          enum: DATE_FORMATS,
          description: '这个格式出现在 value 里。其它常用格式一并输出，不用为此多摆一个节点',
          'x-ui': { widget: 'select', labels: dateFormatLabels() },
        },
        customFormat: {
          type: 'string',
          title: '自定义格式',
          description: "token：yyyy MM dd HH mm ss SSS，其余字符原样输出；要输出会撞 token 的字母用单引号括起来",
          'x-show': { format: ['custom'] },
          'x-ui': { widget: 'text', placeholder: 'yyyy年MM月dd日' },
        },
      },
    },
    output: {
      type: 'object',
      properties: {
        value: { type: 'string', title: '结果（按所选格式）' },
        compact: { type: 'string', title: '紧凑 20260812' },
        date: { type: 'string', title: '日期 2026-08-12' },
        datetime: { type: 'string', title: '日期时间 2026-08-12 00:00:00' },
        time: { type: 'string', title: '时间 00:00:00' },
        month: { type: 'string', title: '月份 202608' },
        iso: { type: 'string', title: 'ISO 串（UTC）' },
        unix: { type: 'integer', title: '时间戳（秒）' },
        weekday: { type: 'string', title: '星期几' },
        // 等价偏移是调试用的，日常取值不该和「日期」「时间戳」并排显示
        expr: { type: 'string', title: '等价偏移表达式', 'x-output-ui': { group: 'advanced' } },
      },
    },
    policy: { idempotent: true },
  },
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
    type: 'transform.template',
    typeVersion: '1.0.0',
    name: '模板转换',
    category: '处理',
    icon: 'T',
    description: '把固定文本和上游变量组合成一段文本',
    input: {
      type: 'object',
      required: ['template'],
      properties: {
        template: {
          type: 'string',
          title: '模板',
          description: '输入 / 可直接选择上游变量',
          'x-ui': { widget: 'textarea', rows: 8, placeholder: '查询到 {{ $.nodes.n2.output.rowCount }} 条数据' },
        },
      },
    },
    output: { type: 'object', properties: { text: { type: 'string', title: '转换后的文本' } } },
    policy: { idempotent: true },
  },
  {
    type: 'variable.assign',
    typeVersion: '1.0.0',
    name: '变量赋值',
    category: '处理',
    icon: '=',
    description: '集中定义一组供下游使用的变量',
    input: {
      type: 'object',
      properties: {
        values: {
          type: 'object',
          title: '变量',
          description: '值支持输入 / 引用上游输出',
          additionalProperties: true,
          'x-ui': { widget: 'kv' },
        },
      },
    },
    output: {
      type: 'object',
      properties: {
        // spread：取值面板把用户起的变量名当一级字段画，不画 values 这一层。
        // 路径不变（仍是 $.nodes.v1.output.values.customerId），只是不让用户
        // 面对一个叫「变量集合」的空壳 —— 他起的名字才是他认得的东西。
        values: { type: 'object', title: '变量集合', 'x-output-ui': { spread: true } },
      },
    },
    policy: { idempotent: true },
  },
  {
    type: 'list.operation',
    typeVersion: '1.0.0',
    name: '列表处理',
    category: '处理',
    icon: '≡',
    description: '从数组中取第一项、最后一项或指定区间',
    input: {
      type: 'object',
      required: ['items', 'operation'],
      properties: {
        items: {
          type: 'string',
          title: '输入列表',
          description: '输入 / 选择一个数组变量',
          'x-ui': { widget: 'text', placeholder: '/ 选择上游数组' },
        },
        operation: {
          type: 'string',
          title: '操作',
          default: 'slice',
          enum: ['first', 'last', 'slice'],
          'x-ui': { widget: 'select', labels: { first: '取第一项', last: '取最后一项', slice: '截取区间' } },
        },
        start: { type: 'integer', title: '开始位置', default: 0, minimum: 0, 'x-show': { operation: ['slice'] } },
        count: { type: 'integer', title: '取几项', default: 10, minimum: 1, 'x-show': { operation: ['slice'] } },
      },
    },
    output: {
      type: 'object',
      properties: {
        result: { title: '处理结果' },
        count: { type: 'integer', title: '结果项数' },
      },
    },
    policy: { idempotent: true },
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
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
          'x-ui': { widget: 'select' },
        },
        url: { type: 'string', title: 'URL', 'x-ui': { placeholder: 'https://svc.internal/api/...' } },
        query: { type: 'object', title: '查询参数', additionalProperties: true, 'x-ui': { widget: 'kv' } },
        authType: {
          type: 'string', title: '认证', default: 'none',
          enum: ['none', 'bearer', 'basic', 'header'],
          'x-ui': { widget: 'select', labels: { none: '无', bearer: 'Bearer Token', basic: 'Basic Auth', header: '自定义请求头' } },
        },
        bearerToken: { type: 'string', title: 'Token', 'x-ui': { secret: true }, 'x-show': { authType: ['bearer'] } },
        basicUsername: { type: 'string', title: '用户名', 'x-show': { authType: ['basic'] } },
        basicPassword: { type: 'string', title: '密码', 'x-ui': { secret: true }, 'x-show': { authType: ['basic'] } },
        authHeaderName: { type: 'string', title: '认证请求头名', 'x-show': { authType: ['header'] } },
        authHeaderValue: { type: 'string', title: '认证请求头值', 'x-ui': { secret: true }, 'x-show': { authType: ['header'] } },
        headers: { type: 'object', title: '请求头', additionalProperties: true, 'x-ui': { widget: 'kv', sensitiveKeys: true } },
        bodyType: {
          type: 'string', title: '请求体类型', default: 'none',
          enum: ['none', 'json', 'raw', 'form-urlencoded'],
          'x-ui': { widget: 'select', labels: { none: '无', json: 'JSON', raw: '纯文本', 'form-urlencoded': '表单 URL 编码' } },
        },
        body: {
          type: 'string', title: '请求体',
          'x-ui': { widget: 'code', language: 'json', rows: 6 },
          'x-show': { bodyType: ['json', 'raw'] },
        },
        formBody: {
          type: 'object', title: '表单字段', additionalProperties: true, 'x-ui': { widget: 'kv' },
          'x-show': { bodyType: ['form-urlencoded'] },
        },
        timeoutMs: {
          type: 'integer', title: '默认超时(ms)', default: 30000, minimum: 1, maximum: 120000,
          description: '连接和读取未单独设置时使用',
        },
        connectTimeoutMs: { type: 'integer', title: '连接超时(ms)', minimum: 1, maximum: 120000 },
        readTimeoutMs: { type: 'integer', title: '读取超时(ms)', minimum: 1, maximum: 120000 },
        allowHttpErrors: {
          type: 'boolean',
          title: '接受错误状态码',
          default: false,
          description: '打开后，4xx / 5xx 仍作为正常输出交给下游处理',
          'x-ui': { widget: 'switch' },
        },
        verifySsl: {
          type: 'boolean', title: '校验 SSL 证书', default: true,
          description: '仅在调用自签名证书服务时关闭', 'x-ui': { widget: 'switch' },
        },
        retryEnabled: {
          type: 'boolean', title: '失败后重试', default: false,
          description: '仅重试网络错误、429 和常见 5xx；POST 等非幂等请求请谨慎开启',
          'x-ui': { widget: 'switch' },
        },
        maxRetries: {
          type: 'integer', title: '最多重试次数', default: 2, minimum: 1, maximum: 5,
          'x-show': { retryEnabled: [true] },
        },
        retryIntervalMs: {
          type: 'integer', title: '重试间隔(ms)', default: 500, minimum: 0, maximum: 10000,
          'x-show': { retryEnabled: [true] },
        },
      },
    },
    output: {
      type: 'object',
      'x-dynamic': 'run',
      properties: {
        status: { type: 'integer', title: '状态码' },
        body: { title: '响应体' },
        headers: { type: 'object', title: '响应头' },
        url: { type: 'string', title: '最终 URL' },
        attempts: { type: 'integer', title: '请求尝试次数' },
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

  // ---------------------------------------------------------------- 画布辅助
  {
    type: 'canvas.note',
    typeVersion: '1.0.0',
    name: '便签',
    category: '辅助',
    icon: 'N',
    description: '在画布上记录说明、约定和待办，不参与流程执行',
    visualOnly: true,
    ports: [],
    input: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          title: '内容',
          default: '',
          'x-ui': { widget: 'textarea', rows: 6, placeholder: '写点说明…' },
        },
        theme: {
          type: 'string',
          title: '颜色',
          default: 'yellow',
          enum: ['yellow', 'blue', 'green', 'pink', 'gray'],
          'x-ui': { widget: 'select' },
        },
      },
    },
    output: { type: 'object', properties: {} },
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

export const CATEGORY_ORDER = ['触发器', '数据查询', '控制', '处理', '输出', '辅助']

export const CATEGORY_COLOR: Record<string, string> = {
  触发器: '#d97706',
  数据查询: '#2563eb',
  控制: '#7c3aed',
  处理: '#0d9488',
  输出: '#e11d48',
  辅助: '#64748b',
}

export function portsOf(t: NodeType) {
  return t.ports ?? [{ id: 'out', label: '' }]
}
