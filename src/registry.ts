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
    keywords: ['手动', '点一下', '调试'],
    category: '触发器',
    icon: '▶',
    description: '手动跑一次',
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
    keywords: ['定时', '每天', '日报', 'cron', '排程', '工作日', '节假日', '调休'],
    category: '触发器',
    icon: '⏰',
    description: '按时间自动跑',
    hasInput: false,
    input: {
      type: 'object',
      required: ['mode'],
      // 接下来三次触发时刻的预览挂在整个表单上（和日期节点同一个机制）
      'x-ui': { preview: 'schedule' },
      properties: {
        mode: {
          type: 'string',
          title: '执行频率',
          default: 'daily',
          enum: ['daily', 'cnWorkday', 'cnHoliday', 'hourly', 'interval', 'cron'],
          'x-ui': {
            widget: 'select',
            labels: {
              daily: '每天',
              cnWorkday: '每个工作日',
              cnHoliday: '每个节假日',
              hourly: '每小时',
              interval: '按间隔',
              cron: 'Cron 表达式',
            },
          },
        },
        at: {
          type: 'string',
          title: '几点',
          default: '09:00',
          'x-show': { mode: ['daily', 'cnWorkday', 'cnHoliday'] },
          'x-ui': { placeholder: '09:00' },
        },
        timezone: {
          type: 'string',
          title: '时区',
          default: 'Asia/Shanghai',
          enum: ['Asia/Shanghai'],
          'x-ui': { widget: 'select', labels: { 'Asia/Shanghai': '北京时间（UTC+8）' }, group: 'advanced' },
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
          description: '五段：分 时 日 月 周，如 0 9 * * 1',
          'x-show': { mode: ['cron'] },
          'x-ui': { placeholder: '30 8 * * *' },
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
    keywords: ['接口触发', '外部调用', 'POST', 'http 入口'],
    category: '触发器',
    icon: '🔗',
    description: '外部 POST 触发',
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
          description: '路径 token 会进日志，不是认证',
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
          'x-show': { responseMode: ['lastNode'] },
          'x-ui': { group: 'advanced' },
        },
        rateLimitPerMin: {
          type: 'integer',
          title: '每分钟最多触发',
          default: 60,
          minimum: 1,
          maximum: 600,
          description: '能 POST 就能触发一次查询',
          'x-ui': { group: 'advanced' },
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
    name: 'DataLego SQL',
    keywords: ['查数', '取数', 'hive', 'doris', 'clickhouse', '数据平台', 'datalego'],
    docsUrl: 'https://github.com/z13255595556/agora-autoflow#sql-节点真实执行',
    category: '数据查询',
    icon: '▤',
    description: 'DataLego 只读 SQL',
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
          'x-placeholders': { valuesFrom: 'params' },
          'x-ui': {
            widget: 'code',
            language: 'sql',
            rows: 8,
            placeholder: 'SELECT vid, name FROM ods.vendor WHERE vid = {{vid}}\n\n键入 / 引用上游变量',
          },
        },
        params: {
          type: 'object',
          title: '占位符参数',
          additionalProperties: true,
          'x-ui': { widget: 'kv' },
        },
        limit: {
          type: 'integer',
          title: '行数上限',
          default: 1000,
          minimum: 1,
          maximum: 100000,
          description: '外层再套一层 LIMIT',
          'x-ui': { group: 'advanced' },
        },
        timeoutMinutes: {
          type: 'integer',
          title: '超时时间（分钟）',
          default: 15,
          minimum: 1,
          maximum: 120,
          'x-ui': { group: 'advanced' },
        },
        queue: { type: 'string', title: '队列', default: 'share', 'x-show': { engine: ['hive'] }, 'x-ui': { widget: 'text', group: 'advanced' } },
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
          description: '截断后行数，不是匹配总数',
        },
        columns: { type: 'array', title: '列信息', items: { type: 'object' } },
        truncated: { type: 'boolean', title: '是否触到行数上限' },
        jobId: { type: 'string', title: '平台任务 ID' },
        renderedSql: { type: 'string', title: '实际执行的 SQL' },
      },
    },
    policy: {
      idempotent: true,
      dryRunnable: true,
      cancellable: true,
      // worker 重试的唯一出处（以前 worker 另有一份写死的表，数字和这里对不上）。
      // 只在基础设施类错误（平台抖动、限流、超时）上重试；SQL 语法错重试一百次也一样。
      // 后端 manifest.py 是正本，这里是离线兜底 —— 两边必须一致，test/manifestParity 会查
      retry: { maxAttempts: 3, initialMs: 5000, backoffCoefficient: 2, maximumIntervalMs: 60_000 },
    },
  },
  {
    type: 'postgres.workspace',
    typeVersion: '1.0.0',
    name: '自建 PostgreSQL',
    keywords: ['建表', '存结果', '自建库', 'pg', 'postgres'],
    category: '数据查询',
    icon: '▤',
    description: '工作区库，不碰系统库',
    input: {
      type: 'object', required: ['sql'],
      properties: {
        sql: {
          type: 'string', title: 'SQL',
          'x-placeholders': { valuesFrom: 'params' },
          'x-ui': { widget: 'code', language: 'sql', rows: 8, placeholder: '一次一条。CREATE TABLE report (id bigint, name text)\n\n键入 / 引用上游变量' },
        },
        params: { type: 'object', title: '占位符参数', additionalProperties: true, 'x-ui': { widget: 'kv' } },
        limit: { type: 'integer', title: '返回行数上限', default: 1000, minimum: 1, maximum: 1000, 'x-ui': { group: 'advanced' } },
      },
    },
    output: {
      type: 'object',
      properties: {
        rows: { type: 'array', title: '结果行', items: { type: 'object' }, 'x-large': true },
        columns: { type: 'array', title: '列信息', items: { type: 'object' } },
        rowCount: { type: 'integer', title: '返回行数' },
        affectedRows: { type: 'integer', title: '影响行数' },
        truncated: { type: 'boolean', title: '是否截断' },
        renderedSql: { type: 'string', title: '实际执行的 SQL' },
      },
    },
    runtime: { kind: 'http', execute: 'POST /nodes/postgres.workspace/execute' },
    policy: {
      idempotent: false,
      // 自建库偶发连不上 / 超时值得等一下再试。执行接口带幂等键（服务端 24h 去重），
      // 重试不会把同一条 INSERT 写两遍
      retry: { maxAttempts: 3, initialMs: 2000, backoffCoefficient: 2, maximumIntervalMs: 30_000 },
    },
  },
  // Kibana 检索 / Grafana 指标暂时下架（按需求临时移除）。
  // 要恢复的话，节点定义在 git 历史里，engine.mockOutput 的对应分支也一起删了。

  // ---------------------------------------------------------------- 控制
  {
    type: 'flow.if',
    typeVersion: '1.0.0',
    name: '条件分支',
    keywords: ['判断', '分支', 'if', '条件'],
    category: '控制',
    icon: '◇',
    description: '真 / 假两个出口',
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
    keywords: ['遍历', '循环', '每个', '逐条', 'loop'],
    category: '控制',
    icon: '↻',
    description: '逐项串行，超 1000 失败',
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
          'x-ui': { widget: 'text', placeholder: '键入 / 引用上游变量，选一个数组' },
        },
        // 这里曾经有 concurrency / batchSize / continueOnItemError 三个「高级设置」。
        // **故意删掉的**：引擎和 worker 一行都没读过它们 —— 用户把并发调到 10
        // 期待快十倍，实际串行；把「单项失败继续」关掉，实际照样继续。
        // 假开关比没有开关更贵：它让用户以为问题已经解决了。
        // 并发、容错和收集结果一起做（docs/node-usability-design.md §3.18），
        // 做完再把字段加回来；老流程里残留的这三个参数无害（没人读，原样带着）。
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
    keywords: ['汇合', '合并', '等待', 'join'],
    category: '控制',
    icon: '⋈',
    description: '等分支到齐再继续',
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
    keywords: ['结束', '返回', '输出', '结果'],
    category: '控制',
    icon: '■',
    description: '结束分支并给出结果',
    ports: [],
    input: {
      type: 'object',
      properties: {
        result: {
          type: 'string',
          title: '流程结果',
          'x-ui': { widget: 'textarea', rows: 5, placeholder: '写固定文本，或键入 / 引用上游变量' },
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
    keywords: ['昨天', '日期', '时间', '分区', '今天', 'date'],
    category: '处理',
    icon: '📅',
    description: '算昨天、月初这类日期',
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
          description: '以本次运行开始时刻为基准',
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
          description: 'now-1d/d 昨天零点；m=分 M=月',
          'x-show': { mode: ['custom'] },
          'x-ui': { widget: 'text', placeholder: 'now-1d/d' },
        },
        format: {
          type: 'string',
          title: '输出格式',
          default: 'compact',
          enum: DATE_FORMATS,
          'x-ui': { widget: 'select', labels: dateFormatLabels() },
        },
        customFormat: {
          type: 'string',
          title: '自定义格式',
          description: 'yyyy MM dd HH mm ss；字面字母加单引号',
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
    keywords: ['整形', '表达式', '加工', '转换'],
    category: '处理',
    icon: '⇄',
    description: '把上游改成下游形状',
    input: {
      type: 'object',
      required: ['expression'],
      properties: {
        expression: {
          type: 'string',
          title: '表达式',
          'x-ui': { widget: 'code', language: 'cel', rows: 6, placeholder: '{ "vids": $.nodes.n1.output.rows.map(r, r.vid) }\n\n键入 / 引用上游变量' },
        },
      },
    },
    output: { type: 'object', properties: { value: { type: 'object', title: '整形结果' } } },
  },
  {
    type: 'transform.template',
    typeVersion: '1.0.0',
    name: '模板转换',
    keywords: ['模板', '拼文本', '正文', '渲染'],
    category: '处理',
    icon: 'T',
    description: '文本和变量拼成一段',
    input: {
      type: 'object',
      required: ['template'],
      properties: {
        template: {
          type: 'string',
          title: '模板',
          'x-ui': { widget: 'textarea', rows: 8, placeholder: '查询到 {{ $.nodes.n2.output.rowCount }} 条数据\n\n键入 / 引用上游变量' },
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
    keywords: ['变量', '赋值', '常量', '设置'],
    category: '处理',
    icon: '=',
    description: '定义下游可用的变量',
    input: {
      type: 'object',
      properties: {
        values: {
          type: 'object',
          title: '变量',
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
    keywords: ['列表', '截取', '第一项', '前几条'],
    category: '处理',
    icon: '≡',
    description: '取首项、末项或区间',
    input: {
      type: 'object',
      required: ['items', 'operation'],
      properties: {
        items: {
          type: 'string',
          title: '输入列表',
          'x-ui': { widget: 'text', placeholder: '键入 / 引用上游变量，选一个数组' },
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
    // 正本在 server/sql_service/manifest.py（CODE_PYTHON），这份是离线兜底 ——
    // 除 runtime 外逐字段镜像，test/manifestParity.test.ts 门禁。
    // 按惯例不写 runtime：后端在线时 applyBackendNodes 整份覆盖才有 runtime，
    // 离线时没有 runtime 就走 mockOutput，不会假装真的执行了代码
    type: 'code.python',
    typeVersion: '1.0.0',
    name: 'Python 代码',
    keywords: ['代码', 'python', '脚本', '加工', '分组', '统计', 'pandas'],
    category: '处理',
    icon: '🐍',
    description: '服务端执行 Python',
    input: {
      type: 'object',
      required: ['code'],
      properties: {
        // 数据进代码的唯一通道（Dify 同款做法）：数据走 JSON 进沙箱永远不会
        // 变成代码；代码里不出现 $.nodes.xxx，换上游只改映射
        inputs: {
          type: 'object', title: '输入变量',
          description: '代码只能通过 inputs 字典拿到这里的值',
          additionalProperties: true,
          'x-ui': { widget: 'kv' },
        },
        code: {
          type: 'string', title: '代码',
          default: 'def main(inputs):\n    # inputs 里是上面「输入变量」配的键\n    return {"result": None}\n',
          // ★ 红线：绝不模板插值，{{ }} 原样进沙箱 —— 否则 webhook body 可注入
          // Python（RCE）。引擎/校验/表单都认这个标记（types.ts 的 x-no-template）
          'x-no-template': true,
          description: '入口是 def main(inputs) -> dict',
          'x-ui': { widget: 'code', language: 'python', rows: 14 },
        },
        timeoutSeconds: {
          type: 'integer', title: '超时（秒）',
          default: 30, minimum: 1, maximum: 120,
          'x-ui': { group: 'advanced' },
        },
      },
    },
    output: {
      type: 'object',
      // main() 返回什么运行时才知道：跑一次学习（和 http.request 同一套机制）
      'x-dynamic': 'run',
      properties: {
        logs: { type: 'string', title: '运行日志（stdout/stderr）', 'x-output-ui': { group: 'run' } },
        durationMs: { type: 'integer', title: '执行耗时(ms)', 'x-output-ui': { group: 'run' } },
      },
    },
    policy: {
      idempotent: true,
      retry: { maxAttempts: 3, initialMs: 2000, backoffCoefficient: 2, maximumIntervalMs: 30_000 },
    },
  },
  {
    type: 'http.request',
    typeVersion: '1.0.0',
    name: 'HTTP 调用',
    keywords: ['接口', '调用', 'api', '请求', 'curl', 'rest'],
    docsUrl: 'https://github.com/z13255595556/agora-autoflow#http-调用节点真实请求',
    category: '处理',
    icon: '↗',
    description: '真实 HTTP 请求',
    input: {
      type: 'object',
      // 粘一段 curl 自动填参。声明在 manifest 里而不是表单里按 typeId 判断
      'x-ui': { importers: ['curl'] },
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
        // 超时 / SSL / 重试都是「配一次就不再动」的，折进高级设置。
        // 后端 manifest.py 是正本，这里只是离线兜底；两边必须一致（test/manifestParity）
        timeoutMs: {
          type: 'integer', title: '默认超时(ms)', default: 30000, minimum: 1, maximum: 120000,
          'x-ui': { group: 'advanced' },
        },
        connectTimeoutMs: { type: 'integer', title: '连接超时(ms)', minimum: 1, maximum: 120000, 'x-ui': { group: 'advanced' } },
        readTimeoutMs: { type: 'integer', title: '读取超时(ms)', minimum: 1, maximum: 120000, 'x-ui': { group: 'advanced' } },
        allowHttpErrors: {
          type: 'boolean',
          title: '接受错误状态码',
          default: false,
          description: '4xx/5xx 仍交给下游',
          'x-ui': { widget: 'switch' },
        },
        verifySsl: {
          type: 'boolean', title: '校验 SSL 证书', default: true,
          description: '自签名证书才关', 'x-ui': { widget: 'switch', group: 'advanced' },
        },
        // HTTP 的重试在节点内做，故意不声明 policy.retry —— 否则 worker 再叠一层
        // 就是 3 × (1 + maxRetries) 次请求，对非幂等的 POST 尤其危险
        retryEnabled: {
          type: 'boolean', title: '失败后重试', default: false,
          description: '仅网络错/429/5xx；非幂等慎开',
          'x-ui': { widget: 'switch', group: 'advanced' },
        },
        maxRetries: {
          type: 'integer', title: '最多重试次数', default: 2, minimum: 1, maximum: 5,
          'x-show': { retryEnabled: [true] }, 'x-ui': { group: 'advanced' },
        },
        retryIntervalMs: {
          type: 'integer', title: '重试间隔(ms)', default: 500, minimum: 0, maximum: 10000,
          'x-show': { retryEnabled: [true] }, 'x-ui': { group: 'advanced' },
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
    keywords: ['发群', '通知', '机器人', '报警', '企业微信', '推送'],
    docsUrl: 'https://github.com/z13255595556/agora-autoflow#企微通知节点真实发送',
    category: '输出',
    icon: '✉',
    description: '推消息到企微群',
    // 是「输出」类，但**不是**终点：通知可以发生在流程任意一步（跑完一段先播报，
    // 再接着查下一段）。省略 ports 就落到默认的单出口 out。
    input: {
      type: 'object',
      required: ['webhook', 'msgtype', 'content'],
      properties: {
        webhook: {
          type: 'string',
          title: 'Webhook 地址',
          description: '等同凭证',
          'x-ui': { placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx' },
        },
        msgtype: {
          type: 'string',
          title: '消息类型',
          default: 'markdown_v2',
          enum: ['text', 'markdown', 'markdown_v2'],
          'x-ui': {
            widget: 'select',
            labels: {
              text: 'text · 可@人',
              markdown: 'markdown · 可@人',
              markdown_v2: 'markdown_v2 · 可表格',
            },
          },
        },
        content: {
          type: 'string',
          title: '内容',
          'x-ui': {
            widget: 'textarea',
            rows: 10,
            inserters: ['message'],
            placeholder: '## 卡顿排查结果\n共 {{ $.nodes.n2.output.rowCount }} 条\n\n{{ $.nodes.n2.output.rows | table(uid, avg_dc, cnt_dc) }}\n\n键入 / 引用上游变量',
          },
        },
        mentioned: {
          type: 'string',
          title: '@成员',
          description: 'userid/手机号，逗号分隔',
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
    policy: {
      // 非幂等：重试会重复发。真实引擎重试前必须带幂等键（worker 已带，服务端 24h 去重）
      idempotent: false,
      retry: { maxAttempts: 5, initialMs: 2000, backoffCoefficient: 2, maximumIntervalMs: 10_000 },
    },
  },

  // ---------------------------------------------------------------- 画布辅助
  {
    type: 'canvas.note',
    typeVersion: '1.0.0',
    name: '便签',
    keywords: ['备注', '说明', '贴纸', '注释'],
    category: '辅助',
    icon: 'N',
    description: '画布备注，不执行',
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
          'x-ui': { widget: 'select', labels: { yellow: '黄', blue: '蓝', green: '绿', pink: '粉', gray: '灰' } },
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
