/**
 * 条件分支的「条件行」：**变量 + 比较方式 + 值**。
 *
 * 在它之前，flow.if 只有一个 `condition` 字符串，用户得自己把整条表达式写出来。
 * 而取值面板插进来的是一整枚引用胶囊（`{{ $.nodes.q1.output.rows }}`），
 * 想表达"查询结果不为空"就必须手工在胶囊后面补 `| count > 0` —— 面板给不了
 * 这一步，用户也无从知道该补什么。最常用的一类判断反而是最难写的那一类。
 *
 * 所以比较方式从表达式里拿出来，变成一个下拉框（对齐 Dify 的 if-else 节点：
 * 变量选择器 + comparison_operator + value）。「为空 / 不为空」这类连值都不需要
 * 的判断，用户一次都不用碰键盘。
 *
 * **这个文件不许有相对导入**，理由和 blocks.ts 一样：它是"一行条件是什么意思"
 * 的唯一住址，引擎、校验、节点摘要三方都从这里取，谁都不许自己再判一遍；
 * 而且没有相对导入，`node --test --experimental-strip-types` 能直接跑它。
 *
 * 求值分两半，边界就在"要不要解析模板"上：
 *   - 这里只负责**值和值之间**怎么比（compareCondition），纯函数、不认识 `{{ }}`；
 *   - 解析 `{{ }}`、缺值怎么办由 engine.ts 的 evaluateIf 负责。
 * 否则这个文件就得反过来 import engine，而 engine 要 import 它 —— 成环。
 */

export type ConditionOp =
  // 文本
  | 'contains' | 'notContains' | 'startsWith' | 'endsWith' | 'is' | 'isNot'
  // 通用
  | 'empty' | 'notEmpty'
  // 数字
  | 'gt' | 'gte' | 'lt' | 'lte'
  // 列表
  | 'lengthEq' | 'lengthGt' | 'lengthLt'
  // 布尔
  | 'isTrue' | 'isFalse'

export interface ConditionItem {
  /** 左值。整串模板，通常是一枚引用胶囊 `{{ $.nodes.q1.output.rows }}` */
  left: string
  op: ConditionOp
  /** 右值。`empty` 这类不需要值的比较方式上没有它 */
  right?: string
}

export interface ConditionGroup {
  /** 行与行之间：and 全部成立 / or 任一成立。**不支持嵌套** —— 需要嵌套就串两个节点 */
  logic: 'and' | 'or'
  items: ConditionItem[]
}

export interface OpMeta {
  id: ConditionOp
  label: string
  /** 下拉框里的分组。只是排版，不限制能选哪个 —— 静态时多半推断不出左值的类型 */
  group: '通用' | '文本' | '数字' | '列表' | '是否'
  /** 需要填右值吗 */
  needsValue: boolean
}

/**
 * 比较方式全表。顺序就是下拉框里的顺序。
 *
 * 「为空 / 不为空」排在最前面：它们是这次改动的由头，也是唯一一类
 * 用户完全不用输入的判断。
 */
export const CONDITION_OPS: readonly OpMeta[] = [
  { id: 'notEmpty', label: '不为空', group: '通用', needsValue: false },
  { id: 'empty', label: '为空', group: '通用', needsValue: false },
  { id: 'is', label: '是', group: '文本', needsValue: true },
  { id: 'isNot', label: '不是', group: '文本', needsValue: true },
  { id: 'contains', label: '包含', group: '文本', needsValue: true },
  { id: 'notContains', label: '不包含', group: '文本', needsValue: true },
  { id: 'startsWith', label: '开始是', group: '文本', needsValue: true },
  { id: 'endsWith', label: '结束是', group: '文本', needsValue: true },
  // 只写中文不写 >、≥：这些文案同时是画布卡片上的摘要，
  // 「rowCount 大于 > 10」里那个符号是纯噪音
  { id: 'gt', label: '大于', group: '数字', needsValue: true },
  { id: 'gte', label: '大于等于', group: '数字', needsValue: true },
  { id: 'lt', label: '小于', group: '数字', needsValue: true },
  { id: 'lte', label: '小于等于', group: '数字', needsValue: true },
  { id: 'lengthGt', label: '数量大于', group: '列表', needsValue: true },
  { id: 'lengthLt', label: '数量小于', group: '列表', needsValue: true },
  { id: 'lengthEq', label: '数量等于', group: '列表', needsValue: true },
  { id: 'isTrue', label: '为真', group: '是否', needsValue: false },
  { id: 'isFalse', label: '为假', group: '是否', needsValue: false },
]

