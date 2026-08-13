"""sqlparams 的测试。平台不支持绑定参数，这层就是唯一的注入防线，必须有测试。

    cd server && python3 test_sqlparams.py
"""
import sys

from sql_service import sqlparams
from sql_service.sqlparams import SqlParamError, render, apply_limit

PASS, FAIL = [], []


def ok(name, got, want):
    (PASS if got == want else FAIL).append((name, got, want))


def raises(name, fn, fragment=""):
    try:
        fn()
    except SqlParamError as exc:
        if fragment and fragment not in str(exc):
            FAIL.append((name, f"报错但内容不符: {exc}", f"包含 {fragment!r}"))
        else:
            PASS.append((name, "raised", "raised"))
    except Exception as exc:  # noqa: BLE001
        FAIL.append((name, f"抛了 {type(exc).__name__}: {exc}", "SqlParamError"))
    else:
        FAIL.append((name, "没有报错", "SqlParamError"))


# ---------------------------------------------------------------- 基本替换
ok("整数", render("SELECT * FROM t WHERE vid = :vid", {"vid": 123}),
   "SELECT * FROM t WHERE vid = 123")
ok("字符串加引号", render("SELECT * FROM t WHERE n = :n", {"n": "abc"}),
   "SELECT * FROM t WHERE n = 'abc'")
ok("None → NULL", render("SELECT * FROM t WHERE n = :n", {"n": None}),
   "SELECT * FROM t WHERE n = NULL")
ok("bool 不当整数", render("SELECT * FROM t WHERE b = :b", {"b": True}),
   "SELECT * FROM t WHERE b = TRUE")
ok("列表用于 IN", render("SELECT * FROM t WHERE vid IN :vids", {"vids": [1, 2, 3]}),
   "SELECT * FROM t WHERE vid IN (1, 2, 3)")
ok("空列表不产生 IN ()", render("SELECT * FROM t WHERE vid IN :vids", {"vids": []}),
   "SELECT * FROM t WHERE vid IN (NULL)")
ok("同名占位符替换多次",
   render("SELECT :v, :v FROM t", {"v": 7}), "SELECT 7, 7 FROM t")

# ---------------------------------------------------------------- {{name}} 写法
ok("大括号占位符", render("SELECT * FROM t WHERE d = {{date}}", {"date": 20260810}),
   "SELECT * FROM t WHERE d = 20260810")
ok("大括号带空格", render("SELECT {{ vid }} AS v", {"vid": 88031}), "SELECT 88031 AS v")
ok("大括号同名多次",
   render("SELECT * FROM t WHERE a = {{d}} AND b = {{d}}", {"d": 7}),
   "SELECT * FROM t WHERE a = 7 AND b = 7")
ok("两种写法混用",
   render("SELECT * FROM t WHERE a = {{d}} AND b = :v", {"d": 1, "v": 2}),
   "SELECT * FROM t WHERE a = 1 AND b = 2")
ok("大括号字符串照样转义",
   render("SELECT * FROM t WHERE n = {{n}}", {"n": "a' OR '1'='1"}),
   "SELECT * FROM t WHERE n = 'a\\' OR \\'1\\'=\\'1'")
ok("字符串里的 {{x}} 不当占位符",
   render("SELECT '{{x}}' AS lit, {{v}} AS v", {"v": 1}),
   "SELECT '{{x}}' AS lit, 1 AS v")
ok("注释里的 {{x}} 不当占位符",
   render("-- {{nope}}\nSELECT {{v}}", {"v": 1}), "-- {{nope}}\nSELECT 1")
raises("大括号缺参数报错时用大括号写法提示",
       lambda: render("SELECT {{a}}, {{b}}", {"a": 1}), "{{b}}")

# ---------------------------------------------------------------- 注入
ok("单引号被转义",
   render("SELECT * FROM t WHERE n = :n", {"n": "a' OR '1'='1"}),
   "SELECT * FROM t WHERE n = 'a\\' OR \\'1\\'=\\'1'")
