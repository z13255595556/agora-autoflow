import type { FlowDefinition, JsonSchema } from '../types'

type JsonObject = Record<string, unknown>

function objectAt(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} 必须是对象`)
  return value as JsonObject
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} 必须是非空字符串`)
  return value.trim()
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 把外部 JSON 规范化为编辑器可安全加载的流程定义。
 * 可缺省的旧字段在这里补齐，引用关系错误则在进入 store 前明确报出位置。
 */
export function normalizeFlowDefinition(value: unknown, fallbackId = 'flow_imported'): FlowDefinition {
  const raw = objectAt(value, '流程定义')
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) throw new Error('nodes 必须是非空数组')

  const ids = new Set<string>()
  const nodes = raw.nodes.map((item, index) => {
    const node = objectAt(item, `nodes[${index}]`)
    const id = nonEmptyString(node.id, `nodes[${index}].id`)
    if (ids.has(id)) throw new Error(`nodes[${index}].id 与已有节点重复：${id}`)
    ids.add(id)
    const type = nonEmptyString(node.type, `nodes[${index}].type`)
    const params = node.params === undefined ? {} : objectAt(node.params, `nodes[${index}].params`)
    const rawProbed = node.probedOutput === undefined ? undefined : objectAt(node.probedOutput, `nodes[${index}].probedOutput`)
    const probedOutput = rawProbed && Object.fromEntries(
      Object.entries(rawProbed).map(([key, schema]) => [key, objectAt(schema, `nodes[${index}].probedOutput.${key}`) as JsonSchema]),
    )
    // 节点设置（备注 / 暂停 / 重试覆盖）。这里是显式键的白名单，漏一个就静默丢字段 ——
    // toDefinition / loadDefinition 是另外两处，test/flowGraph 里有往返测试钉着
    const retry = node.retry === null
      ? null
      : node.retry !== undefined && typeof node.retry === 'object'
        ? {
            ...(typeof (node.retry as { maxAttempts?: unknown }).maxAttempts === 'number' ? { maxAttempts: (node.retry as { maxAttempts: number }).maxAttempts } : {}),
            ...(typeof (node.retry as { initialMs?: unknown }).initialMs === 'number' ? { initialMs: (node.retry as { initialMs: number }).initialMs } : {}),
          }
        : undefined
    return {
      id,
      type,
      typeVersion: typeof node.typeVersion === 'string' && node.typeVersion.trim() ? node.typeVersion : '1.0.0',
      name: typeof node.name === 'string' && node.name.trim() ? node.name : type,
      params,
      onError: node.onError === 'continue' ? 'continue' as const : 'fail' as const,
      ...(probedOutput ? { probedOutput } : {}),
      ...(typeof node.note === 'string' && node.note.trim() ? { note: node.note } : {}),
      ...(node.disabled === true ? { disabled: true } : {}),
      ...(retry !== undefined ? { retry } : {}),
    }
  })

  const edgeItems = raw.edges === undefined ? [] : raw.edges
  if (!Array.isArray(edgeItems)) throw new Error('edges 必须是数组')
  const edges = edgeItems.map((item, index) => {
    const edge = objectAt(item, `edges[${index}]`)
    const from = nonEmptyString(edge.from, `edges[${index}].from`)
    const to = nonEmptyString(edge.to, `edges[${index}].to`)
    if (!ids.has(from)) throw new Error(`edges[${index}].from 引用了不存在的节点：${from}`)
    if (!ids.has(to)) throw new Error(`edges[${index}].to 引用了不存在的节点：${to}`)
    return {
      from,
      to,
      ...(typeof edge.port === 'string' && edge.port ? { port: edge.port } : {}),
    }
  })

  const rawLayout = raw.layout === undefined ? {} : objectAt(raw.layout, 'layout')
  const layout = Object.fromEntries(
    nodes.map((node, index) => {
      const candidate = rawLayout[node.id]
      const position = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        ? candidate as JsonObject
        : {}
      return [
        node.id,
        {
          x: finiteNumber(position.x) ?? 60 + index * 340,
          y: finiteNumber(position.y) ?? 160,
          ...(finiteNumber(position.width) !== null ? { width: finiteNumber(position.width)! } : {}),
          ...(finiteNumber(position.height) !== null ? { height: finiteNumber(position.height)! } : {}),
        },
      ]
    }),
  )

  const rawInputs = raw.inputs === undefined ? {} : objectAt(raw.inputs, 'inputs')
  const rawProperties = rawInputs.properties === undefined ? {} : objectAt(rawInputs.properties, 'inputs.properties')
  const properties = Object.fromEntries(
    Object.entries(rawProperties).map(([key, schema]) => [key, objectAt(schema, `inputs.properties.${key}`) as JsonSchema]),
  )
  const required = Array.isArray(rawInputs.required)
    ? [...new Set(rawInputs.required.filter((key): key is string => typeof key === 'string' && key in properties))]
    : []

  const rawTrigger = raw.trigger && typeof raw.trigger === 'object' && !Array.isArray(raw.trigger)
    ? raw.trigger as JsonObject
    : {}
  const inferredKind = nodes.some((node) => node.type === 'trigger.schedule') ? 'schedule' : 'manual'
  const kind = rawTrigger.kind === 'schedule' || rawTrigger.kind === 'webhook' || rawTrigger.kind === 'manual'
    ? rawTrigger.kind
    : inferredKind

  const pinData = raw.pinData === undefined ? undefined : objectAt(raw.pinData, 'pinData')
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : fallbackId,
    version: finiteNumber(raw.version) ?? 1,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : '未命名流程',
    inputs: { type: 'object', properties, ...(required.length ? { required } : {}) },
    trigger: { ...rawTrigger, kind },
    nodes,
    edges,
    layout,
    ...(pinData ? { pinData } : {}),
  }
}
