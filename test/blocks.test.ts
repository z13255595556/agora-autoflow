import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockRe, canChipify, serializeBlocks, tokenizeRefs, ZWSP } from '../src/lib/blocks.ts'
import { sqlInertAt } from '../src/lib/placeholders.ts'

/**
 * 只测纯层。DOM 那半边（选区、输入法合成、execCommand）拿 jsdom 测只会在
 * 恰恰最危险的行为上给出虚假信心，那部分靠真实浏览器验证。
 */

/** 四语法齐活的 SQL —— 顺带两个 extractSqlPlaceholders 必须跳过的陷阱 */
const SQL_FIXTURE = `SELECT vid, '{{notachip}}' AS lit, ts::int
FROM t                       -- 注释里的 :fake 和 {{fake}} 都不该被认出来
WHERE dt = {{ date('now-1d','yyyyMMdd') }}
  AND vid = {{vid}}
  AND uid = :uid
  AND x   = {{ $.nodes.n2.output.rows[0].avg_dc }}
  AND s   = 'a:b'`

const FIXTURES: string[] = [
  '',
  'no blocks at all',
  '{{ $.trigger.vid }}',
  '前缀 {{ $.nodes.n2.output.rows[0].vid }} 后缀',
  '{{a}}{{b}}',
  '{{  $.x  }}',
  '{{}}',
  '{{ a } b }}',            // 谁都匹配不上，必须原样留着
  '{{ 未闭合',
  '未开始 }}',
  '{{{ $.x }}}',
  '{{ $.nodes.n2.output.rows | table(uid, avg_dc) }}',
  "{{ date('now-1d','yyyy/MM/dd') }}",   // 参数里带 / —— slash 匹配的雷区
  '{{ $.a == "x" }}',
  '行一 {{ $.x }}\n行二 {{ $.y }}',
  '{{ 含\n换行的块 }}',
  '}}{{',
  '{{ $.x }}{{ $.y }}{{ $.z }}',
  SQL_FIXTURE,
]

test('往返无损：serializeBlocks(tokenizeRefs(v)) === v', () => {
  for (const v of FIXTURES) {
    for (const placeholders of [false, true]) {
      assert.equal(serializeBlocks(tokenizeRefs(v, { placeholders })), v, `往返丢了内容：${JSON.stringify(v)}`)
    }
  }
})

test('每个块的 raw 都等于原串上那一段', () => {
  for (const v of FIXTURES) {
    for (const b of tokenizeRefs(v)) {
      assert.equal(b.raw, v.slice(b.start, b.end), `raw 和 start/end 对不上：${JSON.stringify(v)}`)
    }
  }
})

test('块的切法和引擎的正则完全一致', () => {
  // 这条属性保证胶囊和运行期永远不会对"什么算一个块"产生分歧。
  // 不传 inert，否则死区降级会（正确地）让两边不一样
  for (const v of FIXTURES) {
    const mine = tokenizeRefs(v).filter((b) => b.kind !== 'text').map((b) => b.raw)
    const engine = v.match(blockRe()) ?? []
    assert.deepEqual(mine, engine, `切法不一致：${JSON.stringify(v)}`)
  }
})

test('首尾一定是 text 块，且 text 与非 text 交替', () => {
  for (const v of FIXTURES) {
    const bs = tokenizeRefs(v)
    assert.equal(bs[0].kind, 'text')
    assert.equal(bs.at(-1)!.kind, 'text')
    bs.forEach((b, i) => assert.equal(b.kind === 'text', i % 2 === 0, `第 ${i} 块的奇偶不对：${JSON.stringify(v)}`))
  }
})

