import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compareCondition, conditionErrors, conditionSummary, conditionTemplates,
  isEmptyValue, readConditionGroup,
} from '../src/lib/conditions.ts'
import { evaluateIf, MissingValue } from '../src/lib/engine.ts'
import { edge, node, outputOf, runGolden, stepOf } from './golden/harness.ts'

/**
 * 条件行的语义。
 *
 * 这里钉死的是三件"错了也看不出来"的事：
 *   1. 0 和 false 不算空 —— 判它们空会让"结果不为空"在一行都没查到时反而成立；
 *   2. 「为空 / 不为空」允许左值取不到，其余比较方式照旧炸掉；
 *   3. 没有条件行时**必须**回退到老的 condition 表达式，老流程不改一行还能跑。
 */

const ctx = {
  trigger: { name: '日报' },
  run: { id: 'run_test', startedAt: '2026-08-17T09:00:00.000Z' },
  nodes: {
    q1: {
      output: {
        rows: [{ vid: 1, name: 'a' }, { vid: 2, name: 'b' }],
        rowCount: 2,
        note: '',
      },
    },
    q0: { output: { rows: [], rowCount: 0 } },
  },
}

const group = (items: unknown[], logic = 'and') => ({ conditions: { logic, items } })

// ---------------------------------------------------------------- 空的定义

test('0 和 false 不算空 —— 它们是值，不是"没有"', () => {
  assert.equal(isEmptyValue(0), false)
  assert.equal(isEmptyValue(false), false)
  assert.equal(isEmptyValue(''), true)
  assert.equal(isEmptyValue('   '), true)
  assert.equal(isEmptyValue([]), true)
  assert.equal(isEmptyValue({}), true)
  assert.equal(isEmptyValue(null), true)
  assert.equal(isEmptyValue(undefined), true)
})

test('查询结果不为空：有行为真、空数组为假', () => {
  assert.equal(evaluateIf(group([{ left: '{{ $.nodes.q1.output.rows }}', op: 'notEmpty' }]), ctx), true)
  assert.equal(evaluateIf(group([{ left: '{{ $.nodes.q0.output.rows }}', op: 'notEmpty' }]), ctx), false)
  assert.equal(evaluateIf(group([{ left: '{{ $.nodes.q0.output.rows }}', op: 'empty' }]), ctx), true)
})

test('rowCount 为 0 时"不为空"仍然成立 —— 想问是不是 0 得用数字比较', () => {
  assert.equal(evaluateIf(group([{ left: '{{ $.nodes.q0.output.rowCount }}', op: 'notEmpty' }]), ctx), true)
  assert.equal(evaluateIf(group([{ left: '{{ $.nodes.q0.output.rowCount }}', op: 'gt', right: '0' }]), ctx), false)
  assert.equal(evaluateIf(group([{ left: '{{ $.nodes.q1.output.rowCount }}', op: 'gt', right: '0' }]), ctx), true)
})

// ------------------------------------------------------------ 缺值的两种待遇

test('「不为空」允许左值取不到：取不到就是空，这是答案不是故障', () => {
  assert.equal(evaluateIf(group([{ left: '{{ $.nodes.q1.output.没这个字段 }}', op: 'empty' }]), ctx), true)
  assert.equal(evaluateIf(group([{ left: '{{ $.nodes.q1.output.没这个字段 }}', op: 'notEmpty' }]), ctx), false)
})

test('其余比较方式照旧炸掉：包含一个不存在的字段是笔误，不是 false', () => {
  assert.throws(
    () => evaluateIf(group([{ left: '{{ $.nodes.q1.output.没这个字段 }}', op: 'contains', right: 'a' }]), ctx),
    MissingValue,
  )
})

// ---------------------------------------------------------------- 比较语义

test('列表的「包含」按项比，不按 JSON 子串比', () => {
  assert.equal(compareCondition('contains', ['abc'], 'b'), false)
  assert.equal(compareCondition('contains', ['abc'], 'abc'), true)
  assert.equal(compareCondition('contains', 'abc', 'b'), true)
})

test('宽松相等：数字 1 和文本 "1" 相等，SQL 列类型漂移不会造成假阴性', () => {
  assert.equal(compareCondition('is', 1, '1'), true)
  assert.equal(compareCondition('isNot', 1, '1'), false)
})

test('数字比较遇到非数字恒为假，和引擎里的 > 同一套', () => {
  assert.equal(compareCondition('gt', 'abc', 1), false)
  assert.equal(compareCondition('lt', 'abc', 1), false)
})

test('数量比较看的是长度，不是值本身', () => {
  assert.equal(compareCondition('lengthGt', [1, 2, 3], 2), true)
  assert.equal(compareCondition('lengthEq', [], 0), true)
  assert.equal(compareCondition('lengthLt', 'abc', 5), true)
})

test('「为真」用引擎的 truthy 规则，字符串 "false" 是假', () => {
  assert.equal(compareCondition('isTrue', 'false', undefined), false)
  assert.equal(compareCondition('isTrue', '0', undefined), false)
  assert.equal(compareCondition('isTrue', 'x', undefined), true)
})

// ---------------------------------------------------------------- 组合与回退

test('且 / 或', () => {
  const items = [
    { left: '{{ $.nodes.q1.output.rows }}', op: 'notEmpty' },
    { left: '{{ $.nodes.q1.output.note }}', op: 'notEmpty' },
  ]
  assert.equal(evaluateIf(group(items, 'and'), ctx), false)
  assert.equal(evaluateIf(group(items, 'or'), ctx), true)
})

