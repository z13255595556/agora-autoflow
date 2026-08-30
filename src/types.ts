/**
 * 节点定义 / 流程定义的类型契约。
 * 这里的结构就是后端注册表和流程 DSL 的形状，前端只是它的一个视图。
 */
import type { SkipReason } from './lib/engine-core/types'

export type UiWidget = 'text' | 'textarea' | 'code' | 'select' | 'number' | 'kv' | 'switch' | 'conditions'

export interface UiHint {
  widget?: UiWidget
  /**
   * 字段分组。'advanced' = 折进「高级设置」，默认收起。
   *
   * 判据是**改不改**，不是重不重要：超时、行数上限、重试次数这类配一次就
   * 不再动的，和 URL、SQL 这类每次都要看的，不该在表单里平起平坐 —— 一个
   * http.request 节点 14 个可见字段平铺下来，每次找 URL 都要先扫过一堆
   * 这辈子只填过一次的东西。
   *
   * 名字和 x-output-ui.group 对齐：那边早就有 'advanced'，只是管的是输出侧
   * 的取值面板。输入侧一直没有，于是每个想收纳的节点只能像 http.request
   * 那样手写一份专属表单。
   */
  group?: 'advanced'
  /** widget=code 时的语法高亮语言（空壳期只作占位提示用） */
  language?: string
  /** 动态下拉：运行时向 GET /options/{key} 拉取候选项 */
  optionsFrom?: string
  /**
   * 下拉选项的显示名（enum 值 → 中文）。
   * enum 值本身要进流程定义，得保持稳定的英文标识；显示名只是皮。
   */
  labels?: Record<string, string>
  /**
   * 挂在整个 input schema 上的实时预览面板。
   * - 'date' —— 按当前参数当场算出日期，连同各种格式和引用路径一起显示
   * - 'schedule' —— 接下来三次触发时刻（「明天 09:00 · 后天 09:00」），
   *   「每天 09:00」是翻译，这个才是事实
   */
  preview?: 'date' | 'schedule'
  placeholder?: string
  rows?: number
  /**
   * 这个文本字段额外挂哪些"插入器"和预览。
   *
   * 刻意不做成新的 widget：widget 词表里 number / switch 已经是永远匹配不到
   * 的死条目了，再加一个只有一个字段用的只会让它更虚构。插入器是叠加在
   * textarea 上的能力，不是另一种控件。
   *
   * - 'message' —— 下方实时渲染消息成品 + 字节数
   *
   * 这里曾经还有 'table'（选上游和列生成 table(...)），声明了但从来没被任何组件
   * 消费，对应的 TablePicker.tsx 是死代码 —— 表格插入由取值面板的「表格」页签承担。
   * 一个声明了没效果的注解比没有更糟：manifest 的作者会以为它在工作
   */
  inserters?: Array<'message'>
  /** KV 编辑器中按敏感键名遮罩 value，适用于 HTTP headers。 */
  sensitiveKeys?: boolean
  /**
   * widget=conditions 时，"直接写表达式"那条逃生口存在哪个兄弟字段里。
   *
   * 和 x-placeholders.valuesFrom 同一个套路：一个控件管两个参数。声明了它
   * 之后 SchemaForm 不再单独画那个字段 —— 否则同一个条件会在表单里出现两次，
   * 而两处填的东西谁生效是隐式的。
   */
  expressionFrom?: string
  /** 单值凭证输入，默认用密码态显示且禁止浏览器自动填充。 */
  secret?: boolean
  /**
   * 挂在整个 input schema 上：表单顶部长出哪些导入器。
   * - 'curl' —— 粘一段 curl 命令，自动填 method / url / headers / body
   * 以前是 SchemaForm 里按 `typeId === 'http.request'` 判断，是表单里最后一个特判
   */
  importers?: Array<'curl'>
  /**
   * 挂在整个 input schema 上：表单顶部的助手条。
   * - 'python' —— 使用说明悬浮窗、运行环境（版本/可用库，从 /sandbox/env
   *   实时拉，不手抄——手抄的清单迟早和实际装的对不上）、复制 AI 提示词
   * 和 importers 同一个思路：由 manifest 声明，不在表单里按 typeId 判断
   */
  assistants?: Array<'python'>
}

