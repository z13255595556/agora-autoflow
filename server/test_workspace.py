"""PostgreSQL 工作区 SQL 边界的纯函数测试。

不连接真实工作区库；角色/schema 隔离由部署时 PostgreSQL 权限承担。
"""
import sys

from sql_service import workspace

PASS, FAIL = [], []


def ok(name, got, want):
    (PASS if got == want else FAIL).append((name, got, want))


def raises(name, fn, text=""):
    try:
        fn()
    except workspace.WorkspaceError as exc:
        if not text or text in str(exc):
            PASS.append((name, "raised", "raised"))
        else:
            FAIL.append((name, str(exc), text))
    else:
        FAIL.append((name, "no error", "WorkspaceError"))


statement, values, head, limit = workspace._prepare_sql({
    "sql": "INSERT INTO report(id, name) VALUES (:id, :name)",
    "params": {"id": 7, "name": "alice"},
})
ok("PostgreSQL 参数使用绑定占位符", statement, "INSERT INTO report(id, name) VALUES (%(id)s, %(name)s)")
ok("参数原样传给 psycopg", values, {"id": 7, "name": "alice"})
ok("写入类型", workspace._is_write(head, statement), True)
ok("查询限制默认 1000", limit, 1000)
ok("WITH 写入计入配额", workspace._is_write("with", "WITH x AS (INSERT INTO report VALUES (1) RETURNING *) SELECT * FROM x"), True)
ok("邮箱稳定映射", workspace._identity("Alice@Agora.io"), workspace._identity("alice@agora.io"))
raises("多语句拒绝", lambda: workspace._prepare_sql({"sql": "SELECT 1; SELECT 2"}), "一条")
raises("事务控制拒绝", lambda: workspace._prepare_sql({"sql": "BEGIN"}), "只允许")
raises("角色管理拒绝", lambda: workspace._prepare_sql({"sql": "CREATE ROLE bad"}), "不允许")
raises("函数定义拒绝", lambda: workspace._prepare_sql({"sql": "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'SELECT 1'"}), "不允许")
raises("视图定义拒绝", lambda: workspace._prepare_sql({"sql": "CREATE VIEW v AS SELECT 1"}), "只允许操作")
raises("会话 SET 拒绝", lambda: workspace._prepare_sql({"sql": "SET ROLE postgres"}), "只允许")
raises("缺参数拒绝", lambda: workspace._prepare_sql({"sql": "SELECT :id"}), "没有对应参数")
raises("非法身份拒绝", lambda: workspace._identity(""), "无法识别")

for name, got, want in FAIL:
    print(f"x {name}: got={got!r}, want={want!r}")
print(f"{len(PASS)} passed, {len(FAIL)} failed")
sys.exit(1 if FAIL else 0)
