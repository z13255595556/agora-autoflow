import type { FlowDefinition } from '../types'
import { normalizeFlowDefinition } from './flowImport'

/**
 * 本地流程库：首页「最近编辑」的数据源。
 *
 * 存在 localStorage 而不是内存：首页要是刷新一下就空了，它就只是个开屏页，
 * 没有存在的必要。编辑器会防抖自动落盘，用户也可以立即保存。
 * 后端有了之后这一层换成 GET/PUT /flows，首页的调用方式不变。
 */

const KEY = 'autoflow.flows.v1'
/** 只留最近这些条。流程定义可能很大，localStorage 总共就 5MB 左右 */
const MAX = 30

export interface SavedFlow {
  id: string
  name: string
  /** 毫秒时间戳 */
  updatedAt: number
  nodeCount: number
  def: FlowDefinition
}

/**
 * 读整个库。localStorage 在隐私模式/配额满时会抛，存的内容也可能被别的版本
 * 写坏 —— 这两种情况都当"库是空的"，绝不能让首页白屏。
 */
export function listFlows(): SavedFlow[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item): SavedFlow[] => {
      if (!item || typeof item !== 'object') return []
      const candidate = item as Partial<SavedFlow>
      if (typeof candidate.id !== 'string' || !candidate.def) return []
      try {
        const def = normalizeFlowDefinition(candidate.def, candidate.id)
        return [{
          id: candidate.id,
          name: typeof candidate.name === 'string' ? candidate.name : def.name,
          updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : 0,
          nodeCount: def.nodes.length,
          def: { ...def, id: candidate.id },
        }]
      } catch {
        return []
      }
    }).sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

function write(list: SavedFlow[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)))
    return true
  } catch {
    // 配额满 / 隐私模式：不能让编辑器崩，但也不能向 UI 谎报已经保存。
    return false
  }
}

/** 覆盖式保存（按 id）；返回 false 表示本地存储拒绝了写入。 */
export function saveFlow(def: FlowDefinition, at: number = Date.now()): boolean {
  const rest = listFlows().filter((f) => f.id !== def.id)
  return write([{ id: def.id, name: def.name, updatedAt: at, nodeCount: def.nodes.length, def }, ...rest])
}

export function deleteFlow(id: string): void {
  void write(listFlows().filter((f) => f.id !== id))
}

export function getFlow(id: string): SavedFlow | null {
  return listFlows().find((f) => f.id === id) ?? null
}

/** 每条流程一个新 id —— 不然新建出来的都叫 flow_draft，互相覆盖 */
export function newFlowId(): string {
  return `flow_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`
}
