/**
 * 节点定义 / 流程定义的类型契约。
 * 这里的结构就是后端注册表和流程 DSL 的形状，前端只是它的一个视图。
 */

export type UiWidget = 'text' | 'textarea' | 'code' | 'select' | 'number' | 'kv' | 'switch'

export interface UiHint {
  widget?: UiWidget
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
   */
  preview?: 'date'
  placeholder?: string
  rows?: number
  /**
   * 这个文本字段额外挂哪些"插入器"和预览。
   *
   * 刻意不做成新的 widget：widget 词表里 number / switch 已经是永远匹配不到
   * 的死条目了，再加一个只有一个字段用的只会让它更虚构。插入器是叠加在
   * textarea 上的能力，不是另一种控件。
   *
   * - 'table'   —— 选上游节点和列，生成 {{ … | table(列…) }}
   * - 'message' —— 下方实时渲染消息成品 + 字节数
   */
  inserters?: Array<'table' | 'message'>
  /** KV 编辑器中按敏感键名遮罩 value，适用于 HTTP headers。 */
  sensitiveKeys?: boolean
  /** 单值凭证输入，默认用密码态显示且禁止浏览器自动填充。 */
  secret?: boolean
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
  /** 取值面板的展示元数据。纯展示，不影响引用路径 */
  'x-output-ui'?: OutputUiHint
}

/** 输出口。缺省单口 out；if/switch 这类控制节点有多口 */
export interface NodePort {
  id: string
  label: string
}

export interface RetryPolicy {
  maxAttempts: number
  backoff: 'fixed' | 'exponential'
  initialMs: number
}

/**
 * 节点怎么执行。
 * - http：一次请求拿结果。适合秒级返回的服务。
 * - http-async：submit 秒回 handle，引擎按 pollIntervalMs 轮询。
 *   慢查询（Hive 能跑几分钟）必须走这条 —— 同步等会撞网关超时，也会占死 worker。
 */
export interface NodeRuntime {
  kind: 'http' | 'http-async'
  endpoint?: string
  submit?: string
  poll?: string
  cancel?: string
  probe?: string
  pollIntervalMs?: number
  timeoutMs?: number
}

export interface NodeType {
  type: string
  typeVersion: string
  name: string
  category: string
  icon: string
  description?: string
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

/** 挂在画布节点上的业务数据 */
export interface FlowNodeData extends Record<string, unknown> {
  typeId: string
  typeVersion: string
  label: string
  params: Record<string, unknown>
  onError: 'fail' | 'continue'
  /** 试运行探测回来的输出结构，供下游变量提示使用 */
  probedOutput?: Record<string, JsonSchema>
}

/** 流程入参的一行（渲染成手动运行表单 + $.trigger.* 变量） */
export interface FlowInputField {
  key: string
  title: string
  type: 'string' | 'integer' | 'boolean'
  required: boolean
}

/** 导出的流程定义 —— 逻辑与布局分离 */
export interface FlowDefinition {
  id: string
  version: number
  name: string
  inputs: JsonSchema
  /** schedule 时额外带上 mode / at / cron 等排程参数，供调度器读取 */
  trigger: { kind: 'manual' | 'schedule' | 'webhook' } & Record<string, unknown>
  nodes: Array<{
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
