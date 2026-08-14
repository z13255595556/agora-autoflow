import { create } from 'zustand'
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react'
import type { FlowDefinition, FlowInputField, FlowNodeData, FlowRun, JsonSchema, NodeType, StepRun } from './types'
import { applyBackendNodes, NODE_TYPE_MAP, portsOf, setOptions } from './registry'
import { executeFlow, executeSingleNode } from './lib/engine'
import { isFieldVisible } from './lib/display'
import { learnColumns, toProbedFields, toResponseFields } from './lib/output'
import { redactNodeInput } from './lib/secrets'
import { extractSqlPlaceholders } from './lib/placeholders'
import { descendants, freeSpotRightOf, layeredLayout, NODE_W } from './lib/layout'
import { connectionProblem, graphProblems } from './lib/graph'
import * as api from './lib/client'

export type FNode = Node<FlowNodeData>

interface HistorySnapshot {
  flowName: string
  flowInputs: FlowInputField[]
  nodes: FNode[]
  edges: Edge[]
  seq: number
  pinData: Record<string, unknown>
  dirtyNodes: Record<string, true>
}

interface FlowClipboard {
  nodes: FNode[]
  edges: Edge[]
  pasteCount: number
}

const HISTORY_LIMIT = 50
const HISTORY_GROUP_MS = 800
const NODE_H = 76
const RUN_PANEL_HEIGHT_KEY = 'autoflow.run-panel-height'
const DEFAULT_RUN_PANEL_HEIGHT = 258

function initialRunPanelHeight(): number {
  if (typeof localStorage === 'undefined') return DEFAULT_RUN_PANEL_HEIGHT
  const value = Number(localStorage.getItem(RUN_PANEL_HEIGHT_KEY))
  return Number.isFinite(value) ? Math.min(560, Math.max(180, value)) : DEFAULT_RUN_PANEL_HEIGHT
}

function historySnapshot(state: FlowState): HistorySnapshot {
  return {
    flowName: state.flowName,
    flowInputs: state.flowInputs,
    // 选择态是临时 UI，不应该随着撤销一起跳回旧节点。
    nodes: state.nodes.map((node) => (node.selected ? { ...node, selected: false } : node)),
    edges: state.edges.map((edge) => (edge.selected ? { ...edge, selected: false } : edge)),
    seq: state.seq,
    pinData: state.pinData,
    dirtyNodes: state.dirtyNodes,
  }
}

/**
 * 生成一次历史提交。连续输入同一字段会合并成一步，结构性操作则每次单独记录。
 */
function historyCommit(state: FlowState, groupKey?: string) {
  const now = Date.now()
  const grouped =
    !!groupKey && state.historyGroup?.key === groupKey && now - state.historyGroup.at < HISTORY_GROUP_MS
  return {
    historyPast: grouped
      ? state.historyPast
      : [...state.historyPast, historySnapshot(state)].slice(-HISTORY_LIMIT),
    historyFuture: [],
    historyGroup: groupKey ? { key: groupKey, at: now } : null,
  }
}

function defaultParams(t: NodeType): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, schema] of Object.entries(t.input.properties ?? {})) {
    if (schema.default !== undefined) out[key] = schema.default
  }
  return out
}

function isNodeCopyable(node: FNode): boolean {
  // 触发器是流程入口，复制后会产生多个入口语义。
  return NODE_TYPE_MAP.get(node.data.typeId)?.hasInput !== false
}

function isEntryNode(node: FNode): boolean {
  const type = NODE_TYPE_MAP.get(node.data.typeId)
  return type?.hasInput === false && !type.visualOnly
}

function copiedLabel(label: string, reserved: Set<string>): string {
  const base = `${label} 副本`
  let candidate = base
  let index = 2
  while (reserved.has(candidate)) candidate = `${base} ${index++}`
  reserved.add(candidate)
  return candidate
}

/** 造一个画布节点。加节点现在有四个入口（拖、`+` 手柄、连线插入、复制），共用这里 */
function makeNode(typeId: string, position: { x: number; y: number }, seq: number): FNode | null {
  const t = NODE_TYPE_MAP.get(typeId)
  if (!t) return null
  return {
    id: `n${seq}`,
    type: 'flowNode',
    position,
    selected: true,
    ...(t.visualOnly ? { style: { width: 280, height: 160 } } : {}),
    data: {
      typeId: t.type,
      typeVersion: t.typeVersion,
      label: t.name,
      params: defaultParams(t),
      onError: 'fail',
    },
  }
}

/**
 * 从一次成功的运行里学到真实列名，写回节点实例。
 *
 * 这是「变量太多、不知道引用哪个」的正解：后端每次 poll 都返回 columns，
 * 以前整份丢掉，列名只有手动点「试运行探测」才有 —— 而那个按钮藏在默认
 * 折叠的区块里。现在跑一次就有了，探测降级成没跑过时的兜底。
 *
 * 返回 null 表示不需要更新，调用方就别 set —— 每一步都新建节点对象会让
 * 整个画布跟着重渲。
 */
function withLearnedOutput(nodes: FNode[], step: StepRun): FNode[] | null {
  if (step.status !== 'success') return null
  const node = nodes.find((n) => n.id === step.nodeId)
  if (!node) return null
  const learned = learnColumns(step.output)
  const fields = node.data.typeId === 'http.request'
    ? toResponseFields(step.output)
    : learned ? toProbedFields(learned) : null
  if (!fields) return null
  const prev = node.data.probedOutput ?? {}
  const unchanged = JSON.stringify(fields) === JSON.stringify(prev)
  if (unchanged) return null
  return nodes.map((n) => (n.id === step.nodeId ? { ...n, data: { ...n.data, probedOutput: fields } } : n))
}

