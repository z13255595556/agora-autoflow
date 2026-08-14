/**
 * 日期函数：`{{ date('now-1d', 'yyyyMMdd') }}`
 *
 * 为什么需要它：定时触发到点自己跑的时候没人填表单，"昨天"这种值必须能算出来。
 * 手动运行也一样受益 —— 日报不该每天手打一遍日期。
 *
 * 偏移语法沿用 Grafana / Kibana 那套（now-1d、now/d），团队本来就在用，
 * 不另发明一套。
 */

/** 相对时间锚点前缀 */
const NOW = 'now'

type Unit = 's' | 'm' | 'h' | 'd' | 'w' | 'M' | 'y'

const UNIT_NAME: Record<Unit, string> = {
  s: '秒', m: '分钟', h: '小时', d: '天', w: '周', M: '月', y: '年',
}

/** 单位大小写敏感：m 是分钟，M 是月 —— 和 Grafana 一致，也和格式化 token 一致 */
const UNIT_RE = /([+-])(\d+)([smhdwMy])/g
const TRUNC_RE = /\/([smhdwMy])$/

export class DateError extends Error {}

/**
 * 解析 now-1d / now+2h / now-1d/d 这类偏移，返回具体时刻。
 *
 * base 传运行开始时间而不是当下 —— 一次运行里所有日期必须来自同一个瞬间，
 * 否则跨零点那一刻，消息标题写的日期和 SQL 查的分区可能差一天。
 */
export function resolveMoment(expr: string, base: Date): Date {
  const raw = String(expr ?? '').trim()
  if (!raw) throw new DateError('日期表达式为空')

  let body = raw
  let truncate: Unit | null = null
  const t = body.match(TRUNC_RE)
  if (t) {
    truncate = t[1] as Unit
    body = body.slice(0, -t[0].length)
  }

  if (!body.startsWith(NOW)) {
    // 也允许直接给一个具体日期，方便"固定某天"
    const fixed = new Date(body)
    if (Number.isNaN(fixed.getTime())) {
      throw new DateError(`看不懂的日期「${raw}」。写 now、now-1d、now-2h，或一个具体日期如 2026-08-13`)
    }
    return truncate ? truncateTo(fixed, truncate) : fixed
  }

  const rest = body.slice(NOW.length)
  const d = new Date(base.getTime())
  if (rest) {
    UNIT_RE.lastIndex = 0
    let consumed = 0
    let m: RegExpExecArray | null
    while ((m = UNIT_RE.exec(rest)) !== null) {
      consumed += m[0].length
      const sign = m[1] === '-' ? -1 : 1
      const n = sign * Number(m[2])
      applyOffset(d, n, m[3] as Unit)
    }
    if (consumed !== rest.length) {
      throw new DateError(`看不懂的偏移「${rest}」。写法是 now-1d、now+2h、now-30m，单位 s/m/h/d/w/M/y（m 分钟、M 月）`)
    }
  }
  return truncate ? truncateTo(d, truncate) : d
}

function applyOffset(d: Date, n: number, unit: Unit) {
  switch (unit) {
    case 's': d.setSeconds(d.getSeconds() + n); break
    case 'm': d.setMinutes(d.getMinutes() + n); break
    case 'h': d.setHours(d.getHours() + n); break
    case 'd': d.setDate(d.getDate() + n); break
    case 'w': d.setDate(d.getDate() + n * 7); break
    case 'M': d.setMonth(d.getMonth() + n); break
    case 'y': d.setFullYear(d.getFullYear() + n); break
  }
}

/**
 * 截断到某个单位的开头。now-1d/d = 昨天 00:00:00。
 *
 * 由细到粗逐级清零：截到「天」意味着时分秒毫秒都得归零，
 * 只把 hours 设成 0 是不够的。
 */
function truncateTo(d: Date, unit: Unit): Date {
  const out = new Date(d.getTime())
  out.setMilliseconds(0)
  if (unit === 's') return out
  out.setSeconds(0)
  if (unit === 'm') return out
  out.setMinutes(0)
  if (unit === 'h') return out
  out.setHours(0)
  if (unit === 'd') return out
  if (unit === 'w') {
    // 周一为一周之首（ISO），不是周日
    out.setDate(out.getDate() - ((out.getDay() + 6) % 7))
    return out
  }
  out.setDate(1)
  if (unit === 'M') return out
  out.setMonth(0)
  return out
}

