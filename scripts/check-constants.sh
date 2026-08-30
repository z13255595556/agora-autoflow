#!/usr/bin/env bash
# 承重常量必须全仓单一出处。
#
# MAX_LOOP_ITERATIONS 与 OUTPUT_INLINE_LIMIT_BYTES 各自定义在
# src/lib/engine-core/types.ts。复制到 SQL / 文档 / Python 里的后果不是不一致
# 那么简单：超限今天是"整节点失败并给一句能照做的话"，复制成 SQL CHECK 之后
# 用户拿到的是一个约束违例异常，那句提示没了。
#
# 大 output 阈值更直接：它曾经在三份文档里写成 4MB / 64KB / 256KB 三个值，
# 正是它一直没能落地的原因。
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
check() {
  local name="$1" pattern="$2" allowed="$3"
  local hits
  hits=$(grep -rnE "$pattern" --include='*.ts' --include='*.tsx' --include='*.py' --include='*.sql' --include='*.md' \
         src server docs scripts 2>/dev/null | grep -v "^$allowed:" || true)
  if [ -n "$hits" ]; then
    echo "✗ $name 出现了第二个出处（唯一出处应是 $allowed）："
    echo "$hits" | sed 's/^/    /'
    fail=1
  else
    echo "✓ $name 单一出处"
  fi
}

# 按**名字**查而不是按数值：数值会误伤真正不同的限制。
# 例如 server/sql_service/flowdef.py 的 MAX_PIN_BYTES 也是 256KB，但它限的是
# "流程定义里手写的调试数据"，和"运行输出要不要外部化"是两件事，
# 只是碰巧同值 —— 把它们绑成一个常量反而会让以后调其中一个时误伤另一个。
SRC=src/lib/engine-core/types.ts
check "MAX_LOOP_ITERATIONS" '(MAX_LOOP_ITERATIONS[[:space:]]*[=:]|MAX_LOOP_ITERATIONS[[:space:]]*=[[:space:]]*[0-9])' "$SRC"
check "OUTPUT_INLINE_LIMIT_BYTES" 'OUTPUT_INLINE_LIMIT_BYTES[[:space:]]*[=:]' "$SRC"
check "WAIT_MAX_SECONDS" 'WAIT_MAX_SECONDS[[:space:]]*[=:]' "$SRC"

exit $fail
