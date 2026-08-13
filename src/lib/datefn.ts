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
 */
export const DATE_PRESETS: Array<{ label: string; expr: string }> = [
  { label: '昨天 20260812', expr: "date('now-1d', 'yyyyMMdd')" },
  { label: '今天 20260813', expr: "date('now', 'yyyyMMdd')" },
  { label: '昨天 2026-08-12', expr: "date('now-1d', 'yyyy-MM-dd')" },
  { label: '今天 2026-08-13', expr: "date('now', 'yyyy-MM-dd')" },
  { label: '7 天前 20260806', expr: "date('now-7d', 'yyyyMMdd')" },
  { label: '本月 202608', expr: "date('now', 'yyyyMM')" },
  { label: '此刻 2026-08-13 14:30:00', expr: "date('now', 'yyyy-MM-dd HH:mm:ss')" },
  { label: '1 小时前 2026-08-13 13:00', expr: "date('now-1h/h', 'yyyy-MM-dd HH:mm')" },
  { label: '昨天零点 时间戳(秒)', expr: "date('now-1d/d', 'unix')" },
]

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
