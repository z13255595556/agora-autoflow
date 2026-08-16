import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MISSING_MARK, MissingValue, resolveTemplate } from '../src/lib/engine.ts'

/**
 * 表达式求值的回归测试。
 *
 * 重点是**缺值不再静默变成空字符串**。这个坑最难被发现的形态是
 * "消息里那段没了" —— run 记 success，群里收到一句缺了数字的日报，
 * 全程没有任何报错。所以这里的每条断言都是在钉死"必须炸"。
 */

const ctx = {
  trigger: { vid: 12345, days: 7 },
  run: { id: 'run_test', startedAt: '2026-08-16T09:00:00.000Z' },
  nodes: {
    q1: {
      output: {
        rows: [
          { vid: 1, name: 'a', dc: 10 },
          { vid: 2, name: 'b', dc: 20 },
        ],
        rowCount: 2,
        summary: { total: 30 },
      },
    },
  },
}

// ---------------------------------------------------------------- 缺值必须炸

test('混排文本里的未命中引用抛错，而不是渲染成空串', () => {
  // 这就是原来的 bug：JSON.stringify(undefined) 返回 undefined 这个值，
  // `?? ''` 把它变成空串，于是这句话渲染成「今天异常  条」
  assert.throws(
    () => resolveTemplate('今天异常 {{ $.nodes.q1.output.summary.bad }} 条', ctx),
    MissingValue,
  )
})

test('整串就是一个引用时，未命中同样抛错', () => {
  assert.throws(() => resolveTemplate('{{ $.nodes.q1.output.nope }}', ctx), MissingValue)
})

test('未填的流程入参不再悄悄变成空', () => {
  assert.throws(() => resolveTemplate('近 {{ $.trigger.notFilled }} 天', ctx), MissingValue)
})

test('引用不存在的节点抛错', () => {
  assert.throws(() => resolveTemplate('{{ $.nodes.q9.output.rows }}', ctx), MissingValue)
})

test('下标越界抛错 —— 模板照着三行点出来，某天只查回一行', () => {
  assert.throws(() => resolveTemplate('{{ $.nodes.q1.output.rows[5].vid }}', ctx), MissingValue)
})

test('过滤器不能替缺值兜底：路径写错时 count 不许老实返回 0', () => {
  // 返回 0 是个不会被任何人察觉的谎
  assert.throws(() => resolveTemplate('{{ $.nodes.q1.output.norows | count }}', ctx), MissingValue)
})

test('错误信息带上出错的引用和 default 的用法', () => {
  try {
    resolveTemplate('{{ $.trigger.missing }}', ctx)
    assert.fail('应该抛错')
  } catch (err) {
    assert.ok(err instanceof MissingValue)
    assert.equal(err.ref, '$.trigger.missing')
    assert.match(err.message, /default/)
  }
})

// ---------------------------------------------------------------- default 逃生口

test("default() 兜住缺值", () => {
  assert.equal(resolveTemplate("异常 {{ $.trigger.nope | default('—') }} 条", ctx), '异常 — 条')
})

test('default() 不吞掉有值的情况', () => {
  assert.equal(resolveTemplate("{{ $.trigger.vid | default('—') }}", ctx), 12345)
})

test('default() 可以叠在别的过滤器后面（缺值逃生口天生站在链尾）', () => {
  assert.equal(
    resolveTemplate("{{ $.nodes.q1.output.rows | find(vid, eq, 999) | default('无') }}", ctx),
    '无',
  )
})

test('default 不写括号等价于 default("")', () => {
  assert.equal(resolveTemplate('前{{ $.trigger.nope | default }}后', ctx), '前后')
})

test('default() 只兜缺值，不盖住真语法错', () => {
  // 过滤器名写错是笔误，不该被 default 静默吞掉 —— 那等于把这个坑换个地方重开
  assert.throws(
    () => resolveTemplate("{{ $.nodes.q1.output.rows | nosuchfilter | default('x') }}", ctx),
    /过滤器/,
  )
  // 裸标识符同理
  assert.throws(() => resolveTemplate("{{ notaref | default('x') }}", ctx), /不是合法引用/)
})

// ---------------------------------------------------------------- 链式过滤器

test('链式过滤器：跌得最狠的是谁', () => {
  // 以前明确抛错"一个 {{ }} 只能接一个过滤器"，这句话表达不出来就只能回去改 SQL，
  // 而改 SQL 意味着多跑一次几分钟的 Hive 查询
  assert.equal(
    resolveTemplate('{{ $.nodes.q1.output.rows | sort(dc, desc) | at(0, name) }}', ctx),
    'b',
  )
})

test('链式过滤器：三段也行', () => {
  assert.equal(
    resolveTemplate('{{ $.nodes.q1.output.rows | column(vid) | unique | count }}', ctx),
    2,
  )
})

test('链条中间的过滤器名写错要报错', () => {
  assert.throws(
    () => resolveTemplate('{{ $.nodes.q1.output.rows | nosuch | count }}', ctx),
    /过滤器/,
  )
})

test('链条末尾的过滤器名写错也要报错（以前只查第一个）', () => {
  assert.throws(
    () => resolveTemplate('{{ $.nodes.q1.output.rows | column(vid) | sunm }}', ctx),
    /过滤器/,
  )
})

