import type { FlowDefinition } from '../types'
import { newFlowId } from './library'

/**
 * 首页的模板。
 *
 * 挑选标准：这个工具八成的用途就是"定时跑个 SQL 发到群里"。空白画布对着
 * 一个触发器发呆最劝退，从一条连好线的流程改起，比从零拖三个节点快得多。
 *
 * 模板只搭骨架、连好线，SQL 和 webhook 留空 —— 那两样必须用户自己填，
 * 预填假值只会让人以为能直接跑。
 */

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
    key: 'blank',
    name: '空白流程',
    desc: '只有一个手动触发，从头自己搭',
    icon: '＋',
    build: () => ({
      ...base('未命名流程'),
      trigger: { kind: 'manual' },
      nodes: [
        { id: 'n1', type: 'trigger.manual', typeVersion: '1.0.0', name: '手动触发', params: {}, onError: 'fail' },
      ],
      edges: [],
      layout: { n1: { x: 60, y: 200 } },
    }),
  },
  {
    key: 'daily-report',
    name: '每天定时发日报',
    desc: '定时触发 → SQL 查询 → 企微通知，三个节点已连好，填 SQL 和群机器人地址就能跑',
    icon: '⏰',
    build: () => ({
      ...base('每日报表'),
      trigger: { kind: 'schedule', mode: 'daily', at: '09:00' },
      nodes: [
        {
          id: 'n1', type: 'trigger.schedule', typeVersion: '1.0.0', name: '每天 09:00',
          params: { mode: 'daily', at: '09:00' }, onError: 'fail',
        },
        {
          id: 'n2', type: 'date.compute', typeVersion: '1.0.0', name: '昨天',
          params: { mode: 'yesterday', format: 'compact' }, onError: 'fail',
        },
        {
          id: 'n3', type: 'sql.query', typeVersion: '2.0.0', name: 'SQL 查询',
          // dt 用上游算出来的昨天，直接给出"日期怎么进 SQL"的正确写法
          params: {
            engine: 'hive', limit: 1000, queue: 'share',
            sql: "SELECT *\nFROM ods.your_table\nWHERE dt = '{{ $.nodes.n2.output.compact }}'",
          },
          onError: 'fail',
        },
        {
          id: 'n4', type: 'notify.wecom', typeVersion: '1.0.0', name: '企微通知',
          params: {
            msgtype: 'markdown_v2',
            content:
              '## 日报 {{ $.nodes.n2.output.date }}\n共 {{ $.nodes.n3.output.rowCount }} 条\n\n{{ $.nodes.n3.output.rows | table() }}',
          },
          onError: 'fail',
        },
      ],
      edges: [
        { from: 'n1', to: 'n2' },
        { from: 'n2', to: 'n3' },
        { from: 'n3', to: 'n4' },
      ],
      layout: { n1: { x: 60, y: 200 }, n2: { x: 400, y: 200 }, n3: { x: 740, y: 200 }, n4: { x: 1080, y: 200 } },
    }),
  },
  {
    key: 'query-notify',
    name: '查一次发到群里',
    desc: '手动触发 → SQL 查询 → 企微通知。临时排查、一次性核对用这个',
    icon: '▶',
    build: () => ({
      ...base('临时查询'),
      trigger: { kind: 'manual' },
      nodes: [
        { id: 'n1', type: 'trigger.manual', typeVersion: '1.0.0', name: '手动触发', params: {}, onError: 'fail' },
        {
          id: 'n2', type: 'sql.query', typeVersion: '2.0.0', name: 'SQL 查询',
          params: { engine: 'hive', limit: 1000, queue: 'share', sql: '' }, onError: 'fail',
        },
        {
          id: 'n3', type: 'notify.wecom', typeVersion: '1.0.0', name: '企微通知',
          params: {
            msgtype: 'markdown_v2',
            content: '共 {{ $.nodes.n2.output.rowCount }} 条\n\n{{ $.nodes.n2.output.rows | table() }}',
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
]
