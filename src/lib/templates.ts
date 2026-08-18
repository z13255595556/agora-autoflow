import type { FlowDefinition } from '../types'
import { newFlowId } from './library.ts'

/** 新建流程先选择触发方式；后续节点由用户按实际任务添加。 */

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
