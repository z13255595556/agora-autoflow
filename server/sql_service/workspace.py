"""隔离式 PostgreSQL 工作区。

用户永远不会看到数据库地址或密码。服务按 OA 邮箱为每个人派生一个
独立 PostgreSQL 登录角色和私有 schema，再以该角色连接独立的工作区库。
即使应用层 SQL 校验被绕过，PostgreSQL 权限仍会拒绝跨用户访问。
"""
import hashlib
import hmac
import os
import re
from typing import Any, Dict, List, Tuple

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from . import db, sqlparams

DEFAULT_LIMIT = 1000
MAX_LIMIT = 1000
DEFAULT_QUOTA_BYTES = 1024 * 1024 * 1024

WRITE_HEADS = {"insert", "update", "delete", "create", "alter", "drop", "truncate"}
ALLOWED_HEADS = WRITE_HEADS | {"select", "with", "explain", "show"}
TABLE_DDL_RE = re.compile(
    r"^\s*(?:create\s+(?:(?:temporary|temp)\s+)?table|alter\s+table|drop\s+table|truncate\s+(?:table\s+)?)\b",
    re.IGNORECASE,
)
FORBIDDEN_RE = re.compile(
    r"\b(begin|commit|rollback|savepoint|release|set|reset|discard|vacuum|analyze|"
    r"grant|revoke|create\s+(role|database|extension|function|procedure|trigger)|"
    r"alter\s+(role|database|system)|drop\s+(role|database|extension|function|procedure)|"
    r"copy\s+.*\b(program|to|from)\b|listen|notify|unlisten)\b",
    re.IGNORECASE | re.DOTALL,
)


class WorkspaceError(RuntimeError):
    def __init__(self, message: str, code: str = "WORKSPACE_SQL_ERROR", status: int = 400):
        super().__init__(message)
        self.code = code
        self.status = status


def _env(name: str) -> str:
    return (os.getenv(name, "") or "").strip()


def configured() -> bool:
    return bool(_env("WORKSPACE_ADMIN_DSN") and _env("WORKSPACE_ROLE_SECRET"))


def _require_config() -> Tuple[str, str]:
    dsn, secret = _env("WORKSPACE_ADMIN_DSN"), _env("WORKSPACE_ROLE_SECRET")
    if not dsn or not secret:
        raise WorkspaceError(
            "未配置 PostgreSQL 工作区；请设置 WORKSPACE_ADMIN_DSN 与 WORKSPACE_ROLE_SECRET",
            "WORKSPACE_UNAVAILABLE", 503,
        )
    return dsn, secret


def quota_bytes() -> int:
    raw = _env("WORKSPACE_QUOTA_BYTES")
    try:
        value = int(raw) if raw else DEFAULT_QUOTA_BYTES
    except ValueError:
        value = DEFAULT_QUOTA_BYTES
    return max(1, value)


def _identity(email: str) -> Tuple[str, str, str]:
    normalized = email.strip().lower()
    if not normalized or "@" not in normalized:
        raise WorkspaceError("无法识别登录邮箱，不能使用自建 PostgreSQL 工作区", "WORKSPACE_IDENTITY", 403)
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:24]
    name = f"af_u_{digest}"
    return normalized, name, name


def _password(secret: str, email: str) -> str:
    # 角色密码从服务端密钥派生，控制库不保存密码。更换密钥会使旧角色失效，
    # 因此生产中该值应当像数据库主密码一样长期保管。
    return hmac.new(secret.encode("utf-8"), email.encode("utf-8"), hashlib.sha256).hexdigest()


def _mask_sql(sql_text: str) -> str:
    _, skip = sqlparams._scan(sql_text)
    chars = list(sql_text)
    for start, end in skip:
        for i in range(start, min(end, len(chars))):
            chars[i] = " "
    return "".join(chars)


def _one_statement(sql_text: str) -> None:
    masked = _mask_sql(sql_text)
    semis = [m.start() for m in re.finditer(r";", masked)]
    if len(semis) > 1 or (semis and masked[semis[0] + 1:].strip()):
        raise WorkspaceError("自建 PostgreSQL 节点一次只能执行一条 SQL")


def _prepare_sql(params: Dict[str, Any]) -> Tuple[str, Dict[str, Any], str, int]:
    raw = str(params.get("sql") or "").strip().rstrip(";").strip()
    if not raw:
        raise WorkspaceError("SQL 为空")
    _one_statement(raw)
    masked = _mask_sql(raw)
    head_parts = masked.lstrip("( \t\r\n").split(None, 1)
    head = head_parts[0].lower() if head_parts else ""
    if head not in ALLOWED_HEADS:
        raise WorkspaceError("只允许 SELECT/WITH/EXPLAIN/SHOW 或工作区表的 CREATE/ALTER/DROP/INSERT/UPDATE/DELETE")
    if FORBIDDEN_RE.search(masked):
        raise WorkspaceError("SQL 包含不允许的数据库管理、事务或会话命令")
    if head in {"create", "alter", "drop", "truncate"} and not TABLE_DDL_RE.match(masked):
        raise WorkspaceError("DDL 只允许操作个人工作区中的表")

    values = params.get("params") or {}
    if not isinstance(values, dict):
        raise WorkspaceError("params 必须是对象（占位符名到值的映射）")
    found, _ = sqlparams._scan(raw)
    used = {name for _, _, name in found}
    missing = sorted(used - set(values))
    extra = sorted(set(values) - used)
    if missing:
        raise WorkspaceError("SQL 里的占位符没有对应参数：" + "、".join(missing))
    if extra:
        raise WorkspaceError("这些参数在 SQL 里没有对应占位符：" + "、".join(extra))
    rendered: List[str] = []
    offset = 0
    for start, end, name in found:
        rendered.extend((raw[offset:start], f"%({name})s"))
        offset = end
    rendered.append(raw[offset:])
    raw_limit = params.get("limit", DEFAULT_LIMIT)
    try:
        limit = max(1, min(MAX_LIMIT, int(raw_limit)))
    except (TypeError, ValueError):
        limit = DEFAULT_LIMIT
    return "".join(rendered), values, head, limit


