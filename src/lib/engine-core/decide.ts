import type { Edge } from '@xyflow/react'
import type { FNode } from '../../store.ts'
import { NODE_TYPE_MAP } from '../../registry.ts'
import { portOf } from '../flowGraph.ts'
import { branchKill, loopScope, outgoing, prepare } from './graph.ts'
import { isTerminal, stepKeyOf, type SkipReason, type StepKey, type StepStatus } from './types.ts'

/**
 * 「下一步该干什么」——**纯函数**。
 *
 * 只读输入、不做 IO、不 await、**不读时钟**。同一份输入连调两次结果完全相同。
 * 这三条不是洁癖：worker 崩溃重启后要从库里的 steps 重新算出下一步，
 * 算出来的必须和崩之前一致，否则要么漏跑要么重跑 —— 而重跑一个 notify.wecom
 * 就是群里多一条消息。
 *
 * 它替代的是 executeFlow 里"一次遍历累积 dead 集合"的模型。那个模型的状态
 * 全在闭包里（order 下标、dead、inLoopBody、failed），进程一死就没了。
 *
 * ## 签名为什么是四份输入而不是 (definition, steps)
 *
 * - **run**：取消是 run 级事实，steps 里没有它的投影。run 处于 canceling、
 *   steps 里 A=success/B=queued 时，只看 steps 会判 B 可跑，worker 认领之后
 *   **真把企微消息发出去** —— 取消一条流程反而多发一条。
 * - **nodeTypes**：visualOnly 剔除、hasInput===false 的触发器免活性判定、
 *   flow.if 的 true/false 口 —— 唯一来源是注册表，而 FlowDefinition 里只有
 *   type 字符串。第一阶段先从全局 NODE_TYPE_MAP 读；服务端落地时改成
 *   flow_versions 里钉住的快照，否则改一次 manifest 就会改变历史运行的重放结果。
 */

export interface DecideStep {
  nodeId: string
  loopPath: number[]
  status: StepStatus
  /** 循环节点展开了几项。仅 flow.foreach 有 */
  fanout?: number
  /**
   * flow.if 的判定结果。**必须持久化在这一行上**，不能重算 ——
   * 重算意味着 decide() 要去解析表达式，那它就不再是纯的了，
   * 而且条件里可能引用了已经被清理的大 output
   */
  matched?: boolean
  /**
   * skipped 的原因。只有一种会影响判定：`disabled`（用户暂停的）——
   * 它是「活着但没跑」，下游要照常判活；其余 skipped 都是死的
   */
  skipReason?: SkipReason
}

export interface DecideRun {
  /** 'running' 正常推进；'canceling' 只收尾不新起 */
  status: 'running' | 'canceling'
}

export interface DecideInput {
  nodes: readonly FNode[]
  edges: readonly Edge[]
  run: DecideRun
  steps: readonly DecideStep[]
}

export type RunAction = 'start' | 'resume_poll' | 'retry'

export interface DecideResult {
  toRun: Array<StepKey & { action: RunAction }>
  toSkip: Array<StepKey & { reason: SkipReason }>
  /** 正在跑但要撤掉的（取消时） */
  toCancel: StepKey[]
  /** 活着但在等入边到齐。**不是调试信息** —— 它是判断"卡住了"的唯一依据 */
  blocked: Array<StepKey & { waitingOn: string[] }>
  /**
   * - advanced：这一轮有事可做
   * - waiting：没事可做但有非终态的行，等唤醒
   * - stuck：没事可做也没有非终态的行，**但 run 还没结束** —— 有环图会走到这里。
   *   宿主层必须把它判成错误而不是干等，否则 run 永久停在 running，
   *   reaper 只扫 running/waiting 的行，一行都没有，谁也碰不到它
   */
  progress: 'advanced' | 'waiting' | 'stuck'
  finished?: 'success' | 'error' | 'canceled'
}

const TOP: number[] = []

/**
 * 这个节点能不能被暂停。条件 / 循环节点不能：decide 要读它们的 matched / fanout，
 * 没有这行下游永远 stuck；触发器不能：它是运行的起点。
 * 界面上不给这些节点画开关，这里再挡一道 —— 导入的 JSON 能写任何东西
 */
export function pausable(n: FNode): boolean {
  const t = NODE_TYPE_MAP.get(n.data.typeId)
  if (!t || t.hasInput === false || t.visualOnly) return false
  return n.data.typeId !== 'flow.if' && n.data.typeId !== 'flow.foreach'
}

