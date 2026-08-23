import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterCommands, type Command } from '../src/lib/commands.ts'

const cmds: Command[] = [
  { id: 'run', group: '运行', label: '运行流程', enabled: true, run: () => {} },
  { id: 'home', group: '导航', label: '回到流程列表', enabled: true, run: () => {} },
  { id: 'add', group: '节点', label: '添加节点', enabled: true, run: () => {} },
]

test('空查询保留全部命令', () => {
  assert.equal(filterCommands(cmds, '').length, 3)
})

test('按标签过滤命令', () => {
  assert.deepEqual(filterCommands(cmds, '运行').map((c) => c.id), ['run'])
})

test('关掉的命令仍出现，由 UI 决定能不能点', () => {
  const off = [{ ...cmds[0], enabled: false }]
  assert.equal(filterCommands(off, '运行').length, 1)
})