test('引号里的竖线不是管道', () => {
  assert.equal(
    resolveTemplate("{{ $.nodes.q1.output.rows | join('|', name) }}", ctx),
    'a|b',
  )
})

// ---------------------------------------------------------------- 聚合过滤器

test('sum：对象数组给列名', () => {
  assert.equal(resolveTemplate('{{ $.nodes.q1.output.rows | sum(dc) }}', ctx), 30)
})

test('sum：标量数组直接求和（与 column 等价）', () => {
  assert.equal(resolveTemplate('{{ $.nodes.q1.output.rows | column(dc) | sum }}', ctx), 30)
})

test('sum 对非数字报错，并提示可能是漏了列名', () => {
  assert.throws(
    () => resolveTemplate('{{ $.nodes.q1.output.rows | sum }}', ctx),
    /列名/,
  )
})

test('unique：按值去重，不是按引用', () => {
  const c = { ...ctx, nodes: { q1: { output: { rows: [{ a: 1 }, { a: 1 }, { a: 2 }] } } } }
  assert.equal(resolveTemplate('{{ $.nodes.q1.output.rows | unique | count }}', c), 2)
})

test('join：默认用顿号（这些串最终进的是中文消息）', () => {
  assert.equal(resolveTemplate('{{ $.nodes.q1.output.rows | join("、", name) }}', ctx), 'a、b')
  assert.equal(resolveTemplate('{{ $.nodes.q1.output.rows | column(name) | join }}', ctx), 'a、b')
})

test('sort：数字按数值比，不按字符串', () => {
  // '10' < '9' 是字符串比较的经典坑
  const c = { ...ctx, nodes: { q1: { output: { rows: [{ n: 9 }, { n: 10 }, { n: 2 }] } } } }
  assert.deepEqual(
    resolveTemplate('{{ $.nodes.q1.output.rows | sort(n) | column(n) }}', c),
    [2, 9, 10],
  )
})

test('sort 不改上游数据', () => {
  const rows = [{ n: 3 }, { n: 1 }]
  const c = { ...ctx, nodes: { q1: { output: { rows } } } }
  resolveTemplate('{{ $.nodes.q1.output.rows | sort(n, desc) }}', c)
  // 原地排序会改上游节点的 output，下一个引用它的地方看到的就是排过序的数据
  assert.deepEqual(rows, [{ n: 3 }, { n: 1 }])
})

test('default 可以出现在链条中间', () => {
  assert.equal(resolveTemplate("{{ $.trigger.nope | default('—') | count }}", ctx), 1)
})

// ---------------------------------------------------------------- 预览的 mark 模式

test('mark 模式把缺值渲染成显眼占位，而不是消失', () => {
  assert.equal(
    resolveTemplate('今天异常 {{ $.nodes.q1.output.summary.bad }} 条', ctx, { onMissing: 'mark' }),
    `今天异常 ${MISSING_MARK} 条`,
  )
})

test('mark 模式仍然对真语法错报错', () => {
  // 编辑期预览要区别对待：缺值是常态（上游还没跑过），写错了不是
  assert.throws(
    () => resolveTemplate('{{ $.nodes.q1.output.rows | nosuchfilter }}', ctx, { onMissing: 'mark' }),
    /过滤器/,
  )
})

// ---------------------------------------------------------------- 原有行为不许回归

test('正常引用照常工作', () => {
  assert.equal(resolveTemplate('{{ $.trigger.vid }}', ctx), 12345)
  assert.equal(resolveTemplate('vid={{ $.trigger.vid }}', ctx), 'vid=12345')
  assert.equal(resolveTemplate('{{ $.nodes.q1.output.summary.total }}', ctx), 30)
})

test('整串引用保留原始类型（数组不被字符串化）', () => {
  const v = resolveTemplate('{{ $.nodes.q1.output.rows }}', ctx)
  assert.ok(Array.isArray(v))
  assert.equal((v as unknown[]).length, 2)
})

test('过滤器照常工作', () => {
  assert.equal(resolveTemplate('{{ $.nodes.q1.output.rows | count }}', ctx), 2)
  assert.equal(String(resolveTemplate('{{ $.nodes.q1.output.rows | column(vid) }}', ctx)), '1,2')
})

test('二元比较照常工作', () => {
  assert.equal(resolveTemplate('{{ $.trigger.days > 3 }}', ctx), true)
  assert.equal(resolveTemplate('{{ $.trigger.vid == 12345 }}', ctx), true)
})

test('多个块混排各自求值', () => {
  assert.equal(
    resolveTemplate('{{ $.trigger.vid }} 和 {{ $.trigger.days }}', ctx),
    '12345 和 7',
  )
})

test('值为 0 / false / 空串不算缺值', () => {
  const c = { ...ctx, trigger: { zero: 0, no: false, empty: '' } }
  assert.equal(resolveTemplate('{{ $.trigger.zero }}', c), 0)
  assert.equal(resolveTemplate('{{ $.trigger.no }}', c), false)
  assert.equal(resolveTemplate('{{ $.trigger.empty }}', c), '')
  // 混排里也是
  assert.equal(resolveTemplate('n={{ $.trigger.zero }}', c), 'n=0')
})

test('null 不算缺值 —— 它是明确的"没有"，不是"路径写错了"', () => {
  const c = { ...ctx, trigger: { nothing: null } }
  assert.equal(resolveTemplate('{{ $.trigger.nothing }}', c), null)
})