interface FlowState {
  flowId: string
  flowName: string
  flowInputs: FlowInputField[]
  nodes: FNode[]
  edges: Edge[]
  selectedId: string | null
  seq: number

  /** 画布编辑历史；运行结果和面板开关不进入历史。 */
  historyPast: HistorySnapshot[]
  historyFuture: HistorySnapshot[]
  historyGroup: { key: string; at: number } | null
  historyDragStart: HistorySnapshot | null
  /** 节点剪贴板：只保存节点与选区内连线，不进入流程 DSL。 */
  clipboard: FlowClipboard | null

  /** nodeId → 固定输出（n8n pinData）。手动运行时替代真实执行 */
  pinData: Record<string, unknown>
  /** 运行历史，最新在前 */
  runs: FlowRun[]
  /** 当前查看的运行 */
  activeRunId: string | null
  running: boolean
  /** 双击节点打开的详情视图（n8n NDV） */
  ndvNodeId: string | null
  runPanelOpen: boolean
  runPanelHeight: number
  /** 参数改过但还没重跑的节点（n8n dirty/PARAMETERS_UPDATED：输出可能已过期） */
  dirtyNodes: Record<string, true>
  /** 运行代际：clear/load 时 +1，让还在跑的旧引擎回调作废 */
  runGen: number
  /** 注册表加载后 +1，逼读 NODE_TYPE_MAP 的组件重渲染 */
  registryVersion: number
  /** 后端节点服务的状态。null = 还没探 / 探不到，整站退回 mock */
  backend: api.Health | null
  /**
   * 刚加出来的节点。画布看到它就把视野挪过去（落在屏幕外或被配置面板压住时），
   * 然后清空。
   *
   * 走 store 而不是让加节点的组件自己调 setCenter：选择器加完就卸载了，
   * 而且它挂在 <ReactFlow> 外面，那儿拿到的视口 API 动不了画布。
   */
  revealId: string | null
  consumeReveal: () => string | null
  /** 中止当前运行用 */
  abort: AbortController | null

  onNodesChange: (c: NodeChange<FNode>[]) => void
  onEdgesChange: (c: EdgeChange[]) => void
  onConnect: (c: Connection) => void
  undo: () => void
  redo: () => void
  copyNodes: (id?: string) => number
  pasteNodes: (at?: { x: number; y: number }) => string[]
  /** 删除一组节点；入口节点自动排除，整组操作只生成一条历史记录。 */
  deleteNodes: (ids: string[]) => number
  /** 对齐或均匀分布一组节点。 */
  arrangeNodes: (
    ids: string[],
    action: 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom' | 'distribute-x' | 'distribute-y',
  ) => boolean

  addNode: (typeId: string, position: { x: number; y: number }) => string | null
  /** 从某个节点的出口继续加一个节点：自动落位 + 自动连线。 */
  addNodeAfter: (typeId: string, sourceId: string, port?: string) => string | null
  /** 在指定位置新增节点并从某个出口连入，新增和连线共用一次撤销记录。 */
  addNodeConnectedAt: (
    typeId: string,
    sourceId: string,
    port: string,
    position: { x: number; y: number },
  ) => string | null
  /** 往一条已有连线中间插一个节点：断开原线，串成 源 → 新 → 目标 */
  insertNodeOnEdge: (typeId: string, edgeId: string) => string | null
  duplicateNode: (id?: string) => string | null
  /** 按拓扑分层重排全部节点 */
  autoLayout: () => void
  select: (id: string | null) => void
  /** 关闭节点面板并清空 React Flow 的临时选择态。 */
  clearSelection: () => void
  /** 程序化定位到单个节点，同时同步 React Flow 的 selected 标记。 */
  focusNode: (id: string) => void
  toggleNodeSelection: (id: string) => void
  updateNodeParam: (id: string, key: string, value: unknown) => void
  renameNode: (id: string, label: string) => void
  setNodeOnError: (id: string, v: 'fail' | 'continue') => void
  deleteNode: (id: string) => void
  probeNode: (id: string) => Promise<void>
  /** 正在探测的节点 id */
  probing: string | null
  probeError: string | null

  setFlowName: (v: string) => void
  addFlowInput: () => void
  updateFlowInput: (i: number, patch: Partial<FlowInputField>) => void
  removeFlowInput: (i: number) => void

  pinNode: (id: string, data: unknown) => void
  unpinNode: (id: string) => void
  openNdv: (id: string | null) => void
  setRunPanelOpen: (open: boolean) => void
  setRunPanelHeight: (height: number) => void
  setActiveRun: (id: string | null) => void
  loadRegistry: () => Promise<void>
  startRun: (trigger: Record<string, unknown>) => Promise<void>
  stopRun: () => void
  testStep: (id: string) => Promise<void>

  toDefinition: () => FlowDefinition
  loadDefinition: (def: FlowDefinition) => void
  clear: () => void
}

const seedTrigger = (): FNode => ({
  id: 'n1',
  type: 'flowNode',
  position: { x: 60, y: 200 },
  data: {
    typeId: 'trigger.manual',
    typeVersion: '1.0.0',
    label: '手动触发',
    params: {},
    onError: 'fail',
  },
})

