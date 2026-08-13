"""把占位符替换成 SQL 字面量。

两种写法等价，可以混用：`:name` 和 `{{name}}`。后者是数据平台自带 UI 的写法，
很多人手上现成的 SQL 就长这样，直接贴进来能跑。

**数据平台不支持绑定参数** —— SQL 只能拼字符串送过去。所以这个模块就是唯一的
注入防线，不是"顺手做的转义"。三条硬规则：

1. 占位符扫描跳过字符串、注释、`::` 转型 —— 否则 `SELECT 'a:b'` 里的 `:b`
   会被当成参数替换掉。
2. 值按类型渲染，字符串先escape反斜杠再escape引号（Hive/Doris/ClickHouse 都把
   反斜杠当转义符，只 escape 单引号会被 `\\'` 绕过）。
3. 占位符和参数必须一一对应，多了少了都报错 —— 拼错名字时静默留下 `:vid`
   会被平台当语法错，报错信息完全看不出是拼错了。

只放行只读语句。这是自助平台，不该让任何人从流程节点里 DROP 表。
"""
import math
import re
from typing import Any, Dict, List, Tuple

MAX_STRING_LEN = 4096
MAX_LIST_ITEMS = 1000

# 两种写法都认：
#   :name      —— 传统绑定风格
#   {{name}}   —— 数据平台自带 UI 的写法，很多人手上的 SQL 就是这个样子
# 注意 {{ $.xxx }} 不在这里处理：那是工作流的变量引用，前端解析完才送到这里，
# 后端看到的永远只会是裸名字。
COLON_RE = re.compile(r":([A-Za-z_][A-Za-z0-9_]*)")
BRACE_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")

# 只读语句白名单。CTE 用 WITH 开头，所以 WITH 也放行（后面还会检查里面没有 DML）
READ_ONLY_HEADS = ("select", "with", "show", "desc", "describe", "explain")
# 即使以 SELECT/WITH 开头，出现这些关键字也拒绝 —— 挡住 `WITH x AS (...) INSERT ...`
FORBIDDEN_RE = re.compile(
    r"\b(insert|update|delete|drop|truncate|alter|create|replace|grant|revoke|"
    r"merge|load|msck|analyze|set|use)\b",
    re.IGNORECASE,
)


class SqlParamError(ValueError):
    """参数或 SQL 本身不合法。这是用户能改的错，报错要说清哪里不对。"""


def _scan(sql: str) -> Tuple[List[Tuple[int, int, str]], List[Tuple[int, int]]]:
    """扫一遍 SQL，返回 (占位符位置列表, 需要跳过的区间列表)。

    跳过：单引号字符串、双引号/反引号标识符、`--` 行注释、`/* */` 块注释。
    """
    skip: List[Tuple[int, int]] = []
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        if ch == "-" and sql.startswith("--", i):
            end = sql.find("\n", i)
            end = n if end < 0 else end
            skip.append((i, end))
            i = end
        elif ch == "/" and sql.startswith("/*", i):
            end = sql.find("*/", i + 2)
            end = n if end < 0 else end + 2
            skip.append((i, end))
            i = end
        elif ch in "'\"`":
            quote = ch
            j = i + 1
            while j < n:
                if sql[j] == "\\":      # 反斜杠转义：跳过下一个字符
                    j += 2
                    continue
                if sql[j] == quote:
                    if quote == "'" and j + 1 < n and sql[j + 1] == "'":
                        j += 2          # '' 是引号自身的转义
                        continue
                    j += 1
                    break
                j += 1
            skip.append((i, min(j, n)))
            i = min(j, n)
        else:
            i += 1

    def in_skip(pos: int) -> bool:
        return any(start <= pos < end for start, end in skip)

    found: List[Tuple[int, int, str]] = []
    for m in COLON_RE.finditer(sql):
        # `a::int` 这种转型不是占位符
        if m.start() > 0 and sql[m.start() - 1] == ":":
            continue
        if in_skip(m.start()):
            continue
        found.append((m.start(), m.end(), m.group(1)))
    for m in BRACE_RE.finditer(sql):
        if in_skip(m.start()):
            continue
        found.append((m.start(), m.end(), m.group(1)))
    # 按位置排序 —— 替换时要从前往后顺序切片
    found.sort(key=lambda t: t[0])
    return found, skip


