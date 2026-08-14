import { useMemo, useRef, useState } from 'react'
import type { JsonSchema } from '../types'
import { cachedOptions } from '../registry'
import { extractRefs, type VarEntry } from '../lib/vars'
import { isFieldVisible } from '../lib/display'
import { extractSqlPlaceholders } from '../lib/placeholders'
import { useFlow } from '../store'
import DatePreview from './DatePreview'
import MessagePreview from './MessagePreview'
import TablePicker from './TablePicker'
import VarPicker from './VarPicker'

interface Props {
  schema: JsonSchema
  values: Record<string, unknown>
  required: string[]
  vars: VarEntry[]
  onChange: (key: string, value: unknown) => void
  /** 用最近一次运行数据解析引用，给出实时预览（n8n 表达式预览） */
  previewRef?: (path: string) => { found: boolean; value: unknown }
  /** 当前编辑的是哪个节点。选列器和消息预览要靠它找上游 */
  nodeId?: string
}

type TextEl = HTMLInputElement | HTMLTextAreaElement

export default function SchemaForm({ schema, values, required, vars, onChange, previewRef, nodeId }: Props) {
  const refs = useRef<Record<string, TextEl | null>>({})
  const [picking, setPicking] = useState<string | null>(null)
  const known = new Set(vars.map((v) => v.path))

  const insert = (key: string, path: string) => insertRaw(key, `{{ ${path} }}`)

  /** 在光标处插入一段文本（变量引用、表格表达式都走这里） */
  const insertRaw = (key: string, snippet: string) => {
    const el = refs.current[key]
    const cur = String(values[key] ?? '')
    if (!el) {
      onChange(key, cur + snippet)
    } else {
      const s = el.selectionStart ?? cur.length
      const e = el.selectionEnd ?? s
      onChange(key, cur.slice(0, s) + snippet + cur.slice(e))
      setTimeout(() => {
        el.focus()
        const pos = s + snippet.length
        el.setSelectionRange(pos, pos)
      }, 0)
    }
    setPicking(null)
  }

  // 条件显示：n8n displayOptions 语义，联动参数变化实时增减字段
  const entries = Object.entries(schema.properties ?? {}).filter(([key]) =>
    isFieldVisible(key, schema, values),
  )

  // 反查：哪个字段是"取值来源"，以及它服务的是哪个带占位符的字段
  // （sql 声明 x-placeholders.valuesFrom = 'params' → placeholderSource.params = 'sql'）
  const placeholderSource: Record<string, string> = {}
  for (const [k, s] of Object.entries(schema.properties ?? {})) {
    const target = s['x-placeholders']?.valuesFrom
    if (target) placeholderSource[target] = k
  }
  if (entries.length === 0) return <div className="empty">这个节点没有参数</div>

  return (
    <div className="form">
      {entries.map(([key, sub]) => {
        const ui = sub['x-ui'] ?? {}
        const value = values[key]
        const isText = sub.type === 'string' && ui.widget !== 'select'
        const inserters = ui.inserters ?? []
        // 带过滤器的块交给消息预览显示成品。这里的 chip 只认 $. 路径、把过滤器
        // 剥掉，于是 table(...) 会被显示成「→ [3 项]」—— 恰好在最需要看清楚的
        // 场景上给出误导。
        const refsFound =
          typeof value === 'string' && !(inserters.includes('message') && value.includes('|'))
            ? extractRefs(value)
            : []

        return (
          <div className="field" key={key}>
            <label className="field__label">
              {sub.title ?? key}
              {required.includes(key) && <span className="req">*</span>}
              {isText && (
                <button className="field__var" onClick={() => setPicking(key)} title="插入变量 / 日期函数">
                  {'{ }'}
                </button>
              )}
            </label>

            {sub.description && <div className="field__desc">{sub.description}</div>}

            {/* select：静态 enum 或 optionsFrom 动态拉取 */}
            {sub.type === 'string' && ui.widget === 'select' && (
              <select
                value={String(value ?? '')}
                onChange={(e) => onChange(key, e.target.value)}
              >
                <option value="">— 请选择 —</option>
                {(ui.optionsFrom ? cachedOptions(ui.optionsFrom) : (sub.enum ?? [])).map((o) => (
                  <option key={o} value={o}>
                    {ui.labels?.[o] ?? o}
                  </option>
                ))}
              </select>
            )}

            {/* 多行 / 代码 */}
            {sub.type === 'string' && (ui.widget === 'code' || ui.widget === 'textarea') && (
              <>
                <textarea
                  ref={(el) => { refs.current[key] = el }}
                  className={ui.widget === 'code' ? 'mono' : ''}
                  rows={ui.rows ?? 4}
                  spellCheck={false}
                  value={String(value ?? '')}
                  placeholder={ui.placeholder}
                  onChange={(e) => onChange(key, e.target.value)}
                />
                {inserters.includes('table') && nodeId && (
                  <TablePicker
                    nodeId={nodeId}
                    msgtype={String(values.msgtype ?? '')}
                    hasContent={String(value ?? '').trim().length > 0}
                    onInsert={(snippet) => insertRaw(key, snippet)}
                  />
                )}
                {inserters.includes('message') && nodeId && (
                  <MessagePreview
                    content={String(value ?? '')}
                    msgtype={String(values.msgtype ?? '')}
                    nodeId={nodeId}
                  />
                )}
              </>
            )}

            {/* 单行 */}
            {sub.type === 'string' && (!ui.widget || ui.widget === 'text') && (
              <input
                ref={(el) => { refs.current[key] = el }}
                value={String(value ?? '')}
                placeholder={ui.placeholder}
                onChange={(e) => onChange(key, e.target.value)}
              />
            )}

            {(sub.type === 'integer' || sub.type === 'number') && (
              <input
                type="number"
                value={value === undefined || value === null ? '' : Number(value)}
                min={sub.minimum}
                max={sub.maximum}
                onChange={(e) => onChange(key, e.target.value === '' ? undefined : Number(e.target.value))}
              />
            )}

            {sub.type === 'boolean' && (
              <label className="switch">
                <input
                  type="checkbox"
                  checked={Boolean(value)}
                  onChange={(e) => onChange(key, e.target.checked)}
                />
                <span>{value ? '开' : '关'}</span>
              </label>
            )}

            {sub.type === 'object' && ui.widget === 'kv' && (
              placeholderSource[key] !== undefined ? (
                // 这个字段是某个 SQL 字段的取值来源 —— 参数行由 SQL 推导，不让用户手敲
                <PlaceholderEditor
                  sql={String(values[placeholderSource[key]] ?? '')}
                  value={(value as Record<string, unknown>) ?? {}}
                  onChange={(v) => onChange(key, v)}
                />
              ) : (
                <KvEditor
                  value={(value as Record<string, string>) ?? {}}
                  onChange={(v) => onChange(key, v)}
                />
              )
            )}

            {refsFound.length > 0 && (
              <div className="field__refs">
                {refsFound.map((r) => {
                  const ok = known.has(r) || [...known].some((k) => r.startsWith(`${k}.`) || r.startsWith(`${k}[`))
                  const preview = ok && previewRef ? previewRef(r) : undefined
                  return (
                    <code key={r} className={ok ? 'ref ok' : 'ref bad'} title={ok ? '' : '未知变量'}>
                      {r}
                      {preview?.found && (
                        <span className="ref__preview" title={JSON.stringify(preview.value)}>
                          {' '}→ {previewText(preview.value)}
                        </span>
                      )}
                    </code>
                  )
                })}
              </div>
            )}

            {sub['x-large'] && <div className="field__note">大字段：节点间走 $ref 引用传递</div>}

            {picking === key && (
              <VarPicker vars={vars} onPick={(p) => insert(key, p)} onClose={() => setPicking(null)} />
            )}
          </div>
        )
      })}

      {/* 整个表单的实时预览。挂在 schema 上而不是某个字段上 —— 它算的是所有
          字段合起来的结果，位置也该在最后 */}
      {schema['x-ui']?.preview === 'date' && <DatePreview values={values} nodeId={nodeId} />}
    </div>
  )
}