/**
 * 输出字段在取值面板里怎么展示。
 *
 * **纯展示，绝不改变引用路径。** variable.assign 的 spread 只是不画 values 这一层，
 * 路径仍然是 $.nodes.v1.output.values.customerId，lookupPath 认的还是它。
 *
 * 只用在 registry 独占的节点上。sql.query / notify.wecom / http.request 由后端
 * manifest 整份下发（applyBackendNodes 全量覆盖），往 registry.ts 里给它们加的
 * 注解后端一上线就没了 —— 而且**只在线上没，本地永远测不出来**。那三个节点
 * 靠 outputShape.ts 里的名字表推断，一个注解都不需要。
 */
export interface OutputUiHint {
  /** 'data'(缺省) | 'run'(「运行信息」，默认折叠) | 'advanced'(默认折叠) | 'hidden' */
  group?: 'data' | 'run' | 'advanced' | 'hidden'
  /** 把这个容器的**内容**当一级字段，容器本身不显示。variable.assign 的 values */
  spread?: boolean
  /** 数组元素的显示名来源。'sourceNodeName' = 按入边顺序取源节点名 */
  itemLabelFrom?: 'sourceNodeName'
  /** 值敏感，预览必须打码 */
  secret?: boolean
  /** 覆盖显示名 */
  label?: string
  /** 挂在 output 根上：整个节点不作为上游数据源 */
  notASource?: boolean
}

/**
 * 条件显示（对齐 n8n displayOptions 语义）：
 * - show 里多个 key 之间是 AND，每个 key 的候选值数组内部是 OR
 * - hide 里多个 key 之间是 OR，任一命中即隐藏，优先级高于 show
 * - 被引用参数未填时用它的 default 参与比较
 * - 隐藏的字段不做必填校验；编辑器内保留已填的值方便切回，
 *   但导出定义时剥离（n8n 在编辑器和加载时都会 strip 隐藏参数）
 */
export type ShowCondition = Record<string, Array<string | number | boolean>>

export interface JsonSchema {
  type?: 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array'
  title?: string
  description?: string
  default?: unknown
  enum?: string[]
  /** JSON Schema 的 format。入参的「日期」种类就是 string + 'date' */
  format?: string
  minimum?: number
  maximum?: number
  items?: JsonSchema
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean | JsonSchema
  'x-ui'?: UiHint
  /** 结果可能很大：引擎转存对象存储，节点间只传 $ref */
  'x-large'?: boolean
  /** 输出结构运行时才知道（如 SQL 列），靠试运行探测后缓存到节点实例 */
  'x-dynamic'?: 'probe' | 'run'
  /** 满足条件才显示（同级参数名 → 候选值列表） */
  'x-show'?: ShowCondition
  /** 满足条件就隐藏，优先级高于 x-show */
  'x-hide'?: ShowCondition
  /**
   * 这个字段有自己的 `{{name}}` 占位符语法，由下游服务渲染。
   *
   * 前端遇到裸 `{{name}}` 时不解析、原样透传，只负责把值凑齐放进
   * `valuesFrom` 指定的兄弟字段里。`{{ $.xxx }}` 仍由前端解析 ——
   * `$.` 前缀是两者唯一的判别依据。
   */
  'x-placeholders'?: { valuesFrom: string }
  /**
   * 这个字段**绝不做模板插值**，`{{ }}` 原样透传给节点服务。
   *
   * 给代码类字段用的（code.python 的 code）：如果代码字段也解析 `{{ $.trigger.x }}`，
   * webhook body 里的内容就会**变成服务端执行的代码** —— 货真价实的 RCE。
   * 和 x-placeholders 同一个思路：哪些字段不解析由 manifest 声明，
   * 引擎照标记跳过，不在引擎里硬编码字段名。
   *
   * 只在**顶层字段**生效：resolveParams 递归进嵌套对象时不带 schema。
   */
  'x-no-template'?: boolean
  /** 取值面板的展示元数据。纯展示，不影响引用路径 */
  'x-output-ui'?: OutputUiHint
}

/** 输出口。缺省单口 out；if/switch 这类控制节点有多口 */
export interface NodePort {
  id: string
  label: string
}

