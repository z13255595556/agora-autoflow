import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commitNumber, displayNumber } from '../src/lib/numberInput.ts'

// 这几条钉的是一个具体的、报过的毛病：超时时间默认 15，想改成 20 却
// 「一直删不掉」—— 清空输入框的瞬间默认值就被填回来了。

test('★★ 清空输入框时显示的就是空 —— 不能被默认值顶回来', () => {
  // 编辑中的空字符串必须原样显示。这一条挂了，"删掉 15 改成 20" 就做不到
  assert.equal(displayNumber('', 15), '')
  assert.equal(displayNumber('2', 15), '2')
  assert.equal(displayNumber('20', 15), '20')
})

test('没在编辑时显示 props 的值', () => {
  assert.equal(displayNumber(null, 15), '15')
  assert.equal(displayNumber(null, undefined), '')
  assert.equal(displayNumber(null, null), '')
  // 0 是个真值，不能当空处理
  assert.equal(displayNumber(null, 0), '0')
})

test('失焦时清空 = 交还给默认值', () => {
  assert.equal(commitNumber(''), undefined)
  assert.equal(commitNumber('   '), undefined)
})

test('非数字当成没填，不留 NaN 进流程定义', () => {
  assert.equal(commitNumber('abc'), undefined)
  assert.equal(commitNumber('1e999'), undefined)   // Infinity
})

test('★ 边界在失焦时才夹', () => {
  assert.equal(commitNumber('500', { min: 1, max: 120 }), 120)
  assert.equal(commitNumber('0', { min: 1, max: 120 }), 1)
  assert.equal(commitNumber('-5', { min: 1, max: 120 }), 1)
  assert.equal(commitNumber('20', { min: 1, max: 120 }), 20)
})

test('★★ 中间态不许被夹 —— 否则上限 120 的字段里输入 20 会在打完 "2" 时被弹走', () => {
  // 打字过程走的是 displayNumber，它对边界一无所知，这正是要的
  assert.equal(displayNumber('2', 15), '2')
  assert.equal(displayNumber('5', 15), '5')     // 想输 500，第一下是 5
  assert.equal(displayNumber('50', 15), '50')
})

test('整数字段四舍五入，小数字段保留', () => {
  assert.equal(commitNumber('2.6', { integer: true }), 3)
  assert.equal(commitNumber('2.6'), 2.6)
})

test('没有边界时原样返回', () => {
  assert.equal(commitNumber('99999'), 99999)
})
