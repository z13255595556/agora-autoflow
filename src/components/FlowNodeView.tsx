import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react'
import { CATEGORY_COLOR, NODE_TYPE_MAP, portsOf } from '../registry'
import { useFlow, type FNode } from '../store'
import { validateNode } from '../lib/vars'
import { nodeSummary } from '../lib/summary'
import { isSchedulerAlive, SCHEDULER_OFF_DETAIL, SCHEDULER_OFF_SHORT } from '../lib/scheduler'
import { WEBHOOK_MISSING_DETAIL, WEBHOOK_MISSING_SHORT } from '../lib/webhookState'
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
  const webhookReady = useFlow((s) => s.webhookReady)
  const openNdv = useFlow((s) => s.openNdv)
  const deleteNode = useFlow((s) => s.deleteNode)
  const duplicateNode = useFlow((s) => s.duplicateNode)
  const toggleNodeSelection = useFlow((s) => s.toggleNodeSelection)
  const testStep = useFlow((s) => s.testStep)
  const updateNodeParam = useFlow((s) => s.updateNodeParam)
  const running = useFlow((s) => s.running)
  const { openPicker } = useCanvasCtx()

  if (!t) {
    return <div className="node node--unknown">未知节点 {data.typeId}</div>
  }

  if (t.visualOnly) {
    return (
      <CanvasNoteView
        id={id}
        data={data}
        selected={selected}
        onChange={(key, value) => updateNodeParam(id, key, value)}
        onDuplicate={() => duplicateNode(id)}
        onDelete={() => deleteNode(id)}
      />
    )
  }

  const self = nodes.find((n) => n.id === id)
  // pinned 节点执行时跳过参数校验（n8n 语义），画布上也不给它挂错误角标
  const errors = self && !isPinned ? validateNode(self, nodes, edges, flowInputs) : []
  const color = CATEGORY_COLOR[t.category] ?? '#64748b'
  const ports = portsOf(t)
  const hasInput = t.hasInput !== false
  const connectedPorts = new Set(
    edges
      .filter((edge) => edge.source === id)
      .map((edge) => edge.sourceHandle ?? 'out'),
  )

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
      onPointerDown={(event) => {
        if ((!event.metaKey && !event.ctrlKey) || (event.target as Element).closest('button')) return
        event.stopPropagation()
        toggleNodeSelection(id)
      }}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey) event.stopPropagation()
      }}
    >
      {hasInput && <Handle type="target" position={Position.Left} className="handle handle--in" />}

      {/* 悬停工具条：常用动作直接落在节点上，不用先选中再去右栏找 */}
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
        {t.hasInput !== false && (
          <button
            className="node__tool"
            title="复制一份（⌘/Ctrl+D）"
            onClick={(e) => {
              e.stopPropagation()
              duplicateNode(id)
            }}
          >
            <Icon name="copy" size={13} />
          </button>
        )}
        {t.hasInput !== false && (
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
        )}
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

      {/* 定时触发器只有 UI、没有调度器 —— 这一行必须挨着「每天 09:00」那句话，
          因为形成"它会自动跑"这个信念的正是那句话。
          不走 validateNode：那是**阻断执行**的错误，而手动运行是完全正常的 */}
      {!isSchedulerAlive() && data.typeId === 'trigger.schedule' && (
        <div className="node__warnline" title={SCHEDULER_OFF_DETAIL}>
          <i>!</i>
          {SCHEDULER_OFF_SHORT}
        </div>
      )}

      {/* 同理：拖上来这个节点就会相信"外部能触发了"，但地址得先生成一次。
          === false 而不是 !：还没探到结果时（null）不能先说一句假话 */}
      {webhookReady === false && data.typeId === 'trigger.webhook' && (
        <div className="node__warnline" title={WEBHOOK_MISSING_DETAIL}>
          <i>!</i>
          {WEBHOOK_MISSING_SHORT}
        </div>
      )}

      {ports.length === 1 && ports[0].id === 'out' && (
        <>
          <Handle type="source" position={Position.Right} id="out" className="handle handle--out" />
          {!connectedPorts.has('out') && (
            <button className="node__plus" title="接一个节点" onClick={plus('out')}>
              <Icon name="plus" size={13} />
            </button>
          )}
        </>
      )}

      {ports.length > 1 && (
        <div className="node__ports">
          {ports.map((p) => (
            <div className="node__port" key={p.id}>
              <span className="node__portlabel">{p.label}</span>
              <Handle type="source" position={Position.Right} id={p.id} className="handle handle--port" />
              {!connectedPorts.has(p.id) && (
                <button className="node__plus node__plus--port" title={`在「${p.label}」出口接一个节点`} onClick={plus(p.id)}>
                  <Icon name="plus" size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {ports.length === 0 && <div className="node__terminal">流程终点</div>}
    </div>
  )
}

const NOTE_THEMES = ['yellow', 'blue', 'green', 'pink', 'gray'] as const

function CanvasNoteView({
  id,
  data,
  selected,
  onChange,
  onDuplicate,
  onDelete,
}: {
  id: string
  data: FNode['data']
  selected: boolean
  onChange: (key: string, value: unknown) => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const theme = NOTE_THEMES.includes(data.params.theme as typeof NOTE_THEMES[number])
    ? data.params.theme as typeof NOTE_THEMES[number]
    : 'yellow'
  const text = typeof data.params.text === 'string' ? data.params.text : ''

  return (
    <div className={`canvasnote canvasnote--${theme}${selected ? ' canvasnote--selected' : ''}`}>
      <NodeResizer
        isVisible={selected}
        minWidth={220}
        minHeight={110}
        lineClassName="canvasnote__resize-line"
        handleClassName="canvasnote__resize-handle"
      />
      <i className="canvasnote__stripe" />
      {selected && (
        <div className="canvasnote__toolbar nodrag nowheel" onPointerDown={(event) => event.stopPropagation()}>
          <div className="canvasnote__swatches" aria-label="便签颜色">
            {NOTE_THEMES.map((item) => (
              <button
                key={item}
                className={`canvasnote__swatch canvasnote__swatch--${item}${item === theme ? ' is-active' : ''}`}
                onClick={() => onChange('theme', item)}
                title={`${item === 'yellow' ? '黄色' : item === 'blue' ? '蓝色' : item === 'green' ? '绿色' : item === 'pink' ? '粉色' : '灰色'}便签`}
                aria-label={`${item === 'yellow' ? '黄色' : item === 'blue' ? '蓝色' : item === 'green' ? '绿色' : item === 'pink' ? '粉色' : '灰色'}便签`}
                aria-pressed={item === theme}
              />
            ))}
          </div>
          <i />
          <button title="创建副本" aria-label="创建副本" onClick={onDuplicate}><Icon name="copy" size={13} /></button>
          <button className="is-danger" title="删除便签" aria-label="删除便签" onClick={onDelete}><Icon name="trash" size={13} /></button>
        </div>
      )}
      <textarea
        className="canvasnote__editor nodrag nowheel"
        value={text}
        readOnly={!selected}
        placeholder="写点说明…"
        aria-label={`便签 ${id}`}
        onPointerDown={(event) => {
          if (selected) event.stopPropagation()
        }}
        onClick={(event) => {
          if (selected) event.stopPropagation()
        }}
        onChange={(event) => onChange('text', event.target.value)}
      />
    </div>
  )
}