const OP_MAP = new Map(CONDITION_OPS.map((op) => [op.id, op]))

export const isConditionOp = (v: unknown): v is ConditionOp => typeof v === 'string' && OP_MAP.has(v as ConditionOp)

export const opLabel = (op: ConditionOp): string => OP_MAP.get(op)?.label ?? op

export const opNeedsValue = (op: ConditionOp): boolean => OP_MAP.get(op)?.needsValue ?? true

/**
 * 这几个比较方式**允许左值取不到**。
 *
 * 引擎的通则是"引用取不到值一律报错"（见 engine.ts MissingValue 的注释），
 * 那条规则对的是"我以为有值、结果悄悄成了空"。而「为空」问的正是
 * "那儿到底有没有东西" —— 取不到就是空，这是答案，不是故障。
 * 其余比较方式不在此列：`包含` 一个不存在的字段是笔误，不是 false。
 */
export const opToleratesMissing = (op: ConditionOp): boolean => op === 'empty' || op === 'notEmpty'

/**
 * 从节点参数里读出条件组，**容错**。
 *
 * 参数是从流程定义（可能是别人手写的 JSON、也可能是老版本存下来的）里来的，
 * 不能假定形状。读不出任何一行就返回 null —— 调用方据此回退到老的
 * `condition` 表达式，老流程一行都不用改就还能跑。
 */
export function readConditionGroup(params: Record<string, unknown>): ConditionGroup | null {
  const raw = params.conditions
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const list = Array.isArray(record.items) ? record.items : []
  const items: ConditionItem[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const item = entry as Record<string, unknown>
    if (!isConditionOp(item.op)) continue
    items.push({
      left: typeof item.left === 'string' ? item.left : '',
      op: item.op,
      right: typeof item.right === 'string' ? item.right : undefined,
    })
  }
  if (items.length === 0) return null
  return { logic: record.logic === 'or' ? 'or' : 'and', items }
}

/** 值的文本形态。对象/数组按 JSON 比，和引擎混排渲染时的规则一致 */
function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value) ?? ''
  return String(value)
}

/**
 * 「有多少」：列表看长度、文本看字数、对象看键数。
 * 数字和布尔没有"多少"可言，按 0 处理 —— 它们该用数字那组比较方式。
 */
function size(value: unknown): number {
  if (Array.isArray(value)) return value.length
  if (typeof value === 'string') return value.length
  if (value && typeof value === 'object') return Object.keys(value).length
  return 0
}

/**
 * 「空」的定义。
 *
 * **0 和 false 不算空。** 它们是实实在在的值，判它们空会让
 * "结果行数不为空"在一行都没查到时反而成立 —— 那种错没人能一眼看出来。
 * 想问"是不是 0"就用数字那组。
 */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

/** 和引擎 `==` 同一套宽松相等：数字 1 和文本 '1' 相等，避免 SQL 列类型漂移引发的假阴性 */
const looseEq = (l: unknown, r: unknown): boolean => l === r || text(l) === text(r)

/**
 * 一行条件成不成立。**纯值比较**，两边都已经是解析完的值。
 *
 * 数字比较用 Number()：两边有一个不是数字就得到 NaN，比较恒 false ——
 * 和引擎里 `>` 的既有语义一致，不另发明一套。
 */