def _quote_string(value: str, name: str) -> str:
    if len(value) > MAX_STRING_LEN:
        raise SqlParamError(f"参数 {name} 太长（{len(value)} 字符，上限 {MAX_STRING_LEN}）")
    if "\x00" in value:
        raise SqlParamError(f"参数 {name} 含 NUL 字符")
    # 顺序不能反：先 escape 反斜杠，否则后面加的 \' 里的反斜杠又会被 escape 一次
    out = value.replace("\\", "\\\\").replace("'", "\\'")
    out = out.replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    return f"'{out}'"


def literal(value: Any, name: str) -> str:
    """把一个 Python 值渲染成 SQL 字面量。类型不认识就报错，绝不 str() 兜底。"""
    if value is None:
        return "NULL"
    # bool 必须在 int 之前判 —— Python 里 True 是 int 的子类
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            raise SqlParamError(f"参数 {name} 是 {value}，没法写进 SQL")
        return repr(value)
    if isinstance(value, str):
        return _quote_string(value, name)
    if isinstance(value, (list, tuple)):
        if len(value) > MAX_LIST_ITEMS:
            raise SqlParamError(f"参数 {name} 有 {len(value)} 项，上限 {MAX_LIST_ITEMS}")
        if not value:
            # IN () 是语法错；(NULL) 合法且匹配不到任何行，语义上等价于空集合
            return "(NULL)"
        inner = ", ".join(literal(v, f"{name}[{i}]") for i, v in enumerate(value))
        return f"({inner})"
    raise SqlParamError(f"参数 {name} 的类型 {type(value).__name__} 不能写进 SQL")


def assert_read_only(sql: str) -> None:
    """只放行只读语句。自助平台不该让人从流程节点里改数据。"""
    # 去掉注释和字符串再判关键字，避免 `SELECT 'drop'` 被误杀
    _, skip = _scan(sql)
    masked = list(sql)
    for start, end in skip:
        for i in range(start, min(end, len(masked))):
            masked[i] = " "
    bare = "".join(masked).strip()

    head = bare.lstrip("( \t\n\r").split(None, 1)
    if not head or head[0].lower() not in READ_ONLY_HEADS:
        raise SqlParamError(
            f"只允许只读语句（{'/'.join(READ_ONLY_HEADS[:3]).upper()} 开头），"
            f"这条是 {head[0].upper() if head else '空'}"
        )
    hit = FORBIDDEN_RE.search(bare)
    if hit:
        raise SqlParamError(f"SQL 里出现了写操作关键字 {hit.group(1).upper()}，已拒绝执行")
    if re.search(r";\s*\S", bare):
        # 平台一次只接一条语句，多条会整条报语法错；提前说清楚比让人猜好
        raise SqlParamError("一次只能跑一条 SQL（检测到分号后还有内容）")


def render(sql: str, params: Dict[str, Any]) -> str:
    """替换占位符，返回可以直接送给平台的 SQL。"""
    sql = sql.strip().rstrip(";")
    if not sql:
        raise SqlParamError("SQL 为空")
    assert_read_only(sql)

    found, _ = _scan(sql)
    used = {name for _, _, name in found}
    # 报错时用用户自己那种写法回显，别让人对着 :date 找半天他写的 {{date}}
    written = {name: sql[start:end] for start, end, name in found}
    missing = sorted(used - set(params))
    if missing:
        raise SqlParamError("SQL 里的占位符没有对应参数：" + "、".join(written[m] for m in missing))
    extra = sorted(set(params) - used)
    if extra:
        # 静默忽略多余参数会让改名字之后的 SQL 用着旧值，查出来的数是错的
        raise SqlParamError("这些参数在 SQL 里没有对应占位符：" + "、".join(extra))

    out, last = [], 0
    for start, end, name in found:
        out.append(sql[last:start])
        out.append(literal(params[name], name))
        last = end
    out.append(sql[last:])
    return "".join(out)


def apply_limit(sql: str, limit: int) -> str:
    """套一层 LIMIT 兜底。

    显式包一层而不是在结果侧截断 —— 截断时数据已经传过来了，几十万行照样
    把引擎和网络打满。包出来的 SQL 会原样出现在节点输出里，可以复制去平台复跑。
    """
    if not limit or limit <= 0:
        return sql
    return f"SELECT * FROM (\n{sql}\n) AS __wf_limited LIMIT {int(limit)}"
