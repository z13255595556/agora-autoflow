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
