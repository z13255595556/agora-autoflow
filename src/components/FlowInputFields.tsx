import type { FlowInputField } from '../types'

const KIND_LABEL: Record<string, string> = {
  string: '文本', integer: '整数', number: '小数', boolean: '是/否', date: '日期', select: '选择',
}

/**
 * 流程入参的那一排控件。底部运行面板和节点编辑页的运行条**共用这一份**。
 *
 * 两处写的是同一个 `manualInputs`，也就是同一次运行的 `$.trigger.*`。
 * 控件长得不一样（一边日期框、一边裸文本框）的话，用户会以为那是两套入参，
 * 而且日期这种「表单显示 2026-08-21、引擎收到一个随手敲的 20260821」的偏差
 * 只会在其中一条路径上发生 —— 正是 coerceInput 那条注释在防的事。
 *
 * 只渲染字段本身，不带按钮：两边的动作不同（面板是「运行整条」，
 * 运行条是「只跑这一个节点」），布局也不同，那部分留给调用方。
 */
export default function FlowInputFields({
  fields,
  form,
  onChange,
  fieldClassName = 'runpanel__field',
}: {
  fields: FlowInputField[]
  form: Record<string, string>
  onChange: (next: Record<string, string>) => void
  fieldClassName?: string
}) {
  return (
    <>
      {fields.map((f) => {
        const value = form[f.key] ?? ''
        const set = (v: string) => onChange({ ...form, [f.key]: v })
        const placeholder = f.description || KIND_LABEL[f.type]
        return (
          <label key={f.key} className={fieldClassName} title={f.description}>
            <span>
              {f.title || f.key}
              {f.required && <i className="req">*</i>}
            </span>
            {/* 按种类画控件：日期用日期框（值天然是 yyyy-MM-dd，SQL 占位符直接能用），
                下拉用 select，是/否用开关 —— 以前全是一个要手敲的文本框 */}
            {f.type === 'select' ? (
              <select data-run-input={f.key} value={value} onChange={(e) => set(e.target.value)}>
                <option value="">{placeholder}</option>
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : f.type === 'boolean' ? (
              <select data-run-input={f.key} value={value} onChange={(e) => set(e.target.value)}>
                <option value="">{placeholder}</option>
                <option value="true">是</option>
                <option value="false">否</option>
              </select>
            ) : (
              <input
                data-run-input={f.key}
                type={f.type === 'date' ? 'date' : f.type === 'integer' || f.type === 'number' ? 'number' : 'text'}
                step={f.type === 'number' ? 'any' : undefined}
                value={value}
                placeholder={placeholder}
                onChange={(e) => set(e.target.value)}
              />
            )}
          </label>
        )
      })}
    </>
  )
}

/**
 * 把焦点送到第一个还空着的必填入参上。
 *
 * `root` 是调用方自己那一份表单的容器 —— 必须限定在容器里找，不能 document
 * 级查询：运行面板和运行条渲染的是同一批 `data-run-input`，两个都挂着的时候
 * document 级只会命中先挂上的那一个，于是「拦住了却没高亮任何一格」。
 */
export function focusMissingInput(root: HTMLElement | null, key: string | undefined): void {
  if (!root || !key) return
  root.querySelector<HTMLElement>(`[data-run-input="${CSS.escape(key)}"]`)?.focus()
}
