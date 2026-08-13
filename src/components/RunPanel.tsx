import { useState } from 'react'
import { useFlow } from '../store'
import type { StepStatus } from '../types'

const STATUS_ICON: Record<StepStatus, string> = {
  waiting: '·',
  running: '◌',
  success: '✓',
  error: '✗',
  skipped: '⊘',
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
  const setActiveRun = useFlow((s) => s.setActiveRun)
  const setRunPanelOpen = useFlow((s) => s.setRunPanelOpen)
  const openNdv = useFlow((s) => s.openNdv)

  const [form, setForm] = useState<Record<string, string>>({})
  const run = runs.find((r) => r.id === activeRunId) ?? runs[0] ?? null

  const missingRequired = flowInputs.filter((f) => f.required && !form[f.key]?.trim())

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
    <div className="runpanel">
      <div className="runpanel__left">
        <div className="runpanel__title">
          手动运行
          <button className="runpanel__close" onClick={() => setRunPanelOpen(false)} title="收起">▾</button>
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
            disabled={running || missingRequired.length > 0}
            title={missingRequired.length ? `先填必填项：${missingRequired.map((f) => f.title || f.key).join('、')}` : ''}
            onClick={doRun}
          >
            {running ? '运行中…' : '▶ 运行'}
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
              <span>{new Date(r.startedAt).toLocaleTimeString()}</span>
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
