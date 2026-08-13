/**
 * 定时触发的参数 → 一句人话。
 *
 * 画布上和配置面板里都用它。用户不该为了确认"我到底设成几点了"去脑内解析
 * 一串 cron —— 尤其 cron 的五段顺序（分 时 日 月 周）本身就是最容易记反的东西。
 */
export function describeSchedule(params: Record<string, unknown>): string {
  const mode = String(params.mode ?? 'daily')
  switch (mode) {
    case 'daily': {
      const at = String(params.at ?? '').trim()
      return at ? `每天 ${at}` : '每天（未填时间）'
    }
    case 'hourly': {
      const m = Number(params.minute ?? 0)
      return Number.isFinite(m) ? `每小时第 ${m} 分钟` : '每小时'
    }
    case 'interval': {
      const n = Number(params.everyMinutes ?? 0)
      if (!Number.isFinite(n) || n <= 0) return '按间隔（未填间隔）'
      if (n % 60 === 0) return `每 ${n / 60} 小时`
      return `每 ${n} 分钟`
    }
    case 'cron': {
      const c = String(params.cron ?? '').trim()
      return c ? describeCron(c) : 'Cron（未填表达式）'
    }
    default:
      return '未设置'
  }
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * 只翻译最常见的几种 cron 写法，翻不动就原样回显。
 *
 * 刻意不写完整的 cron 解释器：翻错比不翻更糟 —— 用户会照着一个错误的
 * 解释去信任一个错误的排程。翻不了就老实显示原文。
 */
function describeCron(expr: string): string {
  const p = expr.split(/\s+/)
  if (p.length !== 5) return `Cron ${expr}`
  const [min, hour, dom, mon, dow] = p
  const isNum = (s: string) => /^\d+$/.test(s)
  const hhmm = isNum(min) && isNum(hour) ? `${hour.padStart(2, '0')}:${min.padStart(2, '0')}` : null

  if (hhmm && dom === '*' && mon === '*' && dow === '*') return `每天 ${hhmm}`
  if (hhmm && dom === '*' && mon === '*' && isNum(dow)) {
    return `每${WEEKDAYS[Number(dow) % 7]} ${hhmm}`
  }
  if (hhmm && isNum(dom) && mon === '*' && dow === '*') return `每月 ${Number(dom)} 号 ${hhmm}`
  if (isNum(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `每小时第 ${Number(min)} 分钟`
  }
  return `Cron ${expr}`
}

/** 定时触发的参数够不够跑起来。缺什么直接说，别等到上线才发现没排上。 */
export function scheduleErrors(params: Record<string, unknown>): string[] {
  const mode = String(params.mode ?? 'daily')
  if (mode === 'daily') {
    const at = String(params.at ?? '').trim()
    if (!at) return ['「每天几点」没填']
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(at)) return [`时间「${at}」格式不对，要写成 09:00 这样的 24 小时制`]
  }
  if (mode === 'cron') {
    const c = String(params.cron ?? '').trim()
    if (!c) return ['Cron 表达式没填']
    if (c.split(/\s+/).length !== 5) return [`Cron「${c}」不是五段式（分 时 日 月 周）`]
  }
  if (mode === 'interval') {
    const n = Number(params.everyMinutes ?? 0)
    if (!Number.isFinite(n) || n <= 0) return ['间隔分钟数要填一个大于 0 的整数']
  }
  return []
}
