import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Panel,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  useStore,
  type EdgeTypes,
  type NodeTypes,
} from '@xyflow/react'
import { useFlow } from '../store'
import { itemCount } from '../lib/engine'
import FlowNodeView from './FlowNodeView'
import FlowEdge from './FlowEdge'
import NodePicker from './NodePicker'
import Icon from './Icon'
import { CanvasCtx, anchorOf, type PickerRequest } from './canvasCtx'

const nodeTypes: NodeTypes = { flowNode: FlowNodeView }
const edgeTypes: EdgeTypes = { flowEdge: FlowEdge }

export default function Canvas() {
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

  const [picker, setPicker] = useState<PickerRequest | null>(null)
  const openPicker = useCallback((req: PickerRequest) => setPicker(req), [])
  const ctx = useMemo(() => ({ openPicker }), [openPicker])

  // 画布上只剩触发器 = 还没开始。这时候给一条上手路径，别让人对着空画布猜。
  // 一旦拖了第二个节点就消失，不打扰已经会用的人。
  const showGuide = nodes.length <= 1

  // 运行后给连线挂条数标签（n8n 的 "3 items"），运行中加流动动画。
  // n8n 语义：源节点 pinned → 用固定数据条数；跑了多次 → 累计条数。
  // 自定义连线拿不到内置的 label，走 data.count。
  const decoratedEdges = useMemo(() => {
    const run = runs.find((r) => r.id === activeRunId) ?? runs[0]
    const tag = (e: (typeof edges)[number], count?: string) => ({
      ...e,
      animated: running,
      data: { ...e.data, count },
    })
    if (!run && !Object.keys(pinData).length) return edges
    return edges.map((e) => {
      if (Object.prototype.hasOwnProperty.call(pinData, e.source)) {
        return tag(e, `${itemCount(pinData[e.source])} 项 📌`)
      }
      const steps = run?.steps[e.source]
      const last = steps?.at(-1)
      if (!last || last.status !== 'success') return tag(e)
      // 条件分支只给命中的出口挂标签，没走的分支不能显示"有数据流过"
      const srcNode = nodes.find((n) => n.id === e.source)
      if (srcNode?.data.typeId === 'flow.if') {
        const matched = Boolean((last.output as { matched?: boolean } | null)?.matched)
        const takenPort = matched ? 'true' : 'false'
        if ((e.sourceHandle ?? 'out') !== takenPort) return tag(e)
        return tag(e, '1 项')
      }
      if (steps!.length > 1) {
        const total = steps!.reduce((sum, s) => sum + (s.status === 'success' ? itemCount(s.output) : 0), 0)
        return tag(e, `共 ${total} 项`)
      }
      return tag(e, `${itemCount(last.output)} 项`)
    })
  }, [edges, nodes, runs, activeRunId, running, pinData])

  // 落点由 NodePicker 自己算（指针捕获 + screenToFlowPosition），
  // 这里不接 HTML5 drop —— 原生 dragstart 在这套布局里起不来
  return (
    <CanvasCtx.Provider value={ctx}>
      <div className="canvas">
        <ReactFlow
          nodes={nodes}
          edges={decoratedEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_, n) => select(n.id)}
          onNodeDoubleClick={(_, n) => openNdv(n.id)}
          onPaneClick={() => select(null)}
          // interactionWidth 是连线**看不见的**可点区域（默认 20）。线只有 1.6 宽，
          // 要选中删掉得像穿针一样，放宽到 34
          defaultEdgeOptions={{ type: 'flowEdge', interactionWidth: 34 }}
          // 松手时离目标圆点多近算连上（默认 20）。放大到 55：拖到节点边上就能连，
          // 不用精确落在那个 9px 的点上
          connectionRadius={55}
          proOptions={{ hideAttribution: true }}
          // 刻意不用 fitView 属性：它在每次新增节点（节点还没量过尺寸）时都会
          // 重新自适应一遍，画面无缘无故缩一下，还会把「把新节点挪进视野」的
          // 平移覆盖掉。改成载入时手动 fit 一次，见 <FitOnLoad>
          minZoom={0.2}
          maxZoom={2}
          deleteKeyCode={['Backspace', 'Delete']}
          multiSelectionKeyCode={['Meta', 'Control']}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1.4} />
          <FitOnLoad />
          <RevealNewNode />

          <Panel position="top-left">
            <button
              className="canvasadd"
              onClick={(e) => openPicker({ anchor: anchorOf(e.currentTarget), target: { kind: 'free' } })}
            >
              <span><Icon name="plus" size={13} /></span> 添加节点
            </button>
          </Panel>

          {showGuide && (
            <Panel position="top-center">
              <div className="guide">
                <div className="guide__title">三步做一个每天自动发群的报表</div>
                <ol className="guide__steps">
                  <li>
                    点触发器右边的 <b>+</b>，选 <b>SQL 查询</b> —— 位置和连线都自动接好
                  </li>
                  <li>
                    写好 SQL，点右上角 <b>运行</b>；跑通之后列名会自动认出来
                  </li>
                  <li>
                    再点 <b>+</b> 接一个 <b>企微通知</b>，用「插入表格」勾选要发的列
                  </li>
                </ol>
                <div className="guide__foot">想让它每天自己跑？把触发器换成「定时触发」。</div>
              </div>
            </Panel>
          )}

          <Panel position="bottom-left">
            <CanvasControls />
          </Panel>
        </ReactFlow>

        {picker && (
          <NodePicker anchor={picker.anchor} target={picker.target} onClose={() => setPicker(null)} />
        )}
      </div>
    </CanvasCtx.Provider>
  )
}

