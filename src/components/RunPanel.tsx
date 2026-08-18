import { useEffect, useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useFlow } from '../store'
import type { StepStatus } from '../types'
import Icon from './Icon'
import { graphProblems } from '../lib/graph'
import { validateNode } from '../lib/vars'
import { formatDate } from '../lib/datefn'

const STATUS_ICON: Record<StepStatus, string> = {
  waiting: '·',
  running: '◌',
  success: '✓',
  error: '✗',
  skipped: '⊘',
}

const MIN_HEIGHT = 180
const MAX_HEIGHT = 560
const DEFAULT_HEIGHT = 258
const HEIGHT_KEY = 'autoflow.run-panel-height'

function maxPanelHeight() {
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, window.innerHeight - 200))
}

/**
 * 底部运行面板（对齐 n8n 执行日志区）：
 * 左侧触发表单 + 运行历史，右侧当前运行的分步时间线。
 */
export default function RunPanel() {
  const flowInputs = useFlow((s) => s.flowInputs)
  const nodes = useFlow((s) => s.nodes)
  const runs = useFlow((s) => s.runs)
  const activeRunId = useFlow((s) => s.activeRunId)
  const running = useFlow((s) => s.running)
  const startRun = useFlow((s) => s.startRun)
  const form = useFlow((s) => s.manualInputs)
  const setForm = useFlow((s) => s.setManualInputs)
  const setActiveRun = useFlow((s) => s.setActiveRun)
  const setRunPanelOpen = useFlow((s) => s.setRunPanelOpen)
  const openNdv = useFlow((s) => s.openNdv)
  const panelHeight = useFlow((s) => s.runPanelHeight)
  const setPanelHeight = useFlow((s) => s.setRunPanelHeight)
  const edges = useFlow((s) => s.edges)
  const pinData = useFlow((s) => s.pinData)

  const run = runs.find((r) => r.id === activeRunId) ?? runs[0] ?? null
  const resizeStart = useRef<{ pointerId: number; y: number; height: number } | null>(null)

  const setAndRememberHeight = (height: number) => {
    const next = Math.min(maxPanelHeight(), Math.max(MIN_HEIGHT, height))
    setPanelHeight(next)
    localStorage.setItem(HEIGHT_KEY, String(Math.round(next)))
  }

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeStart.current = { pointerId: event.pointerId, y: event.clientY, height: panelHeight }
    document.body.classList.add('is-resizing-runpanel')
  }

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStart.current
    if (!start || start.pointerId !== event.pointerId) return
    setPanelHeight(Math.min(maxPanelHeight(), Math.max(MIN_HEIGHT, start.height + start.y - event.clientY)))
  }

  const finishResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStart.current
    if (!start || start.pointerId !== event.pointerId) return
    resizeStart.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* 指针已被系统释放。 */
    }
    localStorage.setItem(HEIGHT_KEY, String(Math.round(useFlow.getState().runPanelHeight)))
    document.body.classList.remove('is-resizing-runpanel')
  }

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null
    if (event.key === 'ArrowUp') next = panelHeight + 24
    else if (event.key === 'ArrowDown') next = panelHeight - 24
    else if (event.key === 'Home') next = MIN_HEIGHT
    else if (event.key === 'End') next = maxPanelHeight()
    if (next === null) return
    event.preventDefault()
    setAndRememberHeight(next)
  }

  useEffect(() => {
    const fitOnWindowResize = () => {
      if (useFlow.getState().runPanelHeight > maxPanelHeight()) setAndRememberHeight(maxPanelHeight())
    }
    window.addEventListener('resize', fitOnWindowResize)
    return () => {
      window.removeEventListener('resize', fitOnWindowResize)
      document.body.classList.remove('is-resizing-runpanel')
    }
  }, [])

  const missingRequired = flowInputs.filter((f) => f.required && !form[f.key]?.trim())
  const workflowProblems = [
    ...graphProblems(nodes, edges).map((problem) => problem.message),
    ...nodes
      .filter((node) => !Object.prototype.hasOwnProperty.call(pinData, node.id))
      .flatMap((node) => validateNode(node, nodes, edges, flowInputs)),
  ]

  const doRun = () => {
    const trigger: Record<string, unknown> = {}
    for (const f of flowInputs) {
      const raw = form[f.key] ?? ''
      trigger[f.key] = f.type === 'integer' ? Number(raw || 0) : f.type === 'boolean' ? raw === 'true' : raw
    }
    void startRun(trigger)
  }

  const nameOf = (id: string) => nodes.find((n) => n.id === id)?.data.label ?? id

  return (
    <div className="runpanel" style={{ height: panelHeight }}>
      <div
        className="runpanel__resize"
        role="separator"
        aria-label="调整运行面板高度"
        aria-orientation="horizontal"
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={maxPanelHeight()}
        aria-valuenow={Math.round(panelHeight)}
        tabIndex={0}
        title="拖动调整高度；双击恢复默认高度"
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onKeyDown={resizeWithKeyboard}
        onDoubleClick={() => setAndRememberHeight(DEFAULT_HEIGHT)}
      />
      <div className="runpanel__left">
        <div className="runpanel__title">
          手动运行
          <button className="runpanel__close" onClick={() => setRunPanelOpen(false)} title="收起运行面板"><Icon name="close" size={13} /></button>
        </div>
        <div className="runpanel__form">
          {flowInputs.map((f) => (
            <label key={f.key} className="runpanel__field">
              <span>
                {f.title || f.key}
                {f.required && <i className="req">*</i>}
              </span>
              <input
                value={form[f.key] ?? ''}
                placeholder={f.type}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              />
            </label>
          ))}
          <button
            className="btn btn--primary"
            disabled={running || missingRequired.length > 0 || workflowProblems.length > 0}
            title={
              missingRequired.length
                ? `先填必填项：${missingRequired.map((f) => f.title || f.key).join('、')}`
                : workflowProblems[0] ?? ''
            }
            onClick={doRun}
          >
            {running ? '运行中…' : <><Icon name="play" size={12} /> 运行</>}
          </button>
        </div>

        <div className="runpanel__title">历史</div>
        <div className="runpanel__history">
          {runs.length === 0 && <div className="empty">还没跑过</div>}
          {runs.map((r) => (
            <button
              key={r.id}
              className={`runpanel__run${r.id === run?.id ? ' on' : ''} runpanel__run--${r.status}`}
              onClick={() => setActiveRun(r.id)}
            >
              <i>{r.status === 'running' ? '◌' : r.status === 'success' ? '✓' : '✗'}</i>
              <code>{r.id}</code>
              <span>{formatDate(new Date(r.startedAt), 'time')}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="runpanel__right">
        <div className="runpanel__title">分步执行 {run && <code className="runpanel__runid">{run.id}</code>}</div>
        <div className="runpanel__steps">
          {!run && <div className="empty">运行一次，这里出现每个节点的输入输出。</div>}
          {run &&
            Object.entries(run.steps).map(([nodeId, steps]) => {
              const last = steps.at(-1)!
              return (
                <button
                  key={nodeId}
                  className={`steprow steprow--${last.status}`}
                  onClick={() => openNdv(nodeId)}
                  title="点击查看该节点的输入 / 输出"
                >
                  <i className="steprow__icon">{STATUS_ICON[last.status]}</i>
                  <span className="steprow__name">{nameOf(nodeId)}</span>
                  <code className="steprow__id">{nodeId}</code>
                  {steps.length > 1 && <span className="steprow__iters">×{steps.length}</span>}
                  {last.pinned && <span title="来自固定数据">📌</span>}
                  {last.live && <span className="steprow__live" title="真实执行（走了节点服务）">live</span>}
                  <span className="steprow__ms">
                    {last.status === 'skipped'
                      ? '跳过'
                      : last.status === 'running'
                        ? last.progress !== undefined
                          ? `${last.progress.toFixed(0)}%`
                          : '…'
                        : `${(last.durationMs / 1000).toFixed(1)}s`}
                  </span>
                  {last.error && <span className="steprow__err">{last.error}</span>}
                </button>
              )
            })}
        </div>
      </div>
    </div>
  )
}