export const useFlow = create<FlowState>((set, get) => ({
  flowId: 'flow_draft',
  flowName: '未命名流程',
  // 不预置任何入参：新流程不该凭空多出两个用户没要过的字段，
  // 那两个还会以 $.trigger.vid / $.trigger.days 出现在变量表里，
  // 让人以为是平台内置的东西
  flowInputs: [],
  nodes: [seedTrigger()],
  edges: [],
  selectedId: null,
  seq: 1,
  historyPast: [],
  historyFuture: [],
  historyGroup: null,
  historyDragStart: null,
  clipboard: null,

  pinData: {},
  runs: [],
  activeRunId: null,
  running: false,
  ndvNodeId: null,
  runPanelOpen: false,
  runPanelHeight: initialRunPanelHeight(),
  dirtyNodes: {},
  runGen: 0,
  registryVersion: 0,
  backend: null,
  revealId: null,
  abort: null,
  probing: null,
  probeError: null,

  onNodesChange: (changes) => {
    const state = get()
    // 入口节点是流程唯一根节点，React Flow 的 Delete 快捷键也不能移除它。
    const safeChanges = changes.filter((change) => {
      if (change.type !== 'remove') return true
      const node = state.nodes.find((item) => item.id === change.id)
      return !node || !isEntryNode(node)
    })
    if (safeChanges.length === 0) return
    // 键盘 Delete 删除走的是这里而不是 deleteNode —— 同样要清理关联状态
    const removed = safeChanges.filter((c) => c.type === 'remove').map((c) => c.id)
    if (removed.length === 0) {
      const hasGeometry = changes.some((c) => c.type === 'position' || c.type === 'dimensions')
      const gestureActive = changes.some((c) =>
        (c.type === 'position' && c.dragging === true) || (c.type === 'dimensions' && c.resizing === true),
      )
      const gestureEnded = changes.some((c) =>
        (c.type === 'position' && c.dragging === false) || (c.type === 'dimensions' && c.resizing === false),
      )
      const dragStart = hasGeometry && gestureActive && !state.historyDragStart ? historySnapshot(state) : state.historyDragStart
      const commitDrag = hasGeometry && gestureEnded
      set({
        nodes: applyNodeChanges(safeChanges, state.nodes),
        ...(dragStart && commitDrag
          ? {
              historyPast: [...state.historyPast, dragStart].slice(-HISTORY_LIMIT),
              historyFuture: [],
              historyGroup: null,
              historyDragStart: null,
            }
          : dragStart !== state.historyDragStart
            ? { historyDragStart: dragStart, historyFuture: [], historyGroup: null }
            : {}),
      })
      return
    }
    const pinData = { ...state.pinData }
    const dirtyNodes = { ...state.dirtyNodes }
    for (const id of removed) {
      delete pinData[id]
      delete dirtyNodes[id]
    }
    set({
      ...historyCommit(state),
      nodes: applyNodeChanges(safeChanges, state.nodes),
      pinData,
      dirtyNodes,
      ndvNodeId: removed.includes(state.ndvNodeId ?? '') ? null : state.ndvNodeId,
      selectedId: removed.includes(state.selectedId ?? '') ? null : state.selectedId,
    })
  },
  onEdgesChange: (changes) => {
    const state = get()
    const changesGraph = changes.some((change) => change.type === 'remove' || change.type === 'add' || change.type === 'replace')
    set({
      ...(changesGraph ? historyCommit(state) : {}),
      edges: applyEdgeChanges(changes, state.edges),
    })
  },
  onConnect: (conn) => {
    const state = get()
    if (connectionProblem(conn, state.edges)) return
    set({
      ...historyCommit(state),
      edges: addEdge({ ...conn, type: 'flowEdge', animated: false }, state.edges),
    })
  },

  undo: () => {
    const state = get()
    if (state.running || state.historyPast.length === 0) return
    const previous = state.historyPast.at(-1)!
    set({
      ...previous,
      selectedId: null,
      ndvNodeId: null,
      revealId: null,
      historyPast: state.historyPast.slice(0, -1),
      historyFuture: [historySnapshot(state), ...state.historyFuture].slice(0, HISTORY_LIMIT),
      historyGroup: null,
      historyDragStart: null,
    })
  },

  redo: () => {
    const state = get()
    if (state.running || state.historyFuture.length === 0) return
    const next = state.historyFuture[0]
    set({
      ...next,
      selectedId: null,
      ndvNodeId: null,
      revealId: null,
      historyPast: [...state.historyPast, historySnapshot(state)].slice(-HISTORY_LIMIT),
      historyFuture: state.historyFuture.slice(1),
      historyGroup: null,
      historyDragStart: null,
    })
  },

  copyNodes: (id) => {
    const state = get()
    const selected = id
      ? state.nodes.filter((node) => node.id === id)
      : state.nodes.filter((node) => node.selected || node.id === state.selectedId)
    const nodes = selected.filter(isNodeCopyable)
    if (nodes.length === 0) return 0
    const ids = new Set(nodes.map((node) => node.id))
    set({
      clipboard: {
        nodes: nodes.map((node) => ({
          ...node,
          selected: false,
          data: { ...node.data, params: structuredClone(node.data.params) },
        })),
        edges: state.edges
          .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
          .map((edge) => ({ ...edge, selected: false })),
        pasteCount: 0,
      },
    })
    return nodes.length
  },

  pasteNodes: (at) => {
    const state = get()
    const clipboard = state.clipboard
    if (!clipboard?.nodes.length) return []

    const pasteNumber = clipboard.pasteCount + 1
    const minX = Math.min(...clipboard.nodes.map((node) => node.position.x))
    const maxX = Math.max(...clipboard.nodes.map((node) => node.position.x))
    const minY = Math.min(...clipboard.nodes.map((node) => node.position.y))
    const maxY = Math.max(...clipboard.nodes.map((node) => node.position.y))
    const offset = at
      ? { x: at.x - (minX + maxX) / 2 + 20 * (pasteNumber - 1), y: at.y - (minY + maxY) / 2 + 20 * (pasteNumber - 1) }
      : { x: 40 * pasteNumber, y: 40 * pasteNumber }
    const idMap = new Map<string, string>()
    clipboard.nodes.forEach((node, index) => idMap.set(node.id, `n${state.seq + index + 1}`))
    const reservedLabels = new Set(state.nodes.map((node) => node.data.label))
    const pastedNodes = clipboard.nodes.map((node) => ({
      ...node,
      id: idMap.get(node.id)!,
      position: { x: node.position.x + offset.x, y: node.position.y + offset.y },
      selected: true,
      data: {
        ...node.data,
        label: copiedLabel(node.data.label, reservedLabels),
        params: structuredClone(node.data.params),
      },
    }))
    const pastedEdges = clipboard.edges.map((edge, index) => ({
      ...edge,
      id: `e_paste_${state.seq + 1}_${index}`,
      source: idMap.get(edge.source)!,
      target: idMap.get(edge.target)!,
      selected: false,
    }))
    const pastedIds = pastedNodes.map((node) => node.id)

    set({
      ...historyCommit(state),
      nodes: [...state.nodes.map((node) => (node.selected ? { ...node, selected: false } : node)), ...pastedNodes],
      edges: [...state.edges.map((edge) => (edge.selected ? { ...edge, selected: false } : edge)), ...pastedEdges],
      seq: state.seq + pastedNodes.length,
      selectedId: pastedIds.length === 1 ? pastedIds[0] : null,
      revealId: pastedIds.at(-1) ?? null,
      clipboard: { ...clipboard, pasteCount: clipboard.pasteCount + 1 },
    })
    return pastedIds
  },

  deleteNodes: (ids) => {
    const state = get()
    const requested = new Set(ids)
    const removable = new Set(
      state.nodes
        .filter((node) => requested.has(node.id) && !isEntryNode(node))
        .map((node) => node.id),
    )
    if (removable.size === 0) return 0

    const pinData = { ...state.pinData }
    const dirtyNodes = { ...state.dirtyNodes }
    for (const id of removable) {
      delete pinData[id]
      delete dirtyNodes[id]
    }
    set({
      ...historyCommit(state),
      nodes: state.nodes.filter((node) => !removable.has(node.id)),
      edges: state.edges.filter((edge) => !removable.has(edge.source) && !removable.has(edge.target)),
      selectedId: state.selectedId && removable.has(state.selectedId) ? null : state.selectedId,
      ndvNodeId: state.ndvNodeId && removable.has(state.ndvNodeId) ? null : state.ndvNodeId,
      pinData,
      dirtyNodes,
    })
    return removable.size
  },

  arrangeNodes: (ids, action) => {
    const state = get()
    const wanted = new Set(ids)
    const selected = state.nodes.filter((node) => wanted.has(node.id))
    if (selected.length < 2) return false

    const widthOf = (node: FNode) => node.measured?.width ?? node.width ?? NODE_W
    const heightOf = (node: FNode) => node.measured?.height ?? node.height ?? NODE_H
    const minX = Math.min(...selected.map((node) => node.position.x))
    const maxX = Math.max(...selected.map((node) => node.position.x + widthOf(node)))
    const minY = Math.min(...selected.map((node) => node.position.y))
    const maxY = Math.max(...selected.map((node) => node.position.y + heightOf(node)))
    const positions = new Map(selected.map((node) => [node.id, { ...node.position }]))

    if (action === 'distribute-x' || action === 'distribute-y') {
      if (selected.length < 3) return false
      const horizontal = action === 'distribute-x'
      const ordered = [...selected].sort((a, b) =>
        horizontal ? a.position.x - b.position.x : a.position.y - b.position.y,
      )
      const total = horizontal ? maxX - minX : maxY - minY
      const occupied = ordered.reduce(
        (sum, node) => sum + (horizontal ? widthOf(node) : heightOf(node)),
        0,
      )
      const gap = (total - occupied) / (ordered.length - 1)
      if (gap <= 0) return false
      let cursor = horizontal ? minX : minY
      for (const node of ordered) {
        const position = positions.get(node.id)!
        if (horizontal) {
          position.x = cursor
          cursor += widthOf(node) + gap
        } else {
          position.y = cursor
          cursor += heightOf(node) + gap
        }
      }
    } else {
      for (const node of selected) {
        const position = positions.get(node.id)!
        if (action === 'left') position.x = minX
        else if (action === 'center-x') position.x = minX + (maxX - minX - widthOf(node)) / 2
        else if (action === 'right') position.x = maxX - widthOf(node)
        else if (action === 'top') position.y = minY
        else if (action === 'center-y') position.y = minY + (maxY - minY - heightOf(node)) / 2
        else if (action === 'bottom') position.y = maxY - heightOf(node)
      }
    }

    const changed = selected.some((node) => {
      const next = positions.get(node.id)!
      return Math.abs(next.x - node.position.x) > 0.01 || Math.abs(next.y - node.position.y) > 0.01
    })
    if (!changed) return false

    set({
      ...historyCommit(state),
      nodes: state.nodes.map((node) => positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node),
    })
    return true
  },

  addNode: (typeId, position) => {
    const state = get()
    const type = NODE_TYPE_MAP.get(typeId)
    if (type?.hasInput === false) {
      const current = state.nodes.find(isEntryNode)
      if (current) {
        set({
          ...historyCommit(state),
          nodes: state.nodes.map((node) =>
            node.id === current.id
              ? {
                  ...node,
                  selected: true,
                  data: {
                    typeId: type.type,
                    typeVersion: type.typeVersion,
                    label: type.name,
                    params: defaultParams(type),
                    onError: 'fail',
                  },
                }
              : node.selected ? { ...node, selected: false } : node,
          ),
          selectedId: current.id,
          revealId: current.id,
        })
        return current.id
      }
    }
    const node = makeNode(typeId, position, get().seq + 1)
    if (!node) return null
    set({
      ...historyCommit(get()),
      nodes: [...get().nodes.map((item) => item.selected ? { ...item, selected: false } : item), node],
      seq: get().seq + 1,
      selectedId: node.id,
      revealId: node.id,
    })
    return node.id
  },

  addNodeAfter: (typeId, sourceId, port = 'out') => {
    const source = get().nodes.find((n) => n.id === sourceId)
    if (!source) return null
    const node = makeNode(typeId, freeSpotRightOf(get().nodes, source), get().seq + 1)
    if (!node) return null
    set({
      ...historyCommit(get()),
      nodes: [...get().nodes.map((item) => item.selected ? { ...item, selected: false } : item), node],
      seq: get().seq + 1,
      selectedId: node.id,
      revealId: node.id,
      edges: addEdge(
        { source: sourceId, sourceHandle: port, target: node.id, targetHandle: null, type: 'flowEdge' },
        get().edges,
      ),
    })
    return node.id
  },

  addNodeConnectedAt: (typeId, sourceId, port, position) => {
    const state = get()
    if (!state.nodes.some((node) => node.id === sourceId)) return null
    const node = makeNode(typeId, position, state.seq + 1)
    if (!node) return null

    set({
      ...historyCommit(state),
      nodes: [...state.nodes.map((item) => item.selected ? { ...item, selected: false } : item), node],
      edges: addEdge(
        { source: sourceId, sourceHandle: port, target: node.id, targetHandle: null, type: 'flowEdge' },
        state.edges,
      ),
      seq: state.seq + 1,
      selectedId: node.id,
      revealId: node.id,
    })
    return node.id
  },

  insertNodeOnEdge: (typeId, edgeId) => {
    const edge = get().edges.find((e) => e.id === edgeId)
    if (!edge) return null
    const source = get().nodes.find((n) => n.id === edge.source)
    const target = get().nodes.find((n) => n.id === edge.target)
    if (!source || !target) return null

    const node = makeNode(typeId, freeSpotRightOf(get().nodes, source), get().seq + 1)
    if (!node) return null

    // 目标（连同它的全部下游）整体右移，给插进来的节点腾出一档位置。
    // 不移的话新节点会直接压在目标身上 —— 插入是常用操作，不能每次都要手动收拾
    const shift = NODE_W + 96
    const gap = target.position.x - source.position.x
    const moving = gap < shift * 2 ? descendants(target.id, get().edges) : new Set<string>()

    set({
      ...historyCommit(get()),
      seq: get().seq + 1,
      selectedId: node.id,
      revealId: node.id,
      nodes: [
        ...get().nodes.map((n) =>
          moving.has(n.id)
            ? { ...n, selected: false, position: { x: n.position.x + shift, y: n.position.y } }
            : n.selected ? { ...n, selected: false } : n,
        ),
        node,
      ],
      edges: [
        ...get().edges.filter((e) => e.id !== edgeId),
        { id: `e_${node.id}_in`, source: edge.source, sourceHandle: edge.sourceHandle, target: node.id, type: 'flowEdge' },
        { id: `e_${node.id}_out`, source: node.id, sourceHandle: 'out', target: edge.target, type: 'flowEdge' },
      ],
    })
    return node.id
  },

  duplicateNode: (id) => {
    if (get().copyNodes(id) === 0) return null
    return get().pasteNodes()[0] ?? null
  },

  autoLayout: () => {
    const runnable = get().nodes.filter((node) => !NODE_TYPE_MAP.get(node.data.typeId)?.visualOnly)
    const pos = layeredLayout(runnable, get().edges)
    set({ ...historyCommit(get()), nodes: get().nodes.map((n) => (pos[n.id] ? { ...n, position: pos[n.id] } : n)) })
  },

  consumeReveal: () => {
    const id = get().revealId
    if (id) set({ revealId: null })
    return id
  },

  select: (id) => set({ selectedId: id }),
  clearSelection: () => {
    const state = get()
    set({
      selectedId: null,
      nodes: state.nodes.map((node) => (node.selected ? { ...node, selected: false } : node)),
      edges: state.edges.map((edge) => (edge.selected ? { ...edge, selected: false } : edge)),
    })
  },
  focusNode: (id) =>
    set({
      selectedId: id,
      nodes: get().nodes.map((node) => ({ ...node, selected: node.id === id })),
      edges: get().edges.map((edge) => (edge.selected ? { ...edge, selected: false } : edge)),
    }),

  toggleNodeSelection: (id) => {
    const nodes = get().nodes.map((node) =>
      node.id === id ? { ...node, selected: !node.selected } : node,
    )
    const selected = nodes.filter((node) => node.selected)
    set({ nodes, selectedId: selected.length === 1 ? selected[0].id : null })
  },

  updateNodeParam: (id, key, value) => {
    // 该节点有运行结果时，改参数 → 标 dirty（输出已过期，重跑前给黄色提示）
    const hasRunData = get().runs.some((r) => (r.steps[id]?.length ?? 0) > 0)
    const node = get().nodes.find((n) => n.id === id)
    const t = node && NODE_TYPE_MAP.get(node.data.typeId)
    const ph = t?.input.properties?.[key]?.['x-placeholders']

    set({
      ...historyCommit(get(), `param:${id}:${key}`),
      nodes: get().nodes.map((n) => {
        if (n.id !== id) return n
        const params: Record<string, unknown> = { ...n.data.params, [key]: value }
        // 改了带占位符的字段（SQL）→ 把取值字段里已经没对应占位符的键清掉，
        // 否则定义里会攒下陈旧参数，后端判"多余参数"直接失败
        if (ph && typeof value === 'string') {
          const alive = new Set(extractSqlPlaceholders(value).map((p) => p.name))
          const bag = params[ph.valuesFrom]
          if (bag && typeof bag === 'object') {
            params[ph.valuesFrom] = Object.fromEntries(
              Object.entries(bag as Record<string, unknown>).filter(([k]) => alive.has(k)),
            )
          }
        }
        return { ...n, data: { ...n.data, params } }
      }),
      ...(hasRunData ? { dirtyNodes: { ...get().dirtyNodes, [id]: true as const } } : {}),
    })
  },

  renameNode: (id, label) =>
    set({
      ...historyCommit(get(), `node-name:${id}`),
      nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, label } } : n)),
    }),

  setNodeOnError: (id, onError) =>
    set({
      ...historyCommit(get()),
      nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, onError } } : n)),
    }),

  deleteNode: (id) => {
    get().deleteNodes([id])
  },

  /**
   * 试运行探测：输出结构运行时才知道的节点（SQL 列名、ES 字段），
   * 探测一次把真实结构缓存到节点实例，供下游变量提示使用。
   * 后端在线时真跑一行拿 schema，不在线就造几个假列让编辑器能演示。
   */
  probeNode: async (id) => {
    const node = get().nodes.find((n) => n.id === id)
    if (!node) return
    const t = NODE_TYPE_MAP.get(node.data.typeId)
    if (t?.output['x-dynamic'] !== 'probe') return

    const write = (probed: Record<string, JsonSchema>) =>
      set({ nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, probedOutput: probed } } : n)) })

    if (api.isOnline() && t.runtime?.probe) {
      set({ probing: id, probeError: null })
      try {
        const { handle } = await api.probeNodeRemote(t.type, node.data.params)
        // 探测也是异步任务，轮到完成为止 —— 判完成看 done，不看进度
        for (;;) {
          await new Promise((r) => setTimeout(r, t.runtime?.pollIntervalMs ?? 3000))
          const result = await api.pollNode(t.type, handle, 1)
          if (!result.done) continue
          if (result.failed) throw new Error(result.error || '探测失败')
          const columns = (result.output?.columns ?? []) as Array<{ name: string; type?: string }>
          write(toProbedFields({ container: 'rows', columns }))
          break
        }
      } catch (err) {
        set({ probeError: err instanceof Error ? err.message : String(err) })
      } finally {
        set({ probing: null })
      }
      return
    }

    write(
      toProbedFields({
        container: 'rows',
        columns: [{ name: 'vid' }, { name: 'name' }, { name: 'created_at' }],
      }),
    )
  },

  /** 探活 + 拉注册表 + 预取动态选项。后端不在就静默留在 mock 模式。 */
  loadRegistry: async () => {
    const backend = await api.health()
    if (!backend) return
    try {
      const nodes = await api.fetchNodes()
      applyBackendNodes(nodes)
      // 把节点 manifest 里声明的 optionsFrom 全预取一遍，表单打开就有真实候选项
      const keys = new Set<string>()
      for (const t of nodes) {
        for (const p of Object.values(t.input?.properties ?? {})) {
          const key = p['x-ui']?.optionsFrom
          if (key) keys.add(key)
        }
      }
      await Promise.all(
        [...keys].map(async (key) => {
          try {
            setOptions(key, await api.fetchOptions(key))
          } catch {
            /* 单个选项集拉不到不该拖垮整个加载，退回 mock 候选项 */
          }
        }),
      )
      set({ backend, registryVersion: get().registryVersion + 1 })
    } catch {
      set({ backend })
    }
  },

  pinNode: (id, data) => {
    // n8n canPinNode：恰好一个出口的节点才能 pin —— 数据边界上也挡一道，不只靠 UI
    const node = get().nodes.find((n) => n.id === id)
    const t = node && NODE_TYPE_MAP.get(node.data.typeId)
    if (!t || portsOf(t).length !== 1) return
    set({ ...historyCommit(get()), pinData: { ...get().pinData, [id]: data } })
  },

  unpinNode: (id) => {
    if (!Object.prototype.hasOwnProperty.call(get().pinData, id)) return
    const { [id]: _removed, ...rest } = get().pinData
    set({ ...historyCommit(get()), pinData: rest })
  },

  openNdv: (ndvNodeId) => set({ ndvNodeId }),
  setRunPanelOpen: (runPanelOpen) => set({ runPanelOpen }),
  setRunPanelHeight: (runPanelHeight) => set({ runPanelHeight: Math.min(560, Math.max(180, runPanelHeight)) }),
  setActiveRun: (activeRunId) => set({ activeRunId }),

  startRun: async (trigger) => {
    if (get().running) return
    if (graphProblems(get().nodes, get().edges).length > 0) {
      set({ runPanelOpen: true })
      return
    }
    const gen = get().runGen
    const abort = new AbortController()
    set({ running: true, runPanelOpen: true, abort })
    const upsertRun = (run: FlowRun) => {
      if (get().runGen !== gen) return // clear/load 之后的旧回调作废
      const runs = get().runs
      const idx = runs.findIndex((r) => r.id === run.id)
      set({
        runs: idx >= 0 ? runs.map((r, i) => (i === idx ? run : r)) : [run, ...runs].slice(0, 20),
        activeRunId: run.id,
      })
    }
    try {
      await executeFlow({
        nodes: get().nodes,
        edges: get().edges,
        trigger,
        pinData: get().pinData,
        mode: 'manual',
        signal: abort.signal,
        flowInputs: get().flowInputs,
        // dirty 按节点在真正重跑到它时清除，而不是运行一开始全清
        onStep: (step) => {
          if (get().runGen !== gen) return
          if (step.status !== 'success' && step.status !== 'error') return
          const learned = withLearnedOutput(get().nodes, step)
          if (learned) set({ nodes: learned })
          if (!get().dirtyNodes[step.nodeId]) return
          const { [step.nodeId]: _cleared, ...rest } = get().dirtyNodes
          set({ dirtyNodes: rest })
        },
        onRunUpdate: upsertRun,
      })
    } catch (err) {
      // 引擎理论上把每种失败都记成步骤错误了，但兜底必须有：漏出来一个异常
      // 就会让运行记录永远停在 running（僵尸），而 running 被 finally 清掉，
      // 界面看着一切正常。宁可把整条运行标红。
      if (get().runGen === gen) {
        const active = get().runs.find((r) => r.id === get().activeRunId)
        if (active && active.status === 'running') {
          const message = err instanceof Error ? err.message : String(err)
          upsertRun({ ...active, status: 'error', finishedAt: Date.now(), error: message })
        }
      }
    } finally {
      if (get().runGen === gen) set({ running: false, abort: null })
    }
  },

  /** 中止运行。引擎会把在跑的平台任务 cancel 掉，不留后台任务空烧资源。 */
  stopRun: () => {
    get().abort?.abort()
  },

  /** 单节点试运行：上游用最近一次运行输出 + pinned 覆盖，只跑这一个节点 */
  testStep: async (id) => {
    const node = get().nodes.find((n) => n.id === id)
    if (!node || get().running) return
    const baseRun = get().runs.find((r) => r.id === get().activeRunId) ?? get().runs[0] ?? null
    const gen = get().runGen
    const abort = new AbortController()
    const { [id]: _dirty, ...restDirty } = get().dirtyNodes
    set({ running: true, dirtyNodes: restDirty, abort })
    const mergeStep = (step: StepRun) => {
      if (get().runGen !== gen) return
      step = { ...step, input: redactNodeInput(node.data.typeId, step.input) }
      const learned = withLearnedOutput(get().nodes, step)
      if (learned) set({ nodes: learned })
      const runs = get().runs
      // 没有任何运行时，造一个只含这一步的运行记录
      if (!baseRun) {
        const solo: FlowRun = {
          id: 'run_teststep',
          status: step.status === 'running' ? 'running' : step.status === 'error' ? 'error' : 'success',
          startedAt: step.startedAt,
          ...(step.status !== 'running' ? { finishedAt: Date.now() } : {}),
          trigger: {},
          steps: { [id]: [step] },
        }
        const idx = runs.findIndex((r) => r.id === solo.id)
        set({ runs: idx >= 0 ? runs.map((r, i) => (i === idx ? solo : r)) : [solo, ...runs], activeRunId: solo.id })
        return
      }
      // 合并进已有运行后按全部末步重算状态，试运行出错不能让运行还显示绿色
      const mergedSteps = { ...baseRun.steps, [id]: [step] }
      const status: FlowRun['status'] =
        step.status === 'running'
          ? baseRun.status
          : Object.values(mergedSteps).some((s) => s.at(-1)?.status === 'error')
            ? 'error'
            : 'success'
      const updated: FlowRun = { ...baseRun, steps: mergedSteps, status }
      set({ runs: runs.map((r) => (r.id === baseRun.id ? updated : r)), activeRunId: baseRun.id })
    }
    try {
      await executeSingleNode({
        node,
        nodes: get().nodes,
        edges: get().edges,
        flowInputs: get().flowInputs,
        trigger: baseRun?.trigger ?? {},
        pinData: get().pinData,
        baseRun,
        onStep: mergeStep,
        signal: abort.signal,
      })
    } finally {
      if (get().runGen === gen) set({ running: false, abort: null })
    }
  },

  setFlowName: (flowName) => set({ ...historyCommit(get(), 'flow-name'), flowName }),

  addFlowInput: () =>
    set({
      ...historyCommit(get()),
      flowInputs: [...get().flowInputs, { key: `field${get().flowInputs.length + 1}`, title: '', type: 'string', required: false }],
    }),

  updateFlowInput: (i, patch) =>
    set({
      ...historyCommit(get(), `flow-input:${i}:${Object.keys(patch).join(',')}`),
      flowInputs: get().flowInputs.map((f, idx) => (idx === i ? { ...f, ...patch } : f)),
    }),

  removeFlowInput: (i) => set({ ...historyCommit(get()), flowInputs: get().flowInputs.filter((_, idx) => idx !== i) }),

  toDefinition: () => {
    const { flowId, flowName, flowInputs, nodes, edges, pinData } = get()
    // 隐藏参数不进导出（n8n 在编辑器与加载时 strip 隐藏参数；我们在导出边界做）
    const exportParams = (n: FNode): Record<string, unknown> => {
      const t = NODE_TYPE_MAP.get(n.data.typeId)
      if (!t) return n.data.params
      return Object.fromEntries(
        Object.entries(n.data.params).filter(([k]) => isFieldVisible(k, t.input, n.data.params)),
      )
    }
    const properties: Record<string, JsonSchema> = {}
    const required: string[] = []
    for (const f of flowInputs) {
      properties[f.key] = { type: f.type, title: f.title || f.key }
      if (f.required) required.push(f.key)
    }
    return {
      id: flowId,
      version: 1,
      name: flowName,
      inputs: { type: 'object', properties, ...(required.length ? { required } : {}) },
      // 从画布上真实的触发器节点推导，别写死 manual —— 否则配了定时的流程
      // 导出后是一份"手动触发"的定义，调度器永远排不上它
      trigger: (() => {
        const s = nodes.find((n) => n.data.typeId === 'trigger.schedule')
        // 走 exportParams 过一道 x-show：选了 cron 就别把 at/minute 的默认值
        // 也带出去，调度器读到一堆互相矛盾的字段只会犯迷糊
        return s ? { kind: 'schedule' as const, ...exportParams(s) } : { kind: 'manual' as const }
      })(),
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.data.typeId,
        typeVersion: n.data.typeVersion,
        name: n.data.label,
        params: exportParams(n),
        onError: n.data.onError,
        ...(n.data.probedOutput && Object.keys(n.data.probedOutput).length ? { probedOutput: n.data.probedOutput } : {}),
      })),
      edges: edges.map((e) => ({
        from: e.source,
        to: e.target,
        ...(e.sourceHandle && e.sourceHandle !== 'out' ? { port: e.sourceHandle } : {}),
      })),
      // 布局单独一块，和逻辑完全解耦 —— 这样流程能 diff、能 code review
      layout: Object.fromEntries(nodes.map((n) => {
        const type = NODE_TYPE_MAP.get(n.data.typeId)
        const base = { x: Math.round(n.position.x), y: Math.round(n.position.y) }
        if (!type?.visualOnly) return [n.id, base]
        return [n.id, {
          ...base,
          width: Math.round(n.measured?.width ?? n.width ?? (Number(n.style?.width) || 280)),
          height: Math.round(n.measured?.height ?? n.height ?? (Number(n.style?.height) || 160)),
        }]
      })),
      // pinned 数据随流程持久化（n8n 同款做法），生产触发时引擎忽略
      ...(Object.keys(pinData).length ? { pinData } : {}),
    }
  },

  loadDefinition: (def) => {
    get().abort?.abort()
    const nodes: FNode[] = def.nodes.map((n) => {
      const layout = def.layout[n.id] ?? { x: 0, y: 0 }
      const visualOnly = NODE_TYPE_MAP.get(n.type)?.visualOnly
      return {
        id: n.id,
        type: 'flowNode',
        position: { x: layout.x, y: layout.y },
        ...(visualOnly ? { style: { width: layout.width ?? 280, height: layout.height ?? 160 } } : {}),
        data: {
          typeId: n.type,
          typeVersion: n.typeVersion,
          label: n.name,
          params: n.params ?? {},
          onError: n.onError ?? 'fail',
          ...(n.probedOutput ? { probedOutput: n.probedOutput } : {}),
        },
      }
    })
    const edges: Edge[] = def.edges.map((e, i) => ({
      id: `e${i}`,
      source: e.from,
      target: e.to,
      sourceHandle: e.port ?? 'out',
      type: 'flowEdge',
    }))
    const maxSeq = nodes.reduce((m, n) => Math.max(m, Number(n.id.replace(/\D/g, '')) || 0), 0)
    set({
      flowId: def.id,
      flowName: def.name,
      flowInputs: Object.entries(def.inputs?.properties ?? {}).map(([key, s]) => ({
        key,
        title: s.title ?? key,
        type: (s.type as FlowInputField['type']) ?? 'string',
        required: (def.inputs?.required ?? []).includes(key),
      })),
      nodes,
      edges,
      seq: maxSeq,
      selectedId: null,
      // 导入的 pin 也要过 canPinNode 规则（If/foreach/终点节点上的 pin 直接丢弃）
      pinData: Object.fromEntries(
        Object.entries(def.pinData ?? {}).filter(([id]) => {
          const n = def.nodes.find((x) => x.id === id)
          const t = n && NODE_TYPE_MAP.get(n.type)
          return !!t && portsOf(t).length === 1
        }),
      ),
      runs: [],
      activeRunId: null,
      ndvNodeId: null,
      runPanelOpen: false,
      dirtyNodes: {},
      running: false,
      abort: null,
      revealId: null,
      probing: null,
      probeError: null,
      runGen: get().runGen + 1,
      historyPast: [],
      historyFuture: [],
      historyGroup: null,
      historyDragStart: null,
    })
  },

  clear: () => {
    get().abort?.abort()
    set({
      nodes: [seedTrigger()],
      edges: [],
      // 入参也是流程的一部分。不清的话，载入过别的流程再点清空，
      // 画布空了但上一个流程的入参还留在右边
      flowInputs: [],
      selectedId: null,
      seq: 1,
      pinData: {},
      runs: [],
      activeRunId: null,
      ndvNodeId: null,
      runPanelOpen: false,
      dirtyNodes: {},
      running: false,
      abort: null,
      revealId: null,
      probing: null,
      probeError: null,
      runGen: get().runGen + 1,
      historyPast: [],
      historyFuture: [],
      historyGroup: null,
      historyDragStart: null,
    })
  },
}))
