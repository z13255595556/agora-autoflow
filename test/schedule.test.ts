import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeFireTime, describeNextFire, nextRunTexts } from '../src/lib/schedule.ts'

/**
 * 「下次几点跑」是确定性计算，不是翻译 —— describeCron 翻不动的表达式这里照样能算。
 * 固定 now 来断言，时区一律北京时间。
 */

// 北京时间 2026-08-22 周六 10:00
const NOW = new Date('2026-08-22T02:00:00Z')

test('每天 09:00：今天已过，下一次是明天、后天、再后天', () => {
  assert.deepEqual(
    nextRunTexts({ mode: 'daily', at: '09:00', timezone: 'Asia/Shanghai' }, NOW),
    ['明天 09:00', '后天 09:00', '8月25日 周二 09:00'],
  )
})

test('每天 18:00：今天还没到，第一次就是今天', () => {
  assert.equal(nextRunTexts({ mode: 'daily', at: '18:00', timezone: 'Asia/Shanghai' }, NOW)[0], '今天 18:00')
})

test('按间隔 30 分钟对齐到整点 / 半点', () => {
  assert.deepEqual(
    nextRunTexts({ mode: 'interval', everyMinutes: 30, timezone: 'Asia/Shanghai' }, NOW, 2),
    ['今天 10:30', '今天 11:00'],
  )
})

test('describeCron 翻不动的表达式照样算得出时刻', () => {
  // 每周一三五 9 点：describeSchedule 只会原样回显，但下次几点是确定的
  const got = nextRunTexts({ mode: 'cron', cron: '0 9 * * 1,3,5', timezone: 'Asia/Shanghai' }, NOW, 2)
  assert.deepEqual(got, ['后天 09:00', '8月26日 周三 09:00'])
})

test('参数不合法返回空数组，不抛', () => {
  assert.deepEqual(nextRunTexts({ mode: 'daily', at: '9点', timezone: 'Asia/Shanghai' }, NOW), [])
  assert.deepEqual(nextRunTexts({ mode: 'cron', cron: 'nope', timezone: 'Asia/Shanghai' }, NOW), [])
})

test('服务端给的 next_fire_at 翻成人话；空值返回 null', () => {
  assert.equal(describeNextFire('2026-08-23T01:00:00Z', NOW), '明天 09:00')
  assert.equal(describeNextFire(null, NOW), null)
  assert.equal(describeNextFire('garbage', NOW), null)
  assert.equal(describeFireTime(new Date('2026-08-22T08:30:00Z'), NOW, 'Asia/Shanghai'), '今天 16:30')
})

test('每个工作日：周六之后落到周一，跳过普通周末', () => {
  assert.deepEqual(
    nextRunTexts({ mode: 'cnWorkday', at: '09:00', timezone: 'Asia/Shanghai' }, NOW),
    ['后天 09:00', '8月25日 周二 09:00', '8月26日 周三 09:00'],
  )
})

test('每个节假日：下一个法定放假是中秋', () => {
  assert.deepEqual(
    nextRunTexts({ mode: 'cnHoliday', at: '09:00', timezone: 'Asia/Shanghai' }, NOW, 2),
    ['9月25日 周五 09:00', '9月26日 周六 09:00'],
  )
})
