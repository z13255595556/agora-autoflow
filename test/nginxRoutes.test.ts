import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 后端路由 ←→ nginx 显式转发名单的对齐门禁（manifestParity 同款思路）。
 *
 * deploy/nginx.conf 的设计是"不在 /api 下的接口必须逐个显式列出"，
 * 漏一个**不报任何错**：请求落进 SPA 回退，接口原地变成 200 + HTML 首页。
 * 真实事故：/sandbox/env 上线时没进名单，编辑器的「运行环境」悬浮窗
 * 永远停在「读取中…」，本地 dev（前端直连 8791，没有 nginx）
 * 永远复现不出来 —— 只有部署后才炸的坑，必须靠静态比对拦在提交前。
 *
 * 只比"路径第一段"：nginx 按前缀转发，段内的具体路由到了后端自然有 404。
 */

const py = readFileSync(new URL('../server/sql_service/main.py', import.meta.url), 'utf8')
const conf = readFileSync(new URL('../deploy/nginx.conf', import.meta.url), 'utf8')

test('后端每个顶层路径段都在 nginx.conf 里有显式 location', () => {
  const segments = new Set<string>()
  for (const m of py.matchAll(/@app\.(?:get|post|put|delete|patch|websocket)\(\s*"(\/[^"]+)"/g)) {
    const seg = m[1].split('/')[1]
    // 参数段（如 "/{token}"）没有字面前缀可比 —— 目前没有这种顶层路由，出现了再议
    if (seg && !seg.startsWith('{')) segments.add(seg)
  }
  // 解析不出任何路由说明正则和 main.py 的写法脱节了，那门禁就是摆设
  assert.ok(segments.size >= 5, `只从 main.py 解析出 ${segments.size} 个路径段，正则八成失效了`)

  const covered = new Set<string>()
  for (const m of conf.matchAll(/location\s*=\s*\/(\w+)/g)) covered.add(m[1])          // location = /health
  for (const m of conf.matchAll(/location\s+\/(\w+)\//g)) covered.add(m[1])            // location /api/
  for (const m of conf.matchAll(/location\s*~\s*\^\/\(([^)]+)\)\//g)) {                 // location ~ ^/(a|b)/
    for (const s of m[1].split('|')) covered.add(s)
  }

  const missing = [...segments].filter((s) => !covered.has(s))
  assert.deepEqual(
    missing,
    [],
    `这些后端路径段没有进 deploy/nginx.conf 的转发名单：${missing.join('、')}。` +
      '部署后它们会命中 SPA 回退返回 HTML 首页（200），调用方只会看到一个 JSON 解析错。' +
      '裸机部署的 nginx 配置也要照着补同一段。',
  )
})
