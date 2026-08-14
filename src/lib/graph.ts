import type { Edge } from '@xyflow/react'
import { NODE_TYPE_MAP } from '../registry'
import type { FNode } from '../store'

export interface GraphProblem {
  nodeId?: string
  message: string
}

interface ConnectionLike {
  source: string | null
  target: string | null
  sourceHandle?: string | null
  targetHandle?: string | null
}

function reaches(start: string, goal: string, edges: Edge[]): boolean {
  const seen = new Set<string>([start])
  const queue = [start]
  for (let i = 0; i < queue.length; i++) {
    for (const edge of edges) {
      if (edge.source !== queue[i]) continue
      if (edge.target === goal) return true
      if (seen.has(edge.target)) continue
      seen.add(edge.target)
      queue.push(edge.target)
    }
  }
  return false
}

/** 返回不能建立这条边的原因；null 表示连接合法。 */
export function connectionProblem(connection: ConnectionLike, edges: Edge[]): string | null {
  const { source, target } = connection
  if (!source || !target) return '连线两端必须连接到节点'
  if (source === target) return '节点不能连接到自己'
  const sourceHandle = connection.sourceHandle ?? 'out'
  const targetHandle = connection.targetHandle ?? null
  const duplicate = edges.some(
    (edge) =>
      edge.source === source &&
      edge.target === target &&
      (edge.sourceHandle ?? 'out') === sourceHandle &&
      (edge.targetHandle ?? null) === targetHandle,
  )
  if (duplicate) return '这两个端口已经连接'
  if (reaches(target, source, edges)) return '这条连线会形成环路'
  return null
}

/** 对导入、历史数据和当前编辑结果做整图校验。 */
export function graphProblems(nodes: FNode[], edges: Edge[]): GraphProblem[] {
  const problems: GraphProblem[] = []
  const nodeIds = new Set(nodes.map((node) => node.id))
  const visualIds = new Set(
    nodes.filter((node) => NODE_TYPE_MAP.get(node.data.typeId)?.visualOnly).map((node) => node.id),
  )
  const runnableNodes = nodes.filter((node) => !visualIds.has(node.id))
  const entries = runnableNodes.filter((node) => NODE_TYPE_MAP.get(node.data.typeId)?.hasInput === false)
  if (entries.length === 0) problems.push({ message: '流程缺少触发器' })
  if (entries.length > 1) problems.push({ nodeId: entries[1].id, message: '流程只能有一个触发器' })

  const validEdges: Edge[] = []
  const signatures = new Set<string>()
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      problems.push({ nodeId: nodeIds.has(edge.source) ? edge.source : undefined, message: '连线引用了不存在的节点' })
      continue
    }
    if (visualIds.has(edge.source) || visualIds.has(edge.target)) {
      problems.push({ nodeId: visualIds.has(edge.source) ? edge.source : edge.target, message: '便签不能参与流程连线' })
      continue
    }
    if (edge.source === edge.target) {
      problems.push({ nodeId: edge.source, message: '节点不能连接到自己' })
      continue
    }
    const signature = `${edge.source}\u0000${edge.sourceHandle ?? 'out'}\u0000${edge.target}\u0000${edge.targetHandle ?? ''}`
    if (signatures.has(signature)) {
      problems.push({ nodeId: edge.source, message: '存在重复连线' })
      continue
    }
    signatures.add(signature)
    validEdges.push(edge)
  }

  for (const node of runnableNodes) {
    if (NODE_TYPE_MAP.get(node.data.typeId)?.hasInput === false) continue
    if (!validEdges.some((edge) => edge.target === node.id)) {
      problems.push({ nodeId: node.id, message: `节点「${node.data.label}」没有连接上游` })
    }
  }

  // Kahn 算法剩下的节点都在环内或依赖环；整图只报一次，避免问题计数刷屏。
  const indegree = new Map(runnableNodes.map((node) => [node.id, 0]))
  const outgoing = new Map(runnableNodes.map((node) => [node.id, [] as string[]]))
  for (const edge of validEdges) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
    outgoing.get(edge.source)?.push(edge.target)
  }
  const queue = runnableNodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  let visited = 0
  for (let i = 0; i < queue.length; i++) {
    visited++
    for (const target of outgoing.get(queue[i]) ?? []) {
      const next = (indegree.get(target) ?? 1) - 1
      indegree.set(target, next)
      if (next === 0) queue.push(target)
    }
  }
  if (visited < runnableNodes.length) {
    const cycleNode = runnableNodes.find((node) => (indegree.get(node.id) ?? 0) > 0)
    problems.push({ nodeId: cycleNode?.id, message: '流程存在环路，请删除回连的连线' })
  }

  return problems
}
