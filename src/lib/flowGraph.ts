import type { Edge } from '@xyflow/react'
import type { FlowDefinition, FlowInputField } from '../types.ts'
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
export function toGraph(def: FlowDefinition): {
  nodes: FNode[]
  edges: Edge[]
  inputs: FlowInputField[]
} {
  const nodes = def.nodes.map((n) => ({
    id: n.id,
    type: 'flowNode',
    position: def.layout?.[n.id] ?? { x: 0, y: 0 },
    data: {
      typeId: n.type,
      typeVersion: n.typeVersion,
      label: n.name,
      params: n.params ?? {},
      onError: n.onError ?? 'fail',
      ...(n.probedOutput ? { probedOutput: n.probedOutput } : {}),
    },
  })) as FNode[]

  const edges = def.edges.map((e, i) => ({
    id: `e${i}`,
    source: e.from,
    target: e.to,
    sourceHandle: portOf(e),
  })) as Edge[]

  const inputs: FlowInputField[] = Object.entries(def.inputs?.properties ?? {}).map(([key, s]) => ({
    key,
    title: s.title ?? key,
    type: (s.type as FlowInputField['type']) ?? 'string',
    required: (def.inputs?.required ?? []).includes(key),
  }))

  return { nodes, edges, inputs }
}