export function compareCondition(op: ConditionOp, left: unknown, right: unknown): boolean {
  switch (op) {
    case 'empty': return isEmptyValue(left)
    case 'notEmpty': return !isEmptyValue(left)
    case 'is': return looseEq(left, right)
    case 'isNot': return !looseEq(left, right)
    case 'contains':
      // 列表按"含有这一项"，其余按子串。列表用子串会得到一个意外成立的结果：
      // JSON.stringify(['abc']) 里确实含有 'b'
      return Array.isArray(left) ? left.some((item) => looseEq(item, right)) : text(left).includes(text(right))
    case 'notContains':
      return !(Array.isArray(left) ? left.some((item) => looseEq(item, right)) : text(left).includes(text(right)))
    case 'startsWith': return text(left).startsWith(text(right))
    case 'endsWith': return text(left).endsWith(text(right))
    case 'gt': return Number(left) > Number(right)
    case 'gte': return Number(left) >= Number(right)
    case 'lt': return Number(left) < Number(right)
    case 'lte': return Number(left) <= Number(right)
    case 'lengthEq': return size(left) === Number(right)
    case 'lengthGt': return size(left) > Number(right)
    case 'lengthLt': return size(left) < Number(right)
    // 'true' / 'false' 这类字符串按引擎的 truthy 规则算，不用 Boolean()：
    // Boolean('false') === true 是个每次都要重新踩一遍的坑
    case 'isTrue': return conditionTruthy(left)
    case 'isFalse': return !conditionTruthy(left)
  }
}

/** 与 engine.truthy 同一份规则。放在这里是因为本文件不许有相对导入 —— 两处都改才算改 */
function conditionTruthy(v: unknown): boolean {
  if (typeof v === 'string') return v !== '' && v !== 'false' && v !== '0'
  return Boolean(v)
}

/**
 * 编辑期校验：哪一行还没填完。
 *
 * 只查"填没填"，不查类型对不对 —— 左值多半是上游还没跑过的引用，
 * 这时候类型根本无从得知，拦下来只会挡住正常编辑。
 */
export function conditionErrors(group: ConditionGroup): string[] {
  const errors: string[] = []
  group.items.forEach((item, index) => {
    // 开头的「条件」不是修辞：校验错误靠标题反查该跳到哪个字段
    //（validationFocus.validationFieldKey），去掉它这条错误就点不动了
    const at = group.items.length > 1 ? `「条件」第 ${index + 1} 行` : '「条件」'
    if (!item.left.trim()) errors.push(`${at}还没选变量`)
    else if (opNeedsValue(item.op) && !String(item.right ?? '').trim()) {
      errors.push(`${at}选了「${opLabel(item.op)}」但没填值`)
    }
  })
  return errors
}

/** 条件组里所有会被当模板解析的字符串，供引用校验逐个查 */
export function conditionTemplates(group: ConditionGroup): string[] {
  return group.items.flatMap((item) =>
    opNeedsValue(item.op) ? [item.left, item.right ?? ''] : [item.left],
  ).filter((s) => s.trim() !== '')
}

/** 画布上那行摘要文字。胶囊里的路径太长，只留最后一段（多半就是字段名） */
export function conditionSummary(group: ConditionGroup): string {
  const one = (item: ConditionItem) => {
    const left = shortRef(item.left)
    const label = opLabel(item.op)
    return opNeedsValue(item.op) ? `${left} ${label} ${shortRef(item.right ?? '')}` : `${left} ${label}`
  }
  return group.items.map(one).join(group.logic === 'or' ? ' 或 ' : ' 且 ')
}

function shortRef(template: string): string {
  const whole = template.trim().match(/^\{\{(.*)\}\}$/s)
  if (!whole) return template.trim()
  const body = whole[1].trim()
  // `$.nodes.q1.output.rows | count` → `rows | count`
  const [head, ...rest] = body.split('|')
  const path = head.trim().split('.').filter(Boolean)
  const tail = path.at(-1) ?? head.trim()
  return [tail, ...rest.map((s) => s.trim())].join(' | ')
}
