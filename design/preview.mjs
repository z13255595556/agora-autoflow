// 只为本地自查：把 .dc.html 里的取值洞和 sc-if 解掉，出一份能直接看的静态页。
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
const dir = new URL('./', import.meta.url)
mkdirSync(new URL('./preview/', dir), { recursive: true })
const names = readdirSync(dir).filter((f) => f.endsWith('.dc.html')).map((f) => f.replace('.dc.html', ''))

const vals = (open) => ({
  open, closed: !open,
  openCls: open ? 'is-open' : '',
  activeCls: open ? 'nx-field-active' : '',
  ghostCls: open ? 'is-in' : '',
  outW: open ? '280px' : '400px',
  inW: open ? '220px' : '300px',
})

for (const name of names) {
  const src = readFileSync(new URL(`./${name}.dc.html`, dir), 'utf8')
  const style = src.match(/<style>([\s\S]*?)<\/style>/)[1]
  const body = src.split('</helmet>')[1].split('</x-dc>')[0]
  for (const open of [false, true]) {
    const v = vals(open)
    const out = body
      .replace(/<sc-if value="\{\{ (\w+) \}\}"[^>]*>([\s\S]*?)<\/sc-if>/g, (_, k, inner) => (v[k] ? inner : ''))
      .replace(/ onClick="\{\{ \w+ \}\}"/g, '')
      .replace(/\{\{ (\w+) \}\}/g, (_, k) => String(v[k] ?? ''))
    writeFileSync(new URL(`./preview/${name}-${open ? 'open' : 'closed'}.html`, dir),
      `<!doctype html><html><head><meta charset="utf-8"><style>${style}</style></head><body>${out}</body></html>`)
  }
}
console.log('preview:', names.length * 2, 'states')
