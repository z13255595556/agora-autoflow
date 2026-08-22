import type { Edge } from '@xyflow/react'
import type { FlowInputField, FlowRun, JsonSchema, StepRun } from '../types'
// 显式 .ts 后缀：test/ 走 node --test 直接跑源码，它不做 bundler 的路径解析。
// 项目里被测的模块（outputShape.ts 等）都是这个写法，tsconfig 开了
// allowImportingTsExtensions。engine.ts 以前没跟上，所以它一直是不可测的。
import { NODE_TYPE_MAP } from '../registry.ts'
import type { FNode } from '../store'
import { validateNode } from './vars.ts'
import { blockRe, CALL_RE } from './blocks.ts'
import { cancelNode, executeNode, isOnline, pollNode, submitNode } from './client.ts'
import { dateFn, dateNodeOutput, formatDate, toDate } from './datefn.ts'
import { FILTERS, ROW_KEYS, splitTopLevelPipes } from './output.ts'
import { extractSqlPlaceholders } from './placeholders.ts'
import { applySelectionFilter, parseFilterArgs } from './selectionFilters.ts'
import { compareCondition, opNeedsValue, opToleratesMissing, readConditionGroup } from './conditions.ts'
import { redactNodeInput } from './secrets.ts'
// 图遍历那部分已经提纯到 engine-core：decide() 要用同一套判定，而它必须是纯的
import { outgoing, reachableFrom, topoSort } from './engine-core/graph.ts'
// 常量全仓单一出处，scripts/check-constants.sh 是门禁
import { MAX_LOOP_ITERATIONS } from './engine-core/types.ts'
import { isRetryable, MAX_CONSECUTIVE_POLL_FAILURES } from './engine-core/errorCodes.ts'
export { MAX_LOOP_ITERATIONS }

/**
 * 前端 mock 执行引擎。
 * 对齐 n8n 的运行模型：一次运行(FlowRun) → 每个节点若干次执行(StepRun[]，循环体多条)。
 * 正式版整个文件被替换成「订阅后端 run 的 SSE/WS 流」，UI 层不用改。
 */

export interface ExecuteOptions {
  nodes: FNode[]
  edges: Edge[]
  trigger: Record<string, unknown>
  /** nodeId → 固定输出。只在 mode='manual' 时替代真实执行（n8n pinData 语义） */
  pinData: Record<string, unknown>
  /**
   * n8n executionMode 的最小版：manual（编辑器调试）才用 pinData，
   * production（cron/webhook 触发）无视它。前端只有 manual，
   * 字段显式存在是为了把这条语义带给后端引擎实现者。
   */
  mode?: 'manual' | 'production'
  flowInputs: FlowInputField[]
  /** 每步之间的模拟耗时，让画布动起来。真实节点不受影响 */
  stepDelayMs?: number
  /** 中止信号。触发后正在跑的异步任务会被 cancel 掉，不留后台任务空烧资源 */
  signal?: AbortSignal
  /**
   * 运行 id 与开始时刻。**不传就用当下**，行为和以前一样。
   *
   * 传进来是为了让一次运行可复现：`$.run.id` 会进 SQL 注释和消息模板，
   * 而 startedAt 是 date() 的基准（engine.ts 的 resolveCall 锁的就是它，
   * 为的是"一次运行里所有日期必须同源"）。两者都从外面注入之后，
   * 同一份图 + 同一份输入 → 逐字段相同的输出，这是 golden 回放的前提。
   *
   * 服务端引擎将来也要用它：run 行先落库拿到 id 和 scheduled_time，
   * 再交给引擎，而不是让引擎自己造一个。
   */
  runId?: string
  startedAtMs?: number
  /**
   * 节点执行器。**引擎里唯一发生 IO 的地方**，不传就是 defaultExecutor
   * （live 走真实服务、否则 mock）。回放测试传一个"从 fixture 里读答案"的宿主，
   * worker 将来传一个"落库 + 调服务"的宿主，图遍历那部分完全不用改。
   */
  execute?: StepExecutor
  /** 判定一个节点走不走真实服务。回放时固定成 false，不依赖 isOnline() 这个全局 */
  isLive?: (node: FNode) => boolean
  /** 每步状态变化时回调（running → success/error），UI 据此实时刷新 */
  onStep: (step: StepRun) => void
  onRunUpdate: (run: FlowRun) => void
}

// ---------------------------------------------------------------- 表达式解析

type Ctx = {
  trigger: Record<string, unknown>
  run: { id: string; startedAt: string }
  nodes: Record<string, { output: unknown }>
  loop?: { item: unknown; index: number }
}

/**
 * 引用取不到值。
 *
 * 单独一个错误类型，因为它有两条**必须区别对待**的出路：运行期一律炸掉，
 * 编辑期预览标记成可见的占位符。用普通 Error 就没法在 resolveTemplate 里
 * 把它和"过滤器名写错""裸标识符"这类真语法错分开 —— 那两类在预览里也该红。
 */
export class MissingValue extends Error {
  // 不用构造器参数属性：test 走 node --test 的 strip-only 模式，那语法不支持
  readonly ref: string

  constructor(ref: string) {
    super(
      `{{ ${ref} }} 取不到值。检查路径是否写对（上游列名可能变了）；` +
        `确实允许缺值就写 {{ ${ref} | default('—') }}`,
    )
    this.ref = ref
  }
}

/** 沿 $.a.b[0].c 取值；取不到返回 undefined */
export function lookupPath(ctx: Ctx, path: string): unknown {
  const parts = path
    .replace(/^\$\.?/, '')
    .split(/\.|\[|\]/)
    .filter(Boolean)
  let cur: unknown = ctx
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

/** 预览模式下缺值渲染成什么。要显眼 —— 它取代的正是"什么都不显示" */
export const MISSING_MARK = '〔未取到值〕'


export interface ResolveOptions {
  /**
   * 引用取不到值时怎么办。
   * - 'throw'（缺省）：抛 MissingValue。**运行期只能是它**。
   * - 'mark'：渲染成 MISSING_MARK。只给编辑期预览用 —— 那时上游多半还没跑过，
   *   整块拒绝预览比缺一段更没用。
   */
  onMissing?: 'throw' | 'mark'
}

/**
 * 解析模板字符串。
 * 整个字符串就是一个 {{ }} → 返回原始值（保留数组/对象类型）；
 * 混排 → 逐个替换为字符串。
 *
 * **缺值一律报错，不再渲染成空字符串。**
 *
 * 以前这里是 `JSON.stringify(v) ?? ''`：JSON.stringify(undefined) 返回的是
 * undefined 这个值（不是字符串），`?? ''` 于是把它变成空串。后果是
 * `今天异常 {{ $.nodes.q1.output.summary.bad }} 条` 里那个不存在的字段渲染成空、
 * run 记 success、群里收到一句缺了数字的日报，全程没有任何报错。
 *
 * 而 sql.query 的输出结构本来就是 probe/run 学出来的 —— Hive 列名一变就命中
 * 这条路径，编辑期的 validateNode 拦不住这种运行时漂移。
 *
 * 引擎对裸标识符、写错的过滤器都专门抛了错（见 resolveOperand 的注释），
 * 唯独漏了这一种。Airflow 的 StrictUndefined、ASL 的 States.ParameterPathFailure、
 * Argo 的 parameter-not-found、Camunda 的求值失败→incident —— 四个系统的一致
 * 选择都是报错终止，确实允许缺值的场合用显式的 default() 开口子。
 */
export function resolveTemplate(value: unknown, ctx: Ctx, opts: ResolveOptions = {}): unknown {
  if (typeof value !== 'string') return value
  const mark = opts.onMissing === 'mark'
  // [^}]* 而不是贪婪 [\s\S]*：否则 "{{ a }} 和 {{ b }}" 会被整体吞成一个表达式。
  // 块体的写法定在 blocks.ts，胶囊编辑器和这里必须切得一模一样
  const whole = value.match(/^\s*\{\{([^}]*)\}\}\s*$/)
  if (whole) {
    const expr = whole[1].trim()
    try {
      const v = resolveExpr(expr, ctx)
      if (v === undefined) throw new MissingValue(expr)
      return v
    } catch (err) {
      if (mark && err instanceof MissingValue) return MISSING_MARK
      throw err
    }
  }
  return value.replace(blockRe(), (_, raw) => {
    const expr = String(raw).trim()
    try {
      const v = resolveExpr(expr, ctx)
      if (v === undefined) throw new MissingValue(expr)
      return typeof v === 'string' ? v : JSON.stringify(v)
    } catch (err) {
      if (mark && err instanceof MissingValue) return MISSING_MARK
      throw err
    }
  })
}