/** 常用格式的简写，省得记 token */
export const FORMAT_PRESETS: Record<string, string> = {
  compact: 'yyyyMMdd',
  date: 'yyyy-MM-dd',
  datetime: 'yyyy-MM-dd HH:mm:ss',
  time: 'HH:mm:ss',
  slash: 'yyyy/MM/dd',
  month: 'yyyyMM',
  cn: 'yyyy年M月d日',
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/**
 * 按 token 格式化。token 用 yyyy/MM/dd/HH/mm/ss/SSS，非 token 的字符原样保留。
 *
 * 单引号里的内容当字面量输出，用来放会和 token 撞的文字：
 * date('now', "yyyy年MM月dd日") 里的「年月日」不是 token，直接写就行；
 * 但要输出字母比如 T，得写成 'T'。
 */
export function formatDate(d: Date, format: string): string {
  const fmt = FORMAT_PRESETS[format] ?? format
  if (fmt === 'iso') return d.toISOString()
  if (fmt === 'unix') return String(Math.floor(d.getTime() / 1000))
  if (fmt === 'unix_ms') return String(d.getTime())

  const map: Record<string, string> = {
    yyyy: String(d.getFullYear()),
    yy: pad(d.getFullYear() % 100),
    MM: pad(d.getMonth() + 1),
    M: String(d.getMonth() + 1),
    dd: pad(d.getDate()),
    d: String(d.getDate()),
    HH: pad(d.getHours()),
    H: String(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
    SSS: pad(d.getMilliseconds(), 3),
  }
  // 长 token 必须排在前面，否则 yyyy 会被 yy 先吃掉
  return fmt.replace(/'([^']*)'|yyyy|yy|MM|M|dd|d|HH|H|mm|ss|SSS/g, (tok, literal) =>
    literal !== undefined ? literal : (map[tok] ?? tok),
  )
}

/** `date(偏移, 格式)` 的实现。两个参数都可省，默认 now + yyyy-MM-dd */
export function dateFn(args: string[], base: Date): string {
  const offset = args[0] ?? 'now'
  const format = args[1] ?? 'date'
  return formatDate(resolveMoment(offset, base), format)
}

/** 把任意来源的值当成时间读出来，供 `| date(格式)` 过滤器用 */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') {
    // 10 位当秒，13 位当毫秒 —— 日志和数仓里两种都常见
    const ms = value < 1e11 ? value * 1000 : value
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d
  }
  if (typeof value === 'string') {
    const s = value.trim()
    if (!s) return null
    // 纯数字：先按 yyyyMMdd 这种紧凑分区格式试，再按时间戳试
    if (/^\d{8}$/.test(s)) {
      return new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)))
    }
    if (/^\d+$/.test(s)) return toDate(Number(s))
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

/**
 * 变量选择器里列出来的常用日期，点一下直接插进光标处。
 *
 * 挑选标准：Hive 分区几乎都是 yyyyMMdd，所以紧凑格式排前面；
 * 消息正文里人读的是 yyyy-MM-dd，紧随其后。
 *
 * 标签里的样例值当场算，不写死 —— 写死的话过一天就在骗人（"昨天 20260812"
 * 到了明天还是这个数），而这个样例正是用户判断"选哪条"的唯一依据。
 */
export function datePresets(now: Date = new Date()): Array<{ label: string; expr: string }> {
  const at = (offset: string, fmt: string) => formatDate(resolveMoment(offset, now), fmt)
  return [
    { label: `昨天 ${at('now-1d', 'yyyyMMdd')}`, expr: "date('now-1d', 'yyyyMMdd')" },
    { label: `今天 ${at('now', 'yyyyMMdd')}`, expr: "date('now', 'yyyyMMdd')" },
    { label: `昨天 ${at('now-1d', 'yyyy-MM-dd')}`, expr: "date('now-1d', 'yyyy-MM-dd')" },
    { label: `今天 ${at('now', 'yyyy-MM-dd')}`, expr: "date('now', 'yyyy-MM-dd')" },
    { label: `7 天前 ${at('now-7d', 'yyyyMMdd')}`, expr: "date('now-7d', 'yyyyMMdd')" },
    { label: `本月 ${at('now', 'yyyyMM')}`, expr: "date('now', 'yyyyMM')" },
    { label: `此刻 ${at('now', 'yyyy-MM-dd HH:mm:ss')}`, expr: "date('now', 'yyyy-MM-dd HH:mm:ss')" },
    { label: `1 小时前整点 ${at('now-1h/h', 'yyyy-MM-dd HH:mm')}`, expr: "date('now-1h/h', 'yyyy-MM-dd HH:mm')" },
    { label: `昨天零点 时间戳(秒) ${at('now-1d/d', 'unix')}`, expr: "date('now-1d/d', 'unix')" },
  ]
}

// ---------------------------------------------------------------- 日期计算节点
//
// 表达式 date('now-1d','yyyyMMdd') 能干的事，这个节点全都能干，区别只在于
// 它是选出来的而不是敲出来的：偏移和格式各是一个下拉，选完当场看到结果。
// 表达式那条路留着 —— 想在一句话里嵌日期还是写 {{ date(…) }} 最短。

/** 每个模式对应的偏移表达式。取整语义写死在模式里，不再单开一个开关。 */
const MODE_EXPR: Record<string, (n: number) => string> = {
  now: () => 'now',
  today: () => 'now/d',
  yesterday: () => 'now-1d/d',
  dayBefore: () => 'now-2d/d',
  daysAgo: (n) => `now-${n}d/d`,
  hourStart: () => 'now/h',
  hoursAgo: (n) => `now-${n}h/h`,
  weekStart: () => 'now/w',
  lastWeekStart: () => 'now-1w/w',
  monthStart: () => 'now/M',
  lastMonthStart: () => 'now-1M/M',
  custom: () => 'now',
}