/** 一个源步骤算不算「活」：成功、失败但 continue、或**暂停**（活着但没跑） */
function sourceAlive(s: DecideStep | undefined, srcNode: FNode | undefined): boolean {
  if (s?.status === 'success') return true
  if (s?.status === 'skipped') return s.skipReason?.kind === 'disabled'
  if (s?.status !== 'failed') return false
  return srcNode?.data.onError === 'continue'
}

/** 同一路径下的那一行 */
function stepAt(steps: readonly DecideStep[], nodeId: string, loopPath: number[]): DecideStep | undefined {
  const key = stepKeyOf({ nodeId, loopPath })
  return steps.find((s) => stepKeyOf(s) === key)
}

export function decide(input: DecideInput): DecideResult {
  const { nodes, edges } = prepare([...input.nodes], [...input.edges])
  const steps = input.steps
  const byKey = new Map(steps.map((s) => [stepKeyOf(s), s]))

  const toRun: DecideResult['toRun'] = []
  const toSkip: DecideResult['toSkip'] = []
  const toCancel: StepKey[] = []
  const blocked: DecideResult['blocked'] = []

  const typeOf = (n: FNode) => NODE_TYPE_MAP.get(n.data.typeId)
  const nonTerminal = steps.filter((s) => !isTerminal(s.status))

  // ── (a) 取消优先于一切。判定顺序固定，写在这里是因为顺序本身就是语义
  if (input.run.status === 'canceling') {
    for (const s of steps) {
      if (s.status === 'running' || s.status === 'waiting') toCancel.push({ nodeId: s.nodeId, loopPath: s.loopPath })
    }
    for (const n of nodes) {
      const s = byKey.get(n.id)
      if (!s || s.status === 'queued') {
        toSkip.push({ nodeId: n.id, loopPath: TOP, reason: { kind: 'run_failed' } })
      }
    }
    return {
      toRun: [], toSkip, toCancel, blocked,
      progress: toCancel.length ? 'advanced' : 'waiting',
      finished: nonTerminal.length === 0 ? 'canceled' : undefined,
    }
  }

  // ── (b) 全局 fail-fast。**不是"只灭下游"** —— 与失败点毫无关系的并行分支
  //    也要停，否则那条分支上的 notify.wecom 会在流程本该中止后仍然真发出去
  const failedHard = steps.find((s) => {
    if (s.status !== 'failed') return false
    return nodes.find((n) => n.id === s.nodeId)?.data.onError !== 'continue'
  })
  if (failedHard) {
    for (const n of nodes) {
      const s = byKey.get(n.id)
      if (!s) toSkip.push({ nodeId: n.id, loopPath: TOP, reason: { kind: 'run_failed' } })
    }
    return {
      toRun: [], toSkip, toCancel, blocked,
      progress: toSkip.length ? 'advanced' : 'waiting',
      finished: nonTerminal.length === 0 && toSkip.length === 0 ? 'error' : undefined,
    }
  }

  // ── (c) 分支灭活：已判定的 flow.if 决定哪些节点进不了
  const dead = new Set<string>()
  for (const n of nodes) {
    if (n.data.typeId !== 'flow.if') continue
    const s = byKey.get(n.id)
    if (s?.status !== 'success') continue
    if (s.matched === undefined) continue
    const matched = s.matched
    for (const id of branchKill(nodes, edges, n.id, matched ? 'false' : 'true', dead)) dead.add(id)
  }

  // ── (d) 循环作用域。**不加这个会多发消息**：
  //    q1 → loop --each--> send，三次迭代跑完、loop 置 success 之后，
  //    局部规则会看到"send 的唯一入边源已终态且非 skipped"→ 判 send 就绪
  //    → loopPath 取默认 {} → 主键不冲突 → 第 4 条消息发出去，运行记录还是绿的
  const scopeOf = new Map<string, { foreachId: string; fanout: number | undefined }>()
  for (const n of nodes) {
    if (n.data.typeId !== 'flow.foreach') continue
    const s = byKey.get(n.id)
    for (const id of loopScope(n.id, edges)) {
      scopeOf.set(id, { foreachId: n.id, fanout: s?.fanout })
    }
  }

  for (const n of nodes) {
    const t = typeOf(n)
    const scope = scopeOf.get(n.id)

    // 体内节点由所属 foreach 的展开决定跑几次、跑在哪条路径上
    const paths: number[][] = scope
      ? scope.fanout === undefined
        ? []                                                   // foreach 还没展开，先不动
        : Array.from({ length: scope.fanout }, (_, i) => [i])
      : [TOP]

    // fanout=0：体内节点一次都不跑，但要显式记一条，否则"空"这件事在库里没有痕迹
    if (scope && scope.fanout === 0 && !byKey.get(n.id)) {
      toSkip.push({ nodeId: n.id, loopPath: TOP, reason: { kind: 'no_iterations' } })
      continue
    }

    for (const loopPath of paths) {
      const existing = stepAt(steps, n.id, loopPath)
      if (existing && isTerminal(existing.status)) continue
      if (existing && (existing.status === 'running' || existing.status === 'waiting')) continue

      if (dead.has(n.id)) {
        if (!existing) toSkip.push({ nodeId: n.id, loopPath, reason: { kind: 'unreachable' } })
        continue
      }

      // 触发器免活性判定。写 hasInput !== false 而不是 === true：
      // 未知类型也要走校验路径，最终由 validateNode 报"未知节点类型"
      if (t?.hasInput === false) {
        if (!existing) toRun.push({ nodeId: n.id, loopPath, action: 'start' })
        continue
      }

      const incoming = edges.filter((e) => e.target === n.id)
      if (incoming.length === 0) {
        if (!existing) toSkip.push({ nodeId: n.id, loopPath, reason: { kind: 'no_incoming' } })
        continue
      }

      // 入边源在哪条路径上找：从 each 口进来的边，源在父路径上
      const srcPath = (e: Edge) =>
        scope && e.source === scope.foreachId && portOf(e) === 'each' ? TOP : loopPath
      const srcSteps = incoming.map((e) => ({ e, s: stepAt(steps, e.source, srcPath(e)) }))

      const waitingOn = srcSteps.filter(({ s }) => !s || !isTerminal(s.status)).map(({ e }) => e.source)
      if (waitingOn.length) {
        blocked.push({ nodeId: n.id, loopPath, waitingOn })
        continue
      }

      // 活 = ∃ 入边源 success，或（源 failed 且**该源节点** onError='continue'），
      // 或源是**暂停**的（skipped{disabled}：它自己活着才会被记成这种 skipped）。
      // canceled 一律不算活 —— 否则取消过程中 reaper 写的 canceled 会放行下游
      const alive = srcSteps.some(({ e, s }) => sourceAlive(s, nodes.find((x) => x.id === e.source)))
      if (!alive) {
        const failedSrc = srcSteps.find(({ s }) => s?.status === 'failed')
        toSkip.push({
          nodeId: n.id,
          loopPath,
          reason: failedSrc
            ? { kind: 'upstream_failed', src: failedSrc.e.source }
            : { kind: 'unreachable' },
        })
        continue
      }

      // 暂停的节点：走到这里说明它是活的，但用户说了别跑。记成 skipped{disabled}
      // 而不是什么都不记 —— 下游靠这一行判活，运行详情也得能看出"是你自己暂停的"。
      // 只在判完活性之后才这么做：否则上游还没跑完就把它记成 skipped，
      // 下游会拿一个"终态"的源去判，把 pending 当成 dead
      if (n.data.disabled && pausable(n)) {
        if (!existing) toSkip.push({ nodeId: n.id, loopPath, reason: { kind: 'disabled' } })
        continue
      }

      const resume = existing?.status === 'queued' ? 'start' : 'start'
      toRun.push({ nodeId: n.id, loopPath, action: resume })
    }
  }

  // ── (e) 契约：toRun 与 toSkip 不相交，冲突时 toSkip 赢。
  //    违反不是"任选一个执行"，那会让同一个节点既跑又不跑，取决于遍历顺序
  const skipKeys = new Set(toSkip.map(stepKeyOf))
  const runs = toRun.filter((r) => !skipKeys.has(stepKeyOf(r)))

  const anyWork = runs.length + toSkip.length + toCancel.length > 0
  const allTerminal = nodes.every((n) => {
    const s = byKey.get(n.id)
    return s && isTerminal(s.status)
  })

  return {
    toRun: runs,
    toSkip,
    toCancel,
    blocked,
    progress: anyWork ? 'advanced' : nonTerminal.length ? 'waiting' : 'stuck',
    finished: !anyWork && allTerminal
      ? steps.some((s) => s.status === 'failed' && nodes.find((n) => n.id === s.nodeId)?.data.onError !== 'continue')
        ? 'error'
        : 'success'
      : undefined,
  }
}

export { outgoing }
