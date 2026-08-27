import { useMemo, useState } from 'react'
import type { JsonSchema } from '../types'
import { cachedOptions } from '../registry'
import type { VarEntry } from '../lib/vars'
import { tokenizeRefs } from '../lib/blocks'
import { commitNumber, displayNumber } from '../lib/numberInput'
import { describeBlock, type LabelCtx } from '../lib/refLabel'
import { isFieldVisible } from '../lib/display'
import { extractSqlPlaceholders } from '../lib/placeholders'
import { useFlow } from '../store'
import { validationFieldKey } from '../lib/validationFocus'
import DatePreview from './DatePreview'
import SchedulePreview from './SchedulePreview'
import MessagePreview from './MessagePreview'
import RefField from './RefField'
import { useReferenceHost } from './ReferencePickerContext'
import ConditionsEditor from './ConditionsEditor'
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
  const known = new Set(vars.map((v) => v.path))
  // 导入器由 manifest 声明（x-ui.importers），不再按 typeId 判断 —— 那是表单里最后一个特判
  const importers = schema['x-ui']?.importers ?? []
  const nodes = useFlow((s) => s.nodes)
  const flowInputs = useFlow((s) => s.flowInputs)
  // 抽屉正开着给哪个字段取值 —— 那个字段要套上高亮环，跟抽屉是一对
  const { request: picking } = useReferenceHost(nodeId ?? '')
  // 所有可写引用的字符串字段都使用变量胶囊；凭证字段保持 password input。
  const chipField = (sub: JsonSchema) => sub.type === 'string' && !sub['x-ui']?.secret

  const labelCtx: LabelCtx = {
    nodes: nodes.map((n) => ({ id: n.id, label: n.data.label, typeId: n.data.typeId, probedOutput: n.data.probedOutput })),
    flowInputs,
    known,
    // previewRef 只会走路径查找，解不了 `| table(...)`，所以过滤器块的实时值
    // 交给消息预览那边；这里只在纯路径引用上取值
    resolve: previewRef ? (raw) => previewRef(raw.replace(/^\{\{|\}\}$/g, '').trim()).value : undefined,
  }

  // 反查：哪个字段是"取值来源"，以及它服务的是哪个带占位符的字段
  // （sql 声明 x-placeholders.valuesFrom = 'params' → placeholderSource.params = 'sql'）
  const placeholderSource: Record<string, string> = {}
  for (const [k, s] of Object.entries(schema.properties ?? {})) {
    const target = s['x-placeholders']?.valuesFrom
    if (target) placeholderSource[target] = k
  }

  // 条件行控件顺带编辑一个兄弟字段（老的表达式），那个字段就不该再单独画一遍 ——
  // 同一个条件在表单里出现两次，哪一处生效是隐式的
  const ownedByWidget = new Set(
    Object.values(schema.properties ?? {}).map((s) => s['x-ui']?.expressionFrom).filter(Boolean) as string[],
  )

  // 条件显示：联动参数变化实时增减字段。占位符取值区只有 SQL 里真的存在
  // 占位符时才有意义，没有占位符就整块隐藏，不显示额外说明或空状态。
  const entries = Object.entries(schema.properties ?? {}).filter(([key]) => {
    if (ownedByWidget.has(key)) return false
    if (!isFieldVisible(key, schema, values)) return false
    const sourceKey = placeholderSource[key]
    if (!sourceKey) return true
    return extractSqlPlaceholders(String(values[sourceKey] ?? '')).length > 0
  })
  if (entries.length === 0) return <div className="empty">这个节点没有参数</div>

  // 「配一次不再动」的字段折进高级设置。这不是新发明 —— http.request 的专属
  // 表单早就这么干了（超时、重试各一个 details，摘要里写着当前值），只是当时
  // 写死在那一个组件里，别的节点享受不到。改成 schema 驱动之后，任何节点在
  // 注册表里标一个 group: 'advanced' 就有同样的收纳。
  const advanced = ([, sub]: [string, JsonSchema]) => sub['x-ui']?.group === 'advanced'
  const mainEntries = entries.filter((entry) => !advanced(entry))
  const advEntries = entries.filter(advanced)
  const advHasError = advEntries.some(([key]) =>
    validationErrors.some((error) => validationFieldKey(error, schema) === key),
  )

  const renderField = ([key, sub]: [string, JsonSchema]) => {
        const ui = sub['x-ui'] ?? {}
        const value = values[key] === undefined ? sub.default : values[key]
        const inserters = ui.inserters ?? []
        // 字段里每个 {{ }} 块翻成人话，列在字段下面。
        //
        // 以前这里列的是裸路径，而且带过滤器的块会被整块跳过 —— 因为剥掉
        // 过滤器只看 $. 路径的话，`| table(...)` 会显示成「→ [3 项]」，恰好在
        // 最需要看清楚的场景上给出误导。现在 describeBlock 认得过滤器，
        // 「SQL查询·表格 2列」是准确的，就不用再躲着它了。
        const blocks =
          typeof value === 'string'
            ? tokenizeRefs(value, { placeholders: !!sub['x-placeholders'] }).filter((b) => b.kind !== 'text')
            : []
        const fieldErrors = validationErrors.filter((error) => validationFieldKey(error, schema) === key)

        return (
          <div
            className={`field${fieldErrors.length ? ' field--invalid' : ''}${picking?.fieldLabel === (sub.title ?? key) ? ' field--picking' : ''}`}
            key={key}
            data-field-key={key}
          >
            <label className="field__label">
              {sub.title ?? key}
              {required.includes(key) && <span className="req">*</span>}
            </label>

            {sub.description && <div className="field__desc">{sub.description}</div>}

            {/* 条件行：变量 + 比较方式 + 值。它自己管两个参数键，所以拿的是整份 values */}
            {ui.widget === 'conditions' && (
              <ConditionsEditor
                fieldKey={key}
                expressionKey={ui.expressionFrom}
                values={values}
                onChange={onChange}
                vars={vars}
                labelCtx={labelCtx}
                nodeId={nodeId}
              />
            )}

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
                <RefField
                  multiline
                  mono={ui.widget === 'code'}
                  rows={ui.rows ?? 4}
                  value={String(value ?? '')}
                  onChange={(next) => onChange(key, next)}
                  vars={vars}
                  placeholder={ui.placeholder}
                  ariaInvalid={fieldErrors.length > 0}
                  placeholders={!!sub['x-placeholders']}
                  chip={chipField(sub)}
                  labelCtx={labelCtx}
                  nodeId={nodeId}
                  fieldLabel={sub.title ?? key}
                  expectedType="string"
                />
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
              <RefField
                secret={ui.secret}
                value={String(value ?? '')}
                onChange={(next) => onChange(key, next)}
                vars={vars}
                placeholder={ui.placeholder}
                ariaInvalid={fieldErrors.length > 0}
                chip={chipField(sub)}
                labelCtx={labelCtx}
                nodeId={nodeId}
                fieldLabel={sub.title ?? key}
                expectedType="string"
              />
            )}

            {(sub.type === 'integer' || sub.type === 'number') && (
              // key 带上 nodeId：换节点时强制换一个实例，免得上一个节点
              // 没来得及失焦的草稿文本被下一个节点原样显示出来
              <NumberField
                key={`${nodeId ?? ''}:${key}`}
                value={value as number | undefined}
                min={sub.minimum}
                max={sub.maximum}
                integer={sub.type === 'integer'}
                invalid={fieldErrors.length > 0}
                onChange={(next) => onChange(key, next)}
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
                  nodeId={nodeId}
                  labelCtx={labelCtx}
                />
              ) : (
                <KvEditor
                  value={(value as Record<string, string>) ?? {}}
                  onChange={(v) => onChange(key, v)}
                  maskSensitive={ui.sensitiveKeys}
                  vars={vars}
                  nodeId={nodeId}
                  labelCtx={labelCtx}
                />
              )
            )}

            {fieldErrors.length > 0 && (
              <div className="field__errors" role="alert">
                {fieldErrors.map((error) => <div key={error}>{error}</div>)}
              </div>
            )}

            {/* 胶囊字段不再重复列一遍 —— 字段里画的就是这些胶囊，说两次是噪音 */}
            {blocks.length > 0 && !chipField(sub) && (
              <div className="field__refs">
                {blocks.map((b, i) => {
                  const label = describeBlock(b, labelCtx)
                  return (
                    <code key={`${i}:${b.raw}`} className={`ref ${label.tone}`} title={label.title}>
                      {label.text}
                    </code>
                  )
                })}
              </div>
            )}
          </div>
        )
  }

  return (
    <div className="form">
      {importers.includes('curl') && showCurlImport && <CurlImport onChange={onChange} />}
      {mainEntries.map(renderField)}

      {/* 折叠区里有报错就强制展开，且这期间收不起来 —— 把一条"必填项未填"
          折进「高级设置」里，用户看到的就是"哪都没红，就是跑不了" */}
      {advEntries.length > 0 && (
        <details className="form__adv" open={advHasError || undefined}>
          <summary>
            <span>高级设置</span>
            <em>{advSummary(advEntries, values)}</em>
          </summary>
          <div>{advEntries.map(renderField)}</div>
        </details>
      )}

      {/* 整个表单的实时预览。挂在 schema 上而不是某个字段上 —— 它算的是所有
          字段合起来的结果，位置也该在最后 */}
      {schema['x-ui']?.preview === 'date' && <DatePreview values={values} nodeId={nodeId} />}
      {schema['x-ui']?.preview === 'schedule' && <SchedulePreview values={values} />}
    </div>
  )
}

