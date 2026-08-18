import type { FlowDefinition } from '../types'
import { newFlowId } from './library.ts'

/** 新建流程可从常用业务模板或单一触发方式开始。 */

export interface Template {
  key: string
  name: string
  desc: string
  icon: string
  build: () => FlowDefinition
}

const base = (name: string): Omit<FlowDefinition, 'nodes' | 'edges' | 'layout' | 'trigger'> => ({
  id: newFlowId(),
  version: 1,
  name,
  inputs: { type: 'object', properties: {} },
})

export const TEMPLATES: Template[] = [
  {
    key: 'scheduled-sql',
    name: '定时查询 SQL',
    desc: '定时触发 → DataLego SQL → 企微通知，填好 SQL 和通知内容即可使用',
    icon: '⏰',
    build: () => ({
      ...base('定时查询 SQL'),
      trigger: { kind: 'schedule', mode: 'daily', at: '09:00', timezone: 'Asia/Shanghai' },
      nodes: [
        {
          id: 'n1', type: 'trigger.schedule', typeVersion: '1.0.0', name: '每天 09:00',
          params: { mode: 'daily', at: '09:00', timezone: 'Asia/Shanghai' }, onError: 'fail',
        },
        {
          id: 'n2', type: 'sql.query', typeVersion: '2.0.0', name: 'DataLego SQL',
          params: { engine: 'hive', limit: 1000, queue: 'share', sql: '' }, onError: 'fail',
        },
        {
          id: 'n3', type: 'notify.wecom', typeVersion: '1.0.0', name: '企微通知',
          params: {
            msgtype: 'markdown_v2',
            content: '查询完成，共 {{ $.nodes.n2.output.rowCount }} 条\n\n{{ $.nodes.n2.output.rows | table() }}',
          },
          onError: 'fail',
        },
      ],
      edges: [
        { from: 'n1', to: 'n2' },
        { from: 'n2', to: 'n3' },
      ],
      layout: { n1: { x: 60, y: 200 }, n2: { x: 400, y: 200 }, n3: { x: 740, y: 200 } },
    }),
  },
  {
    key: 'manual',
    name: '手动触发',
    desc: '从编辑器手动运行，适合调试和临时任务',
    icon: '▶',
    build: () => ({
      ...base('手动流程'),
      trigger: { kind: 'manual' },
      nodes: [
        { id: 'n1', type: 'trigger.manual', typeVersion: '1.0.0', name: '手动触发', params: {}, onError: 'fail' },
      ],
      edges: [],
      layout: { n1: { x: 60, y: 200 } },
    }),
  },
  {
    key: 'schedule',
    name: '定时器触发',
    desc: '默认每天北京时间 09:00 自动运行，可在节点参数中调整',
    icon: '⏰',
    build: () => ({
      ...base('定时流程'),
      trigger: { kind: 'schedule', mode: 'daily', at: '09:00', timezone: 'Asia/Shanghai' },
      nodes: [
        {
          id: 'n1', type: 'trigger.schedule', typeVersion: '1.0.0', name: '每天 09:00',
          params: { mode: 'daily', at: '09:00', timezone: 'Asia/Shanghai' }, onError: 'fail',
        },
      ],
      edges: [],
      layout: { n1: { x: 60, y: 200 } },
    }),
  },
  {
    key: 'webhook',
    name: 'Webhook 触发',
    desc: '外部系统通过 HTTP POST 触发流程',
    icon: '🔗',
    build: () => ({
      ...base('Webhook 流程'),
      trigger: { kind: 'webhook', authMode: 'secret', responseMode: 'lastNode', responseTimeoutSeconds: 300, rateLimitPerMin: 60 },
      nodes: [
        {
          id: 'n1', type: 'trigger.webhook', typeVersion: '1.0.0', name: 'Webhook 触发',
          params: { authMode: 'secret', responseMode: 'lastNode', responseTimeoutSeconds: 300, rateLimitPerMin: 60 },
          onError: 'fail',
        },
      ],
      edges: [],
      layout: { n1: { x: 60, y: 200 } },
    }),
  },
]