test('分类：六种 kind', () => {
  const kindOf = (v: string, placeholders = false) =>
    tokenizeRefs(v, { placeholders }).find((b) => b.kind !== 'text')?.kind

  assert.equal(kindOf('{{ $.trigger.vid }}'), 'ref')
  assert.equal(kindOf('{{ $.nodes.n2.output.rows | table(a) }}'), 'ref')
  assert.equal(kindOf("{{ date('now-1d','yyyyMMdd') }}"), 'fn')
  assert.equal(kindOf('{{ 123 }}'), 'expr')
  assert.equal(kindOf('{{ "abc" }}'), 'expr')
  assert.equal(kindOf('{{ 1 > 2 }}'), 'expr')
  assert.equal(kindOf('{{}}'), 'bad')
  assert.equal(kindOf('{{ 随便写点什么 }}'), 'bad')
})

test('裸标识符：只有声明了占位符的字段才认，否则是写错了', () => {
  const kindOf = (v: string, placeholders: boolean) =>
    tokenizeRefs(v, { placeholders }).find((b) => b.kind !== 'text')?.kind

  // 这正是 engine.resolveOperand 运行期才抛的那个错，提前到编辑期变红
  assert.equal(kindOf('{{date}}', false), 'bad')
  assert.equal(kindOf('{{date}}', true), 'placeholder')
  // 带 $. 的永远是引用，不受这个开关影响
  assert.equal(kindOf('{{ $.trigger.date }}', true), 'ref')
})

test('SQL 四语法：认出该认的，放过不该认的', () => {
  const opts = { placeholders: true, inert: sqlInertAt(SQL_FIXTURE) }
  const bs = tokenizeRefs(SQL_FIXTURE, opts).filter((b) => b.kind !== 'text')

  // 只有三枚胶囊。`'{{notachip}}'` 在单引号里、`{{fake}}` 在 -- 注释里，
  // 前后端都不会替换它们，所以它们是字面文本，一枚胶囊都不该画。
  assert.deepEqual(bs.map((b) => b.kind), ['fn', 'placeholder', 'ref'])
  assert.deepEqual(bs.map((b) => b.body), [
    "date('now-1d','yyyyMMdd')",
    'vid',
    '$.nodes.n2.output.rows[0].avg_dc',
  ])

  // 死区外的东西一个字都不能动
  const back = serializeBlocks(tokenizeRefs(SQL_FIXTURE, opts))
  assert.equal(back, SQL_FIXTURE)
  for (const s of [':uid', "'a:b'", 'ts::int', "'{{notachip}}'", '{{fake}}']) {
    assert.ok(back.includes(s), `丢了 ${s}`)
  }
})

test('inert 只降级裸标识符，引号里的 $. 引用照样是引用', () => {
  // registry 里的 SQL 模板就长这样：WHERE dt = '{{ $.nodes.n2.output.compact }}'
  const sql = "WHERE dt = '{{ $.nodes.n2.output.compact }}' AND a = '{{bare}}'"
  const bs = tokenizeRefs(sql, { placeholders: true, inert: sqlInertAt(sql) }).filter((b) => b.kind !== 'text')
  assert.deepEqual(bs.map((b) => b.kind), ['ref'])
  assert.equal(serializeBlocks(tokenizeRefs(sql, { placeholders: true, inert: sqlInertAt(sql) })), sql)
})

test('canChipify：自检失败 / 含零宽空格 / 超长 都拒绝', () => {
  for (const v of FIXTURES) assert.equal(canChipify(v, { placeholders: true }), true, JSON.stringify(v))
  assert.equal(canChipify(`已经有${ZWSP}零宽空格`), false)
  assert.equal(canChipify('x'.repeat(20_001)), false)
  assert.equal(canChipify('x'.repeat(20_000)), true)
})

test('空格写法不同的块是不同的原文，不能被归一', () => {
  // dataset.chipRaw 存原始子串而不是反解出的路径，就是为了这个
  for (const v of ['{{$.x}}', '{{ $.x }}', '{{   $.x   }}']) {
    assert.equal(serializeBlocks(tokenizeRefs(v)), v)
  }
  assert.equal(tokenizeRefs('{{$.x}}')[1].body, '$.x')
  assert.equal(tokenizeRefs('{{   $.x   }}')[1].body, '$.x')
  assert.equal(tokenizeRefs('{{   $.x   }}')[1].raw, '{{   $.x   }}')
})
