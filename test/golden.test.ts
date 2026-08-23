import { test } from 'node:test'
import assert from 'node:assert/strict'
import { edge, node, outputOf, runGolden, stepOf, type GoldenFlow } from './golden/harness.ts'

/**
 * 基线用例：**重构 engine 期间必须持续成立的行为**。
 *
 * 每条对应 docs/m1-engine-core.md §3 的一条红线。清单里 66 条语义有 55 条标了
 * silent-wrong —— 坏了不报错。那些才是这里要钉的东西；会大声失败的反倒不急。
 *
 * 每个 test 的名字就是它钉死的那句话。改坏了看名字就知道踩到哪条。
 */

// ---------------------------------------------------------------- 直线

test('直线流程按拓扑序跑完，run 成功', async () => {
  const r = await runGolden({
    name: 'straight',
    pins: '最基本的形状不能坏',
    nodes: [
      node('t', 'trigger.manual'),
      node('d', 'date.compute', { mode: 'yesterday', format: 'compact' }),
      node('m', 'transform.template', { template: '日期 {{ $.nodes.d.output.value }}' }),
    ],
    edges: [edge('t', 'd'), edge('d', 'm')],
  })
  assert.equal(r.runStatus, 'success')
  assert.deepEqual(r.order, ['t', 'd', 'm'])
})

// ---------------------------------------------------------------- 活性与 merge

const diamond = (extraEdgeToMerge: boolean): GoldenFlow => ({
  name: 'diamond',
  pins: 'if 灭一支后 merge 的下标对应关系',
  nodes: [
    node('t', 'trigger.manual'),
    node('i', 'flow.if', { condition: 'false' }),
    node('a', 'transform.template', { template: 'A' }),
    node('b', 'transform.template', { template: 'B' }),
    node('m', 'flow.merge'),
  ],
  edges: [
    edge('t', 'i'),
    edge('i', 'a', 'true'),
    edge('i', 'b', 'false'),
    edge('a', 'm'),
    edge('b', 'm'),
    ...(extraEdgeToMerge ? [edge('t', 'm')] : []),
  ],
})

test('★ flow.merge 的 branches 长度恒等于入边数，未跑到的分支填 null', async () => {
  // 代码注释里专门记了这个 bug：用 flatMap 会把 null 占位挤掉，于是
  // branches[0] 变成"碰巧跑了的那条"而不是"第一条入边"——
  // 取值面板按分支名显示，会把正确的数据贴上错误的来源名，且静默
  const r = await runGolden(diamond(false))
  const out = outputOf<{ branches: unknown[] }>(r, 'm')
  assert.ok(out, 'merge 必须执行')
  assert.equal(out.branches.length, 2, 'branches 长度 = 入边数')
  assert.equal(out.branches[0], null, '被灭的 a 分支留 null 占位')
  assert.notEqual(out.branches[1], null, 'b 分支有值')
})

test('★ 从别的路径也能到的汇合点不被误杀', async () => {
  // 灭活算法要用"从根还能不能到"这个全局判据把还活着的节点捞回来。
  // 换成"看直接入边还有没有活的"这类局部规则，隔两层的汇合点会判错
  const withExtra = await runGolden(diamond(true))
  assert.notEqual(stepOf(withExtra, 'm')?.status, 'skipped', 'm 还有一条来自 t 的边，不该被灭')

  const withoutExtra = await runGolden(diamond(false))
  assert.notEqual(stepOf(withoutExtra, 'm')?.status, 'skipped', 'b 分支活着，m 照样跑')
})

test('★ 活性是 OR 不是 AND：一条入边活就够', async () => {
  const r = await runGolden(diamond(false))
  assert.equal(stepOf(r, 'a')?.status, 'skipped', '被灭的分支 skipped')
  assert.equal(stepOf(r, 'b')?.status, 'success')
  assert.equal(stepOf(r, 'm')?.status, 'success', '只有 b 活，merge 仍要跑')
})

test('★ 非触发器节点没有入边 → skipped 且 output 为 null', async () => {
  const r = await runGolden({
    name: 'orphan',
    pins: '游离节点不该跟着流程跑',
    nodes: [node('t', 'trigger.manual'), node('x', 'transform.template', { template: 'X' })],
    edges: [],
  })
  const x = stepOf(r, 'x')
  assert.equal(x?.status, 'skipped')
  assert.equal(x?.output, 'null')
})

// ---------------------------------------------------------------- 分支判定

test('★ truthy：字符串 "false" / "0" / "" 判为假', async () => {
  // Boolean('false') === true 是经典坑，而模板解析出来的东西经常是字符串
  // 不测 condition=''：它会先被 validateNode 当成"必填项没填"拦下，到不了 truthy。
  // 空串那条规则由模板解析出空串的路径覆盖，不是由空参数覆盖
  for (const [cond, expected] of [['false', false], ['0', false], ['no', true]] as const) {
    const r = await runGolden({
      name: `truthy-${cond}`,
      pins: 'truthy 的字符串规则',
      nodes: [node('t', 'trigger.manual'), node('i', 'flow.if', { condition: cond })],
      edges: [edge('t', 'i')],
    })
    assert.equal(outputOf<{ matched: boolean }>(r, 'i')?.matched, expected, `condition=${JSON.stringify(cond)}`)
  }
})

