import { useMemo } from 'react'
import { ctxFromRun, resolveTemplate } from '../lib/engine'
import { extractBlocks, upstreamColumns } from '../lib/vars'
import { useFlow } from '../store'

/**
 * 企微各消息类型的内容上限，**字节**不是字符（中文一个字 3 字节）。
 *
 * 这里是提示，服务端 wecom.py:build_payload 才是执法者 —— 只是等到发的时候
 * 才被拒太晚了，用户已经在群里等着看结果。数值同步自 server/sql_service/wecom.py
 * 的 MAX_BYTES。
 */
const MAX_BYTES: Record<string, number> = { text: 2048, markdown: 4096, markdown_v2: 4096 }

interface Props {
  content: string
  msgtype: string
  nodeId: string
}

/**
 * 把消息渲染成它真正会发出去的样子。
 *
 * 用的是**和实际运行同一个** resolveTemplate —— 另写一个渲染器迟早会出现
 * "预览好好的、发出去是另一样"。渲染报错也直接显示出来：未知过滤器这类
 * 以前要等到运行期才炸，而那个炸法会让运行记录变成僵尸。
 */
export default function MessagePreview({ content, msgtype, nodeId }: Props) {
  const nodes = useFlow((s) => s.nodes)
  const edges = useFlow((s) => s.edges)
  const runs = useFlow((s) => s.runs)
  const activeRunId = useFlow((s) => s.activeRunId)
  const run = runs.find((r) => r.id === activeRunId) ?? runs[0] ?? null

  // 没跑过也要能预览：只用 date() 和固定文案的消息本来就不依赖运行数据，
  // 拿一个空上下文照样渲染得出来。引用上游的部分会显示成「（无数据）」，
  // 下面单独提示，比整块拒绝预览有用。
  const ctx = useMemo(
    () => ctxFromRun(run) ?? { trigger: {}, run: { id: 'preview', startedAt: new Date().toISOString() }, nodes: {} },
    [run],
  )

  const rendered = useMemo(() => {
    try {
      const v = resolveTemplate(content, ctx)
      return { text: typeof v === 'string' ? v : JSON.stringify(v, null, 2), error: null as string | null }
    } catch (err) {
      return { text: '', error: err instanceof Error ? err.message : String(err) }
    }
  }, [content, ctx])

  // 列名写错只提示不拦截：列名可能只是还没学到，拦了就没法先写模板后跑数据
  const unknownCols = useMemo(() => {
    const known = new Set(upstreamColumns(nodeId, nodes, edges).flatMap((u) => u.columns.map((c) => c.name)))
    if (!known.size) return []
    const used = new Set<string>()
    for (const block of extractBlocks(content)) {
      const m = block.match(/\|\s*(?:table|list|lines)\s*\(([^)]*)\)/)
      if (!m) continue
      for (const a of m[1].split(',').map((s) => s.trim()).filter(Boolean)) used.add(a)
    }
    return [...used].filter((c) => !known.has(c))
  }, [content, nodeId, nodes, edges])

  // 引用的上游被行数上限砍过 —— 表格里只有前 N 行，别让用户以为发的是全量
  const truncatedFrom = useMemo(() => {
    if (!run) return []
    return Object.entries(run.steps)
      .filter(([id]) => content.includes(`$.nodes.${id}.`))
      .filter(([, steps]) => (steps.at(-1)?.output as { truncated?: boolean } | null)?.truncated === true)
      .map(([id]) => id)
  }, [content, run])

  if (!content.trim()) {
    return <div className="mprev mprev--empty">内容还是空的。写点文字，或点上面的「▦ 插入表格」把查询结果放进来。</div>
  }
  if (rendered?.error) {
    return (
      <div className="mprev">
        <div className="mprev__head">预览</div>
        <div className="mprev__err">✗ {rendered.error}</div>
      </div>
    )
  }

  const text = rendered?.text ?? ''
  const bytes = new TextEncoder().encode(text).length
  const limit = MAX_BYTES[msgtype] ?? 4096
  const over = bytes > limit
  const needsV2 = text.includes('\n|') || text.startsWith('|')

  return (
    <div className="mprev">
      <div className="mprev__head">
        预览 <em>就是会发出去的内容</em>
        <span className={`mprev__bytes${over ? ' is-over' : ''}`}>
          {bytes} / {limit} 字节
        </span>
      </div>
      <pre className="mono prewrap mprev__body">{text}</pre>
      {!run && content.includes('$.nodes.') && (
        <div className="mprev__warn">
          ⚠ 还没运行过，引用上游节点的地方现在是空的（表格会显示「（无数据）」）。
          跑一次流程，或对上游节点点「试运行本节点」，这里就是真实内容了。
        </div>
      )}
      {/* 没有"只预览不发送"开关了，运行到这个节点就是真发。说在最显眼的地方 */}
      <div className="mprev__live">⚡ 点「运行」就会真的发到群里，先在上面确认内容</div>
      {over && (
        <div className="mprev__err">
          ✗ 超出 {msgtype} 的 {limit} 字节上限，服务端会拒收。减少列、调小行数上限，或改发文件。
        </div>
      )}
      {needsV2 && msgtype !== 'markdown_v2' && (
        <div className="mprev__warn">
          ⚠ 内容里有表格，但消息类型是 {msgtype || '（未选）'} —— 企微只有 markdown_v2 会把它渲染成表格，
          其他类型会原样显示成一堆竖线。
        </div>
      )}
      {unknownCols.length > 0 && (
        <div className="mprev__warn">
          ⚠ 这些列名在上游数据里没找到：{unknownCols.join('、')}。它们会渲染成空单元格。
        </div>
      )}
      {truncatedFrom.map((id) => (
        <div className="mprev__warn" key={id}>
          ⚠ 引用的 {id} 结果被行数上限截断了，表格里只有前一部分。别在文案里把它写成全部。
        </div>
      ))}
    </div>
  )
}
