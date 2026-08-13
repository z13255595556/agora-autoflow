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
import { learnColumns, toProbedFields } from './lib/output'
import { extractSqlPlaceholders } from './lib/placeholders'
import * as api from './lib/client'

export type FNode = Node<FlowNodeData>

function defaultParams(t: NodeType): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, schema] of Object.entries(t.input.properties ?? {})) {
    if (schema.default !== undefined) out[key] = schema.default
  }
  return out
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
function withLearnedColumns(nodes: FNode[], step: StepRun): FNode[] | null {
  if (step.status !== 'success') return null
  const node = nodes.find((n) => n.id === step.nodeId)
  if (!node) return null
  const learned = learnColumns(step.output)
  if (!learned) return null
  const fields = toProbedFields(learned)
  const prev = node.data.probedOutput ?? {}
  const unchanged =
    Object.keys(fields).length === Object.keys(prev).length && Object.keys(fields).every((k) => k in prev)
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
  /** 参数改过但还没重跑的节点（n8n dirty/PARAMETERS_UPDATED：输出可能已过期） */
  dirtyNodes: Record<string, true>
  /** 运行代际：clear/load 时 +1，让还在跑的旧引擎回调作废 */
  runGen: number
  /** 注册表加载后 +1，逼读 NODE_TYPE_MAP 的组件重渲染 */
  registryVersion: number
  /** 后端节点服务的状态。null = 还没探 / 探不到，整站退回 mock */
  backend: api.Health | null
  /** 中止当前运行用 */
  abort: AbortController | null

  onNodesChange: (c: NodeChange<FNode>[]) => void
  onEdgesChange: (c: EdgeChange[]) => void
  onConnect: (c: Connection) => void

  addNode: (typeId: string, position: { x: number; y: number }) => void
  select: (id: string | null) => void
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
  position: { x: 40, y: 200 },
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

  pinData: {},
  runs: [],
  activeRunId: null,
  running: false,
  ndvNodeId: null,
  runPanelOpen: false,
  dirtyNodes: {},
  runGen: 0,
  registryVersion: 0,
  backend: null,
  abort: null,
  probing: null,
  probeError: null,

  onNodesChange: (changes) => {
    // 键盘 Delete 删除走的是这里而不是 deleteNode —— 同样要清理关联状态
    const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id)
    if (removed.length === 0) {
      set({ nodes: applyNodeChanges(changes, get().nodes) })
      return
    }
    const pinData = { ...get().pinData }
    const dirtyNodes = { ...get().dirtyNodes }
    for (const id of removed) {
      delete pinData[id]
      delete dirtyNodes[id]
    }
    set({
      nodes: applyNodeChanges(changes, get().nodes),
      pinData,
      dirtyNodes,
      ndvNodeId: removed.includes(get().ndvNodeId ?? '') ? null : get().ndvNodeId,
      selectedId: removed.includes(get().selectedId ?? '') ? null : get().selectedId,
    })
  },
  onEdgesChange: (changes) => set({ edges: applyEdgeChanges(changes, get().edges) }),
  onConnect: (conn) =>
    set({ edges: addEdge({ ...conn, type: 'smoothstep', animated: false }, get().edges) }),

  addNode: (typeId, position) => {
    const t = NODE_TYPE_MAP.get(typeId)
    if (!t) return
    const seq = get().seq + 1
    const node: FNode = {
      id: `n${seq}`,
      type: 'flowNode',
      position,
      data: {
        typeId: t.type,
        typeVersion: t.typeVersion,
        label: t.name,
        params: defaultParams(t),
        onError: 'fail',
      },
    }
    set({ nodes: [...get().nodes, node], seq, selectedId: node.id })
  },

  select: (id) => set({ selectedId: id }),

  updateNodeParam: (id, key, value) => {
    // 该节点有运行结果时，改参数 → 标 dirty（输出已过期，重跑前给黄色提示）
    const hasRunData = get().runs.some((r) => (r.steps[id]?.length ?? 0) > 0)
    const node = get().nodes.find((n) => n.id === id)
    const t = node && NODE_TYPE_MAP.get(node.data.typeId)
    const ph = t?.input.properties?.[key]?.['x-placeholders']

    set({
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
    set({ nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, label } } : n)) }),

  setNodeOnError: (id, onError) =>
    set({ nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, onError } } : n)) }),

  deleteNode: (id) => {
    const { [id]: _removed, ...restPin } = get().pinData
    set({
      nodes: get().nodes.filter((n) => n.id !== id),
      edges: get().edges.filter((e) => e.source !== id && e.target !== id),
      selectedId: get().selectedId === id ? null : get().selectedId,
      ndvNodeId: get().ndvNodeId === id ? null : get().ndvNodeId,
      pinData: restPin,
    })
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
    set({ pinData: { ...get().pinData, [id]: data } })
  },

  unpinNode: (id) => {
    const { [id]: _removed, ...rest } = get().pinData
    set({ pinData: rest })
  },

  openNdv: (ndvNodeId) => set({ ndvNodeId }),
  setRunPanelOpen: (runPanelOpen) => set({ runPanelOpen }),
  setActiveRun: (activeRunId) => set({ activeRunId }),

  startRun: async (trigger) => {
    if (get().running) return
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
          const learned = withLearnedColumns(get().nodes, step)
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
    const { [id]: _dirty, ...restDirty } = get().dirtyNodes
    set({ running: true, dirtyNodes: restDirty })
    const mergeStep = (step: StepRun) => {
      if (get().runGen !== gen) return
      const learned = withLearnedColumns(get().nodes, step)
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
      })
    } finally {
      if (get().runGen === gen) set({ running: false })
    }
  },

  setFlowName: (flowName) => set({ flowName }),

  addFlowInput: () =>
    set({
      flowInputs: [...get().flowInputs, { key: `field${get().flowInputs.length + 1}`, title: '', type: 'string', required: false }],
    }),

  updateFlowInput: (i, patch) =>
    set({ flowInputs: get().flowInputs.map((f, idx) => (idx === i ? { ...f, ...patch } : f)) }),

  removeFlowInput: (i) => set({ flowInputs: get().flowInputs.filter((_, idx) => idx !== i) }),

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
      })),
      edges: edges.map((e) => ({
        from: e.source,
        to: e.target,
        ...(e.sourceHandle && e.sourceHandle !== 'out' ? { port: e.sourceHandle } : {}),
      })),
      // 布局单独一块，和逻辑完全解耦 —— 这样流程能 diff、能 code review
      layout: Object.fromEntries(nodes.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }])),
      // pinned 数据随流程持久化（n8n 同款做法），生产触发时引擎忽略
      ...(Object.keys(pinData).length ? { pinData } : {}),
    }
  },

  loadDefinition: (def) => {
    const nodes: FNode[] = def.nodes.map((n) => ({
      id: n.id,
      type: 'flowNode',
      position: def.layout[n.id] ?? { x: 0, y: 0 },
      data: {
        typeId: n.type,
        typeVersion: n.typeVersion,
        label: n.name,
        params: n.params ?? {},
        onError: n.onError ?? 'fail',
      },
    }))
    const edges: Edge[] = def.edges.map((e, i) => ({
      id: `e${i}`,
      source: e.from,
      target: e.to,
      sourceHandle: e.port ?? 'out',
      type: 'smoothstep',
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
      dirtyNodes: {},
      running: false,
      runGen: get().runGen + 1,
    })
  },

  clear: () =>
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
      dirtyNodes: {},
      running: false,
      runGen: get().runGen + 1,
    }),
}))
