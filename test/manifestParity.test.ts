import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { NODE_TYPES } from '../src/registry.ts'
import type { NodeType } from '../src/types.ts'

/**
 * 后端 manifest 与前端 registry 的同名节点**逐字段一致**。
 *
 * applyBackendNodes 是整份替换：前端 registry 里多写的注解（x-ui.group、keywords、
 * policy.retry……）一上线就没了，而且**只在线上没，本地永远测不出来** ——
 * README 里这句话说了三次，这条测试是它的门禁。
 *
 * 比对范围：除 runtime 外的全部（runtime 允许后端独有 —— 前端拿到 runtime 才会走真实执行）。
 * 以后端为正本；前端那份只是离线兜底。
 */

const VENV = 'server/.venv/bin/python'

function backendNodes(): NodeType[] {
  const out = execFileSync(VENV, ['-c',
    'import json,sys; sys.path.insert(0,"server"); from sql_service import manifest; print(json.dumps(manifest.ALL, ensure_ascii=False))',
  ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out.trim()) as NodeType[]
}

/** 去掉 runtime，其余全比。JSON 往返一次，消掉 undefined 和 10_000 这种写法差异 */
const comparable = (t: NodeType) => {
  const { runtime: _r, ...rest } = t
  return JSON.parse(JSON.stringify(rest))
}

test('★ 后端 manifest 里的每个节点，前端 registry 都有一份逐字段相同的兜底', { skip: !existsSync(VENV) }, () => {
  const backend = backendNodes()
  assert.ok(backend.length >= 3, '后端至少要有 sql / wecom / http 三个节点')
  for (const b of backend) {
    const f = NODE_TYPES.find((t) => t.type === b.type)
    assert.ok(f, `前端 registry 缺 ${b.type} 的兜底定义`)
    assert.deepEqual(comparable(f), comparable(b), `${b.type}：前后端定义不一致（以后端为正本）`)
  }
})

test('后端节点都声明了 runtime —— 没有 runtime 的节点永远走 mock', { skip: !existsSync(VENV) }, () => {
  for (const b of backendNodes()) {
    assert.ok(b.runtime?.kind, `${b.type} 没有 runtime`)
  }
})
