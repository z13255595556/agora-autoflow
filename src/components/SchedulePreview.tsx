import { isSchedulerAlive, SCHEDULER_OFF_DETAIL, SCHEDULER_OFF_SHORT } from '../lib/scheduler'
import { nextRunTexts, scheduleErrors } from '../lib/schedule'

/**
 * 定时触发器的实时预览：接下来三次会在几点跑。
 *
 * 「每天 09:00」是翻译，「明天 09:00 · 后天 09:00」是事实 —— 用户要确认的是后者。
 * 算下次触发的函数（engine-core/cron.nextFireTimes）写好之后一直零调用，
 * 这是它的第一个消费者。
 *
 * 措辞必须是「发布后」：调度器跑的是已发布版本，眼前这份是草稿。
 */
export default function SchedulePreview({ values }: { values: Record<string, unknown> }) {
  const errors = scheduleErrors(values)
  if (errors.length) return null   // 字段自己已经标红了，这里不重复说一遍

  const times = nextRunTexts(values, new Date(), 3)
  const tz = String(values.timezone ?? 'Asia/Shanghai') === 'Asia/Shanghai' ? '北京时间' : String(values.timezone)

  if (!isSchedulerAlive()) {
    return (
      <div className="spv spv--off" title={SCHEDULER_OFF_DETAIL}>
        <b>{SCHEDULER_OFF_SHORT}</b>
        {times.length > 0 && <span>调度器恢复后将按：{times.join(' · ')}（{tz}）</span>}
      </div>
    )
  }
  if (!times.length) return <div className="spv spv--off">该表达式算不出下一次触发时刻，可能永不触发</div>

  return (
    <div className="spv">
      <span className="spv__label">发布后将按</span>
      <b>{times.join(' · ')}</b>
      <span className="spv__tz">{tz}</span>
      {String(values.mode) === 'interval' && (
        <span className="spv__note">按整点对齐，不是从启用时刻起算</span>
      )}
      {(String(values.mode) === 'cnWorkday' || String(values.mode) === 'cnHoliday') && (
        <span className="spv__note">按国务院放假安排，含调休</span>
      )}
    </div>
  )
}
