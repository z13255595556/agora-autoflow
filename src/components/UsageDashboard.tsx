import { useEffect, useState } from 'react'
import { adminUsage, type UsageOverview } from '../lib/client'
import Icon from './Icon'

/**
 * 用量看板（管理员）。
 *
 * 读的是 usage_daily 那张按天聚合表，**不是 runs** —— 明细只留 14 天，
 * 现算的话看板的时间范围会被保留期悄悄封顶，而界面上不会有任何迹象：
 * 用户会以为「三个月前确实没人用」。
 *
 * 趋势图**只画一条序列**（每天的运行次数）。成功/失败没有画成两种颜色，
 * 因为绿配红在深色模式下对红绿色盲的可分辨度只有 ΔE 5.8（跑过 validator），
 * 低到不该靠颜色承载信息。失败改为在统计卡和表格里以**数字加标签**出现 ——
 * 那既不依赖颜色，也比一小截红色柱子好读。
 */

const TRIGGER_TEXT: Record<string, string> = {
  manual: '手动',
  schedule: '定时',
  webhook: 'Webhook',
}

const RANGES = [
  { days: 7, label: '7 天' },
  { days: 30, label: '30 天' },
  { days: 90, label: '90 天' },
  { days: 365, label: '一年' },
]

function ms(v: number | null): string {
  if (v === null) return '—'
  return v < 1000 ? `${v}ms` : v < 60_000 ? `${(v / 1000).toFixed(1)}s` : `${(v / 60_000).toFixed(1)}min`
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—'
}

/**
 * 每日运行次数。单序列 → 不需要图例，标题就说明了它是什么。
 *
 * 纯 SVG，没有引图表库：一条柱状图不值得为它多一个依赖，而且这样
 * 配色直接吃 CSS 变量，深浅色和整个应用一起切。
 */
function DayChart({ data }: { data: UsageOverview['byDay'] }) {
  if (data.length === 0) return <div className="empty">这段时间还没有运行记录。</div>

  const W = 720
  const H = 160
  const PAD = { top: 12, right: 8, bottom: 22, left: 40 }
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const max = Math.max(...data.map((d) => d.runs), 1)
  // 柱间留 2px 表面色缝隙，两根柱子不会糊成一条。
  // **上限 40px**：只有三五天数据时，按格子等分会把柱子拉到一百多像素宽 ——
  // 那时候读到的是四个色块，不是一条趋势
  const slot = plotW / data.length
  const barW = Math.max(1, Math.min(40, slot - 2))

  // 三条参考线就够了。网格是背景，不是内容
  const ticks = [0, Math.round(max / 2), max]

  return (
    <svg className="uchart" viewBox={`0 0 ${W} ${H}`} role="img"
         aria-label={`每日运行次数，共 ${data.length} 天，最高 ${max} 次`}>
      {ticks.map((t) => {
        const y = PAD.top + plotH - (t / max) * plotH
        return (
          <g key={t}>
            <line className="uchart__grid" x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} />
            <text className="uchart__tick" x={PAD.left - 6} y={y + 3.5} textAnchor="end">{t}</text>
          </g>
        )
      })}
      {data.map((d, i) => {
        const h = (d.runs / max) * plotH
        const x = PAD.left + i * slot + (slot - barW) / 2
        return (
          <rect
            key={d.day}
            className="uchart__bar"
            x={x} y={PAD.top + plotH - h} width={barW} height={Math.max(h, d.runs > 0 ? 1 : 0)}
            // 数据端 4px 圆角，锚在基线上
            rx={Math.min(4, barW / 2)}
          >
            <title>{`${d.day}\n运行 ${d.runs} 次${d.failed ? `，失败 ${d.failed}` : ''}`}</title>
          </rect>
        )
      })}
      {/* 首尾各标一个日期。每根柱子都标日期会糊成一片，而看趋势只需要知道两端 */}
      <text className="uchart__tick" x={PAD.left} y={H - 6} textAnchor="start">{data[0].day.slice(5)}</text>
      {data.length > 1 && (
        <text className="uchart__tick" x={W - PAD.right} y={H - 6} textAnchor="end">
          {data[data.length - 1].day.slice(5)}
        </text>
      )}
    </svg>
  )
}

