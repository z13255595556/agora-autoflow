import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Edge } from '@xyflow/react'
import { mockOutput, resolveParams } from '../src/lib/engine.ts'
import { toCodeFields } from '../src/lib/output.ts'
import { nodeSummary } from '../src/lib/summary.ts'
import { validateNode } from '../src/lib/vars.ts'
import { NODE_TYPE_MAP, applyBackendNodes } from '../src/registry.ts'
import type { FNode } from '../src/store'
import type { JsonSchema, NodeType } from '../src/types'

/**
 * `x-no-template` 红线的防回归测试。**防回归的，不是防当下的。**
 *
 * 系统里所有文本字段都支持 {{ $.trigger.x }} 插值。代码字段如果也支持，
 * webhook body 里的内容就会变成服务端执行的 Python —— 货真价实的 RCE。
 * 这里的断言钉死"代码字段永远原样透传"：将来任何人往 resolveParams / validateNode
 * 里加新的字符串处理，这个文件先红。
 *
 * 用内联 schema 而不是真的 code.python 节点定义 —— 标记机制必须独立于任何
 * 具体节点成立（x-placeholders 同款原则：manifest 声明，引擎照标记办事）。
 */

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    code: { type: 'string', 'x-no-template': true },
    inputs: { type: 'object', additionalProperties: true },
    note: { type: 'string' },
  },
}

const ctx = {
  trigger: { count: 7, days: 3 },
  run: { id: 'run_test', startedAt: '2026-08-28T09:00:00.000Z' },
  nodes: {
    q1: { output: { rows: [{ vid: 1 }, { vid: 2 }] } },
  },
}

test('★ code 字段原样透传：引用能解析出值也绝不替换', () => {
  const code = 'total = {{ $.trigger.count }}\nprint(total)'
  const out = resolveParams({ code }, ctx, SCHEMA)
  // 逐字相等 —— trigger.count 明明是 7，也不许被填进去
  assert.equal(out.code, code)
})

test('★ code 字段里的引用缺失也不抛错 —— 证明压根没进解析器', () => {
  // 别处的规矩是"缺值必须炸"（见 expression.test.ts）。code 字段例外：
  // 它根本不该被解析，所以连 MissingValue 都不该有机会抛
  const code = 'x = {{ $.trigger.nope }}\ny = {{ $.nodes.ghost.output.rows }}'
  const out = resolveParams({ code }, ctx, SCHEMA)
  assert.equal(out.code, code)
})

test('同一节点的其他字段照常解析：inputs 整串引用回原始数组，不字符串化', () => {
  const out = resolveParams(
    {
      code: 'rows = inputs["rows"]',
      inputs: { rows: '{{ $.nodes.q1.output.rows }}', days: '{{ $.trigger.days }}' },
    },
    ctx,
    SCHEMA,
  )
  // 跳过是按字段的，不是按节点的
  assert.deepEqual(out.inputs, { rows: [{ vid: 1 }, { vid: 2 }], days: 3 })
})

// ---------------------------------------------------------------- 校验层

// 注入一个带 x-no-template 的合成节点类型。applyBackendNodes 是后端上线时
// 真实走的通道；node --test 每个文件独立进程，改了 NODE_TYPE_MAP 不会串场
const GUARD_TYPE: NodeType = {
  type: 'test.codeGuard',
  typeVersion: '1.0.0',
  name: '红线测试',
  category: '处理',
  icon: 'G',
  input: {
    type: 'object',
    properties: {
      code: { type: 'string', 'x-no-template': true },
      note: { type: 'string' },
    },
  },
  output: { type: 'object' },
}
applyBackendNodes([GUARD_TYPE])

const nodeWith = (params: Record<string, unknown>): FNode => ({
  id: 'c1',
  position: { x: 0, y: 0 },
  data: {
    typeId: 'test.codeGuard',
    typeVersion: '1.0.0',
    label: '红线测试',
    params,
    onError: 'fail',
  },
})

const NO_EDGES: Edge[] = []

