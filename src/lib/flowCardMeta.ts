import type { FlowDefinition } from '../types.ts'
import { describeSchedule } from './schedule.ts'

const LABEL: Record<string, string> = {
  'sql.query': 'SQL',
  'postgres.workspace': 'Postgres',
  'http.request': 'HTTP',
  'notify.wecom': '企微',
  'date.compute': '日期',
  'flow.if': '条件',
  'flow.foreach': '循环',
  'transform.template': '模板',
  'transform.map': '整形',
}

export function flowCardMeta(def: FlowDefinition): { nodeLabels: string[]; scheduleText: string | null } {
  const labels: string[] = []
  for (const node of def.nodes) {
    if (node.type.startsWith('trigger.')) continue
    const label = LABEL[node.type]
    if (label && !labels.includes(label)) labels.push(label)
    if (labels.length >= 3) break
  }
  // 本机没缓存过的流程在列表里只是个壳（library.ts 里 nodes: [] 且没有 trigger），
  // 读 def.trigger.kind 会直接炸掉整个首页
  const scheduleText = def.trigger?.kind === 'schedule' ? describeSchedule(def.trigger) : null
  return { nodeLabels: labels, scheduleText }
}