/**
 * 占位符参数表：行不是用户敲出来的，是从 SQL 里认出来的。
 *
 * 这样有三个好处：不用手抄一遍名字；改 SQL 时行自动跟着变；也不可能填出
 * SQL 里没有的多余参数（后端会为此报错）。
 *
 * 留空 = 自动取同名流程入参。所以清空输入框时要把键删掉而不是存 ""，
 * 否则会被当成显式的空字符串渲染进 SQL。
 */
function PlaceholderEditor({
  sql,
  value,
  onChange,
}: {
  sql: string
  value: Record<string, unknown>
  onChange: (v: Record<string, unknown>) => void
}) {
  const flowInputs = useFlow((s) => s.flowInputs)
  const names = useMemo(() => extractSqlPlaceholders(sql), [sql])

  const set = (name: string, raw: string) => {
    const next = { ...value }
    if (raw === '') delete next[name]
    else next[name] = raw
    onChange(next)
  }

  if (names.length === 0) {
    return <div className="empty">SQL 里还没有占位符。写 {'{{name}}'} 或 :name，这里会自动列出来。</div>
  }

  return (
    <div className="phe">
      {names.map(({ name, written }) => {
        const explicit = Object.prototype.hasOwnProperty.call(value, name)
        const fromInput = flowInputs.find((f) => f.key === name)
        return (
          <div className="phe__row" key={name}>
            <code className="phe__name" title={`SQL 里写作 ${written}`}>{name}</code>
            <input
              value={explicit ? String(value[name] ?? '') : ''}
              placeholder={fromInput ? `自动取流程入参「${fromInput.title || name}」` : '需要填值'}
              className={!explicit && !fromInput ? 'phe__missing' : ''}
              onChange={(e) => set(name, e.target.value)}
            />
            <span className={`phe__tag${!explicit && !fromInput ? ' phe__tag--warn' : ''}`}>
              {explicit ? '已覆盖' : fromInput ? `↑ ${fromInput.type === 'integer' ? '整数' : fromInput.type === 'boolean' ? '布尔' : '文本'}` : '缺值'}
            </span>
          </div>
        )
      })}
      <div className="phe__hint">
        留空即自动取同名流程入参。填了就以填的为准（支持 {'{{ $.nodes.n1.output.x }}'} 引用上游）。
      </div>
    </div>
  )
}