/**
 * 格式化过滤器：`{{ $.nodes.n2.output.rows | table(uid, avg_dc) }}`
 *
 * 查询结果直接塞进消息只会得到一坨 JSON。这几个过滤器把它变成人能读的东西。
 * `table` 出的是 markdown 表格 —— 企微要渲染它必须把消息类型设成
 * markdown_v2，老的 markdown 不支持表格（但支持 @人，markdown_v2 反过来）。
 */
function applyFilter(value: unknown, name: string, args: unknown[]): unknown {
  const selection = applySelectionFilter(value, name, args)
  if (selection.handled) return selection.value
  const rows = Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []
  const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
  // list / lines / table 都靠换行定形状，值里的换行会把结构撑破
  const flat = (v: unknown) => cell(v).replace(/\r?\n/g, ' ')
  // 表格还多一层：单元格里的 | 会被当成列分隔符，整张表错位
  const tableCell = (v: unknown) => flat(v).replace(/\|/g, '\\|')
  const cols = (explicit: unknown[]) =>
    explicit.length ? explicit.map(String) : [...new Set(rows.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : [])))]
  /** 聚合类过滤器的取值：给了列名就从对象里取那一列，没给就把元素当标量 */
  const pick = (v: unknown, column: unknown): unknown[] => {
    const arr = Array.isArray(v) ? v : []
    if (column === undefined || column === '') return arr
    const k = String(column)
    return arr.map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>)[k] : undefined))
  }

  switch (name) {
    case 'count':
      return Array.isArray(value) ? value.length : value === undefined || value === null ? 0 : 1
    case 'json':
      return JSON.stringify(value, null, 2)
    case 'date': {
      // 把已有的值当时间格式化：上游查出来的 20260810 / 时间戳 / ISO 串都能认
      const d = toDate(value)
      if (!d) throw new Error(`|date 认不出这个值是时间：${JSON.stringify(value)?.slice(0, 40)}`)
      return formatDate(d, String(args[0] ?? 'date'))
    }
    case 'list': {
      if (!rows.length) return '（无数据）'
      const c = cols(args)
      return rows.map((r) => '- ' + c.map((k) => `${k}=${flat(r?.[k])}`).join('，')).join('\n')
    }
    case 'lines': {
      // 只取一列，一行一个值。适合"把 uid 列表贴给对方"这种
      if (!rows.length) return '（无数据）'
      const k = String(args[0] ?? cols([])[0])
      return rows.map((r) => flat(r?.[k])).join('\n')
    }
    case 'table': {
      if (!rows.length) return '（无数据）'
      const c = cols(args)
      return [
        `| ${c.map(tableCell).join(' | ')} |`,
        `| ${c.map(() => '---').join(' | ')} |`,
        ...rows.map((r) => `| ${c.map((k) => tableCell(r?.[k])).join(' | ')} |`),
      ].join('\n')
    }
    // ---- 聚合。四个都接受可选列名，这样对象数组和标量数组两种形状都能用：
    //      rows | sum(dc)  和  rows | column(dc) | sum  等价
    case 'sum': {
      const nums = pick(value, args[0]).map((v) => Number(v))
      const bad = nums.findIndex((n) => !Number.isFinite(n))
      if (bad >= 0) {
        throw new Error(
          `|sum 只能对数字求和，第 ${bad + 1} 项不是数字。` +
            (args[0] ? '' : '如果数据是对象数组，要写成 |sum(列名)'),
        )
      }
      return nums.reduce((a, b) => a + b, 0)
    }
    case 'unique': {
      const seen = new Set<string>()
      const out: unknown[] = []
      for (const v of pick(value, args[0])) {
        // 按序列化后的形状去重：对象数组去重时按值比，不是按引用
        const key = typeof v === 'object' && v !== null ? JSON.stringify(v) : `${typeof v}:${String(v)}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(v)
      }
      return out
    }
    case 'join': {
      // 默认「、」而不是逗号：这些串最终进的是中文消息，顿号是列举的自然分隔符
      const sep = args[0] === undefined ? '、' : String(args[0])
      return pick(value, args[1]).map(flat).join(sep)
    }
    case 'sort': {
      const key = args[0] === undefined ? undefined : String(args[0])
      const desc = String(args[1] ?? 'asc').toLowerCase() === 'desc'
      const of = (v: unknown) => (key === undefined ? v : (v as Record<string, unknown>)?.[key])
      // 用 slice 复制：原地排序会改上游节点的 output，下一个引用它的地方
      // 看到的就是排过序的数据，而且没有任何痕迹
      return (Array.isArray(value) ? value.slice() : []).sort((a, b) => {
        const x = of(a)
        const y = of(b)
        const nx = Number(x)
        const ny = Number(y)
        // 两边都是数字就按数值比，否则按字符串 —— 否则 '10' 会排在 '9' 前面
        const r =
          Number.isFinite(nx) && Number.isFinite(ny)
            ? nx - ny
            : String(x ?? '').localeCompare(String(y ?? ''), 'zh')
        return desc ? -r : r
      })
    }
    default:
      throw new Error(`未知的格式化过滤器 |${name}，可用：${FILTERS.join(' / ')}`)
  }
}

/** 一段过滤器文本 → 名字和参数。括号可省：`| count` 等价于 `| count()` */
function parseFilterSegment(seg: string): { name: string; args: unknown[] } {
  const m = seg.match(/^([A-Za-z_]+)\s*(?:\(([\s\S]*)\))?$/)
  if (!m) {
    // 解析不出过滤器就**报错**，不能往下掉。
    //
    // 以前是掉到 resolveOperand，整串以 $ 开头 → lookupPath 查一条带空格和
    // 竖线的路径 → undefined → 在混合文本里渲染成空字符串。用户看到的是
    // "消息里那段没了"，没有任何报错。
    throw new Error(
      `过滤器写法不对：| ${seg}。写成 | 名字(参数…)，可用：${FILTERS.join(' / ')}`,
    )
  }
  return { name: m[1], args: parseFilterArgs(m[2] ?? '') }
}

/**
 * 极简表达式：一个引用 / 字面量 / 二元比较，后面可接**任意多个**过滤器。
 *
 * 链式是后加的。以前明确抛错"一个 {{ }} 只能接一个过滤器"，而
 * `rows | sort(dc, desc) | at(0, name)`（"跌得最狠的是谁"）是日报里最自然的
 * 写法之一 —— 表达不出来就只能回去改 SQL，而改 SQL 意味着多跑一次几分钟的
 * Hive 查询。
 *
 * `default` 在链条里是特殊的：它兜的是"前面那一串**没算出东西**"，
 * 所以要能接住上游抛出来的 MissingValue，而不是等一个值传给它。
 */
function resolveExpr(expr: string, ctx: Ctx): unknown {
  const parts = splitTopLevelPipes(expr)
  if (parts.length > 1) {
    let value: unknown
    /** 头部或某个过滤器求值时缺了值，正在等一个 default 来兜 */
    let missing: MissingValue | null = null
    try {
      value = resolveExpr(parts[0], ctx)
    } catch (err) {
      // 只有缺值能被 default 兜住。过滤器名写错、裸标识符这类是真语法错，
      // 让 default 把它们也盖住，等于把"静默出错"这个坑换个地方重开
      if (!(err instanceof MissingValue)) throw err
      missing = err
    }

    for (const seg of parts.slice(1)) {
      const { name, args } = parseFilterSegment(seg)
      if (name === 'default') {
        if (missing || value === undefined) {
          value = args.length ? args[0] : ''
          missing = null
        }
        continue
      }
      // 还没被兜住就一路空跑到底，保持缺值状态 —— 中途拿 undefined 去喂
      // count 之类的过滤器只会得到一个假答案（0），那正是要消灭的东西
      if (missing) continue
      value = applyFilter(value, name, args)
    }

    if (missing) throw missing
    return value
  }
  const cmp = expr.match(/^(.+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/)
  if (cmp) {
    const l = resolveOperand(cmp[1].trim(), ctx)
    const r = resolveOperand(cmp[3].trim(), ctx)
    switch (cmp[2]) {
      case '===': case '==': return l === r || String(l) === String(r)
      case '!==': case '!=': return !(l === r || String(l) === String(r))
      case '>': return Number(l) > Number(r)
      case '<': return Number(l) < Number(r)
      case '>=': return Number(l) >= Number(r)
      case '<=': return Number(l) <= Number(r)
    }
  }
  return resolveOperand(expr, ctx)
}

/** 拆函数实参，尊重引号：date('now-1d', 'yyyy-MM-dd HH:mm') 里的逗号不能乱切 */
function parseCallArgs(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === ',') { out.push(cur.trim()); cur = '' }
    else cur += c
  }
  if (cur.trim() || out.length) out.push(cur.trim())
  return out.filter((a, i) => a !== '' || i < out.length - 1)
}

function resolveCall(name: string, args: string[], ctx: Ctx): unknown {
  // 基准时刻取运行开始时间，不取"当下"：一次运行里所有日期必须同源，
  // 否则跨零点那一刻，消息标题的日期和 SQL 查的分区可能差一天
  const base = new Date(ctx.run.startedAt)
  switch (name) {
    case 'date':
      return dateFn(args, Number.isNaN(base.getTime()) ? new Date() : base)
    default:
      throw new Error(`没有名为 ${name}() 的函数，目前只支持 date(偏移, 格式)`)
  }
}

function resolveOperand(s: string, ctx: Ctx): unknown {
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null') return null
  const quoted = s.match(/^["'](.*)["']$/)
  if (quoted) return quoted[1]
  if (s.startsWith('$')) {
    const v = lookupPath(ctx, s)
    // 在引用这一层就炸，而不是等到渲染那一层：这样 `{{ $.missing | count }}`
    // 也会报错，而不是让 count(undefined) 老老实实返回 0 —— 路径写错时
    // 返回 0 是个不会被任何人察觉的谎。
    if (v === undefined) throw new MissingValue(s)
    return v
  }
  const call = s.match(CALL_RE)
  if (call) return resolveCall(call[1], parseCallArgs(call[2]), ctx)
  // 裸标识符原样还回去会静默出错：`{{date}}` 会让 SQL 变成 `where date = date`
  // —— 合法、恒真、全表扫。宁可在这里炸掉。
  // （声明了 x-placeholders 的字段走 resolvePreservingPlaceholders，不到这里）
  throw new Error(
    `{{ ${s} }} 不是合法引用：想引用流程入参写 {{ $.trigger.${s} }}，想写 SQL 占位符写 :${s}，想要日期写 {{ date('now-1d', 'yyyyMMdd') }}`,
  )
}

/** 条件真值：字符串 'false'/'0'/'' 视为假，避免 Boolean('false') === true 的坑 */
export function truthy(v: unknown): boolean {
  if (typeof v === 'string') return v !== '' && v !== 'false' && v !== '0'
  return Boolean(v)
}

/**
 * flow.if 判真。**两种写法共用的唯一入口** —— 引擎、worker、单节点试运行
 * 都从这里过，判定规则不许有第二份。
 *
 * 优先条件行（`params.conditions`）；一行都读不出来就回退到老的
 * `params.condition` 表达式。老流程存的就是后者，一行都不用改。
 *
 * **每一行都求值，不做短路。** and 里第一行为假就跳过后面几行，等于
 * "后面几行引用写错了要看运气才报错" —— 同一份定义换个行序错误就出现/消失，
 * 这种不确定性比多算一行贵得多。
 */
export function evaluateIf(params: Record<string, unknown>, ctx: Ctx): boolean {
  const group = readConditionGroup(params)
  if (!group) return truthy(resolveTemplate(params.condition, ctx))

  const results = group.items.map((item) => {
    let left: unknown
    try {
      left = resolveTemplate(item.left, ctx)
    } catch (err) {
      // 「为空 / 不为空」问的正是"那儿有没有东西"，取不到就是空 —— 这是答案不是故障。
      // 其余比较方式照引擎通则炸掉：`包含` 一个不存在的字段是笔误，不是 false
      if (!(err instanceof MissingValue) || !opToleratesMissing(item.op)) throw err
      left = undefined
    }
    const right = opNeedsValue(item.op) ? resolveTemplate(item.right ?? '', ctx) : undefined
    return compareCondition(item.op, left, right)
  })

  return group.logic === 'or' ? results.some(Boolean) : results.every(Boolean)
}

// latestOutput 搬到了 output.ts —— 它讲的是"哪份输出算当前的"，属于输出形态那一族，
// 而 outputShape 也要用它，从 engine 取会绕出一条 vars → outputShape → engine → vars 的环。
// 这里再导出一次，调用点不用改。
export { latestOutput } from './output.ts'

/**
 * 把一次运行的数据还原成表达式上下文。
 *
 * 消息预览要用**和实际运行同一个** resolveTemplate 去渲染，才不会出现
 * "预览好好的、发出去是另一样"。只取成功的步骤 —— 失败步骤的 output
 * 是 undefined，混进来只会让引用悄悄解析成空。
 *
 * 固定数据（pinData）合并进来，且**盖过**运行结果，和 NDV 输出栏一个语义。
 * 手写一份 mock 正是没法真跑的时候用的，那时候更需要预览和取值面板解析得出
 * 东西来；以前只看 run.steps，pin 了但没跑过的节点在预览里一律是空 —— 界面
 * 明明画着数据，引用它却渲染成空字符串。
 */
export function ctxFromRun(run: FlowRun | null, pinData: Record<string, unknown> = {}): Ctx | null {
  const pinnedIds = Object.keys(pinData)
  if (!run && pinnedIds.length === 0) return null
  const nodes: Ctx['nodes'] = Object.fromEntries(
    Object.entries(run?.steps ?? {})
      .filter(([, s]) => s.at(-1)?.status === 'success')
      .map(([id, s]) => [id, { output: s.at(-1)!.output }]),
  )
  for (const id of pinnedIds) nodes[id] = { output: pinData[id] }
  return {
    trigger: run?.trigger ?? {},
    // 没有运行记录时的基准时刻取"此刻"—— date() 得有个基准才能算。这和
    // MessagePreview 早先的兜底上下文是同一个约定。
    run: run
      ? { id: run.id, startedAt: new Date(run.startedAt).toISOString() }
      : { id: 'preview', startedAt: new Date().toISOString() },
    nodes,
  }
}

/**
 * 用一次运行的数据构造引用预览函数（n8n 表达式实时预览）。
 * 字段下的 {{ $.nodes.n1.output.x }} chip 会显示 → 实际值。
 */
export function previewFromRun(
  run: FlowRun | null,
  pinData: Record<string, unknown> = {},
): ((path: string) => { found: boolean; value: unknown }) | undefined {
  const ctx = ctxFromRun(run, pinData)
  if (!ctx) return undefined
  return (path: string) => {
    const value = lookupPath(ctx, path)
    return { found: value !== undefined, value }
  }
}

/**
 * 只解析 {{ $.xxx }} 和函数调用，把裸 {{name}} 原样留下。
 *
 * 三种写法在 SQL 字段里各司其职，靠形状区分，不会打架：
 *   {{date}}                     裸标识符 → SQL 占位符，透传给后端按类型渲染
 *   {{ $.trigger.date }}         带 $. → 前端解析成值
 *   {{ date('now-1d','yyyyMMdd') }}  带括号 → 前端调函数
 * 后端的 BRACE_RE 只认 {{标识符}}，所以后两种到不了它那儿，不会被误当占位符。
 */
function resolvePreservingPlaceholders(value: unknown, ctx: Ctx): unknown {
  if (typeof value !== 'string') return value
  return value.replace(blockRe(), (whole, expr) => {
    const body = String(expr).trim()
    if (!body.includes('$.') && !CALL_RE.test(body)) return whole // 裸占位符，透传给后端
    const v = resolveExpr(body, ctx)
    // 和 resolveTemplate 同一条规则：缺值报错，不渲染成空串。
    // 这条路径更要命 —— 它渲染的是 SQL，`where vid = ` 直接是语法错（还算好的），
    // `where vid = '' ` 则是合法、恒假、静默返回空结果集
    if (v === undefined) throw new MissingValue(body)
    return typeof v === 'string' ? v : JSON.stringify(v)
  })
}

/**
 * 把节点 params 全量解析成服务实际收到的入参。
 *
 * schema 里声明了 `x-placeholders` 的字段特殊处理：裸 `{{name}}` 原样透传，
 * 并把同名流程入参的值自动补进 `valuesFrom` 指定的兄弟字段 —— 这样 SQL 直接
 * 贴进来就能跑，不用再手动填一遍键值对。已有的显式值优先，不会被覆盖。
 */
export function resolveParams(
  params: Record<string, unknown>,
  ctx: Ctx,
  schema?: JsonSchema,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const autoBind: Array<{ target: string; names: string[] }> = []

  for (const [k, v] of Object.entries(params)) {
    const field = schema?.properties?.[k]
    const ph = field?.['x-placeholders']
    // 在线注册表短暂缺字段时，不能让 SQL 自动绑定静默失效。`sql` +
    // `params` 是两个 SQL 节点共用的稳定契约；schema 元数据仍是首选。
    const placeholderTarget = ph?.valuesFrom
      ?? (k === 'sql' && typeof v === 'string' && Object.prototype.hasOwnProperty.call(params, 'params')
        ? 'params'
        : undefined)
    if (placeholderTarget && typeof v === 'string') {
      out[k] = resolvePreservingPlaceholders(v, ctx)
      // 两种写法都要自动代入，用和表单、校验同一个解析器
      autoBind.push({
        target: placeholderTarget,
        names: extractSqlPlaceholders(String(out[k])).map((p) => p.name),
      })
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = resolveParams(v as Record<string, unknown>, ctx)
    } else {
      out[k] = resolveTemplate(v, ctx)
    }
  }

  for (const { target, names } of autoBind) {
    // 从零重建，只放当前 SQL 里真实存在的占位符 ——
    // 改 SQL 删掉某个占位符后，之前填的值会留在定义里，直接透传会被后端
    // 判成"多余参数"而整条查询失败。以 SQL 为准，陈旧的键在这里自然消失。
    const existing = (out[target] as Record<string, unknown>) ?? {}
    const bag: Record<string, unknown> = {}
    for (const name of names) {
      if (name in existing) {
        bag[name] = existing[name] // 显式填的优先
      } else {
        const fromTrigger = (ctx.trigger as Record<string, unknown>)[name]
        if (fromTrigger !== undefined) bag[name] = fromTrigger
      }
    }
    out[target] = bag
  }
  return out
}

// ---------------------------------------------------------------- mock 输出

/**
 * mock 输出。**完全确定** —— 没有任何随机源。
 *
 * 这里原先还挂着一个 makeSeq(seed) 伪随机流（executeFlow 用种子 42、
 * executeSingleNode 用 7），一路传进来当 `_seq` 形参，**一次都没被用过**。
 * 它是个隐患而不只是死代码：那种流的取值依赖"在它之前有几个节点调用过"，
 * 一旦引擎并发，同一份输入会随调度顺序产出不同的 mock 数据 ——
 * 而回放测试最不能容忍的就是这个。趁没人用先删掉。
 */
export function mockOutput(node: FNode, ctx: Ctx, resolved: Record<string, unknown>, edges: Edge[]): unknown {
  const probedCols = Object.keys(node.data.probedOutput ?? {})
    .filter((k) => k.startsWith('rows[].'))
    .map((k) => k.slice('rows[].'.length))

  switch (node.data.typeId) {
    case 'trigger.manual':
      return { runId: ctx.run.id, startedAt: ctx.run.startedAt }
    case 'trigger.schedule':
      // 手动点运行时，定时触发器就是立刻跑一次 —— scheduledFor 记的是这次的
      // 计划时间，真到点自动跑的时候由调度器填
      return { runId: ctx.run.id, startedAt: ctx.run.startedAt, scheduledFor: ctx.run.startedAt }
    case 'sql.query':
    case 'postgres.workspace': {
      const cols = probedCols.length ? probedCols : ['vid', 'name', 'created_at']
      const rows = Array.from({ length: 3 }, (_, i) =>
        Object.fromEntries(cols.map((c) => [c, c === 'vid' ? String(ctx.trigger.vid ?? 10000 + i) : `${c}_${i + 1}`])),
      )
      return { rows, rowCount: rows.length, affectedRows: 0, truncated: false }
    }
    case 'date.compute': {
      // 基准和 {{ date() }} 完全一致：本次运行的开始时刻。两种写法混用也不会差一天
      const base = new Date(ctx.run.startedAt)
      return dateNodeOutput(resolved, Number.isNaN(base.getTime()) ? new Date() : base)
    }
    case 'flow.if':
      // 不看 resolved：条件行是嵌在对象里的模板字符串，resolveParams 不会下钻到
      // 数组元素里去解析它们。判定统一走 evaluateIf，和 executeFlow 同一份规则
      return { matched: evaluateIf(node.data.params, ctx) }
    case 'flow.merge':
      // 只汇总真正连进来的分支，不是全图所有节点。
      //
      // 用 map 不用 flatMap：没跑到的分支要留一个 null 占位，**下标必须和入边
      // 顺序一一对应**。以前 flatMap 会把它挤掉，于是 branches[0] 是"碰巧跑了的
      // 那条"而不是"第一条入边" —— 取值面板要按分支名显示，建在这上面会把
      // 正确的数据贴上错误的来源名，而且是静默的。
      return {
        branches: edges
          .filter((e) => e.target === node.id)
          .map((e) => (e.source in ctx.nodes ? ctx.nodes[e.source].output : null)),
      }
    case 'flow.end':
      return { result: resolved.result ?? null }
    case 'transform.map':
      return { value: resolved.expression ?? null }
    case 'transform.template':
      return { text: String(resolved.template ?? '') }
    case 'variable.assign':
      return { values: resolved.values ?? {} }
    case 'list.operation': {
      const items = Array.isArray(resolved.items) ? resolved.items : []
      const operation = String(resolved.operation ?? 'slice')
      if (operation === 'first') return { result: items[0] ?? null, count: items.length ? 1 : 0 }
      if (operation === 'last') return { result: items.at(-1) ?? null, count: items.length ? 1 : 0 }
      const start = Math.max(0, Number(resolved.start ?? 0) || 0)
      const count = Math.max(1, Number(resolved.count ?? 10) || 10)
      const result = items.slice(start, start + count)
      return { result, count: result.length }
    }
    case 'http.request':
      return { status: 200, body: { ok: true, url: resolved.url }, headers: { 'content-type': 'application/json' } }
    case 'notify.wecom': {
      // 形状对齐服务端返回。mock 模式下当然没真发出去，但 sent 报 true 会骗人，
      // 所以 target 明确标 (mock)。
      const content = String(resolved.content ?? '')
      return {
        sent: false,
        bytes: new TextEncoder().encode(content).length,
        target: '(mock：后端未连接，没有真的发送)',
      }
    }
    default:
      return {}
  }
}

/** 一条边在 UI 上显示的条数标签（n8n 的 "3 items"） */
export function itemCount(output: unknown): number {
  if (!output || typeof output !== 'object') return 1
  const o = output as Record<string, unknown>
  for (const key of ROW_KEYS) {
    if (Array.isArray(o[key])) return (o[key] as unknown[]).length
  }
  return 1
}

// ---------------------------------------------------------------- 图执行

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms)
  if (signal.aborted) return Promise.reject(new Aborted())
  return new Promise((resolve, reject) => {
    // 用全局 setTimeout 而不是 window.setTimeout：这个文件要能在 Node 里跑
    // （worker、以及回放测试的基线捕获）。全局那个两边都有，window 只有浏览器有。
    // 返回值类型两边不同，所以不标注类型让它自己推。
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Aborted())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 解析参数，模板炸了就把错误带回来，不要抛出去。
 *
 * resolveParams 原先全在 try 之外（5 处）。模板报错（未知过滤器、裸标识符）
 * 会一路逃出 executeFlow —— 而 startRun 只有 finally 没有 catch，且是以
 * void 调用的。后果：未处理的 rejection；run.status 永远停在 'running'
 * 成为僵尸记录；而 running 被 finally 清掉，所以界面看着一切正常。
 * 用户只知道"跑了一下没反应"。
 */
function tryResolveParams(node: FNode, ctx: Ctx): { input: Record<string, unknown>; error?: string } {
  try {
    return { input: resolveParams(node.data.params, ctx, NODE_TYPE_MAP.get(node.data.typeId)?.input) }
  } catch (err) {
    return { input: {}, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 这个节点该走真实服务还是 mock */
export function isLive(node: FNode): boolean {
  const t = NODE_TYPE_MAP.get(node.data.typeId)
  return isOnline() && !!t?.runtime
}

/** ExecuteOptions.isLive 的缺省实现。取别名是因为 executeFlow 里同名变量会遮蔽它 */
const defaultIsLive = isLive

export class Aborted extends Error {
  constructor() {
    super('已中止')
  }
}

/**
 * 真实执行一个异步节点：submit 拿 handle，然后轮询到完成。
 *
 * 完成与否完全以后端返回的 done 为准 —— 平台的 progress 不单调（多阶段任务会
 * 走到 100 再掉回去重爬），拿进度判完成会提前取到空结果。
 *
 * 中止时一定要 cancel：不撤的话 Hive 那边会继续跑完，白烧集群资源。
 */
async function runLiveNode(
  node: FNode,
  input: Record<string, unknown>,
  onProgress: (progress: number, handle: string) => void,
  signal?: AbortSignal,
): Promise<unknown> {
  const t = NODE_TYPE_MAP.get(node.data.typeId)!

  // 同步节点：一次请求拿结果。发消息这类秒级操作不该走轮询
  if (t.runtime?.kind === 'http') {
    const { output } = await executeNode(t.type, input)
    return output ?? {}
  }

  const interval = t.runtime?.pollIntervalMs ?? 3000
  const limit = Number(input.limit ?? 1000) || 1000

  const { handle } = await submitNode(t.type, input)
  onProgress(0, handle)

  // 轮询失败不等于查询失败：网络抖一下、服务重启一下，平台上的任务都还好好的。
  // 连续失败到 MAX_CONSECUTIVE_POLL_FAILURES 次才认输，中间的单次失败只是等下一轮。
  let consecutiveFailures = 0

  try {
    for (;;) {
      if (signal?.aborted) throw new Aborted()
      await abortableSleep(interval, signal)
      if (signal?.aborted) throw new Aborted()

      let result
      try {
        result = await pollNode(t.type, handle, limit)
        consecutiveFailures = 0
      } catch (err) {
        // 结果被平台清理这类错误重试没意义，直接抛。
        // **按错误码判，不按文案判** —— 以前这里是 msg.includes('已不在数据平台上')，
        // 改一个字文案就静默失效，而失效的表现是"本该停的一直重试"
        if (!isRetryable((err as { code?: string })?.code)) throw err
        if (++consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          const detail = err instanceof Error ? err.message : String(err)
          throw new Error(`连续 ${consecutiveFailures} 次查询状态失败：${detail}`)
        }
        continue
      }

      onProgress(result.progress, handle)
      if (!result.done) continue
      if (result.failed) throw new Error(result.error || '查询失败')
      return result.output ?? {}
    }
  } catch (err) {
    if (err instanceof Aborted || signal?.aborted) {
      try {
        await cancelNode(t.type, handle)
      } catch {
        // 中止的主结果不能被取消接口的网络错误覆盖。
      }
    }
    throw err
  }
}

// ---------------------------------------------------------------- 执行边界

/**
 * 执行一个节点所需的一切。**这是引擎里唯一发生 IO 的接口。**
 *
 * 拆出来是为了让图遍历那部分变成可以脱离环境运行的纯逻辑：浏览器给 mock 宿主、
 * worker 给真实宿主、回放测试给"从 fixture 里读一个答案"的宿主，三者共用同一份
 * 遍历代码。原先 mock 与真实两条路径缠在 runNode 里（一个 if(live) 分出两套
 * try/catch、两套错误记录），加一种宿主就要再抄一遍。
 */
export interface StepExecRequest {
  node: FNode
  /** 表达式解析后的实际入参 —— 服务真正收到的东西 */
  input: Record<string, unknown>
  /** 循环体里的第几次（0 起）；不在循环体内为 undefined */
  iteration?: number
  /** 走真实服务还是 mock */
  live: boolean
  /** 表达式上下文。循环体内带 loop */
  ctx: Ctx
  edges: Edge[]
  /** 异步节点的进度回调。handle 必须回传 —— 中止和崩溃恢复都要靠它 */
  onProgress: (progress: number, handle: string) => void
  signal?: AbortSignal
}

export type StepExecutor = (req: StepExecRequest) => Promise<unknown>

/**
 * 缺省执行器：live 走真实服务，否则 mock。
 *
 * 写成 async 函数而不是返回 Promise.resolve(mockOutput(...))：mockOutput 会抛
 * （未知过滤器、缺值引用），同步抛出去会绕过调用方的 catch 一路逃出 executeFlow，
 * 留下永远 running 的僵尸记录 —— 这正是原先 tryMockOutput 存在的理由。
 * async 函数把同步抛转成 rejection，调用方一个 try/catch 全接住。
 */
export const defaultExecutor: StepExecutor = async (req) =>
  req.live
    ? runLiveNode(req.node, req.input, req.onProgress, req.signal)
    : mockOutput(req.node, req.ctx, req.input, req.edges)


export async function executeFlow(opts: ExecuteOptions): Promise<FlowRun> {
  const { trigger, pinData, flowInputs, onStep, onRunUpdate } = opts
  const nodes = opts.nodes.filter((node) => !NODE_TYPE_MAP.get(node.data.typeId)?.visualOnly)
  const runnableIds = new Set(nodes.map((node) => node.id))
  const edges = opts.edges.filter((edge) => runnableIds.has(edge.source) && runnableIds.has(edge.target))
  const delay = opts.stepDelayMs ?? 240
  const execute = opts.execute ?? defaultExecutor
  const isLive = opts.isLive ?? defaultIsLive

  const startedAt = opts.startedAtMs ?? Date.now()
  const run: FlowRun = {
    id: opts.runId ?? `run_${startedAt.toString(36)}`,
    status: 'running',
    startedAt,
    trigger,
    steps: {},
  }
  onRunUpdate({ ...run })

  const ctx: Ctx = {
    trigger,
    run: { id: run.id, startedAt: new Date(run.startedAt).toISOString() },
    nodes: {},
  }

  const order = topoSort(nodes, edges)
  /** 已判定不执行的节点（分支未命中 / 上游失败中断） */
  const dead = new Set<string>()
  /** 循环体内已经跑过的节点，主循环里跳过 */
  const inLoopBody = new Set<string>()
  let failed = false

  /** 写入序号。每次 record 递增，供回放测试比较执行序列 —— 见 StepRun.seq 的注释 */
  let writeSeq = 0

  const record = (step: StepRun) => {
    const typeId = nodes.find((node) => node.id === step.nodeId)?.data.typeId ?? ''
    const recorded = { ...step, seq: ++writeSeq, input: redactNodeInput(typeId, step.input) }
    const list = run.steps[recorded.nodeId] ?? []
    const idx = list.findIndex((s) => s.iteration === recorded.iteration)
    if (idx >= 0) list[idx] = recorded
    else list.push(recorded)
    run.steps[step.nodeId] = list
    onStep(recorded)
    onRunUpdate({ ...run, steps: { ...run.steps } })
  }

  const skip = (ids: Iterable<string>) => {
    for (const id of ids) {
      if (run.steps[id]?.length) continue
      dead.add(id)
      record({ nodeId: id, status: 'skipped', startedAt: Date.now(), durationMs: 0, input: {}, output: null })
    }
  }

  /** 执行单个节点一次，返回最终 StepRun */
  const runNode = async (node: FNode, iteration?: number, loopCtx?: Ctx['loop']): Promise<StepRun> => {
    const startedAt = Date.now()
    const live = isLive(node)
    const running: StepRun = { nodeId: node.id, status: 'running', startedAt, durationMs: 0, input: {}, output: null, iteration, live }
    record(running)
    // mock 节点靠 sleep 让画布动起来；真实节点本身就有耗时，不额外拖延
    if (!live) await sleep(iteration !== undefined ? Math.round(delay * 0.6) : delay)

    const localCtx: Ctx = loopCtx ? { ...ctx, loop: loopCtx } : ctx
    const resolved = tryResolveParams(node, localCtx)
    if (resolved.error) {
      const step: StepRun = { nodeId: node.id, status: 'error', startedAt, durationMs: Date.now() - startedAt, input: {}, output: null, error: resolved.error, iteration, live }
      record(step)
      return step
    }
    const input = resolved.input

    let output: unknown
    let pinned = false
    if ((opts.mode ?? 'manual') === 'manual' && Object.prototype.hasOwnProperty.call(pinData, node.id)) {
      // n8n 语义：手动运行时 pinned 数据直接替代执行，
      // 且 pinned 节点跳过参数校验（checkReadyForExecution 对 pinned 节点放行）
      output = pinData[node.id]
      pinned = true
    } else {
      // 静态校验错误在运行期表现为节点报错 —— 演示 onError 两种策略
      const errors = validateNode(node, nodes, edges, flowInputs)
      if (errors.length) {
        const step: StepRun = { nodeId: node.id, status: 'error', startedAt, durationMs: Date.now() - startedAt, input, output: null, error: errors[0], iteration, live }
        record(step)
        return step
      }
      // mock 与真实两条路径合并成一次 execute：错误处理只剩这一处，
      // 不会再出现"改了 live 的分支忘了改 mock 的"
      try {
        output = await execute({
          node,
          input,
          iteration,
          live,
          ctx: localCtx,
          edges,
          onProgress: (progress, handle) =>
            record({ nodeId: node.id, status: 'running', startedAt, durationMs: Date.now() - startedAt, input, output: null, iteration, progress, handle, live }),
          signal: opts.signal,
        })
      } catch (err) {
        const step: StepRun = {
          nodeId: node.id, status: 'error', startedAt, durationMs: Date.now() - startedAt,
          input, output: null, error: err instanceof Error ? err.message : String(err),
          iteration, live,
        }
        record(step)
        return step
      }
    }
    ctx.nodes[node.id] = { output }

    const step: StepRun = { nodeId: node.id, status: 'success', startedAt, durationMs: Date.now() - startedAt, input, output, pinned, iteration, live }
    record(step)
    return step
  }

  for (const node of order) {
    if (dead.has(node.id) || inLoopBody.has(node.id)) continue
    if (opts.signal?.aborted) { skip([node.id]); failed = true; continue }
    if (failed) { skip([node.id]); continue }

    // 非触发器节点：没有任何入边 → 不执行（游离节点不该跟着流程跑）
    const t = NODE_TYPE_MAP.get(node.data.typeId)
    const incoming = edges.filter((e) => e.target === node.id)
    if (t?.hasInput !== false) {
      if (incoming.length === 0) { skip([node.id]); continue }
      const alive = incoming.some((e) => {
        const src = run.steps[e.source]?.at(-1)
        return src && src.status !== 'skipped' && src.status !== 'error' && !dead.has(e.source)
      })
      const errButContinue = incoming.some((e) => {
        const srcNode = nodes.find((n) => n.id === e.source)
        const src = run.steps[e.source]?.at(-1)
        return src?.status === 'error' && srcNode?.data.onError === 'continue'
      })
      if (!alive && !errButContinue) { skip([node.id]); continue }
    }

    // 条件分支：先执行自身，再灭掉未命中分支的下游
    if (node.data.typeId === 'flow.if') {
      const startedAt = Date.now()
      const r = tryResolveParams(node, ctx)
      if (r.error) {
        // 和下面的校验失败走同一条路：记错、置位，下游由循环顶部的活性检查处理
        record({ nodeId: node.id, status: 'error', startedAt, durationMs: 0, input: {}, output: null, error: r.error })
        if (node.data.onError === 'fail') failed = true
        continue
      }
      const localInput = r.input
      await sleep(delay)
      const errors = validateNode(node, nodes, edges, flowInputs)
      if (errors.length) {
        record({ nodeId: node.id, status: 'error', startedAt, durationMs: Date.now() - startedAt, input: localInput, output: null, error: errors[0] })
        if (node.data.onError === 'fail') failed = true
        continue
      }
      // 条件行里的引用不经过 tryResolveParams（它不下钻数组），所以求值可能在
      // 这里才炸。不接住的话异常会逃出 executeFlow，运行记录停在 running 变僵尸
      let matched: boolean
      try {
        matched = evaluateIf(node.data.params, ctx)
      } catch (err) {
        record({ nodeId: node.id, status: 'error', startedAt, durationMs: Date.now() - startedAt, input: localInput, output: null, error: err instanceof Error ? err.message : String(err) })
        if (node.data.onError === 'fail') failed = true
        continue
      }
      ctx.nodes[node.id] = { output: { matched } }
      record({ nodeId: node.id, status: 'success', startedAt, durationMs: Date.now() - startedAt, input: localInput, output: { matched } })
      const deadPort = matched ? 'false' : 'true'
      const deadTargets = outgoing(edges, node.id, deadPort).map((e) => e.target)
      // 全图活性：把未命中口的边和已死节点的出边当作不存在，
      // 从所有根节点还能到达的都算活 —— 这样「从别的路径也能到」的汇合点不会被误杀
      const deadEdgeSet = new Set(outgoing(edges, node.id, deadPort))
      const liveEdges = edges.filter((e) => !deadEdgeSet.has(e) && !dead.has(e.source))
      const roots = nodes.filter((n) => !dead.has(n.id) && !edges.some((e) => e.target === n.id)).map((n) => n.id)
      const liveSet = reachableFrom(roots, liveEdges)
      skip([...reachableFrom(deadTargets, edges)].filter((id) => !liveSet.has(id)))
      continue
    }

    // 循环：each 子树按迭代跑多次，done 子树之后正常跑
    if (node.data.typeId === 'flow.foreach') {
      const step = await runNodeForeach(node)
      if (step.status === 'error' && node.data.onError === 'fail') failed = true
      continue
    }

    const step = await runNode(node)
    if (step.status === 'error' && node.data.onError === 'fail') failed = true
  }

  // failed 已在每个错误点按 onError 语义置位；onError=continue 的错误不影响整体结果
  run.status = failed ? 'error' : 'success'
  run.finishedAt = Date.now()
  onRunUpdate({ ...run, steps: { ...run.steps } })
  return run

  async function runNodeForeach(node: FNode): Promise<StepRun> {
    const startedAt = Date.now()
    const params = tryResolveParams(node, ctx)
    if (params.error) {
      const step: StepRun = { nodeId: node.id, status: 'error', startedAt, durationMs: 0, input: {}, output: null, error: params.error }
      record(step)
      return step
    }
    const input = params.input
    const errors = validateNode(node, nodes, edges, flowInputs)
    if (errors.length) {
      const step: StepRun = { nodeId: node.id, status: 'error', startedAt, durationMs: 0, input, output: null, error: errors[0] }
      record(step)
      return step
    }
    record({ nodeId: node.id, status: 'running', startedAt, durationMs: 0, input, output: null })

    // items 的解析必须在这里兜住错，不能让它抛出去。
    //
    // 这一行**不在** tryResolveParams 的保护范围内（那个解的是 params 全量，
    // 这里是单独再解一次 items 拿原始数组）。抛出去会一路逃出 executeFlow，
    // 而 startRun 只有 finally 没有 catch —— 运行记录永远停在 running 成为
    // 僵尸，界面看着一切正常。文件里另外两处已经为同一个理由做过兜底。
    let items: unknown[]
    try {
      const resolved = resolveTemplate(node.data.params.items, ctx)
      if (!Array.isArray(resolved)) {
        throw new Error(
          `循环的「数据来源」要指向一个数组，实际解析出的是 ${resolved === null ? 'null' : typeof resolved}。` +
            `通常应该引用上游的结果集，例如 {{ $.nodes.q1.output.rows }}`,
        )
      }
      // 护栏而不是截断。以前这里是 slice(0, 3) —— 那是 mock 期的限制，
      // 但它对**真实节点也生效**：循环体里的 SQL 是真跑的，用户配了 500 个 vid，
      // 只跑了前 3 个，剩下 497 个静默消失，运行记录还是绿的。
      //
      // 直接放开也不行：一个 foreach 一次展开几百条 Hive 查询，代价会外溢到
      // 别的团队。所以是超限就整个节点失败，并告诉用户去 SQL 里加 LIMIT。
      if (resolved.length > MAX_LOOP_ITERATIONS) {
        throw new Error(
          `循环项有 ${resolved.length} 条，超过上限 ${MAX_LOOP_ITERATIONS}。` +
            `请在上游 SQL 里加 LIMIT，或先用「列表操作」节点截取`,
        )
      }
      items = resolved
    } catch (err) {
      const step: StepRun = {
        nodeId: node.id, status: 'error', startedAt, durationMs: Date.now() - startedAt,
        input, output: null, error: err instanceof Error ? err.message : String(err),
      }
      record(step)
      return step
    }

    // each 子树：从 each 口出发可达、且不经过 done 口可达的节点
    const eachTargets = outgoing(edges, node.id, 'each').map((e) => e.target)
    const doneTargets = outgoing(edges, node.id, 'done').map((e) => e.target)
    const doneSet = reachableFrom(doneTargets, edges)
    const bodyIds = [...reachableFrom(eachTargets, edges)].filter((id) => !doneSet.has(id) && id !== node.id)
    const bodySet = new Set(bodyIds)
    const bodyEdges = edges.filter((e) => bodySet.has(e.source) && bodySet.has(e.target))
    const bodyNodes = topoSort(nodes.filter((n) => bodySet.has(n.id)), edges)
    for (const id of bodyIds) inLoopBody.add(id)

    const results: unknown[] = []
    let failCount = 0
    let aborted = false
    for (let i = 0; i < items.length && !aborted; i++) {
      const loop = { item: items[i], index: i }
      /** 本次迭代内被体内 if 灭掉的节点 */
      const iterDead = new Set<string>()
      let iterFailed = false

      for (const bn of bodyNodes) {
        if (iterDead.has(bn.id)) {
          record({ nodeId: bn.id, status: 'skipped', startedAt: Date.now(), durationMs: 0, input: {}, output: null, iteration: i })
          continue
        }
        // mock 引擎不支持嵌套循环：显式报错，绝不静默产出错误数据
        if (bn.data.typeId === 'flow.foreach') {
          record({ nodeId: bn.id, status: 'error', startedAt: Date.now(), durationMs: 0, input: {}, output: null, error: 'mock 引擎暂不支持嵌套循环（后端引擎支持后放开）', iteration: i })
          iterFailed = true
          if (bn.data.onError === 'fail') { aborted = true; break }
          continue
        }
        // 循环体内的条件分支：按本次迭代的 loop 上下文求值，只灭体内节点
        if (bn.data.typeId === 'flow.if') {
          const localCtx: Ctx = { ...ctx, loop }
          const bStart = Date.now()
          const br = tryResolveParams(bn, localCtx)
          if (br.error) {
            record({ nodeId: bn.id, status: 'error', startedAt: bStart, durationMs: 0, input: {}, output: null, error: br.error, iteration: i })
            iterFailed = true
            if (bn.data.onError === 'fail') { aborted = true; break }
            continue
          }
          const bInput = br.input
          await sleep(Math.round(delay * 0.6))
          const errors = validateNode(bn, nodes, edges, flowInputs)
          if (errors.length) {
            record({ nodeId: bn.id, status: 'error', startedAt: bStart, durationMs: Date.now() - bStart, input: bInput, output: null, error: errors[0], iteration: i })
            iterFailed = true
            if (bn.data.onError === 'fail') { aborted = true; break }
            continue
          }
          let matched: boolean
          try {
            matched = evaluateIf(bn.data.params, localCtx)
          } catch (err) {
            record({ nodeId: bn.id, status: 'error', startedAt: bStart, durationMs: Date.now() - bStart, input: bInput, output: null, error: err instanceof Error ? err.message : String(err), iteration: i })
            iterFailed = true
            if (bn.data.onError === 'fail') { aborted = true; break }
            continue
          }
          ctx.nodes[bn.id] = { output: { matched } }
          record({ nodeId: bn.id, status: 'success', startedAt: bStart, durationMs: Date.now() - bStart, input: bInput, output: { matched }, iteration: i })
          const deadPort = matched ? 'false' : 'true'
          const deadT = outgoing(edges, bn.id, deadPort).map((e) => e.target)
          const liveT = outgoing(edges, bn.id, matched ? 'true' : 'false').map((e) => e.target)
          const liveSet = reachableFrom(liveT, bodyEdges)
          for (const id of reachableFrom(deadT, bodyEdges)) {
            if (!liveSet.has(id) && bodySet.has(id)) iterDead.add(id)
          }
          continue
        }
        const s = await runNode(bn, i, loop)
        if (s.status === 'error') {
          iterFailed = true
          if (bn.data.onError === 'fail') { aborted = true; break }
        }
      }

      if (iterFailed) failCount++
      results.push({ index: i, item: items[i] })
    }

    const output = { results, okCount: results.length - failCount, failCount }
    ctx.nodes[node.id] = { output }
    if (aborted) {
      // 体内节点 onError=fail：中止整条流程（对齐 n8n 停止 workflow 的语义）
      failed = true
      const step: StepRun = { nodeId: node.id, status: 'error', startedAt, durationMs: Date.now() - startedAt, input, output, error: '循环体节点失败（onError=中断），流程中止' }
      record(step)
      return step
    }
    const step: StepRun = { nodeId: node.id, status: 'success', startedAt, durationMs: Date.now() - startedAt, input, output }
    record(step)
    return step
  }
}

/**
 * 单节点试运行（n8n 的 "Test step"）：
 * 上游数据来自最近一次运行的输出 + pinned 数据覆盖，只执行这一个节点。
 * 这就是「改一个参数不用重跑整条流程」的关键能力。
 */
export async function executeSingleNode(opts: {
  node: FNode
  nodes: FNode[]
  edges: Edge[]
  flowInputs: FlowInputField[]
  trigger: Record<string, unknown>
  pinData: Record<string, unknown>
  baseRun: FlowRun | null
  onStep: (step: StepRun) => void
  signal?: AbortSignal
  /** 见 ExecuteOptions.execute */
  execute?: StepExecutor
}): Promise<StepRun> {
  const { node, nodes, edges, flowInputs, trigger, pinData, baseRun, onStep, signal } = opts
  const execute = opts.execute ?? defaultExecutor
  const ctx: Ctx = {
    trigger,
    run: { id: baseRun?.id ?? 'run_teststep', startedAt: new Date().toISOString() },
    nodes: {},
  }
  // 组装上游上下文：pinned 优先，其次最近一次运行的输出
  for (const n of nodes) {
    if (Object.prototype.hasOwnProperty.call(pinData, n.id)) {
      ctx.nodes[n.id] = { output: pinData[n.id] }
    } else {
      const last = baseRun?.steps[n.id]?.at(-1)
      if (last && last.status === 'success') ctx.nodes[n.id] = { output: last.output }
    }
  }

  const startedAt = Date.now()
  onStep({ nodeId: node.id, status: 'running', startedAt, durationMs: 0, input: {}, output: null })
  await sleep(200)
  if (signal?.aborted) {
    const step: StepRun = { nodeId: node.id, status: 'error', startedAt, durationMs: Date.now() - startedAt, input: {}, output: null, error: '已中止' }
    onStep(step)
    return step
  }

  const pinnedHere = Object.prototype.hasOwnProperty.call(pinData, node.id)
  const live = !pinnedHere && isLive(node)
  const resolved = tryResolveParams(node, ctx)
  if (resolved.error) {
    const step: StepRun = { nodeId: node.id, status: 'error', startedAt, durationMs: Date.now() - startedAt, input: {}, output: null, error: resolved.error, live }
    onStep(step)
    return step
  }
  const input = resolved.input
  if (!pinnedHere) {
    const errors = validateNode(node, nodes, edges, flowInputs)
    if (errors.length) {
      const step: StepRun = { nodeId: node.id, status: 'error', startedAt, durationMs: Date.now() - startedAt, input, output: null, error: errors[0], live }
      onStep(step)
      return step
    }
  }

  let output: unknown
  if (pinnedHere) {
    output = pinData[node.id]
  } else {
    // 和 executeFlow 一样走同一个执行边界：两处各写一套 live/mock 分支，
    // 迟早会出现"单节点试运行和整条运行结果不一致"
    try {
      output = await execute({
        node,
        input,
        live,
        ctx,
        edges,
        onProgress: (progress, handle) =>
          onStep({ nodeId: node.id, status: 'running', startedAt, durationMs: Date.now() - startedAt, input, output: null, progress, handle, live }),
        signal,
      })
    } catch (err) {
      const step: StepRun = {
        nodeId: node.id, status: 'error', startedAt, durationMs: Date.now() - startedAt,
        input, output: null, error: err instanceof Error ? err.message : String(err), live,
      }
      onStep(step)
      return step
    }
  }

  const step: StepRun = { nodeId: node.id, status: 'success', startedAt, durationMs: Date.now() - startedAt, input, output, pinned: pinnedHere, live }
  onStep(step)
  return step
}
