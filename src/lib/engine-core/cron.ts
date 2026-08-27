import { isCnHoliday, isCnWorkday } from './cnCalendar.ts'

/**
 * 五段式 cron 的解析与「下次触发时刻」计算。**纯函数，不读时钟。**
 *
 * 自己写而不是引库：只需要 cron 的一个子集（`*` / 数字 / 列表 / 范围 / 步长），
 * 而时区那部分任何库都得靠 Intl，省不掉。更重要的是这段逻辑必须能被狠狠测试 ——
 * 算错一分钟没人会发现，算错一天到第二天才发现，而那时日报已经没发。
 *
 * ## 时区
 *
 * 存 IANA 名（`Asia/Shanghai`）而不是 UTC 偏移：偏移量在有夏令时的地区是错的，
 * 而且错法很隐蔽 —— 一年里有两天会算错一小时。
 *
 * 判定方式是「把候选 UTC 时刻翻译成目标时区的墙上时间，再看它匹不匹配」，
 * 不是「先算本地时间再转 UTC」。后者在夏令时跳变那一小时会算出不存在的时刻。
 */

export interface CronFields {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number> | null   // null = '*'，与 dow 的 OR 语义有关
  month: Set<number>
  dow: Set<number> | null
  /** 中国工作日 / 法定放假。有值时忽略 dom/dow，按国务院安排过滤日期。 */
  calendar: 'cn-workday' | 'cn-holiday' | null
}

/** 解析一段，如 `*` / `5` / `1,3` / `1-5` / `＊/15` */
function parseField(raw: string, min: number, max: number, name: string): Set<number> | null {
  const text = raw.trim()
  if (!text) throw new Error(`cron 的${name}段是空的`)
  if (text === '*') return null

  const out = new Set<number>()
  for (const part of text.split(',')) {
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron 的${name}段步长不合法：${part}`)

    let lo = min
    let hi = max
    if (rangePart !== '*') {
      const bounds = rangePart.split('-').map(Number)
      if (bounds.some((n) => !Number.isInteger(n))) throw new Error(`cron 的${name}段不是数字：${part}`)
      lo = bounds[0]
      hi = bounds.length > 1 ? bounds[1] : (stepPart === undefined ? bounds[0] : max)
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron 的${name}段超出 ${min}-${max}：${part}`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`cron 必须是五段（分 时 日 月 周），收到 ${parts.length} 段：${expr}`)
  }
  const calendar = parts[4] === 'CN_WORKDAY' ? 'cn-workday' as const
    : parts[4] === 'CN_HOLIDAY' ? 'cn-holiday' as const
    : null
  if (calendar && (parts[2] !== '*' || parts[3] !== '*')) {
    throw new Error('中国工作日/节假日的日、月必须是 *')
  }
  const allMonths = new Set(Array.from({ length: 12 }, (_, i) => i + 1))
  return {
    minute: parseField(parts[0], 0, 59, '分') ?? new Set(Array.from({ length: 60 }, (_, i) => i)),
    hour: parseField(parts[1], 0, 23, '时') ?? new Set(Array.from({ length: 24 }, (_, i) => i)),
    dom: calendar ? null : parseField(parts[2], 1, 31, '日'),
    month: calendar ? allMonths : (parseField(parts[3], 1, 12, '月') ?? allMonths),
    // 周日两种写法都认：0 和 7
    dow: calendar ? null : (() => {
      const s = parseField(parts[4], 0, 7, '周')
      if (!s) return null
      if (s.has(7)) s.add(0)
      return s
    })(),
    calendar,
  }
}

/** 把一个 UTC 时刻翻译成目标时区的墙上时间各部分 */
function partsIn(tz: string, at: Date): { y: number; mo: number; d: number; h: number; mi: number; dow: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  })
  const got: Record<string, string> = {}
  for (const p of fmt.formatToParts(at)) got[p.type] = p.value
  const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    y: Number(got.year),
    mo: Number(got.month),
    d: Number(got.day),
    // 24 点：某些环境把午夜格式化成 24 而不是 0
    h: Number(got.hour) % 24,
    mi: Number(got.minute),
    dow: DOW[got.weekday] ?? 0,
  }
}

/**
 * 日和周的 OR 语义：**两者都不是 `*` 时取并集**，不是交集。
 *
 * 这是 cron 最反直觉的一条，也是 Vixie cron 的既有行为：
 * `0 9 1 * 1` 是「每月 1 号**或**每周一的 9 点」，不是「1 号且是周一」。
 * 算成交集的话，`0 9 1 * 1` 一年可能只触发一两次，而用户以为是每周。
 */
function ymdOf(p: { y: number; mo: number; d: number }): string {
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
}

function dayMatches(f: CronFields, p: { d: number; dow: number; y: number; mo: number }): boolean {
  if (f.calendar === 'cn-workday') return isCnWorkday(ymdOf(p))
  if (f.calendar === 'cn-holiday') return isCnHoliday(ymdOf(p))
  if (f.dom === null && f.dow === null) return true
  if (f.dom !== null && f.dow === null) return f.dom.has(p.d)
  if (f.dom === null && f.dow !== null) return f.dow.has(p.dow)
  return f.dom!.has(p.d) || f.dow!.has(p.dow)
}

