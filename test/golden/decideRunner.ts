import type { Edge } from '@xyflow/react'
import type { FNode } from '../../src/store.ts'
import { NODE_TYPE_MAP } from '../../src/registry.ts'
import { MAX_LOOP_ITERATIONS } from '../../src/lib/engine-core/types.ts'
import { decide, type DecideStep } from '../../src/lib/engine-core/decide.ts'
import { stepKeyOf } from '../../src/lib/engine-core/types.ts'
import { mockOutput, resolveParams, resolveTemplate } from '../../src/lib/engine.ts'
import { validateNode } from '../../src/lib/vars.ts'
import { prepare } from '../../src/lib/engine-core/graph.ts'
import { FIXED_RUN_ID, FIXED_STARTED_AT, type GoldenFlow, type GoldenResult } from './harness.ts'

/**
 * decide() 驱动的解释器 —— 模拟服务端 worker，但不落库。
 *
 * **每次 decide 都从 steps 表全量重算，不保留任何跨 tick 的内存状态。**
 * 这正是崩溃恢复要证明的性质：worker 死了、新 worker 从库里读同一批 steps，
 * 算出来的下一步必须和崩之前一致。executeFlow 做不到这一点 ——
 * 它的 dead / inLoopBody / failed 全在闭包里，进程一死就没了。
 *
 * 这个宿主的价值在于对比：同一批 fixture 跑两遍（executeFlow 一遍、这里一遍），
 * 差异必须全部落进 divergence 表里登记过的条目。没登记的差异一律判红。
 */

interface Row extends DecideStep {
  output: unknown
  error?: string
  pinned?: boolean
  /** flow.if 的判定结果，decide() 靠它做分支灭活 */
  matched?: boolean
  /** 写入序号，用来还原执行顺序 */
  seq: number
}

const TOP: number[] = []

