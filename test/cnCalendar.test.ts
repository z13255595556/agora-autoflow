import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCnHoliday, isCnWorkday } from '../src/lib/engine-core/cnCalendar.ts'

/**
 * 中国工作日 ≠ 周一到周五。2026 年国务院安排里：
 * 1 月 4 日周日要上班，1 月 1 日周四放假。
 * 算错一天，日报会在放假当天发出去，或者调休那天不发。
 */

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
