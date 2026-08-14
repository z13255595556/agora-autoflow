import { Handle, Position, type NodeProps } from '@xyflow/react'
import { CATEGORY_COLOR, NODE_TYPE_MAP, portsOf } from '../registry'
import { useFlow, type FNode } from '../store'
import { validateNode } from '../lib/vars'
import { nodeSummary } from '../lib/summary'
import Icon from './Icon'
import { anchorOf, useCanvasCtx } from './canvasCtx'

export default function FlowNodeView({ id, data, selected }: NodeProps<FNode>) {
  const t = NODE_TYPE_MAP.get(data.typeId)
  const nodes = useFlow((s) => s.nodes)
  const edges = useFlow((s) => s.edges)
  const flowInputs = useFlow((s) => s.flowInputs)
  const runs = useFlow((s) => s.runs)
  const activeRunId = useFlow((s) => s.activeRunId)
  const isPinned = useFlow((s) => Object.prototype.hasOwnProperty.call(s.pinData, id))
  const isDirty = useFlow((s) => Boolean(s.dirtyNodes[id]))
  const openNdv = useFlow((s) => s.openNdv)
  const deleteNode = useFlow((s) => s.deleteNode)
  const duplicateNode = useFlow((s) => s.duplicateNode)
  const testStep = useFlow((s) => s.testStep)
  const running = useFlow((s) => s.running)
  const { openPicker } = useCanvasCtx()

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

  /** 出口的 `+`：接一个新节点，位置和连线都自动搞定 */
  const plus = (port: string) => (e: React.MouseEvent) => {
    e.stopPropagation()
    openPicker({ anchor: anchorOf(e.currentTarget), target: { kind: 'after', nodeId: id, port } })
  }

  return (
    <div
      className={`node${selected ? ' node--selected' : ''}${last ? ` node--run-${last.status}` : ''}`}
      style={{ '--accent': color } as React.CSSProperties}
    >
      {hasInput && <Handle type="target" position={Position.Left} className="handle handle--in" />}

      {/* 悬停工具条（Dify 同款）：常用动作直接落在节点上，不用先选中再去右栏找 */}
      <div className="node__tools" onPointerDown={(e) => e.stopPropagation()}>
        <button
          className="node__tool"
          title="只跑这一个节点（上游用最近一次运行的数据）"
          disabled={running}
          onClick={(e) => {
            e.stopPropagation()
            void testStep(id)
          }}
        >
          <Icon name="play" size={13} />
        </button>
        <button
          className="node__tool"
          title="详情：输入 / 参数 / 输出"
          onClick={(e) => {
            e.stopPropagation()
            openNdv(id)
          }}
        >
          <Icon name="expand" size={13} />
        </button>
        <button
          className="node__tool"
          title="复制一份"
          onClick={(e) => {
            e.stopPropagation()
            duplicateNode(id)
          }}
        >
          <Icon name="copy" size={13} />
        </button>
        <button
          className="node__tool node__tool--danger"
          title="删除"
          onClick={(e) => {
            e.stopPropagation()
            deleteNode(id)
          }}
        >
          <Icon name="trash" size={13} />
        </button>
      </div>

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
          <div className="node__name">
            {data.label}
            <span className="node__nid">{id}</span>
          </div>
          {/* 副标题写"配成了什么"而不是类型名 —— 类型名图标已经说了 */}
          <div className="node__summary">{nodeSummary(t, data.params)}</div>
        </div>
      </div>

      {errors.length > 0 && (
        <div className="node__errline" title={errors.join('\n')}>
          <i>!</i>
          {errors.length === 1 ? errors[0] : `${errors.length} 处待补`}
        </div>
      )}

      {ports.length === 1 && ports[0].id === 'out' && (
        <>
          <Handle type="source" position={Position.Right} id="out" className="handle handle--out" />
          <button className="node__plus" title="接一个节点" onClick={plus('out')}>
            <Icon name="plus" size={13} />
          </button>
        </>
      )}

      {ports.length > 1 && (
        <div className="node__ports">
          {ports.map((p) => (
            <div className="node__port" key={p.id}>
              <span className="node__portlabel">{p.label}</span>
              <Handle type="source" position={Position.Right} id={p.id} className="handle handle--port" />
              <button className="node__plus node__plus--port" title={`在「${p.label}」出口接一个节点`} onClick={plus(p.id)}>
                <Icon name="plus" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {ports.length === 0 && <div className="node__terminal">流程终点</div>}
    </div>
  )
}
