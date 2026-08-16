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
