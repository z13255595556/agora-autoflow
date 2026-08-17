import type { NodeType } from '../types'
import { conditionSummary, readConditionGroup } from './conditions.ts'
import { DATE_MODE_LABELS } from './datefn.ts'
import { describeSchedule } from './schedule.ts'

/**
 * 节点卡片上的那行小字：这个节点**现在配成了什么**。
 *
 * 以前那行写的是 `sql.query` 这样的类型名 —— 图标已经说明了是什么节点，
 * 再重复一遍等于什么都没说。画布的价值在于扫一眼看懂整条流程，所以这里
 * 显示的是配置摘要：查哪个引擎、几点跑、发到哪、条件是什么。
 *
 * 没配的必填项直接说"未填"，让空节点在画布上就能被认出来，不用逐个点开。
 */

const MAX = 46

function clip(s: string, max = MAX): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

function str(params: Record<string, unknown>, key: string): string {
  const v = params[key]
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v)
}

export function nodeSummary(t: NodeType, params: Record<string, unknown>): string {
  switch (t.type) {
    case 'trigger.manual':
      return '手动发起一次运行'

    case 'trigger.schedule':
      return describeSchedule(params)

    case 'sql.query': {
      const engine = str(params, 'engine') || 'hive'
      const sql = str(params, 'sql')
      if (!sql) return `${engine} · 未写 SQL`
      // 注释行和空行跳掉，取第一句真正的语句
      const first =
        sql
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith('--')) ?? sql
      return `${engine} · ${clip(first, 34)}`
    }

    case 'date.compute': {
      const mode = str(params, 'mode') || 'yesterday'
      const label = DATE_MODE_LABELS[mode] ?? mode
      const extra =
        mode === 'daysAgo' ? `（${params.days ?? 7} 天）` : mode === 'hoursAgo' ? `（${params.hours ?? 1} 小时）` : ''
      return `${label}${extra}`
    }

    case 'notify.wecom': {
      const type = str(params, 'msgtype') || 'markdown_v2'
      if (!str(params, 'webhook')) return `${type} · 未填群机器人地址`
      const content = str(params, 'content')
      return content ? `${type} · ${clip(content, 30)}` : `${type} · 内容为空`
    }

    case 'flow.if': {
      // 优先级和 engine.evaluateIf 一致：有条件行就以条件行为准，
      // 卡片上显示的必须是**真正会被执行的那份**
      const group = readConditionGroup(params)
      if (group) return clip(conditionSummary(group))
      return str(params, 'condition') ? clip(str(params, 'condition')) : '未设条件'
    }

    case 'flow.foreach':
      return str(params, 'items') ? `遍历 ${clip(str(params, 'items'), 30)}` : '未设遍历对象'

    case 'flow.merge':
      return str(params, 'mode') === 'any' ? '任一分支到达即继续' : '等全部分支到齐'

    case 'flow.end':
      return str(params, 'result') ? clip(str(params, 'result')) : '结束当前分支'

    case 'http.request': {
      const method = str(params, 'method') || 'GET'
      const url = str(params, 'url')
      return url ? `${method} ${clip(url, 34)}` : `${method} · 未填 URL`
    }

    case 'transform.map':
      return str(params, 'expression') ? clip(str(params, 'expression')) : '未写表达式'

    case 'transform.template':
      return str(params, 'template') ? clip(str(params, 'template')) : '未写模板'

    case 'variable.assign': {
      const count = Object.keys((params.values as Record<string, unknown>) ?? {}).filter(Boolean).length
      return count ? `设置 ${count} 个变量` : '还没有变量'
    }

    case 'list.operation': {
      const labels: Record<string, string> = { first: '取第一项', last: '取最后一项', slice: '截取区间' }
      return labels[str(params, 'operation') || 'slice'] ?? '处理列表'
    }

    default: {
      // 认不出来的节点（后端新上报的）：挑第一个必填的文本参数当摘要，
      // 没有就退回 manifest 里的描述 —— 总比什么都不显示强
      const required = t.input.required ?? []
      for (const key of required) {
        const v = str(params, key)
        if (v) return clip(v)
      }
      return clip(t.description ?? t.type)
    }
  }
}