function previewText(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length} 项]`
  if (v !== null && typeof v === 'object') return '{…}'
  const s = String(v)
  return s.length > 24 ? `${s.slice(0, 24)}…` : s
}

function KvEditor({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const rows = Object.entries(value)
  const set = (i: number, k: string, v: string) => {
    // key 撞上别的行时忽略这次输入 —— 对象模型下静默合并会吞掉那一行的数据
    if (rows.some(([ok], idx) => idx !== i && ok === k)) return
    const next: Record<string, string> = {}
    rows.forEach(([ok, ov], idx) => {
      if (idx === i) next[k] = v
      else next[ok] = ov
    })
    onChange(next)
  }
  return (
    <div className="kv">
      {rows.map(([k, v], i) => (
        <div className="kv__row" key={i}>
          <input value={k} placeholder="key" onChange={(e) => set(i, e.target.value, v)} />
          <input value={v} placeholder="value / {{ }}" onChange={(e) => set(i, k, e.target.value)} />
          <button
            onClick={() => onChange(Object.fromEntries(rows.filter((_, idx) => idx !== i)))}
            title="删除"
          >
            ×
          </button>
        </div>
      ))}
      <button className="kv__add" onClick={() => onChange({ ...value, '': '' })}>
        + 添加一项
      </button>
    </div>
  )
}
