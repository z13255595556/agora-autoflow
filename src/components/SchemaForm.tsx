import type { CSSProperties, ChangeEvent, KeyboardEvent, MouseEvent } from 'react'
import { useMemo, useRef, useState } from 'react'
import type { JsonSchema } from '../types'
import { cachedOptions } from '../registry'
import { extractRefs, type VarEntry } from '../lib/vars'
import { isFieldVisible } from '../lib/display'
import { extractSqlPlaceholders } from '../lib/placeholders'
import { filterSlashVars, slashMatchAt } from '../lib/slash'
import { useFlow } from '../store'
import { validationFieldKey } from '../lib/validationFocus'
import DatePreview from './DatePreview'
import MessagePreview from './MessagePreview'
import TablePicker from './TablePicker'
import VarPicker from './VarPicker'
import Icon from './Icon'
import CurlImport from './CurlImport'
import { isSensitiveHeaderName } from '../lib/secrets'

export interface SchemaFormProps {
  schema: JsonSchema
  values: Record<string, unknown>
  required: string[]
  vars: VarEntry[]
  onChange: (key: string, value: unknown) => void
  /** 用最近一次运行数据解析引用，给出实时预览（n8n 表达式预览） */
  previewRef?: (path: string) => { found: boolean; value: unknown }
  /** 当前编辑的是哪个节点。选列器和消息预览要靠它找上游 */
  nodeId?: string
  /** 当前节点的校验错误，用于在具体字段旁反馈。 */
  validationErrors?: string[]
  /** HTTP 专用表单会把 cURL 导入放在标签页外，子表单需关闭重复入口。 */
  showCurlImport?: boolean
}

type TextEl = HTMLInputElement | HTMLTextAreaElement

interface SlashState {
  key: string
  start: number
  end: number
  query: string
  activeIndex: number
  style: CSSProperties
}

