/**
 * 中国工作日 / 法定放假日。
 *
 * cron 的「周一到周五」盖不住国务院调休：周日可能要上班，周四可能放假。
 * 算错一天的症状是放假当天群里多一条日报，或调休那天没有 —— 过了才发现。
 *
 * 数据只收录已公布的国务院安排。没有收录的年份：工作日退回周一到周五，
 * 节假日模式没有可触发的日期（下次触发算不出来，比猜周末更诚实）。
 */

const HOLIDAYS = new Set<string>([
  // 2026 国办发明电〔2025〕7号
  // 元旦：1/1–1/3；1/4（周日）上班
  ...span('2026-01-01', '2026-01-03'),
  // 春节：2/15–2/23；2/14、2/28（周六）上班
  ...span('2026-02-15', '2026-02-23'),
  // 清明：4/4–4/6
  ...span('2026-04-04', '2026-04-06'),
  // 劳动节：5/1–5/5；5/9（周六）上班
  ...span('2026-05-01', '2026-05-05'),
  // 端午：6/19–6/21
  ...span('2026-06-19', '2026-06-21'),
  // 中秋：9/25–9/27
  ...span('2026-09-25', '2026-09-27'),
  // 国庆：10/1–10/7；9/20（周日）、10/10（周六）上班
  ...span('2026-10-01', '2026-10-07'),
])

const MAKEUP = new Set<string>([
  '2026-01-04',
  '2026-02-14',
  '2026-02-28',
  '2026-05-09',
  '2026-09-20',
  '2026-10-10',
])

function span(from: string, to: string): string[] {
  const out: string[] = []
  const cur = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return out
}

export function isCnHoliday(ymd: string): boolean {
  return HOLIDAYS.has(ymd)
}

/**
 * 国务院口径的工作日：周一到周五，减去放假，加上调休上班。
 * 未收录年份没有调休表，退回周一到周五。
 */
export function isCnWorkday(ymd: string): boolean {
  if (MAKEUP.has(ymd)) return true
  if (HOLIDAYS.has(ymd)) return false
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay()
  return dow >= 1 && dow <= 5
}
