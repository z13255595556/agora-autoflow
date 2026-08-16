import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextFireAt, nextFireTimes, parseCron, toCron } from '../src/lib/engine-core/cron.ts'

/**
 * cron 计算的测试。
 *
 * 算错一分钟没人会发现；算错一天，要到第二天才发现，而那时日报已经没发。
 * 所以这里测得比别处狠 —— 尤其是时区和夏令时。
 */

const TZ = 'Asia/Shanghai'
const at = (iso: string) => new Date(iso)
/** 把结果按目标时区格式化成人能读的，断言看得懂 */
const inTz = (d: Date | null, tz = TZ) =>
  d === null ? null : new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d).replace(' ', ' ')

// ---------------------------------------------------------------- 解析

test('五段以外一律报错，并说清收到几段', () => {
  assert.throws(() => parseCron('0 9 * *'), /五段/)
  assert.throws(() => parseCron('0 9 * * * *'), /五段/)
})

test('字段超范围报错', () => {
  assert.throws(() => parseCron('60 9 * * *'), /分/)
  assert.throws(() => parseCron('0 24 * * *'), /时/)
  assert.throws(() => parseCron('0 9 32 * *'), /日/)
})

test('周日两种写法都认（0 和 7）', () => {
  const a = parseCron('0 9 * * 0')
  const b = parseCron('0 9 * * 7')
  assert.ok(a.dow?.has(0))
  assert.ok(b.dow?.has(0), '7 要归一成 0，否则「每周日」配出来永不触发')
})

// ---------------------------------------------------------------- 基本推进

test('每天 09:00', () => {
  assert.equal(inTz(nextFireAt('0 9 * * *', TZ, at('2026-08-16T00:30:00Z'))), '2026-08-16 09:00')
})

test('已经过了今天的点就顺延到明天', () => {
  // 北京时间 2026-08-16 10:00 → 下次是 17 号 09:00
  assert.equal(inTz(nextFireAt('0 9 * * *', TZ, at('2026-08-16T02:00:00Z'))), '2026-08-17 09:00')
})

test('严格晚于 after —— 正好在触发点上时给下一次，不是原地不动', () => {
  // 否则调度器每扫一次都会认为"现在就该触发"，同一时刻重复入队
  const exactly = at('2026-08-16T01:00:00Z')   // 北京 09:00
  assert.equal(inTz(nextFireAt('0 9 * * *', TZ, exactly)), '2026-08-17 09:00')
})

test('每小时第 30 分', () => {
  assert.equal(inTz(nextFireAt('30 * * * *', TZ, at('2026-08-16T01:00:00Z'))), '2026-08-16 09:30')
})

test('每 15 分钟对齐到整点', () => {
  const t = nextFireAt('*/15 * * * *', TZ, at('2026-08-16T01:07:00Z'))
  assert.equal(inTz(t), '2026-08-16 09:15')
})

test('每周一 09:00', () => {
  // 2026-08-16 是周日，下一个周一是 17 号
  assert.equal(inTz(nextFireAt('0 9 * * 1', TZ, at('2026-08-16T00:00:00Z'))), '2026-08-17 09:00')
})

test('每月 1 号 09:00 —— 跨月推进', () => {
  assert.equal(inTz(nextFireAt('0 9 1 * *', TZ, at('2026-08-16T00:00:00Z'))), '2026-09-01 09:00')
})

test('★ 日和周都不是 * 时取并集，不是交集', () => {
  // Vixie cron 的既有语义：「每月 1 号**或**每周一」。
  // 算成交集的话一年可能只触发一两次，而用户以为是每周
  const from = at('2026-08-16T00:00:00Z')   // 周日
  const next = nextFireAt('0 9 1 * 1', TZ, from)
  assert.equal(inTz(next), '2026-08-17 09:00', '周一先到，不必等到 9 月 1 号')
})

test('2 月 29 号这种稀疏表达式也能算出来', () => {
  const t = nextFireAt('0 9 29 2 *', TZ, at('2026-03-01T00:00:00Z'))
  assert.ok(t, '不能因为要跨好几年就放弃')
  assert.match(inTz(t)!, /^2028-02-29 09:00$/)
})

// ---------------------------------------------------------------- 时区

test('★ 时区真的生效：同一个 cron 在不同时区算出不同的 UTC 时刻', () => {
  const from = at('2026-08-16T00:00:00Z')
  const sh = nextFireAt('0 9 * * *', 'Asia/Shanghai', from)!
  const utc = nextFireAt('0 9 * * *', 'UTC', from)!
  assert.notEqual(sh.getTime(), utc.getTime())
  assert.equal(inTz(sh, 'Asia/Shanghai'), '2026-08-16 09:00')
  assert.equal(inTz(utc, 'UTC'), '2026-08-16 09:00')
})

test('★ 夏令时：跨越切换点后仍然是当地的 09:00，不是差一小时', () => {
  // 存 IANA 名而不是 UTC 偏移的全部理由。纽约 2026-03-08 进入夏令时，
  // 偏移从 -05:00 变成 -04:00 —— 用固定偏移算，切换后每天都会差一小时
  const before = nextFireAt('0 9 * * *', 'America/New_York', at('2026-03-06T00:00:00Z'))!
  const after = nextFireAt('0 9 * * *', 'America/New_York', at('2026-03-10T00:00:00Z'))!
  assert.equal(inTz(before, 'America/New_York'), '2026-03-06 09:00')
  assert.equal(inTz(after, 'America/New_York'), '2026-03-10 09:00')
  // 两者的 UTC 小时数必然不同，这正是夏令时
  assert.notEqual(before.getUTCHours(), after.getUTCHours())
})

// ---------------------------------------------------------------- 连续多次

test('nextFireTimes 每次都严格递增，不会卡在同一时刻', () => {
  const times = nextFireTimes('0 9 * * *', TZ, at('2026-08-16T00:00:00Z'), 5)
  assert.equal(times.length, 5)
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i].getTime() > times[i - 1].getTime(), '必须严格递增')
  }
  assert.equal(inTz(times[0]), '2026-08-16 09:00')
  assert.equal(inTz(times[4]), '2026-08-20 09:00')
})

// ---------------------------------------------------------------- 四种模式归一

test('daily → cron', () => {
  assert.equal(toCron({ mode: 'daily', at: '09:00' }), '0 9 * * *')
  assert.equal(toCron({ mode: 'daily', at: '23:45' }), '45 23 * * *')
})

test('hourly → cron', () => {
  assert.equal(toCron({ mode: 'hourly', minute: 30 }), '30 * * * *')
})

test('interval → cron，能整除 60 的走小时位', () => {
  assert.equal(toCron({ mode: 'interval', everyMinutes: 15 }), '*/15 * * * *')
  assert.equal(toCron({ mode: 'interval', everyMinutes: 120 }), '0 */2 * * *')
})

test('cron 模式存之前先验一遍，坏表达式不许进库', () => {
  assert.equal(toCron({ mode: 'cron', cron: '0 9 * * 1' }), '0 9 * * 1')
  assert.throws(() => toCron({ mode: 'cron', cron: '不是 cron' }), /cron/)
  assert.throws(() => toCron({ mode: 'cron', cron: '' }), /没填/)
})

test('参数不合法要报出人能看懂的话', () => {
  assert.throws(() => toCron({ mode: 'daily', at: '9点' }), /09:00/)
  assert.throws(() => toCron({ mode: 'daily', at: '25:00' }), /超出范围/)
  assert.throws(() => toCron({ mode: 'hourly', minute: 99 }), /不合法/)
  assert.throws(() => toCron({ mode: 'nope' }), /不认识/)
})