test('校验不把 Python 语法当坏引用：f-string 的 {{ 与完整引用都不报', () => {
  // Python 里 f"{{x}}" 是转义大括号；{{ $.trigger.x }} 则是原样进沙箱的字面量。
  // 两者按引用语法查都会误报，而"修好误报"的改法恰恰就是把 code 送进解析器
  const node = nodeWith({ code: 'print(f"{{x}}")\nraw = "{{ $.trigger.x }}"\nbad = "{{ 也不是引用 }}"' })
  assert.deepEqual(validateNode(node, [node], NO_EDGES, []), [])
})

test('跳过是按字段的：同节点普通字符串字段的坏引用仍然报', () => {
  const node = nodeWith({ code: 'x = 1', note: '{{ 不是合法引用 }}' })
  const errors = validateNode(node, [node], NO_EDGES, [])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /note/)
})

// ---------------------------------------------------------------- 真节点（code.python）

const codeNode = (params: Record<string, unknown>, probed?: Record<string, JsonSchema>): FNode => ({
  id: 'py1',
  position: { x: 0, y: 0 },
  data: {
    typeId: 'code.python',
    typeVersion: '1.0.0',
    label: 'Python 代码',
    params,
    onError: 'fail',
    ...(probed ? { probedOutput: probed } : {}),
  },
})

test('缺 def main 保存期就拦下，不用等真跑一次', () => {
  const node = codeNode({ code: 'x = 1\nprint(x)' })
  assert.ok(validateNode(node, [node], NO_EDGES, []).some((e) => e.includes('def main')))
  const okNode = codeNode({ code: 'def main(inputs):\n    return {}' })
  assert.deepEqual(validateNode(okNode, [okNode], NO_EDGES, []), [])
})

test('mockOutput 确定性形状：绝不执行代码，学过的顶层字段造假数据', () => {
  const bare = mockOutput(codeNode({ code: 'x' }), ctx, {}, [])
  assert.deepEqual(bare, { result: null, logs: '(mock：后端未连接，代码没有真的执行)', durationMs: 0 })
  const learned = mockOutput(
    codeNode({ code: 'x' }, { total: { type: 'integer' }, 'top[].vid': { type: 'integer' }, logs: { type: 'string' } }),
    ctx, {}, [],
  )
  // 嵌套路径（top[].vid）和保留键不进 mock，顶层数据字段才进
  assert.deepEqual(learned, { total: '(mock)', logs: '(mock：后端未连接，代码没有真的执行)', durationMs: 0 })
})

test('toCodeFields：顶层学习，排除保留键，对象数组下钻', () => {
  assert.deepEqual(
    toCodeFields({
      total: 3,
      user: { name: 'a' },
      top: [{ vid: 1, dc: 2 }],
      logs: 'x', durationMs: 5,
      '非法 键': 1,
    }),
    {
      total: { type: 'integer', title: 'total' },
      user: { type: 'object', title: 'user' },
      'user.name': { type: 'string', title: 'name' },
      top: { type: 'array', title: 'top' },
      'top[].vid': { type: 'integer', title: 'vid' },
      'top[].dc': { type: 'integer', title: 'dc' },
    },
  )
  assert.equal(toCodeFields({ logs: 'x', durationMs: 1 }), null, '只有保留键 = 没学到东西')
})

test('卡片摘要：def main 之前的首条注释当标题，骨架注释不误取', () => {
  const t = NODE_TYPE_MAP.get('code.python')!
  assert.equal(nodeSummary(t, { code: '# 按 vid 汇总\ndef main(inputs):\n    return {}' }), '按 vid 汇总')
  // 默认骨架的注释在函数体内 —— 到 def main 就停手
  assert.equal(
    nodeSummary(t, {
      code: 'def main(inputs):\n    # inputs 里是上面「输入变量」配的键\n    return {"result": None}\n',
      inputs: { rows: '{{ $.nodes.q1.output.rows }}' },
    }),
    'Python · 1 个输入变量',
  )
  assert.equal(nodeSummary(t, { code: 'def main(inputs):\n    return {}' }), 'Python 脚本')
})
