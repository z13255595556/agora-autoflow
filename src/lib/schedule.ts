import { nextFireTimes, toCron } from './engine-core/cron.ts'

/**
 * 定时触发的参数 → 一句人话。
 *
 * 画布上和配置面板里都用它。用户不该为了确认"我到底设成几点了"去脑内解析
 * 一串 cron —— 尤其 cron 的五段顺序（分 时 日 月 周）本身就是最容易记反的东西。
 */
export function describeSchedule(params: Record<string, unknown>): string {
  const mode = String(params.mode ?? 'daily')
  switch (mode) {
    case 'daily': {
      const at = String(params.at ?? '').trim()
      return at ? `每天 ${at}` : '每天（未填时间）'
    }
    case 'cnWorkday': {
      const at = String(params.at ?? '').trim()
      return at ? `每个工作日 ${at}` : '每个工作日（未填时间）'
    }
    case 'cnHoliday': {
      const at = String(params.at ?? '').trim()
      return at ? `每个节假日 ${at}` : '每个节假日（未填时间）'
    }
    case 'hourly': {
      const m = Number(params.minute ?? 0)
      return Number.isFinite(m) ? `每小时第 ${m} 分钟` : '每小时'
    }
    case 'interval': {
      const n = Number(params.everyMinutes ?? 0)
      if (!Number.isFinite(n) || n <= 0) return '按间隔（未填间隔）'
      if (n % 60 === 0) return `每 ${n / 60} 小时`
      return `每 ${n} 分钟`
    }
    case 'cron': {
      const c = String(params.cron ?? '').trim()
      return c ? describeCron(c) : 'Cron（未填表达式）'
    }
    default:
      return '未设置'
  }
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * 只翻译最常见的几种 cron 写法，翻不动就原样回显。
 *
 * 刻意不写完整的 cron 解释器：翻错比不翻更糟 —— 用户会照着一个错误的
 * 解释去信任一个错误的排程。翻不了就老实显示原文。
 */
function describeCron(expr: string): string {
  const p = expr.split(/\s+/)
  if (p.length !== 5) return `Cron ${expr}`
  const [min, hour, dom, mon, dow] = p
  const isNum = (s: string) => /^\d+$/.test(s)
  const hhmm = isNum(min) && isNum(hour) ? `${hour.padStart(2, '0')}:${min.padStart(2, '0')}` : null

  if (hhmm && dom === '*' && mon === '*' && dow === '*') return `每天 ${hhmm}`
  if (hhmm && dom === '*' && mon === '*' && isNum(dow)) {
    return `每${WEEKDAYS[Number(dow) % 7]} ${hhmm}`
  }
  if (hhmm && isNum(dom) && mon === '*' && dow === '*') return `每月 ${Number(dom)} 号 ${hhmm}`
  if (isNum(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `每小时第 ${Number(min)} 分钟`
  }
  return `Cron ${expr}`
}

/** 定时触发的参数够不够跑起来。缺什么直接说，别等到上线才发现没排上。 */
export function scheduleErrors(params: Record<string, unknown>): string[] {
  const mode = String(params.mode ?? 'daily')
  if (mode === 'daily' || mode === 'cnWorkday' || mode === 'cnHoliday') {
    const at = String(params.at ?? '').trim()
    if (!at) return ['「几点」没填']
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(at)) return [`时间「${at}」格式不对，要写成 09:00 这样的 24 小时制`]
  }
  if (mode === 'cron') {
    const c = String(params.cron ?? '').trim()
    if (!c) return ['Cron 表达式没填']
    if (c.split(/\s+/).length !== 5) return [`Cron「${c}」不是五段式（分 时 日 月 周）`]
  }
  if (mode === 'interval') {
    const n = Number(params.everyMinutes ?? 0)
    if (!Number.isFinite(n) || n <= 0) return ['间隔分钟数要填一个大于 0 的整数']
  }
  return []
}

const WEEKDAY_SHORT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 某个时刻在目标时区的墙上日期各部分 */
function wallParts(at: Date, tz: string): { y: number; mo: number; d: number; hhmm: string; dow: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  })
  const got: Record<string, string> = {}
  for (const p of fmt.formatToParts(at)) got[p.type] = p.value
  const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    y: Number(got.year), mo: Number(got.month), d: Number(got.day),
    hhmm: `${String(Number(got.hour) % 24).padStart(2, '0')}:${got.minute}`,
    dow: DOW[got.weekday] ?? 0,
  }
}

/** 「明天 09:00」这种相对说法。超过后天就写日期 —— 相对词再往后读起来要掰手指 */
export function describeFireTime(at: Date, now: Date, tz: string): string {
  const a = wallParts(at, tz)
  const n = wallParts(now, tz)
  const dayOf = (p: { y: number; mo: number; d: number }) => Date.UTC(p.y, p.mo - 1, p.d)
  const diffDays = Math.round((dayOf(a) - dayOf(n)) / 86_400_000)
  const day = diffDays === 0 ? '今天' : diffDays === 1 ? '明天' : diffDays === 2 ? '后天'
    : `${a.mo}月${a.d}日 ${WEEKDAY_SHORT[a.dow]}`
  return `${day} ${a.hhmm}`
}

/**
 * 接下来 n 次触发的人话。**算的是确定性时刻，不是翻译**，所以 describeCron
 * 翻不动的表达式这里照样能算。参数不合法（toCron 会 throw）返回空数组，
 * 让调用方决定怎么提示。
 *
 * 这就是 engine-core/cron.ts 里那句「UI 上直接用它」的 nextFireTimes 的第一个调用方 ——
 * 它写好之后一直零调用，定时节点上只有「每天 09:00」，看不到「明天 09:00 真的会跑」。
 */
export function nextRunTexts(params: Record<string, unknown>, now: Date, n = 3): string[] {
  const tz = String(params.timezone ?? 'Asia/Shanghai')
  let cron: string
  try {
    cron = toCron(params)
  } catch {
    return []
  }
  try {
    return nextFireTimes(cron, tz, now, n).map((at) => describeFireTime(at, now, tz))
  } catch {
    return []
  }
}

/** 从服务端拿到的 ISO 时刻 → 「明天 09:00」。列表页用；调度器记的才是真相（含 misfire / 重叠） */
export function describeNextFire(iso: string | null | undefined, now: Date, tz = 'Asia/Shanghai'): string | null {
  if (!iso) return null
  const at = new Date(iso)
  if (!Number.isFinite(at.getTime())) return null
  return describeFireTime(at, now, tz)
}
