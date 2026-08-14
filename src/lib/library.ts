import type { FlowDefinition } from '../types'

/**
 * 本地流程库：首页「最近编辑」的数据源。
 *
 * 存在 localStorage 而不是内存：首页要是刷新一下就空了，它就只是个开屏页，
 * 没有存在的必要。写入只发生在用户点「保存」的时候 —— 编辑器不自动落盘。
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
    return parsed
      .filter((f): f is SavedFlow => !!f && typeof f.id === 'string' && !!f.def)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

function write(list: SavedFlow[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)))
  } catch {
    // 配额满 / 隐私模式：存不下就算了，不能因为存草稿失败把编辑器搞崩
  }
}

/** 覆盖式保存（按 id）。只有用户点「保存」才会走到这里 */
export function saveFlow(def: FlowDefinition, at: number = Date.now()): void {
  const rest = listFlows().filter((f) => f.id !== def.id)
  write([{ id: def.id, name: def.name, updatedAt: at, nodeCount: def.nodes.length, def }, ...rest])
}

export function deleteFlow(id: string): void {
  write(listFlows().filter((f) => f.id !== id))
}

export function getFlow(id: string): SavedFlow | null {
  return listFlows().find((f) => f.id === id) ?? null
}

/** 每条流程一个新 id —— 不然新建出来的都叫 flow_draft，互相覆盖 */
export function newFlowId(): string {
  return `flow_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`
}
