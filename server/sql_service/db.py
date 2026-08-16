"""数据库连接与迁移。

**没配数据库也要能用。** 这和 client.ts 探不到节点服务就整站退回 mock 是同一个
约定：没有 DATABASE_URL/PGHOST 时流程接口一律返回 503 并说清原因，前端继续用
localStorage。不这么做的话，任何人 clone 下来第一件事就是被迫装个 Postgres，
而这个项目最大的优点之一就是"服务不起也能打开编辑器摆流程"。

迁移用裸 SQL 文件 + 一张版本表，不引 Alembic：整个服务端只有四个依赖，
为两张表引一套迁移框架不划算，而且裸 SQL 更容易在出事时手动接管。
"""
import os
import pathlib
import threading
from typing import Any, Dict, List, Optional

MIGRATIONS_DIR = pathlib.Path(__file__).resolve().parent.parent / "migrations"

_pool: Any = None
_pool_lock = threading.Lock()
_init_error: Optional[str] = None


class DbUnavailable(RuntimeError):
    """数据库没配或连不上。调用方应转成 503 并把原话带给用户。"""


def dsn() -> str:
    return os.getenv("DATABASE_URL", "").strip()


def configured() -> bool:
    # 生产容器使用标准 libpq PG* 环境，密码由 entrypoint 从 Docker Secret
    # 放进 PGPASSWORD；本地开发和测试继续支持一条 DATABASE_URL。
    return bool(dsn() or os.getenv("PGHOST", "").strip())


def _create_pool():
    try:
        from psycopg_pool import ConnectionPool
    except ImportError as exc:
        raise DbUnavailable(
            f"缺少数据库驱动：{exc}。装一下 pip install 'psycopg[binary,pool]'"
        )
    # open=False + 显式 open()：构造时就连不上要立刻报错，而不是等第一次查询
    # 空 conninfo 会让 libpq 读取 PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD。
    pool = ConnectionPool(dsn(), min_size=1, max_size=8, open=False, timeout=5)
    pool.open(wait=True, timeout=5)
    return pool


def pool():
    """拿到连接池；没配或连不上抛 DbUnavailable。

    失败原因缓存下来：每次请求都去重连一个连不上的库，会让每个接口都挂 5 秒。
    """
    global _pool, _init_error
    if _pool is not None:
        return _pool
    if not configured():
        raise DbUnavailable("未配置 DATABASE_URL 或 PGHOST，流程仍存在浏览器本地")
    with _pool_lock:
        if _pool is not None:
            return _pool
        if _init_error is not None:
            raise DbUnavailable(_init_error)
        try:
            _pool = _create_pool()
            migrate(_pool)
        except DbUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001
            _init_error = f"连不上数据库：{exc}"
            raise DbUnavailable(_init_error)
    return _pool


def reset() -> None:
    """测试用：丢掉缓存的池和失败原因。"""
    global _pool, _init_error
    if _pool is not None:
        try:
            _pool.close()
        except Exception:  # noqa: BLE001
            pass
    _pool = None
    _init_error = None


def migrate(p) -> List[str]:
    """按文件名顺序跑没跑过的迁移。返回本次执行了哪几个。

    每个文件在**同一个事务**里执行并记账 —— 分开的话中途崩溃会留下
    "跑了一半但没记账"的库，下次启动重跑就报错，而那时候没人知道该跑到哪。
    """
    applied: List[str] = []
    with p.connection() as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            " name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
        )
        conn.commit()
        done = {r[0] for r in conn.execute("SELECT name FROM schema_migrations").fetchall()}
        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if path.name in done:
                continue
            # **不能给这一句加参数。** psycopg3 只在没有参数时走 simple query
            # protocol，而只有那个协议允许一次发多条语句（见其 _cursor_base.py
            # 里的分支：`elif force_extended or query.params ...`）。
            # 加一个参数进去，迁移文件立刻只有第一条语句生效，而且不报错。
            conn.execute(path.read_text(encoding="utf-8"))
            conn.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (path.name,))
            conn.commit()
            applied.append(path.name)
    return applied


def status() -> Dict[str, Any]:
    """给 /health 用：不抛异常，如实说当前是什么状态。"""
    if not configured():
        return {"configured": False, "ok": False, "detail": "未配置 DATABASE_URL 或 PGHOST"}
    try:
        p = pool()
        with p.connection() as conn:
            conn.execute("SELECT 1")
        return {"configured": True, "ok": True, "detail": None}
    except DbUnavailable as exc:
        return {"configured": True, "ok": False, "detail": str(exc)}
    except Exception as exc:  # noqa: BLE001
        return {"configured": True, "ok": False, "detail": str(exc)}


def scheduler_status(stale_seconds: int = 120) -> Dict[str, Any]:
    """调度器活着没。

    **不是一个常量。** 调度器静默死掉和从来没接入是同一种后果，而且更隐蔽 ——
    那时用户有理由相信定时在跑。前端据此决定要不要挂"不会自动运行"的提示。
    """
    if not configured():
        return {"alive": False, "lastBeatAt": None, "detail": "未配置数据库"}
    try:
        with pool().connection() as conn:
            row = conn.execute(
                "SELECT beat_at, EXTRACT(EPOCH FROM (now() - beat_at)) AS age"
                "  FROM worker_heartbeat WHERE role = 'scheduler'"
                " ORDER BY beat_at DESC LIMIT 1"
            ).fetchone()
        if not row:
            return {"alive": False, "lastBeatAt": None, "detail": "调度器从未上报过心跳"}
        age = float(row[1])
        return {
            "alive": age <= stale_seconds,
            "lastBeatAt": row[0].isoformat(),
            "detail": None if age <= stale_seconds else f"调度器已 {int(age)} 秒没有心跳",
        }
    except Exception as exc:  # noqa: BLE001
        return {"alive": False, "lastBeatAt": None, "detail": str(exc)}
