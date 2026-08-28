/**
 * 从 NateScarlet/holiday-cn 拉国务院放假 JSON，写入 src/lib/engine-core/cn-calendar/。
 * worker 运行时也会再拉；这个脚本是把新一年写进仓库，离线/测试不依赖外网。
 *
 *   npm run update:cn-calendar
 */
const YEARS = (() => {
  const y = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date()))
  return [y - 1, y, y + 1]
})()

const urls = (year: number) => [
  `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
  `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`,
]

const dir = new URL('../src/lib/engine-core/cn-calendar/', import.meta.url)

async function pull(year: number): Promise<unknown | null> {
  for (const url of urls(year)) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!r.ok) continue
      const data = await r.json() as { year?: number; days?: unknown[] }
      if (data.year !== year || !Array.isArray(data.days)) continue
      if (data.days.length === 0) {
        console.log(`${year}: 还是空表（国务院多半没公布），不写文件`)
        return null
      }
      return data
    } catch (err) {
      console.warn(`${year}: ${url} 失败：${err instanceof Error ? err.message : err}`)
    }
  }
  return null
}

const { writeFileSync, mkdirSync } = await import('node:fs')
mkdirSync(dir, { recursive: true })
for (const year of YEARS) {
  const data = await pull(year)
  if (!data) continue
  const path = new URL(`${year}.json`, dir)
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`)
  console.log(`wrote ${path.pathname}`)
}
