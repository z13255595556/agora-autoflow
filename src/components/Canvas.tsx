import { useMemo, useRef } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  type NodeTypes,
} from '@xyflow/react'
import { useFlow } from '../store'
import { CATEGORY_COLOR, NODE_TYPE_MAP } from '../registry'
import { itemCount } from '../lib/engine'
import FlowNodeView from './FlowNodeView'

const nodeTypes: NodeTypes = { flowNode: FlowNodeView }

export default function Canvas() {
  const wrapper = useRef<HTMLDivElement>(null)

  const nodes = useFlow((s) => s.nodes)
  const edges = useFlow((s) => s.edges)
  const onNodesChange = useFlow((s) => s.onNodesChange)
  const onEdgesChange = useFlow((s) => s.onEdgesChange)
  const onConnect = useFlow((s) => s.onConnect)
  const select = useFlow((s) => s.select)
  const openNdv = useFlow((s) => s.openNdv)
  const runs = useFlow((s) => s.runs)
  const activeRunId = useFlow((s) => s.activeRunId)
  const running = useFlow((s) => s.running)
  const pinData = useFlow((s) => s.pinData)

  // 画布上只剩触发器 = 还没开始。这时候给一条上手路径，别让人对着空画布猜。
  // 一旦拖了第二个节点就消失，不打扰已经会用的人。
  const showGuide = nodes.length <= 1

  // 运行后给连线挂条数标签（n8n 的 "3 items"），运行中加流动动画。
  // n8n 语义：源节点 pinned → 用固定数据条数；跑了多次 → 累计条数。
  const decoratedEdges = useMemo(() => {
    const run = runs.find((r) => r.id === activeRunId) ?? runs[0]
    if (!run && !Object.keys(pinData).length) return edges
    return edges.map((e) => {
      if (Object.prototype.hasOwnProperty.call(pinData, e.source)) {
        return { ...e, animated: running, label: `${itemCount(pinData[e.source])} 项 📌` }
      }
      const steps = run?.steps[e.source]
      const last = steps?.at(-1)
      if (!last || last.status !== 'success') return { ...e, animated: running }
      // 条件分支只给命中的出口挂标签，没走的分支不能显示"有数据流过"
      const srcNode = nodes.find((n) => n.id === e.source)
      if (srcNode?.data.typeId === 'flow.if') {
        const matched = Boolean((last.output as { matched?: boolean } | null)?.matched)
        const takenPort = matched ? 'true' : 'false'
        if ((e.sourceHandle ?? 'out') !== takenPort) return { ...e, animated: running }
        return { ...e, animated: running, label: '1 项' }
      }
      if (steps!.length > 1) {
        const total = steps!.reduce((sum, s) => sum + (s.status === 'success' ? itemCount(s.output) : 0), 0)
        return { ...e, animated: running, label: `共 ${total} 项` }
      }
      return { ...e, animated: running, label: `${itemCount(last.output)} 项` }
    })
  }, [edges, nodes, runs, activeRunId, running, pinData])

  // 从节点面板拖过来的落点由 Palette 自己算（指针捕获 + screenToFlowPosition），
  // 这里不接 HTML5 drop —— 原生 dragstart 在这套布局里起不来
  return (
    <div className="canvas" ref={wrapper}>
      <ReactFlow
        nodes={nodes}
        edges={decoratedEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, n) => select(n.id)}
        onNodeDoubleClick={(_, n) => openNdv(n.id)}
        onPaneClick={() => select(null)}
        defaultEdgeOptions={{ type: 'smoothstep' }}
        proOptions={{ hideAttribution: true }}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={2}
        deleteKeyCode={['Backspace', 'Delete']}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        {showGuide && (
          <Panel position="top-center">
            <div className="guide">
              <div className="guide__title">三步做一个每天自动发群的报表</div>
              <ol className="guide__steps">
                <li>
                  从左边把 <b>SQL 查询</b> 拖进画布，拖触发器右侧的圆点连到它上面
                </li>
                <li>
                  写好 SQL，点右上角 <b>运行</b> —— 跑通之后列名会自动认出来
                </li>
                <li>
                  再拖一个 <b>企微通知</b> 接在后面，点「插入表格」勾选要发的列
                </li>
              </ol>
              <div className="guide__foot">
                想让它每天自己跑？把触发器换成「定时触发」。
              </div>
            </div>
          </Panel>
        )}
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => {
            const t = NODE_TYPE_MAP.get((n.data as { typeId?: string }).typeId ?? '')
            return t ? (CATEGORY_COLOR[t.category] ?? '#94a3b8') : '#94a3b8'
          }}
          nodeStrokeWidth={0}
        />
      </ReactFlow>
    </div>
  )
}
