import { useState } from 'react'
import { dateNodeOutput, type DateNodeParams } from '../lib/datefn'

/**
 * 日期节点的实时预览。
 *
 * 这个面板就是这个节点存在的理由：偏移和格式是选出来的，选完当场看到算成什么样，
 * 不用"跑一次才知道"。日期算错在报表里是最贵的错误之一 —— 数字全对，就是差一天，
 * 而且没有任何东西会报错。
 *
 * 按「此刻」预览，实际运行时基准是运行开始时刻，所以下面标一句，免得用户
 * 拿预览里的秒去对运行结果。
 */

/** 显示哪些输出字段，以及怎么称呼它们。顺序按用得多的排。 */
const FIELDS: Array<{ key: string; label: string }> = [
  { key: 'compact', label: 'compact · Hive 分区' },
  { key: 'date', label: 'date · 人读' },
  { key: 'datetime', label: 'datetime' },
  { key: 'month', label: 'month' },
  { key: 'time', label: 'time' },
  { key: 'unix', label: 'unix · 秒' },
  // ISO 串按 UTC 输出（东八区的零点在这里是前一天 16:00），不标一下会被当成算错了
  { key: 'iso', label: 'iso · UTC' },
  { key: 'weekday', label: 'weekday' },
]

export default function DatePreview({
  values,
  nodeId,
}: {
  values: Record<string, unknown>
  nodeId?: string
}) {
  const [copied, setCopied] = useState<string | null>(null)

  let out: Record<string, unknown>
  try {
    out = dateNodeOutput(values as DateNodeParams, new Date())
  } catch (err) {
    return <div className="dpv dpv--err">{err instanceof Error ? err.message : String(err)}</div>
  }

  const ref = (key: string) => (nodeId ? `{{ $.nodes.${nodeId}.output.${key} }}` : `$.output.${key}`)
  const copy = (text: string) => {
    // 非 https / 老浏览器下没有 clipboard，静默失败也不能把面板炸掉
    void navigator.clipboard?.writeText(text).catch(() => {})
    setCopied(text)
  }

  return (
    <div className="dpv">
      <div className="dpv__head">
        <span className="dpv__value">{String(out.value)}</span>
        <span className="dpv__hint">预览用此刻；运行用开始时刻</span>
      </div>

      <div className="dpv__expr">
        等价写法 <code>{`{{ date('${out.expr}', '${values.format === 'custom' ? String(values.customFormat ?? '') : String(values.format ?? 'compact')}') }}`}</code>
      </div>

      <div className="dpv__rows">
        {FIELDS.map((f) => (
          <button
            key={f.key}
            className="dpv__row"
            title={`点一下复制引用 ${ref(f.key)}`}
            onClick={() => copy(ref(f.key))}
          >
            <span className="dpv__k">{f.label}</span>
            <code className="dpv__v">{String(out[f.key])}</code>
            <span className="dpv__copy">{copied === ref(f.key) ? '已复制' : '复制引用'}</span>
          </button>
        ))}
      </div>

      <div className="dpv__foot">
        下游按 <code>{ref('compact')}</code> 这样的路径引用，也可在变量选择器里选。
      </div>
    </div>
  )
}
