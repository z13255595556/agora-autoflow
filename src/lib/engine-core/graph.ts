import type { Edge } from '@xyflow/react'
import type { FNode } from '../../store.ts'
import { NODE_TYPE_MAP } from '../../registry.ts'
import { portOf } from '../flowGraph.ts'

/**
 * 图遍历的纯函数。**只收 (nodes, edges)，不碰任何执行状态。**
 *
 * 从 engine.ts 原样搬出来的，行为一字不改 —— 搬运本身要靠 golden 用例证明。
 * 搬出来是因为 decide()（服务端引擎的核心）要用同一套判定，而它必须是纯的：
 * 只读输入、不做 IO、不持有状态，这样 worker 崩了之后从库里重算下一步才对得上。
 */

/** 从某节点某个口出去的边。port 省略则取全部出边 */
export function outgoing(edges: Edge[], nodeId: string, port?: string): Edge[] {
  // 端口缺省值走 portOf 这一个出处 —— 见 flowGraph.ts 的注释，
  // 散着写会让 flow.if 的灭活方向静默翻转
  return edges.filter((e) => e.source === nodeId && (port === undefined || portOf(e) === port))
}

/** 从一组起点沿边正向可达的所有节点（含起点） */
export function reachableFrom(starts: string[], edges: Edge[]): Set<string> {
  const seen = new Set<string>(starts)
  const queue = [...starts]
  while (queue.length) {
    const id = queue.shift()!
    for (const e of edges) {
      if (e.source === id && !seen.has(e.target)) {
        seen.add(e.target)
        queue.push(e.target)
      }
    }
  }
  return seen
}

/**
 * Kahn 拓扑排序；有环时把剩余节点按原顺序附加在后面（不会死循环）。
 *
 * 只统计两端都在节点集内的边 —— 子图调用（循环体）时传的是全量 edges，
 * 若统计外部入边，循环体的入口节点入度永远 > 0，整个 body 会掉进"环"的尾巴里。
 *
 * 有环不报错是有意的：graphProblems 不查环，引擎宁可跑出个次序也不能挂死。
 */
export function topoSort(nodes: FNode[], edges: Edge[]): FNode[] {
  const idSet = new Set(nodes.map((n) => n.id))
  const innerEdges = edges.filter((e) => idSet.has(e.source) && idSet.has(e.target))
  const indeg = new Map(nodes.map((n) => [n.id, 0]))
  for (const e of innerEdges) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0)
  const out: FNode[] = []
  const done = new Set<string>()
  while (queue.length) {
    const n = queue.shift()!
    out.push(n)
    done.add(n.id)
    for (const e of innerEdges.filter((x) => x.source === n.id)) {
      const d = (indeg.get(e.target) ?? 1) - 1
      indeg.set(e.target, d)
      if (d === 0) {
        const t = nodes.find((x) => x.id === e.target)
        if (t && !done.has(t.id)) queue.push(t)
      }
    }
  }
  return [...out, ...nodes.filter((n) => !done.has(n.id))]
}

/**
 * 剔除只做画布表达的节点（便签）及其两端的边。**执行前唯一的入口。**
 *
 * 不剔除的话便签会被当成一个普通节点：没有入边 → 被 skip，还会在运行面板里
 * 冒出一条 skipped 记录；更糟的是它一旦被连线，会成为下游的入边源让整条 run 卡死。
 */
export function prepare(nodes: FNode[], edges: Edge[]): { nodes: FNode[]; edges: Edge[] } {
  const runnable = nodes.filter((n) => !NODE_TYPE_MAP.get(n.data.typeId)?.visualOnly)
  const ids = new Set(runnable.map((n) => n.id))
  return { nodes: runnable, edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)) }
}

/**
 * foreach 的循环体作用域：从 each 口可达、且不经过 done 口可达的节点。
 *
 * 「同时被两口可达的节点归 done 子树」这条不能反 —— 反了的话汇合点会被当成
 * 体内节点，每轮迭代跑一次，而它本该在循环结束后只跑一次。
 *
 * done 口没连线时 doneSet 为空，each 分支的整个下游都算体内 —— 这是今天的行为，
 * 意味着 each 末端的 notify.wecom 每轮都发。钉住它，不要顺手"改好"。
 */
export function loopScope(foreachId: string, edges: Edge[]): Set<string> {
  const eachTargets = outgoing(edges, foreachId, 'each').map((e) => e.target)
  const doneTargets = outgoing(edges, foreachId, 'done').map((e) => e.target)
  const doneSet = reachableFrom(doneTargets, edges)
  return new Set(
    [...reachableFrom(eachTargets, edges)].filter((id) => !doneSet.has(id) && id !== foreachId),
  )
}

/**
 * flow.if 判定之后要灭掉哪些节点。
 *
 * 算法不能简化成"看直接入边还有没有活的"这类局部规则：杀集先用**全量边**求闭包
 * （宁可先圈大），再用「从根节点还能不能到」这个全局判据把还活着的捞回来 ——
 * 否则隔两层的汇合点会被误杀，而且完全静默。
 *
 * 注意 roots 用**全量 edges** 判入边：改用 liveEdges 的话，被灭分支的下游会
 * 因为"入边都没了"而变成新的 root，反被判活，该杀的没杀。
 */
export function branchKill(
  nodes: FNode[],
  edges: Edge[],
  ifId: string,
  deadPort: string,
  dead: ReadonlySet<string>,
): Set<string> {
  const deadEdgeSet = new Set(outgoing(edges, ifId, deadPort))
  const deadTargets = [...deadEdgeSet].map((e) => e.target)
  const liveEdges = edges.filter((e) => !deadEdgeSet.has(e) && !dead.has(e.source))
  const roots = nodes
    .filter((n) => !dead.has(n.id) && !edges.some((e) => e.target === n.id))
    .map((n) => n.id)
  const liveSet = reachableFrom(roots, liveEdges)
  return new Set([...reachableFrom(deadTargets, edges)].filter((id) => !liveSet.has(id)))
}