/**
 * 节点类型的重试策略 —— **worker 重试的唯一出处**。
 *
 * 四要素来自 Temporal 的 RetryPolicy：第 n 次等
 * `min(initialMs × backoffCoefficient^(n-1), maximumIntervalMs)`。
 *
 * 以前这里是 `{maxAttempts, backoff, initialMs}`，而 worker 另有一份写死的
 * `DEFAULT_RETRY` 表，两边数字还不一样（sql.query 这边说 2 次、那边跑 3 次），
 * 且这里这份**没有任何消费者**。现在只剩这一份：manifest 里声明了就按它重试，
 * 没声明就不重试（http.request 在节点内自己重试，故意不声明）。
 */
export interface RetryPolicy {
  maxAttempts: number
  initialMs: number
  backoffCoefficient: number
  maximumIntervalMs: number
}

/**
 * 节点实例对重试的覆盖。`null` = 这个节点不重试；缺省 = 按类型的 policy.retry。
 * 只能改次数和首次间隔 —— 系数和上限是类型级的判断，没有理由按节点改。
 */
export type NodeRetryOverride = { maxAttempts?: number; initialMs?: number } | null

/**
 * 节点怎么执行。
 * - http：一次请求拿结果。适合秒级返回的服务。
 * - http-async：submit 秒回 handle，引擎按 pollIntervalMs 轮询。
 *   慢查询（Hive 能跑几分钟）必须走这条 —— 同步等会撞网关超时，也会占死 worker。
 */
export interface NodeRuntime {
  kind: 'http' | 'http-async'
  endpoint?: string
  /** 同步节点的一次性执行端点。 */
  execute?: string
  submit?: string
  poll?: string
  cancel?: string
  probe?: string
  pollIntervalMs?: number
  timeoutMs?: number
  /** 没填 timeoutMinutes 的老流程,轮询多久就放弃。见 manifest.SQL_TIMEOUT_MINUTES */
  defaultTimeoutMinutes?: number
  /** 超时最多能设到多少。界面上的 maximum 挡不住导入的 JSON,执行侧要自己夹 */
  maxTimeoutMinutes?: number
}

export interface NodeType {
  type: string
  typeVersion: string
  name: string
  category: string
  icon: string
  description?: string
  /**
   * 搜索别名：用户在加节点时想的是动作（「发群」「查数」「调接口」），不是节点名。
   * 没有它的节点只能按名字和描述搜到
   */
  keywords?: string[]
  /** 说明文档。Inspector 标题栏的 ? 链到这里 */
  docsUrl?: string
  input: JsonSchema
  output: JsonSchema
  /** 缺省 [{ id: 'out', label: '' }] */
  ports?: NodePort[]
  /** 缺省 true；触发器节点为 false */
  hasInput?: boolean
  /** 只用于画布表达，不参与连线、校验或执行，如便签。 */
  visualOnly?: boolean
  runtime?: NodeRuntime
  policy?: {
    idempotent?: boolean
    dryRunnable?: boolean
    cancellable?: boolean
    retry?: RetryPolicy
  }
}

/**
 * 节点实例级的设置（参数之外、每种节点都有的那几项）。
 *
 * 对齐 n8n 的 Settings 标签 / Dify 的节点描述 / Activepieces 的 Skip step。
 * 以前只有 onError 一项 —— 调 SQL 时想让企微节点先别发，只能把它删掉再加回来。
 */
export interface NodeSettings {
  /** 备注。卡片下一行灰字，不参与执行，也不算「逻辑改动」（和拖位置同类） */
  note?: string
  /**
   * 暂停：跳过不执行，但对下游**透明** —— 它的上游活，它的下游就活
   * （n8n Deactivate / AP Skip 的语义）。控制节点（条件 / 循环）不能暂停：
   * 引擎要读它们的判定结果，没有这行下游永远卡住。
   * 下游引用它的输出会在校验期报错，不会静默拿到空值。
   */
  disabled?: boolean
  /** 重试覆盖，见 NodeRetryOverride */
  retry?: NodeRetryOverride
}

/** 挂在画布节点上的业务数据 */
export interface FlowNodeData extends Record<string, unknown>, NodeSettings {
  typeId: string
  typeVersion: string
  label: string
  params: Record<string, unknown>
  onError: 'fail' | 'continue'
  /** 试运行探测回来的输出结构，供下游变量提示使用 */
  probedOutput?: Record<string, JsonSchema>
}

/**
 * 流程入参的**种类**（表单怎么画），不是 JSON Schema 的 type。
 *
 * date / select 不是 JSON Schema 类型：落到定义里是 `string + format: 'date'` /
 * `string + enum`（见 flowGraph.inputSchemaOf），这样 webhook 入参校验、导出 JSON、
 * 老版本前端都能照常读。
 */
