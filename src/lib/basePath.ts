type ViteEnv = { BASE_URL?: string }

const viteEnv = (import.meta as ImportMeta & { env?: ViteEnv }).env

export function normalizeAppBase(value: string | undefined): string {
  const raw = (value || '/').trim()
  if (!raw || raw === '/') return '/'
  return `/${raw.replace(/^\/+|\/+$/g, '')}/`
}

export const APP_BASE = normalizeAppBase(viteEnv?.BASE_URL)

/** Nginx 挂载前缀；根路径部署时为空字符串。 */
export const APP_BASE_PREFIX = APP_BASE === '/' ? '' : APP_BASE.slice(0, -1)

export function appHref(path = '/'): string {
  const suffix = path === '/' ? '' : `/${path.replace(/^\/+/, '')}`
  return `${APP_BASE_PREFIX}${suffix || '/'}`
}

/** 将浏览器的真实路径还原成应用内部路由。 */
export function stripAppBase(pathname: string): string {
  if (!APP_BASE_PREFIX) return pathname
  if (pathname === APP_BASE_PREFIX || pathname === `${APP_BASE_PREFIX}/`) return '/'
  if (pathname.startsWith(`${APP_BASE_PREFIX}/`)) return pathname.slice(APP_BASE_PREFIX.length)
  return pathname
}