test('or 也把每一行都算一遍，不短路 —— 行序不该决定错误报不报', () => {
  assert.throws(
    () => evaluateIf(group([
      { left: '{{ $.nodes.q1.output.rows }}', op: 'notEmpty' },
      { left: '{{ $.nodes.q1.output.没这个字段 }}', op: 'is', right: 'x' },
    ], 'or'), ctx),
    MissingValue,
  )
})

test('右值也能引用变量', () => {
  assert.equal(evaluateIf(group([{ left: '{{ $.trigger.name }}', op: 'is', right: '日报' }]), ctx), true)
  assert.equal(
    evaluateIf(group([{ left: '{{ $.nodes.q1.output.rowCount }}', op: 'is', right: '{{ $.nodes.q1.output.rowCount }}' }]), ctx),
    true,
  )
})

test('没有条件行就回退到老的表达式，老流程一行都不用改', () => {
  assert.equal(evaluateIf({ condition: '{{ $.nodes.q1.output.rowCount > 0 }}' }, ctx), true)
  assert.equal(evaluateIf({ condition: 'false' }, ctx), false)
  // 空壳条件组同样算"没有条件行"
  assert.equal(evaluateIf({ conditions: { logic: 'and', items: [] }, condition: 'true' }, ctx), true)
})

test('有条件行时老表达式不生效', () => {
  const params = {
    ...group([{ left: '{{ $.nodes.q0.output.rows }}', op: 'notEmpty' }]),
    condition: 'true',
  }
  assert.equal(evaluateIf(params, ctx), false)
})

// ---------------------------------------------------------------- 容错读取

test('形状不对的条件组读成 null，而不是抛错 —— 参数可能是手写的 JSON', () => {
  assert.equal(readConditionGroup({}), null)
  assert.equal(readConditionGroup({ conditions: 'x' }), null)
  assert.equal(readConditionGroup({ conditions: { items: [{ left: 'a', op: '没这个比较方式' }] } }), null)
  const partial = readConditionGroup({ conditions: { items: [{ op: 'empty' }, null, { left: 'a', op: 'is', right: 'b' }] } })
  assert.deepEqual(partial, { logic: 'and', items: [{ left: '', op: 'empty', right: undefined }, { left: 'a', op: 'is', right: 'b' }] })
})

// ---------------------------------------------------------------- 校验与摘要

test('没填完的行报错，错误里带「条件」以便点击定位到字段', () => {
  const g = readConditionGroup(group([
    { left: '', op: 'notEmpty' },
    { left: '{{ $.trigger.name }}', op: 'is', right: '  ' },
  ]))!
  const errors = conditionErrors(g)
  assert.equal(errors.length, 2)
  assert.ok(errors.every((e) => e.includes('「条件」')))
  assert.equal(conditionErrors(readConditionGroup(group([{ left: '{{ $.trigger.name }}', op: 'notEmpty' }]))!).length, 0)
})

test('不需要值的比较方式不把右值送去校验引用', () => {
  const g = readConditionGroup(group([{ left: '{{ $.trigger.name }}', op: 'empty', right: '{{ 乱写 }}' }]))!
  assert.deepEqual(conditionTemplates(g), ['{{ $.trigger.name }}'])
})

// ------------------------------------------------------------ 跑通整条流程

/** t → if →(真) a / (假) b。条件行接的是 SQL mock 出来的 3 行结果 */
const branchFlow = (items: unknown[], logic = 'and') => ({
  name: 'conditions',
  pins: '条件行在真实引擎里也要能决定走哪个出口',
  nodes: [
    node('t', 'trigger.manual'),
    node('q', 'sql.query', { engine: 'hive', sql: 'select 1' }),
    node('i', 'flow.if', { conditions: { logic, items }, condition: 'false' }),
    node('a', 'transform.template', { template: '真' }),
    node('b', 'transform.template', { template: '假' }),
  ],
  edges: [edge('t', 'q'), edge('q', 'i'), edge('i', 'a', 'true'), edge('i', 'b', 'false')],
})

test('★ 条件行在引擎里决定走哪个出口，老的 condition 字段不再插手', async () => {
  const r = await runGolden(branchFlow([{ left: '{{ $.nodes.q.output.rows }}', op: 'notEmpty' }]))
  assert.equal(r.runStatus, 'success')
  // 老字段写死 'false'，但条件行说真 —— 走真出口才算优先级正确
  assert.deepEqual(outputOf(r, 'i'), { matched: true })
  assert.equal(stepOf(r, 'a')?.status, 'success')
  assert.equal(stepOf(r, 'b')?.status, 'skipped')
})

test('★ 条件行里的引用写错，整个节点判失败而不是让异常逃出引擎', async () => {
  const r = await runGolden(branchFlow([{ left: '{{ $.nodes.q.output.没这个字段 }}', op: 'is', right: 'x' }]))
  assert.equal(r.runStatus, 'error')
  const step = stepOf(r, 'i')
  assert.equal(step?.status, 'error')
  assert.match(step?.error ?? '', /取不到值/)
})

test('卡片摘要只留路径最后一段', () => {
  const g = readConditionGroup(group([
    { left: '{{ $.nodes.q1.output.rows }}', op: 'notEmpty' },
    { left: '{{ $.nodes.q1.output.rowCount }}', op: 'gt', right: '10' },
  ], 'or'))!
  assert.equal(conditionSummary(g), 'rows 不为空 或 rowCount 大于 10')
})
