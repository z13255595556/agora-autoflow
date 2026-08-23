import type { Edge } from '@xyflow/react'
import type { FlowDefinition, FlowInputField, FlowInputKind, JsonSchema } from '../types.ts'
import type { FNode } from '../store.ts'

/**
 * 流程定义 ↔ 图的相互转换。**端口缺省值只有这一个出处。**
 *
 * 为什么单独一个文件：`边走的是哪个口` 这条规则原先散在三处 ——
 * store.toDefinition（导出时写 port）、engine.executeFlow（执行时读 sourceHandle）、
 * scripts/check-flows.ts（校验时又拼一次）。改一处漏两处的后果不是报错，
 * 是 flow.if 的分支灭活方向**静默翻转**：
 *
 * 导出时只在 `sourceHandle` 存在且 !== 'out' 时才写 port，所以一条从 flow.if
 * 拉出但没带 handle 的边，在定义里 port 是 undefined。今天引擎按
 * `(e.sourceHandle ?? 'out') === port` 比，它既不匹配 'true' 也不匹配 'false'
 * → 两侧都不灭活、下游全跑。若有人改成 `edge.port === exitPort` 直接比，
 * undefined 两边都不等 → 该边被判死 → 下游全被 skip。
 * **同一份定义，行为从「全跑」翻成「全不跑」，完全静默。**
 */

/** 定义里的边（逻辑形状）和画布上的边（xyflow 形状）都能认 */
export interface AnyEdge {
  port?: string
  sourceHandle?: string | null
}

/**
 * 这条边从源节点的哪个口出去。
 *
 * 顺序不能换：`port` 是定义里的权威字段，`sourceHandle` 是画布上的，
 * 两者都缺才回落到单口节点的 'out'。
 */
export function portOf(edge: AnyEdge): string {
  return edge.port ?? edge.sourceHandle ?? 'out'
}

/**
 * 流程定义 → 引擎与校验层认的图。
 *
 * 和 store.loadDefinition 必须产出同一个形状 —— 否则 `npm run check:flows`
 * 查出来的问题和编辑器里显示的问题会对不上，而那种不一致最难排查：
 * 两边单独看都是对的。
 */
/**
 * 定义里的一个节点 → 画布 / 引擎用的 data。
 *
 * **定义 → data 只有这一个出处。** 以前 store.loadDefinition 和这里各写一份字段清单，
 * 加「暂停」时前端那份加了、这份没加 —— 表现是编辑器里暂停了、worker 照跑，
 * 而且 DB 端到端测试跑出来之前谁也不知道
 */
export function nodeDataOf(n: FlowDefinition['nodes'][number]): FNode['data'] {
  return {
    typeId: n.type,
    typeVersion: n.typeVersion,
    label: n.name,
    params: n.params ?? {},
    onError: n.onError ?? 'fail',
    ...(n.probedOutput ? { probedOutput: n.probedOutput } : {}),
    ...(n.note ? { note: n.note } : {}),
    ...(n.disabled ? { disabled: true } : {}),
    ...(n.retry !== undefined ? { retry: n.retry } : {}),
  }
}

/**
 * 入参的种类 ↔ JSON Schema。**两个方向只在这一处。**
 *
 * date / select 不是 JSON Schema 类型，落盘时变成 string + format / string + enum；
 * 读回来再认出种类。store.loadDefinition / toDefinition 和 worker 的 toGraph 都走这里 ——
 * 各写一份的后果是"表单显示日期、引擎当字符串"，而且只在某一条路径上坏
 */
export function inputFieldOf(key: string, s: JsonSchema, required: boolean): FlowInputField {
  const type: FlowInputKind = s.enum
    ? 'select'
    : s.format === 'date'
      ? 'date'
      : s.type === 'integer' || s.type === 'number' || s.type === 'boolean'
        ? s.type
        : 'string'
  return {
    key,
    title: s.title ?? key,
    type,
    required,
    ...(s.default !== undefined && s.default !== null ? { default: String(s.default) } : {}),
    ...(s.description ? { description: s.description } : {}),
    ...(s.enum ? { options: s.enum } : {}),
  }
}

export function inputSchemaOf(f: FlowInputField): JsonSchema {
  const type = f.type === 'date' || f.type === 'select' ? 'string' : f.type
  const raw = f.default?.trim()
  const def = raw === undefined || raw === ''
    ? undefined
    : type === 'integer' || type === 'number'
      ? (Number.isFinite(Number(raw)) ? Number(raw) : undefined)
      : type === 'boolean'
        ? raw === 'true'
        : raw
  return {
    type,
    title: f.title || f.key,
    ...(f.type === 'date' ? { format: 'date' } : {}),
    ...(f.type === 'select' ? { enum: (f.options ?? []).filter(Boolean) } : {}),
    ...(def !== undefined ? { default: def } : {}),
    ...(f.description?.trim() ? { description: f.description.trim() } : {}),
  }
}

export function toGraph(def: FlowDefinition): {
  nodes: FNode[]
  edges: Edge[]
  inputs: FlowInputField[]
} {
  const nodes = def.nodes.map((n) => ({
    id: n.id,
    type: 'flowNode',
    position: def.layout?.[n.id] ?? { x: 0, y: 0 },
    data: nodeDataOf(n),
  })) as FNode[]

  const edges = def.edges.map((e, i) => ({
    id: `e${i}`,
    source: e.from,
    target: e.to,
    sourceHandle: portOf(e),
  })) as Edge[]

  const required = def.inputs?.required ?? []
  const inputs: FlowInputField[] = Object.entries(def.inputs?.properties ?? {}).map(([key, s]) =>
    inputFieldOf(key, s, required.includes(key)))

  return { nodes, edges, inputs }
}