export default function SchemaForm({
  schema,
  values,
  required,
  vars,
  onChange,
  previewRef,
  nodeId,
  validationErrors = [],
  showCurlImport = true,
}: SchemaFormProps) {
  const refs = useRef<Record<string, TextEl | null>>({})
  const [slash, setSlash] = useState<SlashState | null>(null)
  const known = new Set(vars.map((v) => v.path))
  const isHttpRequest = useFlow((s) => s.nodes.some((node) => node.id === nodeId && node.data.typeId === 'http.request'))

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
    setSlash(null)
  }

  const updateSlash = (key: string, el: TextEl, nextValue: string) => {
    const match = slashMatchAt(nextValue, el.selectionStart)
    if (!match || filterSlashVars(vars, match.query).length === 0) {
      setSlash((current) => (current?.key === key ? null : current))
      return
    }
    setSlash({ key, ...match, activeIndex: 0, style: caretPopupStyle(el, match.end) })
  }

  const handleTextChange = (key: string, event: ChangeEvent<TextEl>) => {
    const nextValue = event.target.value
    onChange(key, nextValue)
    updateSlash(key, event.target, nextValue)
  }

  const pickSlashVariable = (path: string) => {
    if (!slash) return
    const el = refs.current[slash.key]
    const current = String(values[slash.key] ?? '')
    const snippet = `{{ ${path} }}`
    onChange(slash.key, current.slice(0, slash.start) + snippet + current.slice(slash.end))
    setSlash(null)
    setTimeout(() => {
      el?.focus()
      const pos = slash.start + snippet.length
      el?.setSelectionRange(pos, pos)
    }, 0)
  }

  const handleTextKeyDown = (key: string, event: KeyboardEvent<TextEl>) => {
    if (!slash || slash.key !== key) return
    const matches = filterSlashVars(vars, slash.query)
    if (event.key === 'Escape') {
      event.preventDefault()
      setSlash(null)
    } else if (event.key === 'ArrowDown' && matches.length) {
      event.preventDefault()
      setSlash({ ...slash, activeIndex: (slash.activeIndex + 1) % matches.length })
    } else if (event.key === 'ArrowUp' && matches.length) {
      event.preventDefault()
      setSlash({ ...slash, activeIndex: (slash.activeIndex - 1 + matches.length) % matches.length })
    } else if (event.key === 'Enter' && matches.length) {
      event.preventDefault()
      pickSlashVariable(matches[Math.min(slash.activeIndex, matches.length - 1)].path)
    }
  }

  const handleTextClick = (key: string, event: MouseEvent<TextEl>) => {
    updateSlash(key, event.currentTarget, event.currentTarget.value)
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
      {isHttpRequest && showCurlImport && <CurlImport onChange={onChange} />}
      {entries.map(([key, sub]) => {
        const ui = sub['x-ui'] ?? {}
        const value = values[key] === undefined ? sub.default : values[key]
        const isText = sub.type === 'string' && ui.widget !== 'select'
        const inserters = ui.inserters ?? []
        // 带过滤器的块交给消息预览显示成品。这里的 chip 只认 $. 路径、把过滤器
        // 剥掉，于是 table(...) 会被显示成「→ [3 项]」—— 恰好在最需要看清楚的
        // 场景上给出误导。
        const refsFound =
          typeof value === 'string' && !(inserters.includes('message') && value.includes('|'))
            ? extractRefs(value)
            : []
        const fieldErrors = validationErrors.filter((error) => validationFieldKey(error, schema) === key)

        return (
          <div className={`field${fieldErrors.length ? ' field--invalid' : ''}`} key={key} data-field-key={key}>
            <label className="field__label">
              {sub.title ?? key}
              {required.includes(key) && <span className="req">*</span>}
            </label>

            {sub.description && <div className="field__desc">{sub.description}</div>}

            {/* select：静态 enum 或 optionsFrom 动态拉取 */}
            {sub.type === 'string' && ui.widget === 'select' && (
              <select
                value={String(value ?? '')}
                aria-invalid={fieldErrors.length > 0}
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
                  aria-invalid={fieldErrors.length > 0}
                  placeholder={ui.placeholder}
                  aria-autocomplete={isText ? 'list' : undefined}
                  aria-expanded={slash?.key === key}
                  onChange={(e) => handleTextChange(key, e)}
                  onKeyDown={(e) => handleTextKeyDown(key, e)}
                  onClick={(e) => handleTextClick(key, e)}
                  onBlur={() => setTimeout(() => setSlash((current) => (current?.key === key ? null : current)), 150)}
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
                type={ui.secret ? 'password' : 'text'}
                value={String(value ?? '')}
                aria-invalid={fieldErrors.length > 0}
                placeholder={ui.placeholder}
                aria-autocomplete="list"
                aria-expanded={slash?.key === key}
                autoComplete={ui.secret ? 'new-password' : undefined}
                onChange={(e) => handleTextChange(key, e)}
                onKeyDown={(e) => handleTextKeyDown(key, e)}
                onClick={(e) => handleTextClick(key, e)}
                onBlur={() => setTimeout(() => setSlash((current) => (current?.key === key ? null : current)), 150)}
              />
            )}

            {(sub.type === 'integer' || sub.type === 'number') && (
              <input
                type="number"
                value={value === undefined || value === null ? '' : Number(value)}
                min={sub.minimum}
                max={sub.maximum}
                aria-invalid={fieldErrors.length > 0}
                onChange={(e) => onChange(key, e.target.value === '' ? undefined : Number(e.target.value))}
              />
            )}

            {sub.type === 'boolean' && (
              <label className="switch">
                <input
                  type="checkbox"
                  checked={Boolean(value)}
                  aria-invalid={fieldErrors.length > 0}
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
                  vars={vars}
                />
              ) : (
                <KvEditor
                  value={(value as Record<string, string>) ?? {}}
                  onChange={(v) => onChange(key, v)}
                  maskSensitive={ui.sensitiveKeys}
                  vars={vars}
                />
              )
            )}

            {fieldErrors.length > 0 && (
              <div className="field__errors" role="alert">
                {fieldErrors.map((error) => <div key={error}>{error}</div>)}
              </div>
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

            {slash?.key === key && (
              <VarPicker
                vars={vars}
                query={slash.query}
                activeIndex={slash.activeIndex}
                style={slash.style}
                onActiveIndex={(activeIndex) => setSlash((current) => current ? { ...current, activeIndex } : null)}
                onPick={pickSlashVariable}
              />
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

/** Position the menu at the text caret without replacing the native input. */
function caretPopupStyle(el: TextEl, caret: number): CSSProperties {
  const rect = el.getBoundingClientRect()
  const computed = getComputedStyle(el)
  const mirror = document.createElement('div')
  const marker = document.createElement('span')
  const props = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  ] as const
  mirror.style.position = 'fixed'
  mirror.style.left = '-10000px'
  mirror.style.top = '0'
  mirror.style.visibility = 'hidden'
  mirror.style.boxSizing = 'border-box'
  mirror.style.width = `${rect.width}px`
  mirror.style.whiteSpace = el instanceof HTMLTextAreaElement ? 'pre-wrap' : 'pre'
  mirror.style.overflowWrap = 'break-word'
  for (const prop of props) mirror.style[prop] = computed[prop]
  mirror.textContent = el.value.slice(0, caret)
  marker.textContent = '\u200b'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)

  const lineHeight = Number.parseFloat(computed.lineHeight) || 20
  const caretLeft = rect.left + marker.offsetLeft - el.scrollLeft
  const caretTop = rect.top + marker.offsetTop - el.scrollTop
  mirror.remove()

  const left = Math.max(8, Math.min(caretLeft, window.innerWidth - 338))
  if (caretTop + lineHeight + 240 < window.innerHeight) {
    return { left, top: caretTop + lineHeight + 4 }
  }
  return { left, bottom: Math.max(8, window.innerHeight - caretTop + 4) }
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
  vars,
}: {
  sql: string
  value: Record<string, unknown>
  onChange: (v: Record<string, unknown>) => void
  vars: VarEntry[]
}) {
  const flowInputs = useFlow((s) => s.flowInputs)
  const names = useMemo(() => extractSqlPlaceholders(sql), [sql])
  const refs = useRef<Record<string, HTMLInputElement | null>>({})
  const [slash, setSlash] = useState<(Omit<SlashState, 'key'> & { name: string }) | null>(null)

  const set = (name: string, raw: string) => {
    const next = { ...value }
    if (raw === '') delete next[name]
    else next[name] = raw
    onChange(next)
  }

  const updateSlash = (name: string, el: HTMLInputElement, nextValue: string) => {
    const match = slashMatchAt(nextValue, el.selectionStart)
    if (!match || filterSlashVars(vars, match.query).length === 0) {
      setSlash((current) => current?.name === name ? null : current)
      return
    }
    setSlash({ name, ...match, activeIndex: 0, style: caretPopupStyle(el, match.end) })
  }

  const pickVariable = (path: string) => {
    if (!slash) return
    const current = String(value[slash.name] ?? '')
    const snippet = `{{ ${path} }}`
    set(slash.name, current.slice(0, slash.start) + snippet + current.slice(slash.end))
    const el = refs.current[slash.name]
    const pos = slash.start + snippet.length
    setSlash(null)
    setTimeout(() => {
      el?.focus()
      el?.setSelectionRange(pos, pos)
    }, 0)
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
              ref={(el) => { refs.current[name] = el }}
              value={explicit ? String(value[name] ?? '') : ''}
              placeholder={fromInput ? `自动取流程入参「${fromInput.title || name}」` : '需要填值'}
              className={!explicit && !fromInput ? 'phe__missing' : ''}
              aria-autocomplete="list"
              aria-expanded={slash?.name === name}
              onChange={(e) => {
                set(name, e.target.value)
                updateSlash(name, e.target, e.target.value)
              }}
              onClick={(e) => updateSlash(name, e.currentTarget, e.currentTarget.value)}
              onKeyDown={(event) => {
                if (!slash || slash.name !== name) return
                const matches = filterSlashVars(vars, slash.query)
                if (event.key === 'Escape') { event.preventDefault(); setSlash(null) }
                else if (event.key === 'ArrowDown' && matches.length) {
                  event.preventDefault(); setSlash({ ...slash, activeIndex: (slash.activeIndex + 1) % matches.length })
                } else if (event.key === 'ArrowUp' && matches.length) {
                  event.preventDefault(); setSlash({ ...slash, activeIndex: (slash.activeIndex - 1 + matches.length) % matches.length })
                } else if (event.key === 'Enter' && matches.length) {
                  event.preventDefault(); pickVariable(matches[Math.min(slash.activeIndex, matches.length - 1)].path)
                }
              }}
              onBlur={() => setTimeout(() => setSlash((current) => current?.name === name ? null : current), 150)}
            />
            <span className={`phe__tag${!explicit && !fromInput ? ' phe__tag--warn' : ''}`}>
              {explicit ? '已覆盖' : fromInput ? `↑ ${fromInput.type === 'integer' ? '整数' : fromInput.type === 'boolean' ? '布尔' : '文本'}` : '缺值'}
            </span>
            {slash?.name === name && (
              <VarPicker
                vars={vars}
                query={slash.query}
                activeIndex={slash.activeIndex}
                style={slash.style}
                onActiveIndex={(activeIndex) => setSlash((current) => current ? { ...current, activeIndex } : null)}
                onPick={pickVariable}
              />
            )}
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

function KvEditor({
  value,
  onChange,
  maskSensitive = false,
  vars,
}: {
  value: Record<string, string>
  onChange: (v: Record<string, string>) => void
  maskSensitive?: boolean
  vars: VarEntry[]
}) {
  const rows = Object.entries(value)
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set())
  const [slash, setSlash] = useState<(Omit<SlashState, 'key'> & { row: number }) | null>(null)
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
  const updateValueSlash = (row: number, el: HTMLInputElement, nextValue: string) => {
    const match = slashMatchAt(nextValue, el.selectionStart)
    if (!match || filterSlashVars(vars, match.query).length === 0) {
      setSlash((current) => current?.row === row ? null : current)
      return
    }
    setSlash({ row, ...match, activeIndex: 0, style: caretPopupStyle(el, match.end) })
  }
  const pickVariable = (path: string) => {
    if (!slash) return
    const [key, current] = rows[slash.row] ?? ['', '']
    set(slash.row, key, current.slice(0, slash.start) + `{{ ${path} }}` + current.slice(slash.end))
    setSlash(null)
  }
  return (
    <div className="kv">
      {rows.map(([k, v], i) => {
        const sensitive = maskSensitive && isSensitiveHeaderName(k)
        const showing = revealed.has(i)
        return (
          <div className="kv__row" key={i}>
            <input
              value={k}
              placeholder="key"
              aria-label={`第 ${i + 1} 项的键`}
              onChange={(e) => {
                setRevealed(new Set())
                set(i, e.target.value, v)
              }}
            />
            <input
              type={sensitive && !showing ? 'password' : 'text'}
              value={v}
              placeholder="value / {{ }}"
              aria-label={`${k || `第 ${i + 1} 项`}的值`}
              autoComplete="off"
              aria-autocomplete="list"
              aria-expanded={slash?.row === i}
              onChange={(e) => {
                set(i, k, e.target.value)
                updateValueSlash(i, e.target, e.target.value)
              }}
              onClick={(e) => updateValueSlash(i, e.currentTarget, e.currentTarget.value)}
              onKeyDown={(event) => {
                if (!slash || slash.row !== i) return
                const matches = filterSlashVars(vars, slash.query)
                if (event.key === 'Escape') { event.preventDefault(); setSlash(null) }
                else if (event.key === 'ArrowDown' && matches.length) {
                  event.preventDefault(); setSlash({ ...slash, activeIndex: (slash.activeIndex + 1) % matches.length })
                } else if (event.key === 'ArrowUp' && matches.length) {
                  event.preventDefault(); setSlash({ ...slash, activeIndex: (slash.activeIndex - 1 + matches.length) % matches.length })
                } else if (event.key === 'Enter' && matches.length) {
                  event.preventDefault(); pickVariable(matches[Math.min(slash.activeIndex, matches.length - 1)].path)
                }
              }}
              onBlur={() => setTimeout(() => setSlash((current) => current?.row === i ? null : current), 150)}
            />
            {sensitive && (
              <button
                className="kv__reveal"
                onClick={() => setRevealed((current) => {
                  const next = new Set(current)
                  if (showing) next.delete(i)
                  else next.add(i)
                  return next
                })}
                title={showing ? '隐藏敏感值' : '显示敏感值'}
                aria-label={showing ? '隐藏敏感值' : '显示敏感值'}
              >
                <Icon name={showing ? 'eyeOff' : 'eye'} size={14} />
              </button>
            )}
            <button
              className="kv__delete"
              onClick={() => {
                setRevealed(new Set())
                onChange(Object.fromEntries(rows.filter((_, idx) => idx !== i)))
              }}
              title="删除"
            >
              ×
            </button>
          </div>
        )
      })}
      {slash && (
        <VarPicker
          vars={vars}
          query={slash.query}
          activeIndex={slash.activeIndex}
          style={slash.style}
          onActiveIndex={(activeIndex) => setSlash((current) => current ? { ...current, activeIndex } : null)}
          onPick={pickVariable}
        />
      )}
      <button className="kv__add" onClick={() => {
        setRevealed(new Set())
        onChange({ ...value, '': '' })
      }}>
        + 添加一项
      </button>
    </div>
  )
}