def _is_write(head: str, statement: str) -> bool:
    if head in WRITE_HEADS:
        return True
    # CTE can hide a data-modifying operation. It is still executed in the
    # user's isolated role, but must participate in the quota gate.
    return head == "with" and bool(re.search(r"\b(insert|update|delete)\b", _mask_sql(statement), re.IGNORECASE))


def _record_mapping(email: str, role: str, schema: str, used: int, exceeded: bool) -> None:
    with db.pool().connection() as conn:
        conn.execute(
            "INSERT INTO workspace_users (email, role_name, schema_name, used_bytes, quota_exceeded) "
            "VALUES (%s,%s,%s,%s,%s) ON CONFLICT (email) DO UPDATE SET "
            "last_used_at=now(), used_bytes=EXCLUDED.used_bytes, quota_exceeded=EXCLUDED.quota_exceeded",
            (email, role, schema, used, exceeded),
        )
        conn.commit()


def _ensure_user(email: str) -> Tuple[str, str, str, str]:
    email, role, schema = _identity(email)
    admin_dsn, secret = _require_config()
    password = _password(secret, email)
    try:
        with psycopg.connect(admin_dsn, connect_timeout=5, autocommit=True) as conn:
            database = conn.execute("SELECT current_database()").fetchone()[0]
            exists = conn.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (role,)).fetchone()
            if not exists:
                conn.execute(
                    sql.SQL("CREATE ROLE {} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %s")
                    .format(sql.Identifier(role)),
                    (password,),
                )
            conn.execute(sql.SQL("ALTER ROLE {} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %s").format(sql.Identifier(role)), (password,))
            conn.execute(sql.SQL("CREATE SCHEMA IF NOT EXISTS {} AUTHORIZATION {}").format(sql.Identifier(schema), sql.Identifier(role)))
            conn.execute(sql.SQL("REVOKE ALL ON SCHEMA public FROM PUBLIC"))
            conn.execute(sql.SQL("REVOKE ALL ON DATABASE {} FROM PUBLIC").format(sql.Identifier(database)))
            conn.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(sql.Identifier(database), sql.Identifier(role)))
            conn.execute(sql.SQL("GRANT USAGE, CREATE ON SCHEMA {} TO {}").format(sql.Identifier(schema), sql.Identifier(role)))
    except psycopg.Error as exc:
        raise WorkspaceError(f"无法开通 PostgreSQL 工作区：{exc}", "WORKSPACE_UNAVAILABLE", 503) from exc

    return email, role, schema, make_conninfo(admin_dsn, user=role, password=password, options=f"-c search_path={schema},pg_catalog")


def _used_bytes(conn, schema: str) -> int:
    row = conn.execute(
        "SELECT COALESCE(sum(pg_total_relation_size(c.oid)), 0) "
        "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
        "WHERE n.nspname=%s AND c.relkind IN ('r','m','t','i','S')",
        (schema,),
    ).fetchone()
    return int(row[0] or 0)


def execute(email: str, params: Dict[str, Any]) -> Dict[str, Any]:
    statement, values, head, limit = _prepare_sql(params)
    email, role, schema, user_dsn = _ensure_user(email)
    quota = quota_bytes()
    try:
        with psycopg.connect(user_dsn, connect_timeout=5) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SET LOCAL statement_timeout = '30s'")
                    cur.execute("SET LOCAL lock_timeout = '5s'")
                    before = _used_bytes(conn, schema)
                    if _is_write(head, statement) and before >= quota:
                        raise WorkspaceError(f"工作区已使用 {before} 字节，达到 {quota} 字节配额，不能继续写入", "WORKSPACE_QUOTA", 409)
                    cur.execute(statement, values)
                    columns = [{"name": d.name, "type": str(d.type_code)} for d in (cur.description or [])]
                    rows: List[Dict[str, Any]] = []
                    truncated = False
                    if cur.description:
                        data = cur.fetchmany(limit + 1)
                        truncated = len(data) > limit
                        for row in data[:limit]:
                            rows.append(dict(zip([d.name for d in cur.description], row)))
                    affected = max(0, cur.rowcount if cur.rowcount is not None else 0)
                after = _used_bytes(conn, schema)
            _record_mapping(email, role, schema, after, after >= quota)
    except WorkspaceError:
        raise
    except psycopg.errors.QueryCanceled as exc:
        raise WorkspaceError("SQL 执行超过 30 秒限制", "WORKSPACE_TIMEOUT", 408) from exc
    except psycopg.Error as exc:
        raise WorkspaceError(str(exc)) from exc
    return {
        "rows": rows, "columns": columns, "rowCount": len(rows),
        "affectedRows": affected, "truncated": truncated, "renderedSql": statement,
    }
