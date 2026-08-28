/**
 * 中国工作日 / 法定放假日。
 *
 * cron 的「周一到周五」盖不住国务院调休。数据来自 NateScarlet/holiday-cn
 * （自动抓国务院公告），打包进仓库；worker 启动和每天再拉一次当年±1。
 * 调度器**不**在每次算下次触发时打在线接口 —— 接口挂了会让工作日流程漏跑。
 *
 * holiday-cn：isOffDay true = 放假，false = 调休上班。
 * 普通周末不在表里。未收录的年份：工作日退回周一到周五，节假日没有可触发日。
 */

import bundled2025 from './cn-calendar/2025.json' with { type: 'json' }
import bundled2026 from './cn-calendar/2026.json' with { type: 'json' }

export type HolidayCnDay = { date: string; name?: string; isOffDay: boolean }
export type HolidayCnYear = { year: number; papers?: string[]; days: HolidayCnDay[] }

export type CalendarTables = {
  holidays: Set<string>
  makeup: Set<string>
  years: Set<number>
}

const BUNDLED: HolidayCnYear[] = [bundled2025 as HolidayCnYear, bundled2026 as HolidayCnYear]

const bundledTables = tablesFromYears(BUNDLED)
let overlay: CalendarTables | null = null

function tables(): CalendarTables {
  return overlay ?? bundledTables
}

export function tablesFromYears(years: HolidayCnYear[]): CalendarTables {
  const holidays = new Set<string>()
  const makeup = new Set<string>()
  const covered = new Set<number>()
  for (const y of years) {
    const days = Array.isArray(y.days) ? y.days : []
    if (days.length === 0) continue
    covered.add(y.year)
    for (const d of days) {
      if (typeof d?.date !== 'string' || typeof d.isOffDay !== 'boolean') continue
      if (d.isOffDay) holidays.add(d.date)
      else makeup.add(d.date)
    }
  }
  return { holidays, makeup, years: covered }
}

export function applyCnCalendarYears(years: HolidayCnYear[]): void {
  overlay = tablesFromYears([...BUNDLED, ...years])
}

export function resetCnCalendar(): void {
  overlay = null
}

export function isCnHoliday(ymd: string): boolean {
  return tables().holidays.has(ymd)
}

/**
 * 国务院口径的工作日：周一到周五，减去放假，加上调休上班。
 * 未收录年份没有调休表，退回周一到周五。
 */
export function isCnWorkday(ymd: string): boolean {
  const t = tables()
  if (t.makeup.has(ymd)) return true
  if (t.holidays.has(ymd)) return false
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay()
  return dow >= 1 && dow <= 5
}

const HOLIDAY_CN_URLS = (year: number) => [
  `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
  `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`,
]

async function fetchYear(year: number, fetchImpl: typeof fetch): Promise<HolidayCnYear | null> {
  for (const url of HOLIDAY_CN_URLS(year)) {
    try {
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(4000) })
      if (!r.ok) continue
      const data = await r.json() as HolidayCnYear
      if (data?.year !== year || !Array.isArray(data.days)) continue
      return { year: data.year, papers: data.papers, days: data.days }
    } catch {
      // 换下一个镜像。全失败就当这一年没有新表
    }
  }
  return null
}

/**
 * 拉当年、去年、明年。空表（下一年还没公布）丢掉。
 * 失败沿用内置数据，不抛 —— 调用方（worker tick）不能被日历刷新卡死。
 */
export async function refreshCnCalendar(opts?: {
  now?: Date
  fetchImpl?: typeof fetch
}): Promise<{ applied: number[] }> {
  const now = opts?.now ?? new Date()
  const fetchImpl = opts?.fetchImpl ?? fetch
  const y = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(now))
  const files = await Promise.all([y - 1, y, y + 1].map((year) => fetchYear(year, fetchImpl)))
  const years = files.filter((f): f is HolidayCnYear => Boolean(f && f.days.length))
  if (years.length === 0) return { applied: [] }
  applyCnCalendarYears(years)
  return { applied: years.map((x) => x.year) }
}
