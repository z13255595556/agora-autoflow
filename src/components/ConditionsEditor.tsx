import { useState } from 'react'
import {
  CONDITION_OPS, conditionErrors, opNeedsValue, readConditionGroup,
  type ConditionGroup, type ConditionItem, type ConditionOp,
} from '../lib/conditions'
import type { VarEntry } from '../lib/vars'
import type { LabelCtx } from '../lib/refLabel'
import RefField from './RefField'
import Icon from './Icon'
import { useReferencePicker } from './ReferencePickerContext'

/**
 * 条件行编辑器（对齐 Dify if-else 的 变量 / comparison_operator / value 三段式）。
 *
 * 它取代的写法是"在一个文本框里手写整条表达式"。那个写法真正卡住人的地方不是
 * 语法难，而是**取值面板只能插一枚引用胶囊**：点完 SQL 查询的结果，框里就是
 * `{{ $.nodes.q1.output.rows }}`，想表达"不为空"得自己接着敲 `| count > 0`，
 * 而面板不会告诉你这件事。比较方式做成下拉框之后，「不为空」是一次点击。
 *
 * 左值仍然是完整的模板输入框（RefField），不是只能选变量的下拉：
 * `{{ $.nodes.q1.output.rows | column('dc') | sum }} 大于 100` 这种表达式
 * 一样能写。可视化只是把最常用的一段拿出来，不是把表达能力收窄。
 *
 * 老的 `condition` 表达式没有被删掉，收在下面的「直接写表达式」里 ——
 * 老流程打开时如果看不见自己那条正在生效的表达式，那才是真的坑。
 */

interface Props {
  /** 条件行存在哪个参数键上 */
  fieldKey: string
  /** 老表达式存在哪个兄弟参数键上（registry 的 x-ui.expressionFrom） */
  expressionKey?: string
  values: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  vars: VarEntry[]
  labelCtx: LabelCtx
  nodeId?: string
}

const BLANK: ConditionItem = { left: '', op: 'notEmpty' }

/** 下拉框按分组排版。分组只是排版，不限制能选哪个 —— 左值多半还没跑过，类型无从推断 */
const OP_GROUPS = [...new Set(CONDITION_OPS.map((op) => op.group))]