test('★ flow.if 的出边不带 port 时两侧都不灭活，下游全跑', async () => {
  // 导出时只在 sourceHandle 存在且 !== 'out' 时才写 port，所以这条边的 port
  // 是 undefined。今天它既不匹配 'true' 也不匹配 'false' → 两侧都不灭。
  // 若有人改成 edge.port === exitPort 直接比，undefined 两边都不等
  // → 该边被判死 → 下游全被 skip。同一份定义行为完全翻转，且静默
  const r = await runGolden({
    name: 'if-no-port',
    pins: '没带 handle 的边',
    nodes: [
      node('t', 'trigger.manual'),
      node('i', 'flow.if', { condition: 'true' }),
      node('x', 'transform.template', { template: 'X' }),
    ],
    edges: [edge('t', 'i'), edge('i', 'x')],
  })
  assert.equal(stepOf(r, 'x')?.status, 'success', '下游照跑，不因为口对不上被灭')
})

// ---------------------------------------------------------------- 错误传播

test('★ 全局 fail-fast：无关的并行分支也被 skipped', async () => {
  // "只灭下游"是重构时最自然的写法，正因如此它是红线：
  // 一条无关分支上的 notify.wecom 会在流程本该中止后仍然真发出去
  const r = await runGolden({
    name: 'failfast',
    pins: 'onError=fail 中断整条流程',
    nodes: [
      node('t', 'trigger.manual'),
      // 引用不存在的节点 → MissingValue → 该节点 error
      node('bad', 'transform.template', { template: '{{ $.nodes.nope.output.x }}' }),
      node('other', 'transform.template', { template: '无关分支' }),
    ],
    edges: [edge('t', 'bad'), edge('t', 'other')],
  })
  assert.equal(stepOf(r, 'bad')?.status, 'error')
  assert.equal(stepOf(r, 'other')?.status, 'skipped', '与失败点毫无关系的分支也要 skipped')
  assert.equal(r.runStatus, 'error')
})

test('★ errButContinue：源节点 onError=continue 时下游照常执行（多半以缺值失败）', async () => {
  // 这是一条独立例外规则，不是"非 skipped"顺带覆盖得了的。
  // 注意配套后果：出错的节点没有写进 ctx，所以下游引用它必然抛 MissingValue
  // —— 这个链条是既有行为，重构时不要无意"修好"它
  const r = await runGolden({
    name: 'continue',
    pins: 'onError=continue 的下游可达性',
    nodes: [
      node('t', 'trigger.manual'),
      node('bad', 'transform.template', { template: '{{ $.nodes.nope.output.x }}' }, 'continue'),
      node('down', 'transform.template', { template: '{{ $.nodes.bad.output.text }}' }),
    ],
    edges: [edge('t', 'bad'), edge('bad', 'down')],
  })
  assert.equal(stepOf(r, 'bad')?.status, 'error')
  const down = stepOf(r, 'down')
  assert.equal(down?.status, 'error', '有 step 且是 error，不是 skipped')
  assert.match(down?.error ?? '', /取不到值/, '失败原因是引用缺值')
})

test('★ ctx 只写 success 的输出：引用失败节点必抛缺值，不静默成 null', async () => {
  const r = await runGolden({
    name: 'ctx-success-only',
    pins: 'error 的节点永不进 ctx',
    nodes: [
      node('t', 'trigger.manual'),
      node('bad', 'transform.template', { template: '{{ $.nodes.nope.output.x }}' }, 'continue'),
      node('down', 'transform.template', { template: '值是 {{ $.nodes.bad.output.text }}' }),
    ],
    edges: [edge('t', 'bad'), edge('bad', 'down')],
  })
  // 不许渲染成 "值是 null" 塞进企微消息
  assert.doesNotMatch(stepOf(r, 'down')?.output ?? '', /值是/)
})

// ---------------------------------------------------------------- 循环

const ROWS = [{ v: 1 }, { v: 2 }, { v: 3 }]

/** items 表达式与数据源一起给，避免两处不同步 */
const loopFlow = (items: string, values: Record<string, unknown> = { rows: ROWS }): GoldenFlow => ({
  name: 'loop',
  pins: 'foreach 的迭代与作用域',
  nodes: [
    node('t', 'trigger.manual'),
    node('q', 'variable.assign', { values }),
    node('lp', 'flow.foreach', { items }),
    node('b', 'transform.template', { template: '第 {{ $.loop.index }} 项' }),
    node('after', 'transform.template', { template: '完了' }),
  ],
  edges: [edge('t', 'q'), edge('q', 'lp'), edge('lp', 'b', 'each'), edge('lp', 'after', 'done')],
})

/** 真正执行过的次数。skipped 也是一条记录，直接数长度会把它算进去 */
const ranTimes = (r: { steps: Array<{ nodeId: string; status: string }> }, nodeId: string) =>
  r.steps.filter((s) => s.nodeId === nodeId && s.status !== 'skipped').length

