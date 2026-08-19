import type { FlowDefinition, NodeType } from '../types'
import { setSchedulerAlive } from './scheduler.ts'
import { APP_BASE_PREFIX } from './basePath.ts'

/**
 * 节点服务客户端。
 *
 * 后端在不在都能用：启动时探一次 /health，探到了 SQL 节点走真实执行，
 * 探不到就整个退回 mock。这样没配凭证的人也能打开编辑器摆流程。
 */

// 8787 被内网的 agora-gateway 占着，避开
// `?.`：test/ 走 node --test 直接跑源码，那里没有 import.meta.env
const BASE = (import.meta.env?.VITE_SQL_SERVICE as string | undefined)
  ?? (import.meta.env?.DEV ? 'http://localhost:8791' : APP_BASE_PREFIX)

/**
 * 请求超时。
 *
 * 以前一个都没有 —— fetch 不带超时，一次 poll 请求挂住就是**永久**挂住：
 * engine 的 MAX_CONSECUTIVE_POLL_FAILURES=5 靠"这次失败了"来计数，
 * 而永远不返回的请求既不成功也不失败，那个计数器永远数不到 5，
 * 整条运行就停在 running 上不动，界面显示"查询中"。
 *
 * 分档而不是一个数：poll/health 本来就是秒回的，30 秒都算宽；
 * 而 execute 打的是 http.request 节点，服务端自己允许到 120 秒。
 */
const TIMEOUT_MS = { default: 30_000, execute: 130_000 } as const

let online = false
export const isOnline = () => online

/**
 * 服务端的流程存储可用吗。
 *
 * 和 isOnline() 分开：节点服务在、但没配 DATABASE_URL 是完全正常的一档状态
 * （节点照跑，流程存浏览器本地）。合成一个布尔会让"能跑 SQL"和"流程存哪"
 * 这两件毫不相干的事互相牵连。
 */
let remoteStorage = false
export const hasRemoteStorage = () => remoteStorage

async function req<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const timeout = AbortSignal.timeout(init?.timeoutMs ?? TIMEOUT_MS.default)
  const resp = await fetch(`${BASE}${path}`, {
    ...init,
    // 调用方自己的 signal（中止运行）和超时是两回事，两个都要生效
    signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!resp.ok) {
    // FastAPI 的错误在 detail 里，把原话带出来 —— "占位符没有对应参数" 和
    // "机器人账号不可用" 是完全不同的两件事，吞掉就没法排查
    let detail = `HTTP ${resp.status}`
    let code: string | undefined
    try {
      const body = await resp.json()
      // 服务端现在返回 {code, retryable, message}；老格式是一个字符串
      const d = body?.detail
      if (d && typeof d === 'object') {
        detail = d.message ?? detail
        code = d.code
      } else if (typeof d === 'string') {
        detail = d
      }
    } catch {
      /* 非 JSON 错误体，保留状态码 */
    }
    // 错误码挂在异常上：引擎据此判定要不要重试，而不是去匹配文案
    throw Object.assign(new Error(detail), { code, status: resp.status })
  }
  return resp.json() as Promise<T>
}

/** 流程持久化的可用性。和节点服务是**两档独立能力**：没有数据库节点照样跑 */
export interface StorageHealth {
  configured: boolean
  ok: boolean
  detail: string | null
}

export interface Health {
  ok: boolean
  endpoint: string
  missingCredentials: string[]
  /** 老版本服务端没有这个字段 —— 当作"没有存储"处理，前端继续用 localStorage */
  storage?: StorageHealth
  /** 调度器活着没。老版本没有这个字段 → 当作没在跑 */
  scheduler?: { alive: boolean; lastBeatAt: string | null; detail: string | null }
}

