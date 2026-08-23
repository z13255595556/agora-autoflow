export type AppRoute =
  | { kind: 'home'; openRun?: { flowId: string; runId?: string } }
  | { kind: 'editor'; flowId: string }
  | { kind: 'invalid' }

/**
 * 路径 → 页面。`search` 只在首页有意义：`/?flow=<id>&run=<id>` 直接打开那条运行记录 ——
 * 失败告警里的链接指的就是它。在此之前前端没有任何能打开某次运行的 URL，
 * 告警只能给一个 /api/runs/{id} 的 JSON 接口
 */
export function routeFromPath(pathname: string, search = ''): AppRoute {
  if (pathname === '/' || pathname === '/index.html') {
    const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    const flowId = q.get('flow')?.trim()
    const runId = q.get('run')?.trim()
    return flowId ? { kind: 'home', openRun: { flowId, ...(runId ? { runId } : {}) } } : { kind: 'home' }
  }
  const match = /^\/workflows\/([^/]+)\/?$/.exec(pathname)
  if (!match) return { kind: 'invalid' }
  try {
    const flowId = decodeURIComponent(match[1])
    return flowId ? { kind: 'editor', flowId } : { kind: 'invalid' }
  } catch {
    return { kind: 'invalid' }
  }
}
