import type { SandboxEnv } from './client'

/**
 * 「复制给 AI」的提示词。拿去贴给任何一个大模型，让它替用户写 main()。
 *
 * 提示词必须带上**当下真实的**输入变量键名和已装的包 —— 契约写死在文案里，
 * 环境部分实时拼：AI 生成的代码最常见的死法就是 import 了一个沙箱里没有的包，
 * 或者编了一个不存在的 inputs 键。
 */
export function buildPythonPrompt(inputKeys: string[], env: SandboxEnv | null): string {
  const keys = inputKeys.filter((k) => k.trim())
  const installed = (env?.packages ?? []).filter((p) => p.status === 'installed')
  const libs = installed.length
    ? installed.map((p) => `${p.name}==${p.version}`).join(', ')
    : 'pandas, numpy, python-dateutil, orjson, requests（以实际环境为准）'

  return [
    '请帮我写一段在工作流「Python 代码」节点里运行的 Python 代码。',
    '',
    '硬性契约（不满足就无法运行）：',
    '- 入口固定为 def main(inputs: dict) -> dict，除 import 外不要写顶层执行代码',
    keys.length
      ? `- 数据只能从 inputs 字典读取，可用的键：${keys.join('、')}（值由上游在运行时注入）`
      : '- 数据只能从 inputs 字典读取（键名以节点「输入变量」里配的为准）',
    '- 必须返回 dict 且可 JSON 序列化：DataFrame 用 .to_dict("records")；datetime 可直接返回（自动转 ISO 字符串）',
    '- 返回值的键不要用 logs、durationMs（保留键）；返回值总大小不超过 10MB',
    '- 代码里不要出现 {{ }} 模板语法，它不会被替换',
    '- print 可用于调试，会进入运行日志，不影响返回值',
    '',
    '运行环境：',
    `- Python ${env?.python ?? '3.11'}`,
    `- 可用的第三方库（版本钉死，不能安装新包）：${libs}`,
    '- 可以联网（requests 可用）',
    '- 执行超时默认 30 秒，最长 120 秒',
    '',
    '我的需求：',
    '（在这里描述要做的加工逻辑，以及每个输入变量里的数据长什么样）',
  ].join('\n')
}
