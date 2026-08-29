import { formatDate } from './datefn.ts'

export function formatRunLabel(run: {
  id: string
  startedAt: string | number
  status: string
  durationMs?: number
}): string {
  const when = formatDate(new Date(run.startedAt), 'yyyy-MM-dd HH:mm')
  const status = run.status === 'success' ? '成功' : run.status === 'error' ? '失败' : run.status === 'running' ? '进行中' : run.status
  const duration = run.status === 'running' || run.durationMs == null
    ? ''
    : ` · ${(run.durationMs / 1000).toFixed(1)}s`
  return `${when} · ${status}${duration}`
}

export type StepRunTone = 'running' | 'stale' | 'success' | 'error' | 'idle'

/**
 * 「这个节点上次跑成什么样」那颗状态胶囊的文案。
 *
 * 侧栏（Inspector）和节点编辑页的运行条各画一遍，但说的必须是同一句话 ——
 * 两边同时开着的情况不存在（NDV 一开侧栏就卸了），所以对不上的时候用户
 * 只会觉得「刚才明明写着成功」，而不会看见两句话并排打架。
 */
export function stepRunState(input: {
  running: boolean
  /** 最近一次这个节点的执行；没跑过是 undefined */
  lastStep?: { status: string; durationMs: number } | null
  /** 参数改过、还没重跑 */
  dirty: boolean
}): { tone: StepRunTone; text: string } {
  const { lastStep } = input
  if (input.running && lastStep?.status === 'running') return { tone: 'running', text: '正在执行' }
  if (input.dirty && lastStep) return { tone: 'stale', text: '参数已修改，结果已过期' }
  if (lastStep?.status === 'success') return { tone: 'success', text: `上次成功 · ${lastStep.durationMs}ms` }
  if (lastStep?.status === 'error') return { tone: 'error', text: '上次执行失败' }
  return { tone: 'idle', text: '尚未运行' }
}