export default function UsageDashboard({ onClose }: { onClose: () => void }) {
  const [days, setDays] = useState(30)
  const [data, setData] = useState<UsageOverview | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    setData(null)
    setErr('')
    adminUsage(days)
      .then((got) => { if (!cancelled) setData(got) })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [days])

  const t = data?.totals

  return (
    <div className="modal__mask" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <span className="modal__title">用量看板</span>
          <button className="modal__x" onClick={onClose} title="关闭"><Icon name="close" /></button>
        </div>
        <div className="modal__note">
          全部用户的运行统计，来自按天聚合表。<b>统计永久保留</b>，运行明细只留 14 天：久远的用量看得到，但点不进明细。
          {data?.since && ` 最早的统计从 ${data.since} 开始。`}
        </div>

        <div className="urange">
          {RANGES.map((r) => (
            <button
              key={r.days}
              className={`urange__btn${days === r.days ? ' on' : ''}`}
              onClick={() => setDays(r.days)}
            >
              {r.label}
            </button>
          ))}
        </div>

        {err && <div className="errors">读不到用量统计：{err}</div>}
        {!data && !err && <div className="empty">读取中…</div>}

        {data && t && (
          <div className="udash">
            <div className="ustats">
              <Stat label="运行次数" value={t.runs.toLocaleString()} />
              <Stat label="节点执行" value={t.steps.toLocaleString()} hint="运行次数看不出规模，一条 20 节点的流程和 2 节点的在「跑了 100 次」下一样" />
              <Stat label="成功率" value={pct(t.succeeded, t.runs)} hint={`成功 ${t.succeeded} · 失败 ${t.failed} · 取消 ${t.canceled}`} />
              <Stat label="平均耗时" value={ms(t.avgDurationMs)} hint="只统计已结束的运行" />
              <Stat label="活跃流程" value={String(t.flows)} />
              <Stat label="使用人数" value={String(t.owners)} hint="按流程归属算" />
            </div>

            <section className="usection">
              <h3 className="usection__title">每日运行次数</h3>
              <DayChart data={data.byDay} />
            </section>

            <div className="ucols">
              <section className="usection">
                <h3 className="usection__title">用得最多的流程</h3>
                <table className="utable">
                  <thead>
                    <tr><th>流程</th><th>归属</th><th className="num">运行</th><th className="num">失败</th><th className="num">平均耗时</th></tr>
                  </thead>
                  <tbody>
                    {data.byFlow.map((f) => (
                      <tr key={f.flowId}>
                        <td title={f.flowId}>{f.flowName}</td>
                        <td className="dim">{f.owner ?? '无主'}</td>
                        <td className="num">{f.runs.toLocaleString()}</td>
                        <td className="num">{f.failed || '—'}</td>
                        <td className="num dim">{ms(f.avgDurationMs)}</td>
                      </tr>
                    ))}
                    {data.byFlow.length === 0 && <tr><td colSpan={5} className="dim">没有数据</td></tr>}
                  </tbody>
                </table>
              </section>

              <section className="usection">
                <h3 className="usection__title">按人</h3>
                <table className="utable">
                  <thead>
                    <tr><th>归属</th><th className="num">流程</th><th className="num">运行</th><th className="num">失败</th></tr>
                  </thead>
                  <tbody>
                    {data.byOwner.map((o) => (
                      <tr key={o.owner ?? 'none'}>
                        <td>{o.owner ?? '无主'}</td>
                        <td className="num">{o.flows}</td>
                        <td className="num">{o.runs.toLocaleString()}</td>
                        <td className="num">{o.failed || '—'}</td>
                      </tr>
                    ))}
                    {data.byOwner.length === 0 && <tr><td colSpan={4} className="dim">没有数据</td></tr>}
                  </tbody>
                </table>

                <h3 className="usection__title usection__title--sub">按触发方式</h3>
                <table className="utable">
                  <thead>
                    <tr><th>方式</th><th className="num">运行</th><th className="num">占比</th></tr>
                  </thead>
                  <tbody>
                    {data.byTrigger.map((x) => (
                      <tr key={x.triggerKind}>
                        <td>{TRIGGER_TEXT[x.triggerKind] ?? x.triggerKind}</td>
                        <td className="num">{x.runs.toLocaleString()}</td>
                        <td className="num dim">{pct(x.runs, t.runs)}</td>
                      </tr>
                    ))}
                    {data.byTrigger.length === 0 && <tr><td className="dim">没有数据</td></tr>}
                  </tbody>
                </table>
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="ustat" title={hint}>
      <div className="ustat__value">{value}</div>
      <div className="ustat__label">{label}</div>
    </div>
  )
}