export default function ConditionsEditor({
  fieldKey, expressionKey, values, onChange, vars, labelCtx, nodeId,
}: Props) {
  const stored = readConditionGroup(values)
  const expression = expressionKey ? String(values[expressionKey] ?? '') : ''
  // 没有条件行、却有一条老表达式 —— 那条表达式正在生效，必须一进来就看得见
  const [advanced, setAdvanced] = useState(() => !stored && expression.trim() !== '')

  // 一行都没有时显示一行空的：空表单里没有任何可点的东西，用户不知道从哪开始。
  // 这一行只存在于界面上，用户真动了它才写进 params
  const group: ConditionGroup = stored ?? { logic: 'and', items: [BLANK] }
  const rowErrors = conditionErrors(group)

  const write = (next: ConditionGroup) => {
    // 删到一行不剩 = 不用条件行了，把键清掉而不是留个空壳：
    // 留下 { items: [] } 会让 readConditionGroup 回退到老表达式，
    // 而界面上还画着条件行，两边说的不是一件事
    onChange(fieldKey, next.items.length ? next : undefined)
  }
  const patch = (index: number, change: Partial<ConditionItem>) => write({
    ...group,
    items: group.items.map((item, i) => {
      if (i !== index) return item
      const merged = { ...item, ...change }
      // 换到不需要值的比较方式时把右值丢掉，不留一个看不见却存着的值
      return opNeedsValue(merged.op) ? merged : { left: merged.left, op: merged.op }
    }),
  })

  return (
    <div className="cond">
      {group.items.map((item, index) => (
        <div className="cond__row" key={index}>
          <div className="cond__lead">
            {index === 0 ? (
              <span className="cond__if">IF</span>
            ) : (
              <button
                className="cond__logic"
                title="在「且」和「或」之间切换。整组条件用同一种连接方式"
                onClick={() => write({ ...group, logic: group.logic === 'and' ? 'or' : 'and' })}
              >
                {group.logic === 'and' ? '且' : '或'}
              </button>
            )}
          </div>

          <div className="cond__fields">
            <div className="cond__line">
              <VariableField
                value={item.left}
                onChange={(next) => patch(index, { left: next })}
                vars={vars}
                labelCtx={labelCtx}
                nodeId={nodeId}
                invalid={!item.left.trim() && rowErrors.length > 0}
              />
              <select
                className="cond__op"
                value={item.op}
                aria-label="比较方式"
                onChange={(e) => patch(index, { op: e.target.value as ConditionOp })}
              >
                {OP_GROUPS.map((groupName) => (
                  <optgroup label={groupName} key={groupName}>
                    {CONDITION_OPS.filter((op) => op.group === groupName).map((op) => (
                      <option value={op.id} key={op.id}>{op.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            {opNeedsValue(item.op) && (
              <RefField
                value={item.right ?? ''}
                onChange={(next) => patch(index, { right: next })}
                vars={vars}
                placeholder="输入值，也可以插入变量"
                ariaLabel="比较值"
                chip
                labelCtx={labelCtx}
                nodeId={nodeId}
                expectedType="string"
              />
            )}
          </div>

          <button
            className="cond__del"
            title="删除这个条件"
            aria-label="删除这个条件"
            onClick={() => write({ ...group, items: group.items.filter((_, i) => i !== index) })}
          >
            <Icon name="trash" size={13} />
          </button>
        </div>
      ))}

      <button className="cond__add" onClick={() => write({ ...group, items: [...group.items, BLANK] })}>
        <Icon name="plus" size={12} /> 添加条件
      </button>

      {expressionKey && (
        <div className="cond__adv">
          <button className="cond__advtoggle" aria-expanded={advanced} onClick={() => setAdvanced((open) => !open)}>
            <b>{advanced ? '−' : '+'}</b> 直接写表达式
          </button>
          {advanced && (
            <>
              <RefField
                value={expression}
                onChange={(next) => onChange(expressionKey, next)}
                vars={vars}
                placeholder="{{ $.nodes.n1.output.rowCount > 0 }}"
                ariaLabel="条件表达式"
                chip
                labelCtx={labelCtx}
                nodeId={nodeId}
                expectedType="string"
              />
              <div className="cond__hint">
                {stored
                  ? '上面有条件行，运行时以条件行为准，这条表达式不生效。'
                  : '整串解析为真才走「真」出口。填了上面的条件行之后，这里就不再生效。'}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 左值输入。就是一个 RefField，外加一枚直接叫出取值面板的按钮。
 *
 * 按钮存在的理由：斜杠触发（打 `/`）在这里发现不了 —— 条件行是个窄输入框，
 * 没有 placeholder 教你打斜杠。而「点一下选变量」是这个控件的主路径。
 */
function VariableField({ value, onChange, vars, labelCtx, nodeId, invalid }: {
  value: string
  onChange: (next: string) => void
  vars: VarEntry[]
  labelCtx: LabelCtx
  nodeId?: string
  invalid?: boolean
}) {
  const picker = useReferencePicker()
  return (
    <div className="cond__var">
      <RefField
        value={value}
        onChange={onChange}
        vars={vars}
        placeholder="选择变量"
        ariaLabel="条件变量"
        ariaInvalid={invalid}
        chip
        labelCtx={labelCtx}
        nodeId={nodeId}
      />
      {picker && nodeId && (
        <button
          className="cond__pick"
          title="从上游数据里选一个值"
          aria-label="从上游数据里选一个值"
          onClick={() => picker.open({
            nodeId,
            query: '',
            // 左值整枚替换，不是往光标处插一段：一行条件的左边只该是一个值。
            // mixed=false 才允许选列表/对象 —— 「结果不为空」问的正是整份列表
            mixed: false,
            initialExpression: value,
            replace: (snippet) => onChange(snippet),
          })}
        >
          <Icon name="vars" size={13} />
        </button>
      )}
    </div>
  )
}