/**
 * 折叠条右侧那行摘要 —— 收起时也得知道里面是什么。
 *
 * 不写它的话「高级设置」就是个黑盒：想确认超时改没改过，只能点开看一眼再
 * 收起来。所以只列**和默认值不同**的项，全是默认就直说，这样绝大多数节点
 * 收起状态下就已经把话说完了。
 */
function advSummary(entries: Array<[string, JsonSchema]>, values: Record<string, unknown>): string {
  const changed = entries.filter(([key, sub]) => {
    const v = values[key]
    if (v === undefined || v === '' || v === null) return false
    return JSON.stringify(v) !== JSON.stringify(sub.default)
  })
  if (changed.length === 0) return '全部默认'
  const text = (v: unknown): string => {
    if (typeof v === 'boolean') return v ? '开' : '关'
    if (v !== null && typeof v === 'object') return '已设置'
    const raw = String(v)
    return raw.length > 12 ? raw.slice(0, 12) + '…' : raw
  }
  const head = changed.slice(0, 2).map(([key, sub]) => `${sub.title ?? key} ${text(values[key])}`)
  return changed.length > 2 ? `${head.join(' · ')} 等 ${changed.length} 项` : head.join(' · ')
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
  nodeId,
  labelCtx,
}: {
  sql: string
  value: Record<string, unknown>
  onChange: (v: Record<string, unknown>) => void
  vars: VarEntry[]
  nodeId?: string
  labelCtx: LabelCtx
}) {
  const flowInputs = useFlow((s) => s.flowInputs)
  const names = useMemo(() => extractSqlPlaceholders(sql), [sql])

  const set = (name: string, raw: string) => {
    const next = { ...value }
    if (raw === '') delete next[name]
    else next[name] = raw
    onChange(next)
  }

  if (names.length === 0) return null

  return (
    <div className="phe">
      {names.map(({ name, written }) => {
        const explicit = Object.prototype.hasOwnProperty.call(value, name)
        const fromInput = flowInputs.find((f) => f.key === name)
        return (
          <div className="phe__row" key={name}>
            <code className="phe__name" title={`SQL 里写作 ${written}`}>{name}</code>
            <RefField
              value={explicit ? String(value[name] ?? '') : ''}
              onChange={(next) => set(name, next)}
              vars={vars}
              placeholder={fromInput ? `自动取流程入参「${fromInput.title || name}」` : '需要填值'}
              className={!explicit && !fromInput ? 'phe__missing' : undefined}
              ariaLabel={`占位符 ${name} 的值`}
              chip
              labelCtx={labelCtx}
              nodeId={nodeId}
              expectedType="string"
            />
            <span className={`phe__tag${!explicit && !fromInput ? ' phe__tag--warn' : ''}`}>
              {explicit ? '已覆盖' : fromInput ? `↑ ${fromInput.type === 'integer' ? '整数' : fromInput.type === 'boolean' ? '布尔' : '文本'}` : '缺值'}
            </span>
          </div>
        )
      })}
      <div className="phe__hint">
        留空用同名入参；填了以填的为准。
      </div>
    </div>
  )
}


