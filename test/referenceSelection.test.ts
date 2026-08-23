import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applySelectionFilter, parseFilterArgs } from '../src/lib/selectionFilters.ts'
import { compileReferenceSelection } from '../src/lib/referenceSelection.ts'
import { resolveTemplate } from '../src/lib/engine.ts'

const rows = [
  { uid: 123, name: '张三', note: '上海,浦东' },
  { uid: 456, name: '李四', note: '北京' },
]

test('参数解析保留引号内逗号和字面量类型', () => {
  assert.deepEqual(parseFilterArgs('"note", eq, "上海,浦东", true, 12, null'), ['note', 'eq', '上海,浦东', true, 12, null])
  assert.deepEqual(parseFilterArgs("'备注', eq, 'O\\'Reilly,上海\\n浦东'"), ['备注', 'eq', "O'Reilly,上海\n浦东"])
})

test('表格选择过滤器覆盖行、单元格、整列和条件匹配', () => {
  assert.equal(applySelectionFilter(rows, 'at', [1, 'name']).value, '李四')
  assert.deepEqual(applySelectionFilter(rows, 'first', []).value, rows[0])
  assert.equal(applySelectionFilter(rows, 'last', ['uid']).value, 456)
  assert.deepEqual(applySelectionFilter(rows, 'column', ['name']).value, ['张三', '李四'])
  assert.equal(applySelectionFilter(rows, 'find', ['note', 'contains', '浦东', 'uid']).value, 123)
  assert.equal(applySelectionFilter(rows, 'find', ['uid', 'gt', 999, 'name']).value, undefined)
})

test('选择结果编译为兼容流程定义的表达式', () => {
  assert.equal(compileReferenceSelection({
    sourceNodeId: 'n2', sourceLabel: 'SQL 查询', path: 'rows', mode: 'at', index: 1,
    column: 'token', valueType: 'string', label: 'token · 第 2 行',
  }), "{{ $.nodes.n2.output.rows | at(1, 'token') }}")
  assert.equal(compileReferenceSelection({
    sourceNodeId: 'n2', sourceLabel: 'SQL 查询', path: 'rows', mode: 'find',
    matchColumn: 'note', operator: 'eq', matchValue: '上海,浦东', resultColumn: 'token',
    valueType: 'string', label: 'token',
  }), "{{ $.nodes.n2.output.rows | find('note', eq, '上海,浦东', 'token') }}")
})

test('插入 HTTP JSON 字符串后仍是合法 JSON', () => {
  const reference = compileReferenceSelection({
    sourceNodeId: 'n2', sourceLabel: 'SQL 查询', path: 'rows', mode: 'at', index: 0,
    column: 'sign_key', valueType: 'string', label: 'sign_key · 第 1 行',
  })
  const body = `{"appCertificate":"${reference}"}`
  assert.deepEqual(JSON.parse(body), { appCertificate: "{{ $.nodes.n2.output.rows | at(0, 'sign_key') }}" })
  const resolved = resolveTemplate(body, {
    trigger: {},
    run: { id: 'run_test', startedAt: '2026-08-17T00:00:00.000Z' },
    nodes: { n2: { output: { rows: [{ sign_key: 'secret-value' }] } } },
  })
  assert.deepEqual(JSON.parse(String(resolved)), { appCertificate: 'secret-value' })
})

// ---------------------------------------------------------------- 第二批：筛选行 / 前 N / 汇总

test('筛选行编译成 where，且引擎筛出来的和面板预览一致', () => {
  const expr = compileReferenceSelection({
    sourceNodeId: 'n2', sourceLabel: 'SQL 查询', path: 'rows', mode: 'where',
    matchColumn: 'uid', operator: 'gte', matchValue: 200, valueType: 'array', label: '筛选 uid≥200',
  })
  assert.equal(expr, "{{ $.nodes.n2.output.rows | where('uid', gte, 200) }}")
  const out = resolveTemplate(expr, {
    trigger: {}, run: { id: 'r', startedAt: '2026-08-17T00:00:00.000Z' },
    nodes: { n2: { output: { rows } } },
  })
  assert.deepEqual(out, [rows[1]])
})

test('前 N 行：带列就接 table，不带列就是行列表', () => {
  const base = { sourceNodeId: 'n2', sourceLabel: 'SQL 查询', path: 'rows', mode: 'top' as const, sortColumn: 'uid', direction: 'desc' as const, limit: 1, label: '前 1 行' }
  assert.equal(
    compileReferenceSelection({ ...base, columns: ['uid', 'name'], valueType: 'string' }),
    "{{ $.nodes.n2.output.rows | sort('uid', desc) | limit(1) | table('uid', 'name') }}",
  )
  assert.equal(
    compileReferenceSelection({ ...base, valueType: 'array' }),
    "{{ $.nodes.n2.output.rows | sort('uid', desc) | limit(1) }}",
  )
  const ctx = { trigger: {}, run: { id: 'r', startedAt: '2026-08-17T00:00:00.000Z' }, nodes: { n2: { output: { rows } } } }
  assert.deepEqual(resolveTemplate(compileReferenceSelection({ ...base, valueType: 'array' }), ctx), [rows[1]])
  assert.match(String(resolveTemplate(compileReferenceSelection({ ...base, columns: ['name'], valueType: 'string' }), ctx)), /李四/)
})

test('汇总按钮 = 引擎里同名过滤器；去重个数和拼接各是两段链', () => {
  const base = { sourceNodeId: 'n2', sourceLabel: 'SQL 查询', path: 'rows' }
  assert.equal(compileReferenceSelection({ ...base, mode: 'aggregate', fn: 'avg', column: 'uid', valueType: 'number', label: 'uid · 平均' }), "{{ $.nodes.n2.output.rows | avg('uid') }}")
  assert.equal(compileReferenceSelection({ ...base, mode: 'uniqueCount', column: 'name', valueType: 'integer', label: 'name · 去重个数' }), "{{ $.nodes.n2.output.rows | unique('name') | count }}")
  assert.equal(compileReferenceSelection({ ...base, mode: 'join', column: 'name', separator: '、', valueType: 'string', label: 'name · 拼接' }), "{{ $.nodes.n2.output.rows | column('name') | join('、') }}")
})
