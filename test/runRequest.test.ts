import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideRunRequest, defaultForm, stepRunBlockers, triggerFromForm } from '../src/lib/runRequest.ts'

test('运行中点运行是停止', () => {
  assert.deepEqual(
    decideRunRequest({ running: true, flowInputs: [], form: {}, problems: [] }),
    { action: 'stop' },
  )
})

test('有校验问题则打开面板并说明原因', () => {
  const got = decideRunRequest({
    running: false,
    flowInputs: [],
    form: {},
    problems: ['SQL 未填写'],
  })
  assert.deepEqual(got, { action: 'open-panel', reason: 'invalid', messages: ['SQL 未填写'] })
})

test('有未填必填入参则打开面板并聚焦', () => {
  const got = decideRunRequest({
    running: false,
    flowInputs: [{ key: 'date', title: '日期', type: 'string', required: true }],
    form: {},
    problems: [],
  })
  assert.deepEqual(got, { action: 'open-panel', reason: 'missing-inputs', messages: ['日期'] })
})

test('无入参且校验通过则直接开跑', () => {
  const got = decideRunRequest({ running: false, flowInputs: [], form: {}, problems: [] })
  assert.deepEqual(got, { action: 'start', trigger: {} })
})

test('入参都填了则带着转换后的 trigger 开跑', () => {
  const got = decideRunRequest({
    running: false,
    flowInputs: [
      { key: 'date', title: '日期', type: 'string', required: true },
      { key: 'n', title: '数量', type: 'integer', required: false },
      { key: 'ok', title: '开关', type: 'boolean', required: false },
    ],
    form: { date: '20260822', n: '3', ok: 'true' },
    problems: [],
  })
  assert.deepEqual(got, { action: 'start', trigger: { date: '20260822', n: 3, ok: true } })
})

test('triggerFromForm 按类型转换', () => {
  assert.deepEqual(
    triggerFromForm(
      [
        { key: 's', title: 's', type: 'string', required: false },
        { key: 'i', title: 'i', type: 'integer', required: false },
        { key: 'b', title: 'b', type: 'boolean', required: false },
      ],
      { s: 'x', i: '', b: 'false' },
    ),
    { s: 'x', i: 0, b: false },
  )
})

// ---------------------------------------------------------------- 入参种类：日期 / 下拉 / 小数 + 默认值

test('日期和下拉原样是字符串，小数转 number', () => {
  const inputs = [
    { key: 'date', title: '日期', type: 'date' as const, required: true },
    { key: 'engine', title: '引擎', type: 'select' as const, required: false, options: ['hive', 'doris'] },
    { key: 'ratio', title: '阈值', type: 'number' as const, required: false },
  ]
  assert.deepEqual(
    triggerFromForm(inputs, { date: '2026-08-21', engine: 'doris', ratio: '0.25' }),
    { date: '2026-08-21', engine: 'doris', ratio: 0.25 },
  )
})

test('★ 有默认值的必填项不拦运行 —— 默认值灌进表单，不只是 placeholder', () => {
  const inputs = [{ key: 'date', title: '日期', type: 'date' as const, required: true, default: '2026-08-21' }]
  const form = defaultForm(inputs)
  assert.deepEqual(form, { date: '2026-08-21' })
  assert.equal(decideRunRequest({ running: false, flowInputs: inputs, form, problems: [] }).action, 'start')
})

test('defaultForm 跳过没有默认值和默认值为空的项', () => {
  assert.deepEqual(defaultForm([
    { key: 'a', title: 'a', type: 'string', required: false },
    { key: 'b', title: 'b', type: 'string', required: false, default: '' },
    { key: 'c', title: 'c', type: 'integer', required: false, default: '7' },
  ]), { c: '7' })
})

// ---------------------------------------------------------------- 单节点试运行的闸

const DATE = { key: 'date', title: '日期', type: 'date' as const, required: true }

test('★ 单节点试运行同样拦必填入参 —— 空着跑出来的是一份悄悄用了空日期的结果', () => {
  assert.deepEqual(
    stepRunBlockers({ running: false, nodeErrors: [], flowInputs: [DATE], form: {} }),
    ['必填入参未填：日期'],
  )
})

test('入参填了就放行', () => {
  assert.deepEqual(
    stepRunBlockers({ running: false, nodeErrors: [], flowInputs: [DATE], form: { date: '2026-08-21' } }),
    [],
  )
})

test('只填了空格不算填了', () => {
  assert.equal(
    stepRunBlockers({ running: false, nodeErrors: [], flowInputs: [DATE], form: { date: '  ' } }).length,
    1,
  )
})

test('节点自己的参数错排在入参前面 —— 运行条上只显示第一条', () => {
  assert.deepEqual(
    stepRunBlockers({
      running: false,
      nodeErrors: ['必填项「SQL」未填'],
      flowInputs: [DATE],
      form: {},
    }),
    ['必填项「SQL」未填', '必填入参未填：日期'],
  )
})

test('运行中只说运行中，不再堆一串还没轮到的理由', () => {
  assert.deepEqual(
    stepRunBlockers({ running: true, nodeErrors: ['必填项「SQL」未填'], flowInputs: [DATE], form: {} }),
    ['正在运行中，等这次跑完'],
  )
})

test('★ 单节点不看图结构 —— 没接触发器也能单独跑这一个节点', () => {
  // decideRunRequest 那边 problems 里装的是 graphProblems；这边刻意没有这个入口
  assert.deepEqual(stepRunBlockers({ running: false, nodeErrors: [], flowInputs: [], form: {} }), [])
})

test('★ 有默认值的必填入参不拦试运行 —— 和整条运行同一把尺子', () => {
  const inputs = [{ ...DATE, default: '2026-08-21' }]
  assert.deepEqual(
    stepRunBlockers({ running: false, nodeErrors: [], flowInputs: inputs, form: defaultForm(inputs) }),
    [],
  )
})