export type FlowInputKind = 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'select'

/** 流程入参的一行（渲染成手动运行表单 + $.trigger.* 变量） */
export interface FlowInputField {
  key: string
  title: string
  type: FlowInputKind
  required: boolean
  /**
   * 默认值，存表单里的原始文本（运行时按 type 转换）。
   * 日报的「日期」以前是每天手敲一遍的文本框 —— 有默认值之后打开就能点运行
   */
  default?: string
  /** 给填表单的人看的一句话，当 placeholder */
  description?: string
  /** type === 'select' 时的候选项 */
  options?: string[]
}

/** 导出的流程定义 —— 逻辑与布局分离 */
export interface FlowDefinition {
  id: string
  version: number
  name: string
  inputs: JsonSchema
  /** schedule 时额外带上 mode / at / cron 等排程参数，供调度器读取 */
  trigger: { kind: 'manual' | 'schedule' | 'webhook' } & Record<string, unknown>
  nodes: Array<NodeSettings & {
    id: string
    type: string
    typeVersion: string
    name: string
    params: Record<string, unknown>
    onError: 'fail' | 'continue'
    /** 运行中学习到的输出字段结构；不包含真实响应值。 */
    probedOutput?: Record<string, JsonSchema>
  }>
  edges: Array<{ from: string; to: string; port?: string }>
  layout: Record<string, { x: number; y: number; width?: number; height?: number }>
  /**
   * 固定输出（对齐 n8n pinData）：nodeId → 固定的输出数据。
   * 只在手动/调试运行时替代真实执行；生产触发（cron/webhook）忽略。
   * 跟 n8n 一样随流程定义持久化。
   */
  pinData?: Record<string, unknown>
}

// ---------------------------------------------------------------- 运行态

/** 单步状态（对齐 n8n ExecutionStatus 的子集） */
export type StepStatus = 'waiting' | 'running' | 'success' | 'error' | 'skipped'

/**
 * 一次节点执行的记录（对齐 n8n ITaskData）。
 * 一个节点在一次运行里可能执行多次（循环体），所以 FlowRun.steps
 * 的值是数组 —— 这正是 n8n runData 用 ITaskData[] 的原因。
 */
export interface StepRun {
  nodeId: string
  status: StepStatus
  /**
   * status='skipped' 时为什么没跑。和 worker 写进 steps.skip_reason 的是同一个词表。
   * 没有它的话「暂停的」和「分支没命中的」在界面上长得一模一样
   */
  skipReason?: SkipReason
  startedAt: number
  durationMs: number
  /** 表达式解析后的实际入参 —— 服务真正收到的东西 */
  input: Record<string, unknown>
  output: unknown
  error?: string
  /** 输出来自固定数据而非真实执行 */
  pinned?: boolean
  /** 循环体里的第几次（0 起） */
  iteration?: number
  /** 异步节点的进度 0-100。注意平台的进度不单调，只用于显示，不能拿来判完成 */
  progress?: number
  /** 等待节点睡到几点（epoch ms）。只在等待中有值，面板靠它把「在等」和「卡住」分开 */
  resumeAt?: number
  /** 异步节点的任务句柄，中止时用它去取消 —— 不取消的话引擎那边继续烧资源 */
  handle?: string
  /** 真实执行（走了后端服务）而不是 mock */
  live?: boolean
  /**
   * 这条记录是本次运行里第几次写入（从 1 递增）。
   *
   * **执行顺序在 FlowRun.steps 里根本不存在** —— 它是 Record<nodeId, StepRun[]>，
   * 按节点分组，组间无序；而 stepDelayMs=0 时所有 startedAt 会挤在同一毫秒，
   * 拿时间戳排也排不出来。回放测试要比"两版引擎的执行序列是否一致"，
   * 就必须有这么一个单调计数。
   *
   * 只有引擎写，UI 不读。
   */
  seq?: number
}

export interface FlowRun {
  id: string
  status: 'running' | 'success' | 'error'
  startedAt: number
  finishedAt?: number
  /** 本次运行的流程入参 */
  trigger: Record<string, unknown>
  /** nodeId → 该节点的历次执行（循环体会有多条） */
  steps: Record<string, StepRun[]>
  /** 没能归到任何节点头上的整体失败（引擎自身抛异常），正常不该出现 */
  error?: string
}