/** 一次扫描最多看多久。够覆盖「每年 2 月 29 号」这种最稀疏的表达式 */
const MAX_MINUTES = 366 * 4 * 24 * 60

/**
 * 严格晚于 `after` 的下一个触发时刻。取不到返回 null（表达式永不触发）。
 *
 * 逐分钟推进，但在月/日/时不匹配时整块跳过 —— 每天一次的表达式最多看 1440 步。
 */
export function nextFireAt(cron: string, tz: string, after: Date): Date | null {
  const f = parseCron(cron)
  // 从下一整分开始，且严格晚于 after：同一分钟内重复调用不会返回同一个时刻
  let cur = new Date(Math.floor(after.getTime() / 60000) * 60000 + 60000)
  // 日历模式按天跳，400 天够跨过春节；没有收录的年份节假日会算不出下一次
  const limit = f.calendar ? 400 : MAX_MINUTES

  for (let i = 0; i < limit; i++) {
    const p = partsIn(tz, cur)
    if (!f.month.has(p.mo)) {
      // 跳到下个月 1 号 0 点附近。跳粗一点没关系，循环会收敛
      cur = new Date(cur.getTime() + 24 * 3600_000)
      continue
    }
    if (!dayMatches(f, p)) {
      cur = new Date(cur.getTime() + 24 * 3600_000 - (p.h * 3600_000 + p.mi * 60_000))
      continue
    }
    if (!f.hour.has(p.h)) {
      cur = new Date(cur.getTime() + 3600_000 - p.mi * 60_000)
      continue
    }
    if (f.minute.has(p.mi)) return cur
    cur = new Date(cur.getTime() + 60_000)
  }
  return null
}

/** 接下来 n 次触发。UI 上「下次几点跑」直接用它 —— 用户不该为了确认这个去脑内解析 cron */
export function nextFireTimes(cron: string, tz: string, after: Date, n = 5): Date[] {
  const out: Date[] = []
  let cur = after
  for (let i = 0; i < n; i++) {
    const next = nextFireAt(cron, tz, cur)
    if (!next) break
    out.push(next)
    cur = next
  }
  return out
}

/**
 * 存储层只认 cron 一种（中国工作日/节假日写在第五段 CN_WORKDAY / CN_HOLIDAY）。
 *
 * 存储归一、展示友好：调度器不用为四种模式各写一份「下次几点」的计算，
 * 而 UI 层继续用 describeSchedule 那套人话描述。
 *
 * 一处有损转换要说明白：`interval` 归一成 `＊/N` 之后是**对齐到整点的**
 * （每 30 分钟 = :00 和 :30），不是从启用那一刻开始滚动计时。
 * N 不能整除 60 时（比如 7 分钟），cron 会在每小时末尾出现一次短间隔 ——
 * 这是 cron 的固有行为，不是 bug，但用户配的时候应该知道。
 */
export function toCron(params: Record<string, unknown>): string {
  const mode = String(params.mode ?? 'daily')
  switch (mode) {
    case 'daily': {
      const at = String(params.at ?? '09:00')
      const m = at.match(/^(\d{1,2}):(\d{2})$/)
      if (!m) throw new Error(`「每天几点」格式不对：${at}，应该像 09:00`)
      const [h, mi] = [Number(m[1]), Number(m[2])]
      if (h > 23 || mi > 59) throw new Error(`「每天几点」超出范围：${at}`)
      return `${mi} ${h} * * *`
    }
    case 'hourly': {
      const mi = Number(params.minute ?? 0)
      if (!Number.isInteger(mi) || mi < 0 || mi > 59) throw new Error(`「每小时第几分钟」不合法：${params.minute}`)
      return `${mi} * * * *`
    }
    case 'interval': {
      const n = Number(params.everyMinutes ?? 0)
      if (!Number.isInteger(n) || n < 1 || n > 1440) throw new Error(`间隔分钟数不合法：${params.everyMinutes}`)
      if (n % 60 === 0) return `0 */${n / 60} * * *`
      return `*/${n} * * * *`
    }
    case 'cron': {
      const c = String(params.cron ?? '').trim()
      if (!c) throw new Error('没填 Cron 表达式')
      parseCron(c)   // 存之前先验一遍，别把坏表达式写进库
      return c
    }
    case 'cnWorkday':
    case 'cnHoliday': {
      const at = String(params.at ?? '09:00')
      const m = at.match(/^(\d{1,2}):(\d{2})$/)
      if (!m) throw new Error(`「几点」格式不对：${at}，应该像 09:00`)
      const [h, mi] = [Number(m[1]), Number(m[2])]
      if (h > 23 || mi > 59) throw new Error(`「几点」超出范围：${at}`)
      return `${mi} ${h} * * ${mode === 'cnWorkday' ? 'CN_WORKDAY' : 'CN_HOLIDAY'}`
    }
    default:
      throw new Error(`不认识的执行频率：${mode}`)
  }
}