function KvEditor({
  value,
  onChange,
  maskSensitive = false,
  vars,
  nodeId,
  labelCtx,
}: {
  value: Record<string, string>
  onChange: (v: Record<string, string>) => void
  maskSensitive?: boolean
  vars: VarEntry[]
  nodeId?: string
  labelCtx: LabelCtx
}) {
  const rows = Object.entries(value)
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set())
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
            {/* 这一格以前是唯一没有 ref 的输入框：选完变量光标会跳到末尾，
                想在中间插第二个引用得重新点一次。换成 RefField 之后不存在
                "没有 ref"的路径了 */}
            <RefField
              secret={sensitive && !showing}
              value={v}
              onChange={(next) => set(i, k, next)}
              vars={vars}
              placeholder="值，键入 / 引用上游变量"
              ariaLabel={`${k || `第 ${i + 1} 项`}的值`}
              autoComplete="off"
              chip={!sensitive || showing}
              labelCtx={labelCtx}
              nodeId={nodeId}
              expectedType="string"
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
      <button className="kv__add" onClick={() => {
        setRevealed(new Set())
        onChange({ ...value, '': '' })
      }}>
        + 添加一项
      </button>
    </div>
  )
}

/**
 * 数字输入框。**编辑期间显示的是本地草稿，不是从 props 推出来的值。**
 *
 * 直接用受控 input 的话，清空输入框会把值置成 undefined，而上面那句
 * `values[key] === undefined ? sub.default : values[key]` 立刻又把默认值填回来 ——
 * 于是「把 15 删掉改成 20」这件事**根本做不到**：退格两下，15 自己回来了。
 * 有 default 的数字字段全都中招（超时时间、行数上限、HTTP 超时……）。
 *
 * 所以：编辑时输入框跟着草稿走，允许它一时是空的；失焦时才归位 ——
 * 空了就退回默认值，超出范围就夹到边界。
 */
function NumberField({
  value, min, max, integer, invalid, onChange,
}: {
  value: number | undefined
  min?: number
  max?: number
  integer?: boolean
  invalid?: boolean
  onChange: (next: number | undefined) => void
}) {
  /** null = 没在编辑，显示 props 的值 */
  const [draft, setDraft] = useState<string | null>(null)
  const shown = displayNumber(draft, value)

  return (
    <input
      type="number"
      value={shown}
      min={min}
      max={max}
      aria-invalid={invalid}
      onChange={(e) => {
        const text = e.target.value
        setDraft(text)                                  // 先让输入框跟手，哪怕现在是空的
        // 空着不往上抛：抛了就会被默认值顶回来，正是这个组件要解决的问题。
        // 中间态（比如 min=1 时打出的 0）照抛，实时预览要跟着动，失焦时再夹
        if (text === '') return
        const n = Number(text)
        if (Number.isFinite(n)) onChange(integer ? Math.round(n) : n)
      }}
      onBlur={() => {
        const text = draft
        setDraft(null)                                  // 把显示权交回 props
        if (text !== null) onChange(commitNumber(text, { min, max, integer }))
      }}
    />
  )
}
