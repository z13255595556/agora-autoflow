import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectionDisplayLabel, compileReferenceSelection } from '../src/lib/referenceSelection.ts'
import { filterSlashVars } from '../src/lib/slash.ts'
import { fitReason } from '../src/lib/referenceFit.ts'
import { describeBlock } from '../src/lib/refLabel.ts'
import { columnsUsedIn } from '../src/lib/output.ts'

test('展示文案不含 $. 路径', () => {
  const sel = {
    sourceNodeId: 'n2', sourceLabel: 'SQL 查询', path: 'rows',
    mode: 'at' as const, index: 0, column: 'token',
    valueType: 'string' as const, label: 'token · 第 1 行',
  }
  const shown = selectionDisplayLabel(sel)
  assert.equal(shown.includes('$.'), false)
  assert.equal(shown.includes('n2'), false)
  assert.match(compileReferenceSelection(sel), /\$\.nodes\.n2/)
})

test('slash 候选项的展示名不含 $.', () => {
  const vars = [{
    path: '$.nodes.n2.output.rows',
    label: '结果行',
    group: 'SQL 查询',
    type: 'array',
    displayLabel: 'SQL 查询 · 结果行',
  }]
  const [hit] = filterSlashVars(vars, '结果')
  assert.ok(hit)
  assert.equal((hit.displayLabel ?? `${hit.group} · ${hit.label}`).includes('$.'), false)
})

test('URL 字段不能插入整表', () => {
  const reason = fitReason({
    sourceNodeId: 'n2', sourceLabel: 'SQL', path: 'rows',
    mode: 'table', columns: ['a'], valueType: 'string', label: '表',
  }, 'url')
  assert.ok(reason)
})

test('文本字段可以插入标量', () => {
  assert.equal(fitReason({
    sourceNodeId: 'n2', sourceLabel: 'SQL', path: 'rowCount',
    mode: 'field', valueType: 'integer', label: '行数',
  }, 'string'), null)
})

test('第二批选择（筛选 / 前 N / 汇总）的展示文案也不含 $. 和节点 id', () => {
  const sels = [
    { sourceNodeId: 'n2', sourceLabel: 'SQL 查询', path: 'rows', mode: 'where' as const, matchColumn: 'dc', operator: 'gt' as const, matchValue: 5, valueType: 'array' as const, label: '筛选 dc>5' },
    { sourceNodeId: 'n2', sourceLabel: 'SQL 查询', path: 'rows', mode: 'top' as const, sortColumn: 'dc', direction: 'desc' as const, limit: 10, columns: ['vid'], valueType: 'string' as const, label: '按 dc 最大的前 10 行 · 表格' },
    { sourceNodeId: 'n2', sourceLabel: 'SQL 查询', path: 'rows', mode: 'aggregate' as const, fn: 'avg' as const, column: 'dc', valueType: 'number' as const, label: 'dc · 平均' },
  ]
  for (const sel of sels) {
    const shown = selectionDisplayLabel(sel)
    assert.equal(shown.includes('$.'), false, shown)
    assert.equal(shown.includes('n2'), false, shown)
    assert.match(compileReferenceSelection(sel), /\$\.nodes\.n2/)
  }
})

test('链式过滤器在胶囊上每一段都有中文标签', () => {
  const label = describeBlock(
    { kind: 'ref', raw: "{{ $.nodes.n2.output.rows | sort('dc', desc) | limit(10) | table('vid') }}", body: "$.nodes.n2.output.rows | sort('dc', desc) | limit(10) | table('vid')", start: 0, end: 0 },
    { nodes: [{ id: 'n2', label: 'SQL 查询', typeId: 'sql.query' }], flowInputs: [] },
  )
  assert.equal(label.tone, 'ok')
  assert.match(label.text, /降序/)
  assert.match(label.text, /前 10 行/)
  assert.match(label.text, /表格 1列/)
  assert.equal(label.text.includes("'"), false, '标签里不该带编译出来的引号')
})

test('消息预览认得每种过滤器里的列名位置', () => {
  assert.deepEqual(columnsUsedIn("$.nodes.n2.output.rows | where('dcc', gt, 5) | sum('vid')"), ['dcc', 'vid'])
  assert.deepEqual(columnsUsedIn("$.nodes.n2.output.rows | column('name') | join('、', 'uid')"), ['name', 'uid'])
  assert.deepEqual(columnsUsedIn('$.nodes.n2.output.rows | table(uid, name)'), ['uid', 'name'])
  assert.deepEqual(columnsUsedIn('$.nodes.n2.output.rows | count'), [])
})