test('★ foreach 跑满全部项，不再截断到 3 条', async () => {
  const r = await runGolden(loopFlow('{{ $.nodes.q.output.values.rows }}'))
  const iters = r.steps.filter((s) => s.nodeId === 'b').map((s) => s.iteration)
  assert.deepEqual(iters, [0, 1, 2], 'iteration 严格 0..n-1 递增')
})

test('★ 循环体内能读到本轮的 $.loop', async () => {
  const r = await runGolden(loopFlow('{{ $.nodes.q.output.values.rows }}'))
  for (const i of [0, 1, 2]) {
    assert.match(outputOf<{ text: string }>(r, 'b', i)?.text ?? '', new RegExp(`第 ${i} 项`))
  }
})

test('★ foreach 展开 0 项时体内节点一次都不执行，done 子树照跑', async () => {
  // 两个方向都要断言：既不许多发，也不许把 done 支路一起吞掉
  const r = await runGolden(loopFlow('{{ $.nodes.q.output.values.rows }}', { rows: [] }))
  assert.equal(stepOf(r, 'lp')?.status, 'success', '空集合不是错误')
  assert.equal(ranTimes(r, 'b'), 0, 'each 末端一次都不跑')
  assert.equal(stepOf(r, 'after')?.status, 'success', 'done 子树照跑')
})

test('★ foreach 的 items 不是数组 → 整节点失败，文案可操作', async () => {
  const r = await runGolden(loopFlow('{{ $.nodes.q.output.values.rows[0].v }}'))
  const lp = stepOf(r, 'lp')
  assert.equal(lp?.status, 'error')
  assert.match(lp?.error ?? '', /要指向一个数组/)
})

test('★ foreach 超过上限 → 整节点失败，绝不截断', async () => {
  // 截断会让"少跑了几百条"变成一次绿色的运行
  const big = Array.from({ length: 1001 }, (_, i) => ({ v: i }))
  const r = await runGolden(loopFlow('{{ $.nodes.q.output.values.rows }}', { rows: big }))
  const lp = stepOf(r, 'lp')
  assert.equal(lp?.status, 'error')
  assert.match(lp?.error ?? '', /超过上限/)
  assert.match(lp?.error ?? '', /LIMIT/, '要给一句能照做的话')
  assert.equal(ranTimes(r, 'b'), 0, '体内零执行')
})

// ---------------------------------------------------------------- pinData

test('★ pinData 替代执行，且 pinned 节点跳过参数校验', async () => {
  const r = await runGolden({
    name: 'pin',
    pins: 'pinData 语义',
    nodes: [
      node('t', 'trigger.manual'),
      // 故意留一个必填项没填：没 pin 的话这里会因校验失败而 error
      node('w', 'notify.wecom', { msgtype: 'text', content: 'x' }),
    ],
    edges: [edge('t', 'w')],
    pinData: { w: { sent: true, bytes: 1, target: 'pinned' } },
  })
  const w = stepOf(r, 'w')
  assert.equal(w?.status, 'success')
  assert.equal(w?.pinned, true)
  assert.match(w?.output ?? '', /pinned/)
})

test('没 pin 时同一个节点因必填项缺失而失败（证明上一条不是碰巧）', async () => {
  const r = await runGolden({
    name: 'pin-control',
    pins: '对照组',
    nodes: [node('t', 'trigger.manual'), node('w', 'notify.wecom', { msgtype: 'text', content: 'x' })],
    edges: [edge('t', 'w')],
  })
  assert.equal(stepOf(r, 'w')?.status, 'error')
})

// ---------------------------------------------------------------- 引擎整体不变量

test('★ executeFlow 任何路径下都不留 running 的僵尸记录', async () => {
  const r = await runGolden({
    name: 'no-zombie',
    pins: '错误不许逃出 executeFlow',
    nodes: [
      node('t', 'trigger.manual'),
      node('bad', 'transform.template', { template: '{{ 裸标识符 }}' }),
    ],
    edges: [edge('t', 'bad')],
  })
  assert.ok(['success', 'error'].includes(r.runStatus))
  assert.equal(r.steps.filter((s) => s.status === 'running').length, 0)
})

test('同一份输入连跑两次结果逐字段相同', async () => {
  const flow = diamond(true)
  assert.deepEqual(await runGolden(flow), await runGolden(flow))
})

test('★ 暂停的体内节点每轮都记一条 skipped{disabled}，循环本身照常完成', async () => {
  const flow = loopFlow('{{ $.nodes.q.output.values.rows }}')
  flow.nodes = flow.nodes.map((n) => (n.id === 'b' ? node('b', 'transform.template', { template: 'x' }, 'fail', { disabled: true }) : n))
  const r = await runGolden(flow)
  assert.equal(ranTimes(r, 'b'), 0, '暂停的节点一次都不跑')
  assert.equal(r.steps.filter((s) => s.nodeId === 'b' && s.status === 'skipped').length, 3, '但每轮都有痕迹')
  assert.equal(stepOf(r, 'after')?.status, 'success', 'done 子树照跑')
  assert.equal(r.runStatus, 'success')
})