/** 探活。返回 null 表示后端不在，调用方应退回 mock。 */
export async function health(): Promise<Health | null> {
  try {
    const h = await req<Health>('/health')
    online = true
    remoteStorage = Boolean(h.storage?.ok)
    setSchedulerAlive(Boolean(h.scheduler?.alive))
    return h
  } catch {
    online = false
    remoteStorage = false
    setSchedulerAlive(false)
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
    // http.request 节点服务端自己允许到 120 秒，客户端不能比它先放弃
    timeoutMs: TIMEOUT_MS.execute,
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

// ---------------------------------------------------------------- 流程（控制面）
//
// 和 /nodes/* 分两档：那些是节点执行面，引擎调用；这些是控制面，编辑器调用。

/** 服务端返回的流程摘要。`draft` 只在取单条时有 */
export interface RemoteFlow {
  id: string
  name: string
  activeVersion: number | null
  updatedAt: string | null
  archivedAt: string | null
  nodeCount: number
  nodeTypes: string[]
  triggerKind: string
  /** 草稿和已发布那一版不一致（只比逻辑不比布局） */
  hasUnpublishedChanges: boolean
  /**
   * 归属（邮箱）。null = 还没有主 —— 是 owner 那次迁移之前建的流程。
   *
   * 普通用户的列表里只有两种：我的，和无主的。**管理员例外** —— 服务端会把
   * 全部流程都返回，此时这个字段是「这是谁的」的唯一来源。
   *
   * 即便如此也**不要拿它在前端做过滤**：能不能看见由服务端的视角决定，
   * 前端再筛一遍只会在两边不一致时产生一个谁都解释不了的空列表。
   */
  owner: string | null
  draft?: Record<string, unknown>
}

/** 这次请求以谁的身份查数。/whoami 的返回 */
export interface WhoAmI {
  creator: string | null
  source: 'athena' | 'worker' | 'none'
  note: string | null
  /**
   * 是不是管理员。**和服务端每个接口放行用的是同一个判定**（identity.is_admin）——
   * 不要改成自己去 user.isAdmin 里推：两条路径迟早会分叉，症状是
   * 界面上有按钮、点下去 403，或者更糟的反过来。
   *
   * 它只决定**显不显示**。权限本身在服务端，前端能改的东西不能当权限用。
   */
  isAdmin?: boolean
  /** athena 校验过的登录用户。认不出身份时为 null */
  user?: {
    id: string
    email: string
    displayName: string
    permissions: string[]
    /** 管理员。**服务端每个接口自己再判一次** —— 这个字段只用来决定界面显不显示，
     *  不是权限本身。前端能改的东西不能是权限 */
    isAdmin: boolean
  } | null
}

export function whoami() {
  return req<WhoAmI>('/whoami')
}

export interface UsageOverview {
  days: number
  /** 统计从哪天开始有数。看板要写出来，否则「最近 365 天」在一个上线两周的
   *  系统上会让人以为前面 351 天真的没人用 */
  since: string | null
  totals: {
    runs: number; succeeded: number; failed: number; canceled: number
    steps: number; flows: number; owners: number; avgDurationMs: number | null
  }
  byDay: Array<{ day: string; runs: number; succeeded: number; failed: number }>
  byFlow: Array<{
    flowId: string; flowName: string; owner: string | null
    runs: number; succeeded: number; failed: number; avgDurationMs: number | null
  }>
  byOwner: Array<{ owner: string | null; runs: number; flows: number; failed: number }>
  byTrigger: Array<{ triggerKind: string; runs: number }>
}

/** 用量看板。只有管理员能调，服务端 403 —— 前端那个 isAdmin 只决定显不显示入口 */
export function adminUsage(days = 30) {
  return req<UsageOverview>(`/api/admin/usage?days=${days}`)
}

export interface FlowVersionMeta {
  version: number
  createdAt: string
  createdBy: string | null
}

/**
 * 流程列表。
 *
 * `scope='all'` 是管理台，要管理员权限。**默认永远是 'mine'** ——
 * 管理员身份不该悄悄把他自己的工作台换成全公司的流程：那样他就再也看不到
 * 自己每天真正在用的那一屏了。
 */
export function listRemoteFlows(includeArchived = false, scope: 'mine' | 'all' = 'mine') {
  return req<{ flows: RemoteFlow[] }>(
    `/api/flows?includeArchived=${includeArchived}&scope=${scope}`,
  ).then((r) => r.flows)
}

export function getRemoteFlow(id: string) {
  return req<RemoteFlow>(`/api/flows/${encodeURIComponent(id)}`)
}

export function createRemoteFlow(id: string, definition: unknown) {
  return req<RemoteFlow>('/api/flows', { method: 'POST', body: JSON.stringify({ id, definition }) })
}

export function saveRemoteFlow(id: string, definition: unknown) {
  return req<RemoteFlow>(`/api/flows/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ definition }),
  })
}

export function publishRemoteFlow(id: string) {
  return req<RemoteFlow>(`/api/flows/${encodeURIComponent(id)}/publish`, { method: 'POST' })
}

export function listRemoteVersions(id: string) {
  return req<{ versions: FlowVersionMeta[] }>(`/api/flows/${encodeURIComponent(id)}/versions`).then((r) => r.versions)
}

/**
 * 取某一版的定义。**查运行记录时用它把 nodeId 翻成节点名。**
 *
 * 必须按运行钉住的那一版取，不能拿当前草稿凑合：流程改过之后草稿里可能
 * 已经没有这个节点了，或者同一个 id 换成了另一种节点 —— 那时界面上会给出
 * 一个看着合理、实际错误的名字，而这正是查历史最不能出错的地方。
 */
export function getRemoteVersion(id: string, version: number) {
  return req<{ version: number; definition: FlowDefinition; createdAt: string; createdBy: string | null }>(
    `/api/flows/${encodeURIComponent(id)}/versions/${version}`,
  )
}

export function archiveRemoteFlow(id: string) {
  return req<{ archived: boolean }>(`/api/flows/${encodeURIComponent(id)}`, { method: 'DELETE' })
}


// ---------------------------------------------------------------- Webhook
//
// 触发入口不在 /api 下（token 在路径、密钥在头），但**管理**它的接口在。

export interface RemoteWebhook {
  id: string
  flowId: string
  token: string
  authMode: 'secret' | 'hmac' | 'none'
  responseMode: 'immediate' | 'lastNode'
  responseTimeoutSeconds: number
  enabled: boolean
  rateLimitPerMin: number
  /** 服务端给的路径部分，不含域名 */
  path: string
  createdAt: string
  rotatedAt: string | null
  /** 可持续查看的调用密钥；旧版本创建且尚未轮换的 Webhook 可能为 null */
  secret?: string | null
}

export interface WebhookDelivery {
  receivedAt: string
  remoteIp: string | null
  statusCode: number
  rejectReason: string | null
  bodyBytes: number | null
  runId: string | null
}

export interface WebhookView {
  webhook: RemoteWebhook | null
  deliveries: WebhookDelivery[]
  /** null = 流程从未发布 → webhook 打过来只会拿到 409 */
  activeVersion: number | null
}

export interface WebhookSettings {
  authMode?: string
  rateLimitPerMin?: number
  responseMode?: string
  responseTimeoutSeconds?: number
  enabled?: boolean
}

export function getFlowWebhook(flowId: string) {
  return req<WebhookView>(`/api/flows/${encodeURIComponent(flowId)}/webhook`)
}

export function createFlowWebhook(flowId: string, settings: WebhookSettings = {}) {
  return req<RemoteWebhook>(`/api/flows/${encodeURIComponent(flowId)}/webhook`, {
    method: 'POST',
    body: JSON.stringify(settings),
  })
}

export function updateFlowWebhook(flowId: string, settings: WebhookSettings) {
  return req<RemoteWebhook>(`/api/flows/${encodeURIComponent(flowId)}/webhook`, {
    method: 'PUT',
    body: JSON.stringify(settings),
  })
}

export function rotateFlowWebhook(flowId: string) {
  return req<RemoteWebhook>(`/api/flows/${encodeURIComponent(flowId)}/webhook/rotate`, {
    method: 'POST',
  })
}

/**
 * webhook 完整地址的域名部分。
 *
 * BASE 既可能是本机开发的绝对地址，也可能是服务器上的挂载前缀。
 *
 * 拼错的后果特别隐蔽：面板上显示得好好的，用户复制给上游，对方打过来 404。
 */
export function webhookOrigin(): string {
  if (typeof window === 'undefined') return /^https?:\/\//i.test(BASE) ? BASE.replace(/\/+$/, '') : ''
  return new URL(BASE || '/', window.location.origin).toString().replace(/\/+$/, '')
}


// ---------------------------------------------------------------- 运行
//
// 执行发生在服务端 worker 上。前端只入队和查询 —— 关掉浏览器流程照跑。

export interface RemoteStep {
  nodeId: string
  loopPath: number[]
  status: string
  attempt: number
  input: Record<string, unknown> | null
  output: unknown
  error: string | null
  failureKind: string | null
  waitKind: string | null
  matched: boolean | null
  fanout: number | null
  /** 在不在等平台出结果。handle 本身是内部断点，不外泄 */
  hasHandle: boolean
  skipReason: unknown
  seq: number
  startedAt: string | null
  finishedAt: string | null
}

export interface RemoteRun {
  id: string
  flowId: string
  flowVersion: number
  status: string
  mode: string
  triggerKind: string
  triggerInput: Record<string, unknown>
  scheduledTime: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  attempt: number
  steps?: RemoteStep[]
}

export function createRun(flowId: string, inputs: Record<string, unknown>) {
  return req<{ runId: string; status: string }>(`/api/flows/${encodeURIComponent(flowId)}/runs`, {
    method: 'POST',
    body: JSON.stringify({ inputs, mode: 'manual' }),
  })
}

export function getRun(runId: string) {
  return req<RemoteRun>(`/api/runs/${encodeURIComponent(runId)}`)
}

/**
 * 某条流程的运行记录。**服务端那份才是历史。**
 *
 * 运行面板里那个「历史」只有本次会话跑过的、上限 20 条、刷新即失 ——
 * 而库里那份带着每个节点的输入输出、保留 14 天。要查「昨天定时任务
 * 为什么失败」，只有这个接口答得上来。
 *
 * 返回的行**不带 steps**（列表不搬结果集，那可能很大）；要看分步去调 getRun。
 */
export function listRuns(flowId: string, limit = 50) {
  return req<{ runs: RemoteRun[] }>(
    `/api/runs?flowId=${encodeURIComponent(flowId)}&limit=${limit}`,
  ).then((r) => r.runs)
}

/** 中止。**不是停止轮询** —— 平台上的任务要真的撤掉，不撤会继续跑完白烧资源 */
export function cancelRun(runId: string) {
  return req<{ status: string }>(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
    .catch(() => ({ status: 'unknown' }))
}
