import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyCnCalendarYears,
  isCnHoliday,
  isCnWorkday,
  refreshCnCalendar,
  resetCnCalendar,
  tablesFromYears,
} from '../src/lib/engine-core/cnCalendar.ts'

/**
 * 中国工作日 ≠ 周一到周五。2026 年国务院安排里：
 * 1 月 4 日周日要上班，1 月 1 日周四放假。
 * 算错一天，日报会在放假当天发出去，或者调休那天不发。
 */

afterEach(() => resetCnCalendar())

test('2026 元旦：1 日放假，4 日周日调休上班', () => {
  assert.equal(isCnHoliday('2026-01-01'), true)
  assert.equal(isCnWorkday('2026-01-01'), false)
  assert.equal(isCnHoliday('2026-01-04'), false)
  assert.equal(isCnWorkday('2026-01-04'), true)
})

test('普通周六不是工作日也不是法定放假', () => {
  assert.equal(isCnWorkday('2026-08-22'), false)
  assert.equal(isCnHoliday('2026-08-22'), false)
})

test('普通周一是工作日', () => {
  assert.equal(isCnWorkday('2026-08-24'), true)
  assert.equal(isCnHoliday('2026-08-24'), false)
})

test('春节放假不是工作日；2 月 14 日周六调休是工作日', () => {
  assert.equal(isCnHoliday('2026-02-15'), true)
  assert.equal(isCnWorkday('2026-02-15'), false)
  assert.equal(isCnWorkday('2026-02-14'), true)
  assert.equal(isCnHoliday('2026-02-14'), false)
})

test('holiday-cn：isOffDay true=放假，false=调休上班', () => {
  const t = tablesFromYears([{
    year: 2027,
    days: [
      { date: '2027-01-01', isOffDay: true },
      { date: '2027-01-03', isOffDay: false },
    ],
  }])
  assert.equal(t.holidays.has('2027-01-01'), true)
  assert.equal(t.makeup.has('2027-01-03'), true)
  assert.equal(t.years.has(2027), true)
})

test('空年份不算已收录 —— 国务院还没公布时不能假装有表', () => {
  const t = tablesFromYears([{ year: 2027, days: [] }])
  assert.equal(t.years.has(2027), false)
  assert.equal(t.holidays.size, 0)
})

test('overlay 能补上未收录年份，reset 后回到内置表', () => {
  assert.equal(isCnWorkday('2027-01-03'), false) // 周日，内置表没有 2027
  applyCnCalendarYears([{
    year: 2027,
    days: [{ date: '2027-01-03', isOffDay: false }],
  }])
  assert.equal(isCnWorkday('2027-01-03'), true)
  resetCnCalendar()
  assert.equal(isCnWorkday('2027-01-03'), false)
})

test('refresh 拉到新一年后工作日立刻认调休', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input)
    if (url.includes('/2027.json')) {
      return new Response(JSON.stringify({
        year: 2027,
        papers: ['https://www.gov.cn/example'],
        days: [{ date: '2027-01-03', name: '元旦', isOffDay: false }],
      }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }
  const got = await refreshCnCalendar({
    now: new Date('2027-01-02T00:00:00Z'),
    fetchImpl,
  })
  assert.ok(got.applied.includes(2027), `applied=${got.applied.join(',')}`)
  assert.equal(isCnWorkday('2027-01-03'), true)
})