/** 节点宽度，和 .node 的 CSS 宽度一致 */
const NODE_W = 244
const NODE_H = 76
/** 配置面板压住的那条右边区域（面板宽 + 边距）—— 落在这后面不算"看得见" */
const DOCK_W = 424

/**
 * 换一条流程（打开 / 导入 / 清空）时把整条流程收进视野，一条流程只做一次。
 *
 * 必须等节点量过尺寸才 fit，否则拿到的包围盒是空的，会缩到一个奇怪的比例。
 */
function FitOnLoad() {
  const initialized = useNodesInitialized()
  const flowId = useFlow((s) => s.flowId)
  const runGen = useFlow((s) => s.runGen)
  const { fitView } = useReactFlow()
  const doneFor = useRef<string | null>(null)
  const key = `${flowId}#${runGen}`

  useEffect(() => {
    if (!initialized || doneFor.current === key) return
    doneFor.current = key
    void fitView({ padding: 0.25, maxZoom: 1 })
  }, [initialized, key, fitView])

  return null
}

/**
 * 刚加的节点不在视野里就把画面挪过去。
 *
 * 挂在 <ReactFlow> 里面（而不是加节点的选择器里）：视口 API 只在这层真正
 * 生效，而且选择器加完节点当场就卸载了，挪视野这件事没人接手。
 *
 * 已经看得见就不动 —— 每加一个节点都平移一下会让人晕。
 */
function RevealNewNode() {
  const revealId = useFlow((s) => s.revealId)
  const consumeReveal = useFlow((s) => s.consumeReveal)
  const { getViewport, setCenter } = useReactFlow()

  useEffect(() => {
    if (!revealId) return
    const id = consumeReveal()
    const node = useFlow.getState().nodes.find((n) => n.id === id)
    const rect = document.querySelector('.canvas')?.getBoundingClientRect()
    if (!node || !rect) return

    const { x: tx, y: ty, zoom } = getViewport()
    const sx = rect.left + tx + node.position.x * zoom
    const sy = rect.top + ty + node.position.y * zoom
    const visible =
      sx > rect.left + 16 &&
      sx + NODE_W * zoom < rect.right - DOCK_W &&
      sy > rect.top + 16 &&
      sy + NODE_H * zoom < rect.bottom - 72
    if (visible) return

    // setCenter 把给定的流程坐标摆到画布正中；往右偏半个面板宽，
    // 节点就落在"没被面板盖住"那半边的中间。
    //
    // duration 必须是 0：带时长的话 setCenter 走 d3 的过渡，而加节点这一帧的
    // 重渲会把过渡打断 —— 打断之后 transform 一点没变、promise 也不 resolve，
    // 表现就是"完全没反应"。宁可瞬间跳过去，也不要有一半概率不动。
    void setCenter(node.position.x + NODE_W / 2 + DOCK_W / 2 / zoom, node.position.y + NODE_H / 2, {
      zoom,
      duration: 0,
    })
  }, [revealId, consumeReveal, getViewport, setCenter])

  return null
}

/**
 * 画布控制条。react-flow 自带的 <Controls> 是竖着一列纯图标按钮，
 * 缩放比例看不见、也没有「整理」。自己画一条横的，顺手把当前缩放显示出来。
 */
function CanvasControls() {
  const { zoomIn, zoomOut, fitView, zoomTo } = useReactFlow()
  const zoom = useStore((s) => s.transform[2])
  const autoLayout = useFlow((s) => s.autoLayout)

  return (
    <div className="cctl">
      <button className="cctl__btn" onClick={() => zoomOut({ duration: 120 })} title="缩小"><Icon name="minus" size={14} /></button>
      <button className="cctl__zoom" onClick={() => zoomTo(1, { duration: 120 })} title="点击恢复 100%">
        {Math.round(zoom * 100)}%
      </button>
      <button className="cctl__btn" onClick={() => zoomIn({ duration: 120 })} title="放大"><Icon name="plus" size={14} /></button>
      <i className="cctl__sep" />
      <button className="cctl__btn" onClick={() => fitView({ padding: 0.25, duration: 200 })} title="适应画布"><Icon name="fit" size={14} /></button>
      <button
        className="cctl__btn cctl__btn--wide"
        onClick={() => {
          autoLayout()
          // 重排后节点全挪了位置，视野得跟着走一遍，否则要自己找它们去哪了
          setTimeout(() => fitView({ padding: 0.25, duration: 260 }), 0)
        }}
        title="按流程顺序自动排列节点"
      >
        <Icon name="layout" size={14} /> 整理
      </button>
    </div>
  )
}
