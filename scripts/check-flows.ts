/**
 * 存量流程的批量静态校验 —— 变更影响面分析。
 *
 *   npm run check:flows                     # 从服务端拉全部流程
 *   npm run check:flows -- docs/flows/*.json  # 或者查一批导出的 JSON
 *
 * 为什么需要它：节点的 input schema 由后端 manifest 整份下发，改一个字段名，
 * 所有已保存流程里那个参数就变成孤儿。types.ts 里已经为同一类问题写过一段注释 ——
 * 这种不一致"一上线就没，而且**只在线上没，本地永远测不出来**"。
 *
 * 流程还在各人 localStorage 里的时候这件事没法检测；集中到服务端之后既可检测
 * 也更致命：一次变更同时打坏所有人的日报。
 *
 * 退出码非 0 表示有流程会因当前的节点定义而失效 —— CI 可以直接拿它当门禁。
 */
import { readFile } from 'node:fs/promises'
import type { FlowDefinition } from '../src/types.ts'
import { applyBackendNodes, NODE_TYPE_MAP } from '../src/registry.ts'
import { normalizeFlowDefinition } from '../src/lib/flowImport.ts'
import { toGraph } from '../src/lib/flowGraph.ts'
import { graphProblems } from '../src/lib/graph.ts'
import { validateNode } from '../src/lib/vars.ts'

const BASE = process.env.VITE_SQL_SERVICE ?? 'http://localhost:8791'

interface Report {
  id: string
  name: string
  problems: string[]
}

function check(def: FlowDefinition): string[] {
  const problems: string[] = []
  const { nodes, edges, inputs } = toGraph(def)

  // 节点类型本身还在不在。删掉一个节点类型是最狠的破坏性变更
  for (const n of def.nodes) {
    if (!NODE_TYPE_MAP.has(n.type)) problems.push(`节点「${n.name}」(${n.id}) 的类型 ${n.type} 已不存在`)
  }
  problems.push(...graphProblems(nodes, edges).map((p) => (p.nodeId ? `[${p.nodeId}] ${p.message}` : p.message)))
  for (const node of nodes) {
    for (const e of validateNode(node, nodes, edges, inputs)) {
      problems.push(`[${node.id}] ${e}`)
    }
  }
  return problems
}

async function loadFromFiles(paths: string[]): Promise<Array<{ id: string; def: FlowDefinition }>> {
  const out = []
  for (const p of paths) {
    const raw = JSON.parse(await readFile(p, 'utf-8'))
    const id = String(raw.id ?? p)
    out.push({ id, def: normalizeFlowDefinition(raw, id) })
  }
  return out
}

async function loadFromServer(): Promise<Array<{ id: string; def: FlowDefinition }>> {
  const list = await fetch(`${BASE}/api/flows`).then((r) => {
    if (!r.ok) throw new Error(`GET /api/flows → HTTP ${r.status}`)
    return r.json() as Promise<{ flows: Array<{ id: string }> }>
  })
  const out = []
  for (const f of list.flows) {
    const one = await fetch(`${BASE}/api/flows/${encodeURIComponent(f.id)}`).then((r) => r.json())
    if (one?.draft) out.push({ id: f.id, def: normalizeFlowDefinition(one.draft, f.id) })
  }
  return out
}

async function main() {
  // 用后端下发的注册表，不是前端那份硬编码的 ——
  // **要检测的正是"后端 manifest 改了之后存量流程会不会坏"**，
  // 拿前端的兜底定义去查等于什么都没查
  try {
    const { nodes } = await fetch(`${BASE}/registry/nodes`).then((r) => r.json())
    applyBackendNodes(nodes)
    console.log(`已加载后端节点注册表（${nodes.length} 个节点类型）`)
  } catch (err) {
    console.error(`× 拉不到后端注册表 ${BASE}/registry/nodes：${err instanceof Error ? err.message : err}`)
    console.error('  没有它就只能用前端的兜底定义，查不出后端 manifest 的破坏性变更。先把服务起起来。')
    process.exit(2)
  }

  const files = process.argv.slice(2)
  let flows
  try {
    flows = files.length ? await loadFromFiles(files) : await loadFromServer()
  } catch (err) {
    console.error(`× 读不到流程：${err instanceof Error ? err.message : err}`)
    process.exit(2)
  }

  if (!flows.length) {
    console.log('没有流程可查。')
    return
  }

  const reports: Report[] = []
  for (const { id, def } of flows) {
    const problems = check(def)
    if (problems.length) reports.push({ id, name: def.name, problems })
  }

  console.log(`\n查了 ${flows.length} 条流程，${reports.length} 条有问题。\n`)
  for (const r of reports) {
    console.log(`✗ ${r.name} (${r.id})`)
    for (const p of r.problems) console.log(`    ${p}`)
    console.log()
  }
  if (reports.length) {
    console.log('破坏性的节点 schema 变更必须伴随 typeVersion 升级，否则存量流程会静默失效。')
    process.exit(1)
  }
  console.log('全部通过。')
}

await main()
