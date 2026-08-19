import { useEffect, useState } from 'react'
import { getRemoteVersion, getRun, listRuns, type RemoteRun, type RemoteStep } from '../lib/client'
import type { SavedFlow } from '../lib/library'
import { formatDate } from '../lib/datefn'
import Icon from './Icon'

/**
 * 一条流程的运行记录。**这是「关掉浏览器流程照跑」之后唯一能回头查的地方。**
 *
 * 编辑器里那个运行面板的「历史」只有本次会话跑过的、上限 20 条、刷新即失；
 * 而库里那份带着每个节点解析后的输入和真实输出，保留 14 天。
 * 「昨天定时任务为什么发错了」只有这里答得上来 —— 在此之前要回答它，
 * 得有人能连生产库。
 *
 * 一律读服务端，**不合并本地那份**：本地那份是同一批数据的残缺副本，
 * 混在一起只会让人分不清哪条是真的。
 */

const RUN_STATUS: Record<string, { icon: string; text: string; cls: string }> = {
  queued: { icon: '·', text: '排队中', cls: 'queued' },
  running: { icon: '◌', text: '运行中', cls: 'running' },
  canceling: { icon: '◌', text: '取消中', cls: 'running' },
  success: { icon: '✓', text: '成功', cls: 'success' },
  error: { icon: '✗', text: '失败', cls: 'error' },
  canceled: { icon: '⊘', text: '已取消', cls: 'skipped' },
}

const STEP_STATUS: Record<string, { icon: string; text: string; cls: string }> = {
  queued: { icon: '·', text: '待跑', cls: 'queued' },
  running: { icon: '◌', text: '运行中', cls: 'running' },
  waiting: { icon: '◌', text: '等待中', cls: 'running' },
  success: { icon: '✓', text: '成功', cls: 'success' },
  failed: { icon: '✗', text: '失败', cls: 'error' },
  skipped: { icon: '⊘', text: '跳过', cls: 'skipped' },
  canceled: { icon: '⊘', text: '已取消', cls: 'skipped' },
}

const TRIGGER_TEXT: Record<string, string> = {
  manual: '手动',
  schedule: '定时',
  webhook: 'Webhook',
}

/** 三套灭活逻辑产生的 skipped 在界面上长得一模一样，这里要把它们分开 */
const SKIP_TEXT: Record<string, string> = {
  unreachable: '所在分支没有被选中',
  upstream_failed: '上游节点失败',
  run_failed: '流程已经失败，不再往下跑',
  no_incoming: '没有入边，接不上任何上游',
  no_iterations: '循环展开出 0 项，体内一次都不跑',
}

/** 大结果集直接铺出来会把界面卡住。截断要**说出来**，不能让人以为就这么多 */
const MAX_JSON = 20_000

function jsonText(v: unknown): { text: string; truncated: boolean } {
  if (v === null || v === undefined) return { text: '', truncated: false }
  const full = typeof v === 'string' ? v : JSON.stringify(v, null, 2)
  return full.length > MAX_JSON
    ? { text: full.slice(0, MAX_JSON), truncated: true }
    : { text: full, truncated: false }
}