export async function runViaDecide(flow: GoldenFlow): Promise<GoldenResult> {
  const { nodes, edges } = prepare(flow.nodes, flow.edges)
  const rows = new Map<string, Row>()
  let seq = 0

  const put = (r: Omit<Row, 'seq'>) => {
    const key = stepKeyOf(r)
    // 条件写：已经有终态的行不覆盖（对应 executeFlow 里 skip() 那道保护）
    rows.set(key, { ...r, seq: ++seq })
  }

  const trigger = flow.trigger ?? {}
  const pinData = flow.pinData ?? {}
  const run = { id: FIXED_RUN_ID, startedAt: new Date(FIXED_STARTED_AT).toISOString() }

  /**
   * 装配表达式上下文。**硬规则**：
   * - 只取 status='success' 的行（error/skipped/canceled 永不进 ctx）
   * - 循环体内节点只取同 loopPath 的行，**跨 loopPath 一律视为缺失**
   *
   * 后一条是有意的行为翻转，见 divergence 表：今天体内下游会静默读到上一轮的数据
   */
  const ctxFor = (loopPath: number[], loop?: { item: unknown; index: number }) => {
    const bag: Record<string, { output: unknown }> = {}
    for (const r of rows.values()) {
      if (r.status !== 'success') continue
      const sameScope = r.loopPath.length === 0 || stepKeyOf({ nodeId: '', loopPath: r.loopPath }) === stepKeyOf({ nodeId: '', loopPath })
      if (!sameScope) continue
      bag[r.nodeId] = { output: r.output }
    }
    return { trigger, run, nodes: bag, ...(loop ? { loop } : {}) }
  }

  /** 循环体某一轮的 item：从所属 foreach 那一行存下来的展开结果里取 */
  const itemsOf = new Map<string, unknown[]>()

  const nodeById = new Map(nodes.map((n) => [n.id, n]))

  /** 这个节点属于哪个 foreach 的体内（用于取 $.loop） */
  const ownerOf = (nodeId: string): string | undefined => {
    for (const n of nodes) {
      if (n.data.typeId !== 'flow.foreach') continue
      // loopScope 在 decide 里已经算过，这里复用同一份逻辑
      const scope = require_loopScope(n.id, edges)
      if (scope.has(nodeId)) return n.id
    }
    return undefined
  }

  for (let tick = 0; tick < 5000; tick++) {
    const result = decide({
      nodes,
      edges,
      run: { status: 'running' },
      steps: [...rows.values()].map((r) => ({
        nodeId: r.nodeId,
        loopPath: r.loopPath,
        status: r.status,
        ...(r.fanout === undefined ? {} : { fanout: r.fanout }),
        ...(r.matched === undefined ? {} : { matched: r.matched }),
        // 和 worker 的 loadSteps 一样把原因带回去：暂停的 skipped 要被下游判成活
        ...(r.skipReason === undefined ? {} : { skipReason: r.skipReason }),
      })) as DecideStep[],
    })

    for (const s of result.toSkip) {
      if (rows.has(stepKeyOf(s))) continue
      put({ nodeId: s.nodeId, loopPath: s.loopPath, status: 'skipped', output: null, skipReason: s.reason })
    }

    if (!result.toRun.length) {
      if (result.progress === 'stuck' || result.finished) break
      if (!result.toSkip.length) break
      continue
    }

    // **一个 tick 只执行一个**，然后重新 decide。
    //
    // 批量执行整个 toRun 等于偷偷引入并行，而并行会静默改变 fail-fast 语义：
    // bad 和 other 在同一拓扑层，批量跑时 other 已经跑完了 bad 才失败，
    // 于是"与失败点无关的分支也要停"这条红线被绕过去了。
    // 并行是后面「架构优化」里一次**显式**的改动，不该从这里漏进来。
    for (const target of result.toRun.slice(0, 1)) {
      const node = nodeById.get(target.nodeId)!
      const owner = target.loopPath.length ? ownerOf(target.nodeId) : undefined
      const loop = owner
        ? { item: (itemsOf.get(owner) ?? [])[target.loopPath[0]], index: target.loopPath[0] }
        : undefined
      const ctx = ctxFor(target.loopPath, loop)

      // pinData 替代执行，且跳过参数校验（n8n 语义）
      if (Object.prototype.hasOwnProperty.call(pinData, node.id)) {
        put({ nodeId: node.id, loopPath: target.loopPath, status: 'success', output: pinData[node.id], pinned: true })
        continue
      }

      let input: Record<string, unknown> = {}
      try {
        input = resolveParams(node.data.params, ctx, NODE_TYPE_MAP.get(node.data.typeId)?.input)
      } catch (err) {
        put({ nodeId: node.id, loopPath: target.loopPath, status: 'failed', output: null, error: msg(err) })
        continue
      }

      const errors = validateNode(node, nodes, edges, flow.flowInputs ?? [])
      if (errors.length) {
        put({ nodeId: node.id, loopPath: target.loopPath, status: 'failed', output: null, error: errors[0] })
        continue
      }

      // 循环节点：展开 items，把 fanout 记进这一行 —— decide() 靠它决定体内跑几次
      if (node.data.typeId === 'flow.foreach') {
        try {
          const resolved = resolveTemplate(node.data.params.items, ctx)
          if (!Array.isArray(resolved)) {
            throw new Error(
              `循环的「数据来源」要指向一个数组，实际解析出的是 ${resolved === null ? 'null' : typeof resolved}。` +
                `通常应该引用上游的结果集，例如 {{ $.nodes.q1.output.rows }}`,
            )
          }
          if (resolved.length > MAX_LOOP_ITERATIONS) {
            throw new Error(
              `循环项有 ${resolved.length} 条，超过上限 ${MAX_LOOP_ITERATIONS}。` +
                `请在上游 SQL 里加 LIMIT，或先用「列表操作」节点截取`,
            )
          }
          itemsOf.set(node.id, resolved)
          put({
            nodeId: node.id, loopPath: TOP, status: 'success', fanout: resolved.length,
            output: { results: resolved.map((item, index) => ({ index, item })), okCount: resolved.length, failCount: 0 },
          })
        } catch (err) {
          put({ nodeId: node.id, loopPath: TOP, status: 'failed', output: null, error: msg(err) })
        }
        continue
      }

      try {
        const output = mockOutput(node, ctx, input, edges)
        put({
          nodeId: node.id, loopPath: target.loopPath, status: 'success', output,
          ...(node.data.typeId === 'flow.if' ? { matched: (output as { matched: boolean }).matched } : {}),
        })
      } catch (err) {
        put({ nodeId: node.id, loopPath: target.loopPath, status: 'failed', output: null, error: msg(err) })
      }
    }
  }

  const flat = [...rows.values()].sort((a, b) => a.seq - b.seq)
  const hardFail = flat.some(
    (r) => r.status === 'failed' && nodeById.get(r.nodeId)?.data.onError !== 'continue',
  )
  return {
    runStatus: hardFail ? 'error' : 'success',
    order: flat.map((r) => (r.loopPath.length ? `${r.nodeId}#${r.loopPath[0]}` : r.nodeId)),
    steps: flat.map((r) => ({
      nodeId: r.nodeId,
      ...(r.loopPath.length ? { iteration: r.loopPath[0] } : {}),
      // decide 的词表是 7 态，executeFlow 是 5 态；比较时把 failed 映射成 error
      status: (r.status === 'failed' ? 'error' : r.status) as GoldenResult['steps'][number]['status'],
      output: JSON.stringify(r.output),
      ...(r.error ? { error: r.error } : {}),
      ...(r.pinned ? { pinned: true } : {}),
    })),
  }
}

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err))

// loopScope 在 graph.ts 里，这里包一层避免 import 循环带来的读者困惑
import { loopScope } from '../../src/lib/engine-core/graph.ts'
function require_loopScope(foreachId: string, edges: readonly Edge[]): Set<string> {
  return loopScope(foreachId, [...edges])
}

export type { GoldenFlow }
export type UnusedNode = FNode
