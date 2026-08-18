import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  getViewportForBounds,
  Panel,
  ReactFlow,
  SelectionMode,
  useNodesInitialized,
  useReactFlow,
  useStore,
  type EdgeTypes,
  type FinalConnectionState,
  type NodeTypes,
} from '@xyflow/react'
import { useFlow } from '../store'
import { itemCount } from '../lib/engine'
import { connectionProblem } from '../lib/graph'
import { rememberNodeType } from '../lib/nodeUsage'
import { NODE_TYPE_MAP } from '../registry'
import FlowNodeView from './FlowNodeView'
import FlowEdge from './FlowEdge'
import NodePicker from './NodePicker'
import CanvasContextMenu, { type CanvasMenuRequest } from './CanvasContextMenu'
import CanvasNodeSearch from './CanvasNodeSearch'
import Icon from './Icon'
import { CanvasCtx, anchorOf, type PickerRequest } from './canvasCtx'

const nodeTypes: NodeTypes = { flowNode: FlowNodeView }
const edgeTypes: EdgeTypes = { flowEdge: FlowEdge }

export default function Canvas({ reservedRight = 0 }: { reservedRight?: number }) {
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
  const pasteNodes = useFlow((s) => s.pasteNodes)
  const addNode = useFlow((s) => s.addNode)
  const addNodeAfter = useFlow((s) => s.addNodeAfter)
  const { screenToFlowPosition } = useReactFlow()

  const [picker, setPicker] = useState<PickerRequest | null>(null)
  const [contextMenu, setContextMenu] = useState<CanvasMenuRequest | null>(null)
  const [nodeSearchOpen, setNodeSearchOpen] = useState(false)
  const [canvasMode, setCanvasMode] = useState<'pan' | 'note'>('pan')
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null)
  const lastPointer = useRef<{ x: number; y: number } | null>(null)
  const invalidConnection = useRef<string | null>(null)
  const noticeTimer = useRef<number | null>(null)
  const openPicker = useCallback((req: PickerRequest) => setPicker(req), [])
  const ctx = useMemo(() => ({ openPicker }), [openPicker])

  const showConnectionNotice = useCallback((message: string) => {
    setConnectionNotice(message)
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setConnectionNotice(null), 2600)
  }, [])

  useEffect(() => () => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      setContextMenu(null)
      setPicker(null)
      setNodeSearchOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isInputLike(event.target)) return
      if (event.key.toLowerCase() === 'h') setCanvasMode('pan')
      else if (event.key.toLowerCase() === 'c') setCanvasMode('note')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const isValidConnection = useCallback(
    (connection: Parameters<typeof connectionProblem>[0]) => {
      const problem = connectionProblem(connection, edges)
      invalidConnection.current = problem
      return !problem
    },
    [edges],
  )

  // 画布上只剩触发器时，把最常用的第一步变成直接操作。
  const showGuide = nodes.length <= 1
  const triggerId = showGuide ? nodes[0]?.id : undefined

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
      <div className={`canvas canvas--mode-${canvasMode}`}>
        <ReactFlow
          nodes={nodes}
          edges={decoratedEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={(connection) => {
            const problem = connectionProblem(connection, edges)
            if (problem) showConnectionNotice(problem)
            else onConnect(connection)
          }}
          isValidConnection={isValidConnection}
          onConnectStart={() => { invalidConnection.current = null }}
          onConnectEnd={(event, state: FinalConnectionState) => {
            const target = event.target as Element | null
            const droppedOnPane = !!target?.closest('.react-flow__pane') && !target.closest('.react-flow__node')

            if (
              state.fromHandle?.type === 'source' &&
              state.fromHandle.nodeId &&
              !state.toHandle &&
              droppedOnPane
            ) {
              const point = 'changedTouches' in event
                ? event.changedTouches[0]
                : event
              if (point) {
                const dropAt = { x: point.clientX, y: point.clientY }
                openPicker({
                  anchor: dropAt,
                  target: {
                    kind: 'connection',
                    nodeId: state.fromHandle.nodeId,
                    port: state.fromHandle.id ?? 'out',
                    dropAt,
                  },
                })
              }
            } else if (invalidConnection.current) {
              showConnectionNotice(invalidConnection.current)
            }
            invalidConnection.current = null
          }}
          onNodeClick={(_, n) => {
            setContextMenu(null)
            select(n.id)
          }}
          onNodeDoubleClick={(_, n) => {
            if (!NODE_TYPE_MAP.get(n.data.typeId)?.visualOnly) openNdv(n.id)
          }}
          onNodeContextMenu={(event, node) => {
            event.preventDefault()
            const selected = nodes.filter((item) => item.selected)
            if (node.selected && selected.length > 1) {
              select(null)
              setContextMenu({ kind: 'selection', nodeIds: selected.map((item) => item.id), x: event.clientX, y: event.clientY })
            } else {
              select(node.id)
              setContextMenu({ kind: 'node', nodeId: node.id, x: event.clientX, y: event.clientY })
            }
          }}
          onSelectionContextMenu={(event, selected) => {
            event.preventDefault()
            select(null)
            setContextMenu({ kind: 'selection', nodeIds: selected.map((item) => item.id), x: event.clientX, y: event.clientY })
          }}
          onPaneClick={(event) => {
            setContextMenu(null)
            if (canvasMode === 'note') {
              const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
              addNode('canvas.note', { x: position.x - 140, y: position.y - 80 })
              setCanvasMode('pan')
              return
            }
            select(null)
          }}
          onPaneContextMenu={(event) => {
            event.preventDefault()
            select(null)
            setContextMenu({ kind: 'pane', x: event.clientX, y: event.clientY })
          }}
          onPaneMouseMove={(event) => { lastPointer.current = { x: event.clientX, y: event.clientY } }}
          onSelectionChange={({ nodes: selected }) => select(selected.length === 1 ? selected[0].id : null)}
          // interactionWidth 是连线**看不见的**可点区域（默认 20）。线只有 1.6 宽，
          // 要选中删掉得像穿针一样，放宽到 34
          defaultEdgeOptions={{ type: 'flowEdge', interactionWidth: 34 }}
          selectionOnDrag={false}
          selectionMode={SelectionMode.Partial}
          panOnDrag={canvasMode === 'pan' ? true : [1]}
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
          <FitOnLoad reservedRight={reservedRight} />
          <PanelViewportGuard reservedRight={reservedRight} />
          <KeepSelectedNodeVisible reservedRight={reservedRight} />
          <RevealNewNode reservedRight={reservedRight} />
          <CanvasShortcuts lastPointer={lastPointer} reservedRight={reservedRight} />

          <Panel position="top-left">
            <div className="canvasprimarytools">
              <button
                className="canvasadd"
                onClick={(e) => openPicker({ anchor: anchorOf(e.currentTarget), target: { kind: 'free' } })}
              >
                <span><Icon name="plus" size={13} /></span> 添加节点
              </button>
              <button
                className="canvasfind"
                onClick={() => setNodeSearchOpen(true)}
                title="查找节点（⌘/Ctrl+K）"
                aria-label="查找节点"
              >
                <Icon name="search" size={15} />
              </button>
            </div>
          </Panel>

          {showGuide && (
            <Panel position="top-center">
              <div className="quickstart" aria-label="添加第一个步骤">
                <span className="quickstart__label">添加第一个步骤</span>
                <button disabled={!triggerId} onClick={() => {
                  if (!triggerId) return
                  rememberNodeType('sql.query')
                  addNodeAfter('sql.query', triggerId)
                }}>
                  <span>▤</span> DataLego SQL
                </button>
                <button disabled={!triggerId} onClick={() => {
                  if (!triggerId) return
                  rememberNodeType('http.request')
                  addNodeAfter('http.request', triggerId)
                }}>
                  <span>↗</span> HTTP 请求
                </button>
                <button
                  disabled={!triggerId}
                  onClick={(event) => openPicker({
                    anchor: anchorOf(event.currentTarget),
                    target: { kind: 'after', nodeId: triggerId!, port: 'out' },
                  })}
                >
                  <Icon name="plus" size={13} /> 更多节点
                </button>
              </div>
            </Panel>
          )}

          <Panel position="bottom-left">
            <CanvasControls
              reservedRight={reservedRight}
              mode={canvasMode}
              onMode={setCanvasMode}
            />
          </Panel>
        </ReactFlow>

        {picker && (
          <NodePicker anchor={picker.anchor} target={picker.target} onClose={() => setPicker(null)} />
        )}
        {nodeSearchOpen && <CanvasNodeSearch onClose={() => setNodeSearchOpen(false)} />}
        {contextMenu && (
          <CanvasContextMenu
            request={contextMenu}
            onClose={() => setContextMenu(null)}
            onAdd={() => openPicker({ anchor: { x: contextMenu.x, y: contextMenu.y }, target: { kind: 'free' } })}
            onPaste={() => pasteNodes(screenToFlowPosition({ x: contextMenu.x, y: contextMenu.y }))}
          />
        )}
        {connectionNotice && (
          <div className="canvasnotice" role="status" aria-live="polite">
            <i>!</i>
            {connectionNotice}
          </div>
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
 * 按画布真正可见的区域计算视口。右侧配置面板是浮层，React Flow 自带的
 * fitView 不知道它占了空间，会把最右侧节点排到面板下面。
 */
function useFitVisibleArea(reservedRight: number) {
  const nodes = useFlow((s) => s.nodes)
  const { getNodesBounds, setViewport } = useReactFlow()

  return useCallback(
    (duration = 180) => {
      const rect = document.querySelector<HTMLElement>('.canvas')?.getBoundingClientRect()
      if (!rect || nodes.length === 0) return
      const width = Math.max(280, rect.width - reservedRight)
      const height = Math.max(180, rect.height)
      const bounds = getNodesBounds(nodes)
      if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return
      const viewport = getViewportForBounds(bounds, width, height, 0.2, 1, 0.18)
      void setViewport(viewport, { duration })
    },
    [nodes, reservedRight, getNodesBounds, setViewport],
  )
}

/**
 * 换一条流程（打开 / 导入 / 清空）时把整条流程收进视野，一条流程只做一次。
 *
 * 必须等节点量过尺寸才 fit，否则拿到的包围盒是空的，会缩到一个奇怪的比例。
 */
function FitOnLoad({ reservedRight }: { reservedRight: number }) {
  const initialized = useNodesInitialized()
  const flowId = useFlow((s) => s.flowId)
  const runGen = useFlow((s) => s.runGen)
  const fitVisible = useFitVisibleArea(reservedRight)
  const doneFor = useRef<string | null>(null)
  const key = `${flowId}#${runGen}`

  useEffect(() => {
    if (!initialized || doneFor.current === key) return
    doneFor.current = key
    fitVisible(0)
  }, [initialized, key, fitVisible])

  return null
}

/** 面板挤占工作区时重新适配一次，关闭面板则保留用户当前视角。 */
function PanelViewportGuard({ reservedRight }: { reservedRight: number }) {
  const initialized = useNodesInitialized()
  const runPanelOpen = useFlow((s) => s.runPanelOpen)
  const runPanelHeight = useFlow((s) => s.runPanelHeight)
  const fitVisible = useFitVisibleArea(reservedRight)
  const previous = useRef({ reservedRight: 0, runPanelOpen: false, runPanelHeight })

  useEffect(() => {
    const before = previous.current
    previous.current = { reservedRight, runPanelOpen, runPanelHeight }
    if (!initialized) return
    const workAreaShrank = reservedRight > before.reservedRight || (runPanelOpen && !before.runPanelOpen)
    const panelGrew = runPanelOpen && before.runPanelOpen && runPanelHeight > before.runPanelHeight
    if (!workAreaShrank && !panelGrew) return
    const timer = window.setTimeout(() => fitVisible(180), panelGrew ? 120 : 0)
    return () => window.clearTimeout(timer)
  }, [initialized, reservedRight, runPanelOpen, runPanelHeight, fitVisible])

  return null
}

/** 切换选中节点时，如果它落在配置面板后面，只平移视图，不改变用户缩放。 */
function KeepSelectedNodeVisible({ reservedRight }: { reservedRight: number }) {
  const selectedId = useFlow((s) => s.selectedId)
  const { getNode, getViewport, setViewport } = useReactFlow()

  useEffect(() => {
    if (!selectedId) return
    const frame = requestAnimationFrame(() => {
      const rect = document.querySelector<HTMLElement>('.canvas')?.getBoundingClientRect()
      const node = getNode(selectedId)
      if (!rect || !node) return
      const { x, y, zoom } = getViewport()
      const width = node.measured?.width ?? node.width ?? NODE_W
      const height = node.measured?.height ?? node.height ?? NODE_H
      const sx = x + node.position.x * zoom
      const sy = y + node.position.y * zoom
      const safeRight = rect.width - reservedRight - 24
      const safeBottom = rect.height - 64
      const visible = sx >= 24 && sy >= 24 && sx + width * zoom <= safeRight && sy + height * zoom <= safeBottom
      if (visible) return

      const safeWidth = Math.max(280, rect.width - reservedRight)
      const centerX = node.position.x + width / 2
      const centerY = node.position.y + height / 2
      void setViewport(
        { x: safeWidth / 2 - centerX * zoom, y: rect.height / 2 - centerY * zoom, zoom },
        { duration: 160 },
      )
    })
    return () => cancelAnimationFrame(frame)
  }, [selectedId, reservedRight, getNode, getViewport, setViewport])

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
function RevealNewNode({ reservedRight }: { reservedRight: number }) {
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
      sx + NODE_W * zoom < rect.right - reservedRight &&
      sy > rect.top + 16 &&
      sy + NODE_H * zoom < rect.bottom - 72
    if (visible) return

    // setCenter 把给定的流程坐标摆到画布正中；往右偏半个面板宽，
    // 节点就落在"没被面板盖住"那半边的中间。
    //
    // duration 必须是 0：带时长的话 setCenter 走 d3 的过渡，而加节点这一帧的
    // 重渲会把过渡打断 —— 打断之后 transform 一点没变、promise 也不 resolve，
    // 表现就是"完全没反应"。宁可瞬间跳过去，也不要有一半概率不动。
    const panelOffset = reservedRight || DOCK_W
    void setCenter(node.position.x + NODE_W / 2 + panelOffset / 2 / zoom, node.position.y + NODE_H / 2, {
      zoom,
      duration: 0,
    })
  }, [revealId, consumeReveal, getViewport, setCenter, reservedRight])

  return null
}

/**
 * 画布控制条。react-flow 自带的 <Controls> 是竖着一列纯图标按钮，
 * 缩放比例看不见、也没有「整理」。自己画一条横的，顺手把当前缩放显示出来。
 */
function CanvasControls({
  reservedRight,
  mode,
  onMode,
}: {
  reservedRight: number
  mode: 'pan' | 'note'
  onMode: (mode: 'pan' | 'note') => void
}) {
  const { zoomIn, zoomOut, zoomTo } = useReactFlow()
  const fitVisible = useFitVisibleArea(reservedRight)
  const zoom = useStore((s) => s.transform[2])
  const autoLayout = useFlow((s) => s.autoLayout)

  return (
    <div className="cctl">
      <button
        className={`cctl__btn cctl__btn--wide${mode === 'pan' ? ' is-active' : ''}`}
        onClick={() => onMode('pan')}
        title="平移画布（H）"
        aria-label="平移画布"
        aria-pressed={mode === 'pan'}
      >
        <Icon name="hand" size={14} /> 平移
      </button>
      <button
        className={`cctl__btn cctl__btn--wide${mode === 'note' ? ' is-active' : ''}`}
        onClick={() => onMode('note')}
        title="添加便签（C）"
        aria-label="添加便签"
        aria-pressed={mode === 'note'}
      >
        <Icon name="note" size={14} /> 便签
      </button>
      <i className="cctl__sep" />
      <button className="cctl__btn" onClick={() => zoomOut({ duration: 120 })} title="缩小"><Icon name="minus" size={14} /></button>
      <button className="cctl__zoom" onClick={() => zoomTo(1, { duration: 120 })} title="恢复 100%（Shift+1）">
        {Math.round(zoom * 100)}%
      </button>
      <button className="cctl__btn" onClick={() => zoomIn({ duration: 120 })} title="放大"><Icon name="plus" size={14} /></button>
      <i className="cctl__sep" />
      <button className="cctl__btn" onClick={() => fitVisible(200)} title="适应可见区域（⌘/Ctrl+1）"><Icon name="fit" size={14} /></button>
      <button
        className="cctl__btn cctl__btn--wide"
        onClick={() => {
          autoLayout()
          // 重排后节点全挪了位置，视野得跟着走一遍，否则要自己找它们去哪了
          setTimeout(() => fitVisible(260), 0)
        }}
        title="按流程顺序自动排列节点（⌘/Ctrl+O）"
      >
        <Icon name="layout" size={14} /> 整理
      </button>
    </div>
  )
}

/** 画布高频快捷键。输入控件与详情弹窗内不接管。 */
function CanvasShortcuts({
  lastPointer,
  reservedRight,
}: {
  lastPointer: React.RefObject<{ x: number; y: number } | null>
  reservedRight: number
}) {
  const hasSelectedNodes = useFlow((s) => s.nodes.some((node) => node.selected || node.id === s.selectedId))
  const ndvNodeId = useFlow((s) => s.ndvNodeId)
  const running = useFlow((s) => s.running)
  const duplicateNode = useFlow((s) => s.duplicateNode)
  const copyNodes = useFlow((s) => s.copyNodes)
  const pasteNodes = useFlow((s) => s.pasteNodes)
  const hasClipboard = useFlow((s) => Boolean(s.clipboard?.nodes.length))
  const autoLayout = useFlow((s) => s.autoLayout)
  const { getZoom, screenToFlowPosition, zoomTo } = useReactFlow()
  const fitVisible = useFitVisibleArea(reservedRight)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (running || ndvNodeId || isInputLike(event.target)) return
      const mod = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()

      if (mod && key === 'c') {
        const selection = window.getSelection()
        if (selection && !selection.isCollapsed) return
        if (copyNodes() > 0) event.preventDefault()
      } else if (mod && key === 'v' && hasClipboard) {
        event.preventDefault()
        const point = lastPointer.current
        pasteNodes(point ? screenToFlowPosition(point) : undefined)
      } else if (mod && key === 'd' && hasSelectedNodes) {
        event.preventDefault()
        duplicateNode()
      } else if (mod && key === 'o') {
        event.preventDefault()
        autoLayout()
        setTimeout(() => fitVisible(220), 0)
      } else if (mod && key === '1') {
        event.preventDefault()
        fitVisible(180)
      } else if (!mod && event.shiftKey && event.code === 'Digit1') {
        event.preventDefault()
        void zoomTo(1, { duration: 120 })
      } else if (mod && (key === '=' || key === '+')) {
        event.preventDefault()
        void zoomTo(Math.min(2, getZoom() + 0.1), { duration: 100 })
      } else if (mod && key === '-') {
        event.preventDefault()
        void zoomTo(Math.max(0.2, getZoom() - 0.1), { duration: 100 })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasSelectedNodes, ndvNodeId, running, copyNodes, pasteNodes, hasClipboard, duplicateNode, autoLayout, fitVisible, getZoom, screenToFlowPosition, zoomTo, lastPointer])

  return null
}

function isInputLike(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}