function duration(from: string | null, to: string | null): string {
  if (!from || !to) return ''
  const ms = new Date(to).getTime() - new Date(from).getTime()
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** 负数版本是调试运行钉的草稿快照，给它一个人话名字而不是 v-3 */
function versionText(v: number): string {
  return v < 0 ? '草稿' : `v${v}`
}

export default function RunHistory({ flow, onClose }: { flow: SavedFlow; onClose: () => void }) {
  const [runs, setRuns] = useState<RemoteRun[] | null>(null)
  const [listErr, setListErr] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RemoteRun | null>(null)
  const [detailErr, setDetailErr] = useState('')
  /** nodeId → 节点名。按**运行钉住的那一版**取，不是当前草稿 */
  const [names, setNames] = useState<Record<string, string>>({})
  const [openStep, setOpenStep] = useState<string | null>(null)

  // Esc 关闭。这是全屏遮罩，点不到底下任何东西，不给键盘出口等于把人困住 ——
  // 画布右键菜单、节点选择器都是这么做的
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    listRuns(flow.id)
      .then((got) => {
        if (cancelled) return
        setRuns(got)
        setActiveId(got[0]?.id ?? null)
      })
      .catch((err) => {
        if (cancelled) return
        setRuns([])
        setListErr(err instanceof Error ? err.message : String(err))
      })
    return () => { cancelled = true }
  }, [flow.id])

  useEffect(() => {
    if (!activeId) { setDetail(null); return }
    let cancelled = false
    setDetail(null)
    setDetailErr('')
    setOpenStep(null)
    getRun(activeId)
      .then((got) => {
        if (cancelled) return
        setDetail(got)
        // 节点名取不到不是错误 —— 那一版可能已经被清理（调试快照只留 14 天）。
        // 拿不到就退回显示 nodeId，绝不用当前草稿的名字冒充
        return getRemoteVersion(flow.id, got.flowVersion)
          .then((v) => {
            if (cancelled) return
            setNames(Object.fromEntries((v.definition.nodes ?? []).map((n) => [n.id, n.name])))
          })
          .catch(() => { if (!cancelled) setNames({}) })
      })
      .catch((err) => {
        if (cancelled) return
        setDetailErr(err instanceof Error ? err.message : String(err))
      })
    return () => { cancelled = true }
  }, [activeId, flow.id])

  // 只存在于这台浏览器的流程没有服务端运行记录，说清楚而不是给一个空列表 ——
  // 空列表看着像"没跑过"，实际是"根本不在这儿存"
  const localOnly = flow.origin === 'local'

  return (
    <div className="modal__mask" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <span className="modal__title">「{flow.name}」的运行记录</span>
          <button className="modal__x" onClick={onClose} title="关闭">
            <Icon name="close" />
          </button>
        </div>
        <div className="modal__note">
          服务端保留最近 14 天，含每个节点解析后的输入和真实输出。
          编辑器里那个「历史」只有本次会话跑过的，刷新就没了 —— 要查以前的看这里。
        </div>

        {localOnly ? (
          <div className="empty">
            这条流程只存在这台浏览器里，没有同步到服务端，因此没有服务端运行记录。
            在首页把它「上传到服务器」之后，之后的每次运行才会被记下来。
          </div>
        ) : (
          <div className="rhist">
            <div className="rhist__list">
              {runs === null && <div className="empty">读取中…</div>}
              {listErr && <div className="errors">读不到运行记录：{listErr}</div>}
              {runs?.length === 0 && !listErr && <div className="empty">这条流程还没跑过。</div>}
              {runs?.map((r) => {
                const s = RUN_STATUS[r.status] ?? { icon: '?', text: r.status, cls: 'queued' }
                return (
                  <button
                    key={r.id}
                    className={`rhist__run rhist__run--${s.cls}${r.id === activeId ? ' on' : ''}`}
                    onClick={() => setActiveId(r.id)}
                  >
                    <i className="rhist__icon">{s.icon}</i>
                    <span className="rhist__when">
                      {formatDate(new Date(r.createdAt), 'yyyy-MM-dd HH:mm:ss')}
                    </span>
                    <span className="rhist__meta">
                      {TRIGGER_TEXT[r.triggerKind] ?? r.triggerKind} · {versionText(r.flowVersion)}
                      {duration(r.startedAt, r.finishedAt) && ` · ${duration(r.startedAt, r.finishedAt)}`}
                    </span>
                    <code className="rhist__id">{r.id}</code>
                  </button>
                )
              })}
            </div>

            <div className="rhist__detail">
              {detailErr && <div className="errors">读不到这次运行：{detailErr}</div>}
              {!activeId && !detailErr && <div className="empty">左边选一次运行。</div>}
              {activeId && !detail && !detailErr && <div className="empty">读取中…</div>}
              {detail && (
                <>
                  <div className="rhist__sum">
                    <span className={`rhist__badge rhist__badge--${RUN_STATUS[detail.status]?.cls ?? 'queued'}`}>
                      {RUN_STATUS[detail.status]?.text ?? detail.status}
                    </span>
                    <span>
                      {TRIGGER_TEXT[detail.triggerKind] ?? detail.triggerKind}触发 ·
                      跑的是 {versionText(detail.flowVersion)}
                      {detail.attempt > 1 && ` · 第 ${detail.attempt} 次尝试`}
                    </span>
                    <code className="rhist__id">{detail.id}</code>
                  </div>
                  {detail.error && <div className="errors">{detail.error}</div>}

                  {Object.keys(detail.triggerInput ?? {}).length > 0 && (
                    <details className="rhist__io">
                      <summary>触发入参</summary>
                      <pre className="rhist__json mono">{jsonText(detail.triggerInput).text}</pre>
                    </details>
                  )}

                  <div className="rhist__steps">
                    {(detail.steps ?? []).map((s) => (
                      <StepRow
                        key={`${s.nodeId}:${s.loopPath.join('.')}`}
                        step={s}
                        name={names[s.nodeId]}
                        open={openStep === `${s.nodeId}:${s.loopPath.join('.')}`}
                        onToggle={() =>
                          setOpenStep((cur) => {
                            const key = `${s.nodeId}:${s.loopPath.join('.')}`
                            return cur === key ? null : key
                          })
                        }
                      />
                    ))}
                    {(detail.steps ?? []).length === 0 && (
                      <div className="empty">这次运行还没有任何节点跑过。</div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function StepRow({
  step, name, open, onToggle,
}: {
  step: RemoteStep
  name?: string
  open: boolean
  onToggle: () => void
}) {
  const s = STEP_STATUS[step.status] ?? { icon: '?', text: step.status, cls: 'queued' }
  const skip = (step.skipReason as { kind?: string } | null)?.kind
  const input = jsonText(step.input)
  const output = jsonText(step.output)

  return (
    <div className="rhist__step">
      {/* 内层沿用 steprow 那一套：图标配色、节点名/id 排版全都现成的，
          不另起一套免得两处慢慢长歪 */}
      <button className={`steprow steprow--${s.cls}`} onClick={onToggle} title="展开这一步的输入 / 输出">
        <i className="steprow__icon">{s.icon}</i>
        <span className="steprow__name">{name ?? step.nodeId}</span>
        <code className="steprow__id">{step.nodeId}</code>
        {step.loopPath.length > 0 && <span className="steprow__iters">#{step.loopPath.join('.')}</span>}
        {/* flow.if 的判定结果。没有它的话"为什么走了这条分支"永远查不明白 */}
        {step.matched !== null && (
          <span className="rhist__flag">条件 {step.matched ? '成立' : '不成立'}</span>
        )}
        {step.fanout !== null && <span className="rhist__flag">展开 {step.fanout} 项</span>}
        {step.attempt > 0 && <span className="rhist__flag">重试 {step.attempt} 次</span>}
        {skip && <span className="rhist__flag">{SKIP_TEXT[skip] ?? skip}</span>}
        {/* business = 参数/SQL 写错了，重试没有意义；infra 才是可以重试的 */}
        {step.failureKind && (
          <span className="rhist__flag">
            {step.failureKind === 'business' ? '业务错误' : step.failureKind === 'infra' ? '基础设施错误' : step.failureKind}
          </span>
        )}
        <span className="steprow__ms">{duration(step.startedAt, step.finishedAt)}</span>
        <i className="rhist__caret">{open ? '▾' : '▸'}</i>
      </button>
      {step.error && <div className="steprow__err rhist__steperr">{step.error}</div>}
      {open && (
        <div className="rhist__io-pair">
          <div className="rhist__io">
            <div className="rhist__io-title">输入</div>
            <pre className="rhist__json mono">{input.text || '（没有记录输入）'}</pre>
            {input.truncated && <div className="rhist__cut">太长，只显示前 {MAX_JSON} 个字符</div>}
          </div>
          <div className="rhist__io">
            <div className="rhist__io-title">输出</div>
            <pre className="rhist__json mono">{output.text || '（没有记录输出）'}</pre>
            {output.truncated && <div className="rhist__cut">太长，只显示前 {MAX_JSON} 个字符</div>}
          </div>
        </div>
      )}
    </div>
  )
}
