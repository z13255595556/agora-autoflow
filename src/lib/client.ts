import type { NodeType } from '../types'

/**
 * 节点服务客户端。
 *
 * 后端在不在都能用：启动时探一次 /health，探到了 SQL 节点走真实执行，
 * 探不到就整个退回 mock。这样没配凭证的人也能打开编辑器摆流程。
 */

// 8787 被内网的 agora-gateway 占着，避开
const BASE = (import.meta.env.VITE_SQL_SERVICE as string | undefined) ?? 'http://localhost:8791'

let online = false
export const isOnline = () => online

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!resp.ok) {
    // FastAPI 的错误在 detail 里，把原话带出来 —— "占位符没有对应参数" 和
    // "机器人账号不可用" 是完全不同的两件事，吞掉就没法排查
    let detail = `HTTP ${resp.status}`
    try {
      const body = await resp.json()
      detail = body?.detail ?? detail
    } catch {
      /* 非 JSON 错误体，保留状态码 */
    }
    throw new Error(detail)
  }
  return resp.json() as Promise<T>
}

export interface Health {
  ok: boolean
  endpoint: string
  missingCredentials: string[]
}

/** 探活。返回 null 表示后端不在，调用方应退回 mock。 */
export async function health(): Promise<Health | null> {
  try {
    const h = await req<Health>('/health')
    online = true
    return h
  } catch {
    online = false
    return null
  }
}

export async function fetchNodes(): Promise<NodeType[]> {
  const { nodes } = await req<{ nodes: NodeType[] }>('/registry/nodes')
  return nodes
}

export async function fetchOptions(key: string): Promise<string[]> {
  const { options } = await req<{ options: Array<{ value: string; label?: string }> }>(
    `/options/${encodeURIComponent(key)}`,
  )
  return options.map((o) => o.value)
}

export interface SubmitResult {
  handle: string
  renderedSql?: string
  limit?: number
}

export interface PollResult {
  done: boolean
  failed?: boolean
  progress: number
  status?: string
  error?: string
  output?: Record<string, unknown>
}

export function submitNode(type: string, params: Record<string, unknown>) {
  return req<SubmitResult>(`/nodes/${type}/submit`, {
    method: 'POST',
    body: JSON.stringify({ params }),
  })
}

export function probeNodeRemote(type: string, params: Record<string, unknown>) {
  return req<SubmitResult>(`/nodes/${type}/probe`, {
    method: 'POST',
    body: JSON.stringify({ params }),
  })
}

/** 同步节点：一次请求拿结果（runtime.kind === 'http'） */
export function executeNode(type: string, params: Record<string, unknown>) {
  return req<{ output: Record<string, unknown> }>(`/nodes/${type}/execute`, {
    method: 'POST',
    body: JSON.stringify({ params }),
  })
}

export function pollNode(type: string, handle: string, limit = 1000) {
  return req<PollResult>(
    `/nodes/${type}/poll?handle=${encodeURIComponent(handle)}&limit=${limit}`,
  )
}

/** 中止时务必调 —— 不取消的话平台那边继续跑，白烧集群资源。 */
export function cancelNode(type: string, handle: string) {
  return req<{ cancelled: boolean }>(`/nodes/${type}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ handle }),
  }).catch(() => ({ cancelled: false }))
}

