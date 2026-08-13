import { Handle, Position, type NodeProps } from '@xyflow/react'
import { CATEGORY_COLOR, NODE_TYPE_MAP, portsOf } from '../registry'
import { useFlow, type FNode } from '../store'
import { validateNode } from '../lib/vars'
import { describeSchedule } from '../lib/schedule'

export default function FlowNodeView({ id, data, selected }: NodeProps<FNode>) {
  const t = NODE_TYPE_MAP.get(data.typeId)
  const nodes = useFlow((s) => s.nodes)
  const edges = useFlow((s) => s.edges)
  const flowInputs = useFlow((s) => s.flowInputs)
  const runs = useFlow((s) => s.runs)
  const activeRunId = useFlow((s) => s.activeRunId)
  const isPinned = useFlow((s) => Object.prototype.hasOwnProperty.call(s.pinData, id))
  const isDirty = useFlow((s) => Boolean(s.dirtyNodes[id]))

  if (!t) {
    return <div className="node node--unknown">未知节点 {data.typeId}</div>
  }

  const self = nodes.find((n) => n.id === id)
  // pinned 节点执行时跳过参数校验（n8n 语义），画布上也不给它挂错误角标
  const errors = self && !isPinned ? validateNode(self, nodes, edges, flowInputs) : []
  const color = CATEGORY_COLOR[t.category] ?? '#64748b'
  const ports = portsOf(t)
  const hasInput = t.hasInput !== false

  // 运行状态角标（n8n 画布上的 ✓/✗/spinner）
  const run = runs.find((r) => r.id === activeRunId) ?? runs[0]
  const steps = run?.steps[id]
  const last = steps?.at(-1)

  return (
    <div
      className={`node${selected ? ' node--selected' : ''}${last ? ` node--run-${last.status}` : ''}`}
      style={{ '--accent': color } as React.CSSProperties}
    >
      {hasInput && <Handle type="target" position={Position.Left} className="handle handle--in" />}

      {(last || isPinned) && (
        <div className="node__runbadges">
          {isPinned && <span className="runbadge runbadge--pin" title="输出已固定（调试运行不会真正执行）">📌</span>}
          {last?.status === 'running' && last.progress !== undefined && (
            <span className="runbadge runbadge--progress" title={`执行中 ${last.progress.toFixed(1)}%`}>
              {last.progress.toFixed(0)}%
            </span>
          )}
          {last?.status === 'running' && last.progress === undefined && (
            <span className="runbadge runbadge--running" title="执行中" />
          )}
          {/* n8n dirty：参数改过没重跑 → 黄色 ⚠ 替代绿色 ✓；pinned 数据永远是当前真相，不标脏 */}
          {last?.status === 'success' && isDirty && !isPinned && (
            <span className="runbadge runbadge--dirty" title="参数改过了，输出可能已过期">⚠</span>
          )}
          {last?.status === 'success' && (!isDirty || isPinned) && (
            <span className="runbadge runbadge--success" title={`成功 · ${last.durationMs}ms`}>
              ✓{steps && steps.length > 1 ? `×${steps.length}` : ''}
            </span>
          )}
          {last?.status === 'error' && <span className="runbadge runbadge--error" title={last.error}>✗</span>}
          {last?.status === 'skipped' && <span className="runbadge runbadge--skipped" title="分支未命中，已跳过">⊘</span>}
        </div>
      )}

      <div className="node__head">
        <span className="node__icon">{t.icon}</span>
        <div className="node__titles">
          <div className="node__name">{data.label}</div>
          <div className="node__type">
            <span className="node__nid">{id}</span>
            {/* 定时触发把排程直接写在节点上 —— "我到底设成几点了"不该要点进去才知道 */}
            {data.typeId === 'trigger.schedule' ? describeSchedule(data.params) : t.type}
          </div>
        </div>
        {errors.length > 0 && (
          <span className="node__badge" title={errors.join('\n')}>
            {errors.length}
          </span>
        )}
      </div>

      {ports.length === 1 && ports[0].id === 'out' && (
        <Handle type="source" position={Position.Right} id="out" className="handle handle--out" />
      )}

      {ports.length > 1 && (
        <div className="node__ports">
          {ports.map((p) => (
            <div className="node__port" key={p.id}>
              <span>{p.label}</span>
              <Handle type="source" position={Position.Right} id={p.id} className="handle handle--port" />
            </div>
          ))}
        </div>
      )}

      {ports.length === 0 && <div className="node__terminal">终点</div>}
    </div>
  )
}