export const DATE_MODES = Object.keys(MODE_EXPR)

/** 下拉里显示的中文名。enum 值本身保持英文 —— 它会被存进流程定义。 */
export const DATE_MODE_LABELS: Record<string, string> = {
  now: '此刻（含时分秒）',
  today: '今天 零点',
  yesterday: '昨天 零点',
  dayBefore: '前天 零点',
  daysAgo: 'N 天前 零点',
  hourStart: '当前整点',
  hoursAgo: 'N 小时前 整点',
  weekStart: '本周一 零点',
  lastWeekStart: '上周一 零点',
  monthStart: '本月 1 号 零点',
  lastMonthStart: '上月 1 号 零点',
  custom: '自定义偏移…',
}

/** 输出格式下拉的取值。custom 之外都是 FORMAT_PRESETS / 特殊格式的键。 */
export const DATE_FORMATS = ['compact', 'date', 'datetime', 'time', 'month', 'cn', 'slash', 'iso', 'unix', 'custom']

/** 格式下拉的标签带当场算出来的样例：选之前就知道长什么样 */
export function dateFormatLabels(now: Date = new Date()): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of DATE_FORMATS) {
    out[f] = f === 'custom' ? '自定义格式…' : `${f} · ${formatDate(now, f)}`
  }
  return out
}

/** 节点参数。和 registry 里 date.compute 的 input schema 一一对应。 */
export interface DateNodeParams {
  mode?: string
  days?: number
  hours?: number
  expr?: string
  format?: string
  customFormat?: string
}

const num = (v: unknown, fallback: number) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n >= 1 ? n : fallback
}

/** 参数 → 等价的偏移表达式。预览里会把它显示出来，方便迁移到 {{ date() }} 写法 */
export function dateNodeExpr(p: DateNodeParams): string {
  const mode = p.mode ?? 'yesterday'
  if (mode === 'custom') return String(p.expr ?? 'now').trim() || 'now'
  const build = MODE_EXPR[mode]
  if (!build) throw new DateError(`没有「${mode}」这个模式，可选：${DATE_MODES.join(' / ')}`)
  return build(mode === 'hoursAgo' ? num(p.hours, 1) : num(p.days, 1))
}

function dateNodeFormat(p: DateNodeParams): string {
  const f = p.format ?? 'compact'
  if (f !== 'custom') return f
  const custom = String(p.customFormat ?? '').trim()
  if (!custom) throw new DateError('选了自定义格式但没填格式串，比如 yyyy年MM月dd日')
  return custom
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * 节点的输出。
 *
 * 除了用户选的那个格式（value），常用格式全都一并给出来 —— 同一个日期，SQL
 * 分区要 20260812、消息标题要 2026-08-12、接口要时间戳，让用户为此摆三个
 * 节点是没道理的。下游按需引用 $.nodes.n3.output.compact 就行。
 */
export function dateNodeOutput(p: DateNodeParams, base: Date): Record<string, unknown> {
  const expr = dateNodeExpr(p)
  const d = resolveMoment(expr, base)
  return {
    value: formatDate(d, dateNodeFormat(p)),
    compact: formatDate(d, 'compact'),
    date: formatDate(d, 'date'),
    datetime: formatDate(d, 'datetime'),
    time: formatDate(d, 'time'),
    month: formatDate(d, 'month'),
    iso: formatDate(d, 'iso'),
    unix: Number(formatDate(d, 'unix')),
    weekday: WEEKDAY[d.getDay()],
    expr,
  }
}

/**
 * 参数有没有问题，有就返回给用户看的一句话。
 *
 * 校验必须在 validateNode 里发生：mockOutput 抛出去的异常会一路逃出
 * executeFlow，把运行记录留成永远 running 的僵尸（见 tryResolveParams 上的注释）。
 */
export function dateNodeError(p: DateNodeParams): string | null {
  try {
    dateNodeOutput(p, new Date())
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** 给用户看的一行说明，UI 里当帮助文案用 */
export function describeOffset(expr: string): string {
  const raw = String(expr ?? '').trim()
  if (raw === 'now') return '此刻'
  const t = raw.match(TRUNC_RE)
  const unit = t ? (t[1] as Unit) : null
  const body = t ? raw.slice(0, -t[0].length) : raw
  const parts: string[] = []
  UNIT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = UNIT_RE.exec(body.slice(NOW.length))) !== null) {
    parts.push(`${m[1] === '-' ? '前' : '后'} ${m[2]} ${UNIT_NAME[m[3] as Unit]}`)
  }
  const head = parts.length ? parts.join('') : '此刻'
  return unit ? `${head}（取整到${UNIT_NAME[unit]}开头）` : head
}
