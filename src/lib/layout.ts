import type { Edge } from '@xyflow/react'
import type { FNode } from '../store'

/**
 * 自动整理画布：按拓扑层级排列节点。
 *
 * 手摆节点必然歪 —— 尤其是从 `+` 一路加出来的流程，位置是按"上一个节点右边"
 * 硬算的，加过分支、删过节点之后就乱了。这里按拓扑分层重排：
 * 同一层竖着排，层与层之间横着排，层内顺序按父节点的平均位置（重心法）定，
 * 连线才不会互相穿过。
 */

/** 节点宽度，和 .node 的 CSS 宽度保持一致 */
export const NODE_W = 244
const GAP_X = 96
const GAP_Y = 40
const FALLBACK_H = 78
const ORIGIN = { x: 60, y: 60 }

type Pos = Record<string, { x: number; y: number }>

/** react-flow v12 量出来的真实高度；还没渲染过就用兜底值 */
function heightOf(n: FNode): number {
  return (n as { measured?: { height?: number } }).measured?.height ?? FALLBACK_H
}

/**
 * 每个节点的层号 = 从任意根节点出发的最长路径长度。
 * 用最长路径而不是最短：`n1 → n2 → n3` 且 `n1 → n3` 时，n3 必须排在 n2 右边，
 * 否则那条长边会往回拐。
 */
function depths(nodes: FNode[], edges: Edge[]): Record<string, number> {
  const out = new Map<string, string[]>()
  const indeg = new Map<string, number>()
  for (const n of nodes) {
    out.set(n.id, [])
    indeg.set(n.id, 0)
  }
  for (const e of edges) {
    if (!out.has(e.source) || !indeg.has(e.target)) continue
    out.get(e.source)!.push(e.target)
    indeg.set(e.target, indeg.get(e.target)! + 1)
  }

  const depth: Record<string, number> = {}
  for (const n of nodes) depth[n.id] = 0
  // Kahn 拓扑序推进层号。有环时剩下的节点不会进队，保持 0 层 —— 画布上允许
  // 存在环（用户随手连的），整理不该因此崩掉或死循环
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id)
  const seen = new Set(queue)
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]
    for (const next of out.get(id) ?? []) {
      depth[next] = Math.max(depth[next], depth[id] + 1)
      indeg.set(next, indeg.get(next)! - 1)
      if (indeg.get(next) === 0 && !seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return depth
}

export function layeredLayout(nodes: FNode[], edges: Edge[]): Pos {
  if (nodes.length === 0) return {}
  const depth = depths(nodes, edges)
  const parents = new Map<string, string[]>()
  for (const n of nodes) parents.set(n.id, [])
  for (const e of edges) parents.get(e.target)?.push(e.source)

  const layers: string[][] = []
  for (const n of nodes) {
    const d = depth[n.id] ?? 0
    ;(layers[d] ??= []).push(n.id)
  }

  // 层内顺序：先按原本的 y 排一遍（保住用户手摆的相对上下关系），
  // 再按父节点的平均序号做两轮重心排序，让连线尽量不交叉
  const yOf = new Map(nodes.map((n) => [n.id, n.position.y]))
  const order = new Map<string, number>()
  for (const layer of layers) {
    if (!layer) continue
    layer.sort((a, b) => (yOf.get(a) ?? 0) - (yOf.get(b) ?? 0))
    layer.forEach((id, i) => order.set(id, i))
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const layer of layers) {
      if (!layer) continue
      const key = new Map<string, number>()
      for (const id of layer) {
        const ps = (parents.get(id) ?? []).map((p) => order.get(p) ?? 0)
        key.set(id, ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : (order.get(id) ?? 0))
      }
      layer.sort((a, b) => (key.get(a) ?? 0) - (key.get(b) ?? 0))
      layer.forEach((id, i) => order.set(id, i))
    }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const pos: Pos = {}
  // 各层竖直居中对齐：单节点的层（比如末尾的通知）会落在整体中线上，
  // 而不是贴着顶端，视觉上才像一条主干
  const heights = layers.map((layer) =>
    (layer ?? []).reduce((sum, id) => sum + heightOf(byId.get(id)!) + GAP_Y, -GAP_Y),
  )
  const tallest = Math.max(0, ...heights)

  layers.forEach((layer, d) => {
    if (!layer) return
    let y = ORIGIN.y + (tallest - heights[d]) / 2
    for (const id of layer) {
      pos[id] = { x: ORIGIN.x + d * (NODE_W + GAP_X), y: Math.round(y) }
      y += heightOf(byId.get(id)!) + GAP_Y
    }
  })
  return pos
}

/**
 * 从某个节点右边找一个不压着别人的落点。
 * `+` 加出来的节点全按"上一个右边 320"摆，同一个出口连加两个就会重叠。
 */
export function freeSpotRightOf(nodes: FNode[], from: FNode): { x: number; y: number } {
  const x = from.position.x + NODE_W + GAP_X
  let y = from.position.y
  const clash = (ty: number) =>
    nodes.some(
      (n) =>
        Math.abs(n.position.x - x) < NODE_W - 20 &&
        Math.abs(n.position.y - ty) < heightOf(n) + 12,
    )
  for (let i = 0; i < 40 && clash(y); i++) y += heightOf(from) + GAP_Y
  return { x, y }
}

/** 某节点的全部下游（含自己），插入节点时要整体右移给新节点腾地方 */
export function descendants(id: string, edges: Edge[]): Set<string> {
  const out = new Set<string>([id])
  const queue = [id]
  for (let i = 0; i < queue.length; i++) {
    for (const e of edges) {
      if (e.source !== queue[i] || out.has(e.target)) continue
      out.add(e.target)
      queue.push(e.target)
    }
  }
  return out
}