ok("反斜杠先转义，堵住 \\' 绕过",
   render("SELECT * FROM t WHERE n = :n", {"n": "a\\"}),
   "SELECT * FROM t WHERE n = 'a\\\\'")
ok("注释符不特殊，只是普通字符",
   render("SELECT * FROM t WHERE n = :n", {"n": "x'--"}),
   "SELECT * FROM t WHERE n = 'x\\'--'")
ok("换行被转义，不能截断语句",
   render("SELECT * FROM t WHERE n = :n", {"n": "a\nb"}),
   "SELECT * FROM t WHERE n = 'a\\nb'")
raises("NUL 字符被拒", lambda: render("SELECT :n", {"n": "a\x00b"}), "NUL")
raises("超长字符串被拒",
       lambda: render("SELECT :n", {"n": "x" * (sqlparams.MAX_STRING_LEN + 1)}), "太长")
raises("不认识的类型不 str() 兜底",
       lambda: render("SELECT :n", {"n": {"a": 1}}), "不能写进 SQL")

# ---------------------------------------------------------------- 扫描器
ok("字符串里的 :b 不当占位符",
   render("SELECT 'a:b' , :v FROM t", {"v": 1}), "SELECT 'a:b' , 1 FROM t")
ok("行注释里的占位符不替换",
   render("-- :nope\nSELECT :v", {"v": 1}), "-- :nope\nSELECT 1")
ok("块注释里的占位符不替换",
   render("/* :nope */ SELECT :v", {"v": 1}), "/* :nope */ SELECT 1")
ok(":: 转型不当占位符",
   render("SELECT a::int, :v FROM t", {"v": 1}), "SELECT a::int, 1 FROM t")
ok("反引号标识符里的不替换",
   render("SELECT `a:b`, :v FROM t", {"v": 1}), "SELECT `a:b`, 1 FROM t")
ok("字符串里 '' 转义不会让扫描器错位",
   render("SELECT 'it''s :x', :v FROM t", {"v": 1}), "SELECT 'it''s :x', 1 FROM t")

# ---------------------------------------------------------------- 名字对不上
raises("占位符缺参数（回显用户写法）", lambda: render("SELECT :a, :b", {"a": 1}), ":b")
raises("参数多余（防改名后用旧值）",
       lambda: render("SELECT :a", {"a": 1, "b": 2}), "b")

# ---------------------------------------------------------------- 只读
raises("DROP 被拒", lambda: render("DROP TABLE t", {}), "只读")
raises("INSERT 被拒", lambda: render("INSERT INTO t VALUES (1)", {}), "只读")
raises("WITH 里藏 INSERT 被拒",
       lambda: render("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x", {}), "INSERT")
raises("多条语句被拒", lambda: render("SELECT 1; SELECT 2", {}), "一条")
ok("SELECT 放行", render("SELECT 1", {}), "SELECT 1")
ok("WITH 放行", render("WITH x AS (SELECT 1) SELECT * FROM x", {}),
   "WITH x AS (SELECT 1) SELECT * FROM x")
ok("SHOW 放行", render("SHOW TABLES", {}), "SHOW TABLES")
ok("字符串里的 drop 不误杀",
   render("SELECT * FROM t WHERE n = 'drop'", {}),
   "SELECT * FROM t WHERE n = 'drop'")
ok("末尾分号被去掉", render("SELECT 1;", {}), "SELECT 1")

# ---------------------------------------------------------------- limit
ok("套 LIMIT", apply_limit("SELECT 1", 10),
   "SELECT * FROM (\nSELECT 1\n) AS __wf_limited LIMIT 10")
ok("limit=0 不套", apply_limit("SELECT 1", 0), "SELECT 1")


for name, got, want in FAIL:
    print(f"✗ {name}\n    实际: {got!r}\n    期望: {want!r}")
print(f"\n{len(PASS)} 通过, {len(FAIL)} 失败")
sys.exit(1 if FAIL else 0)
