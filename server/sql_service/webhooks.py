"""Webhook 触发入口。

**这是把内部工具变成「任何能 POST 的人都能触发一条 Hive 大查询」的口子。**
所以这个文件里安全相关的代码比功能代码多，那是应该的。

执行那一半 M1 已经建好了 —— 这里只负责：认这个人、限住频率、
把 body 翻译成流程入参、入队。
"""
import hashlib
import hmac
import json
import re
import os
import secrets
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

from psycopg.types.json import Jsonb

from . import db, runstore

MAX_BODY_BYTES = 1024 * 1024
"""签名的时间戳容差。超过就当重放攻击拒掉"""
HMAC_SKEW_SECONDS = 300


class WebhookError(RuntimeError):
    """带 HTTP 状态码的拒绝。status 决定调用方看到什么。"""

    def __init__(self, status: int, message: str):
        self.status = status
        super().__init__(message)


def _rows(conn, sql, args=()):
    cur = conn.execute(sql, args)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def _one(conn, sql, args=()):
    got = _rows(conn, sql, args)
    return got[0] if got else None


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- 管理


AUTH_MODES = ("secret", "hmac", "none")
RESPONSE_MODES = ("immediate", "lastNode")
"""和 registry.ts 的 trigger.webhook.rateLimitPerMin 上下界对齐"""
RATE_MIN, RATE_MAX = 1, 600
RESPONSE_TIMEOUT_MIN, RESPONSE_TIMEOUT_MAX = 1, 1800
SYNC_TIMEOUT_SECONDS = 300.0
SYNC_POLL_SECONDS = 0.15


def _valid_auth(mode: Any) -> str:
    if mode not in AUTH_MODES:
        raise WebhookError(400, f"认证方式只能是 {'/'.join(AUTH_MODES)}，收到 {mode!r}")
    return str(mode)


def _valid_rate(rate: Any) -> int:
    if not isinstance(rate, int) or isinstance(rate, bool) or not RATE_MIN <= rate <= RATE_MAX:
        raise WebhookError(400, f"每分钟上限只能是 {RATE_MIN}–{RATE_MAX} 的整数，收到 {rate!r}")
    return rate


def _valid_response_mode(mode: Any) -> str:
    if mode not in RESPONSE_MODES:
        raise WebhookError(400, f"响应方式只能是 {'/'.join(RESPONSE_MODES)}，收到 {mode!r}")
    return str(mode)


def _valid_response_timeout(seconds: Any) -> int:
    if (
        not isinstance(seconds, int)
        or isinstance(seconds, bool)
        or not RESPONSE_TIMEOUT_MIN <= seconds <= RESPONSE_TIMEOUT_MAX
    ):
        raise WebhookError(
            400,
            f"同步等待秒数只能是 {RESPONSE_TIMEOUT_MIN}–{RESPONSE_TIMEOUT_MAX} 的整数，收到 {seconds!r}",
        )
    return seconds


def ensure(
    flow_id: str,
    auth_mode: str = "secret",
    rate_limit_per_min: int = 60,
    response_mode: str = "lastNode",
    response_timeout_seconds: int = 300,
) -> Dict[str, Any]:
    """给流程建一个 webhook（已有就返回已有的地址和密钥）。

    token 挂在 flow 上而不是 version 上：改一次流程就让上游改配置，没人受得了。

    **已存在时不动配置。** 认证方式是上游正在用的东西，一次误点就把
    对方的调用全打成 401 —— 改它必须是明确的动作，走 update()。
    """
    auth_mode = _valid_auth(auth_mode)
    rate_limit_per_min = _valid_rate(rate_limit_per_min)
    response_mode = _valid_response_mode(response_mode)
    response_timeout_seconds = _valid_response_timeout(response_timeout_seconds)
    with db.pool().connection() as conn:
        exist = _one(conn, "SELECT * FROM webhooks WHERE flow_id = %s", (flow_id,))
        if exist:
            return _public(exist)
        if not _one(conn, "SELECT id FROM flows WHERE id = %s", (flow_id,)):
            raise runstore.NotFound(f"流程 {flow_id} 不存在")

        token = secrets.token_hex(16)
        secret = secrets.token_urlsafe(24)
        wid = f"wh_{secrets.token_hex(6)}"
        conn.execute(
            "INSERT INTO webhooks"
            " (id, flow_id, token, secret_hash, secret_plain, auth_mode, rate_limit_per_min,"
            "  response_mode, response_timeout_seconds)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                wid, flow_id, token, _hash(secret), secret, auth_mode, rate_limit_per_min,
                response_mode, response_timeout_seconds,
            ),
        )
        conn.commit()
        row = _one(conn, "SELECT * FROM webhooks WHERE id = %s", (wid,))
    return _public(row)


def update(
    flow_id: str,
    auth_mode: Optional[str] = None,
    rate_limit_per_min: Optional[int] = None,
    response_mode: Optional[str] = None,
    response_timeout_seconds: Optional[int] = None,
    enabled: Optional[bool] = None,
) -> Dict[str, Any]:
    """改已生效的配置。

    画布上那两个字段（认证方式 / 每分钟上限）以前**只是装饰** —— 建 webhook 的
    接口根本不读它们，改了也没有任何效果。要么让它们真的生效，要么不该摆在那。
    """
    sets, args = [], []
    if auth_mode is not None:
        sets.append("auth_mode = %s")
        args.append(_valid_auth(auth_mode))
    if rate_limit_per_min is not None:
        sets.append("rate_limit_per_min = %s")
        args.append(_valid_rate(rate_limit_per_min))
    if response_mode is not None:
        sets.append("response_mode = %s")
        args.append(_valid_response_mode(response_mode))
    if response_timeout_seconds is not None:
        sets.append("response_timeout_seconds = %s")
        args.append(_valid_response_timeout(response_timeout_seconds))
    if enabled is not None:
        sets.append("enabled = %s")
        args.append(bool(enabled))
    if not sets:
        raise WebhookError(400, "没有要改的字段")

    with db.pool().connection() as conn:
        row = _one(conn, "SELECT id FROM webhooks WHERE flow_id = %s", (flow_id,))
        if not row:
            raise runstore.NotFound(f"流程 {flow_id} 还没有 webhook")
        conn.execute(f"UPDATE webhooks SET {', '.join(sets)} WHERE id = %s", (*args, row["id"]))
        conn.commit()
        fresh = _one(conn, "SELECT * FROM webhooks WHERE id = %s", (row["id"],))
    return _public(fresh)


def rotate(flow_id: str) -> Dict[str, Any]:
    """轮换 token 和密钥，旧的立即失效。"""
    with db.pool().connection() as conn:
        row = _one(conn, "SELECT id FROM webhooks WHERE flow_id = %s", (flow_id,))
        if not row:
            raise runstore.NotFound(f"流程 {flow_id} 还没有 webhook")
        token = secrets.token_hex(16)
        secret = secrets.token_urlsafe(24)
        conn.execute(
            "UPDATE webhooks"
            " SET token = %s, secret_hash = %s, secret_plain = %s, rotated_at = now() WHERE id = %s",
            (token, _hash(secret), secret, row["id"]),
        )
        conn.commit()
        fresh = _one(conn, "SELECT * FROM webhooks WHERE id = %s", (row["id"],))
    return _public(fresh)


def _public(row: Dict[str, Any]) -> Dict[str, Any]:
    """管理接口的返回形态。secret_hash 永不外泄，密钥原文允许回显。"""
    return {
        "id": row["id"],
        "flowId": row["flow_id"],
        "token": row["token"],
        "authMode": row["auth_mode"],
        "responseMode": row["response_mode"],
        "responseTimeoutSeconds": row["response_timeout_seconds"],
        "enabled": row["enabled"],
        "rateLimitPerMin": row["rate_limit_per_min"],
        "path": f"/hooks/{row['token']}",
        "createdAt": row["created_at"].isoformat(),
        "rotatedAt": row["rotated_at"].isoformat() if row.get("rotated_at") else None,
        # 旧 Webhook 只有 hash，无法反推；轮换一次后这里就会一直有值。
        "secret": row.get("secret_plain"),
    }


def get(flow_id: str) -> Optional[Dict[str, Any]]:
    with db.pool().connection() as conn:
        row = _one(conn, "SELECT * FROM webhooks WHERE flow_id = %s", (flow_id,))
    return _public(row) if row else None


def active_version(flow_id: str) -> Optional[int]:
    """已发布的版本号。None = 从未发布 → webhook 打过来只会拿到 409。

    和 webhook 一起返回，省掉前端一次请求，也避免"面板说已发布、实际没有"的时间差。
    """
    with db.pool().connection() as conn:
        row = _one(
            conn,
            "SELECT active_version FROM flows WHERE id = %s AND archived_at IS NULL",
            (flow_id,),
        )
    return row["active_version"] if row else None


def deliveries(flow_id: str, limit: int = 20):
    """最近的投递记录。「上游说发了但没跑」的唯一证据。"""
    with db.pool().connection() as conn:
        rows = _rows(
            conn,
            "SELECT d.received_at, d.remote_ip, d.status_code, d.reject_reason,"
            "       d.body_bytes, d.run_id"
            "  FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id"
            " WHERE w.flow_id = %s ORDER BY d.received_at DESC LIMIT %s",
            (flow_id, max(1, min(limit, 100))),
        )
    return [
        {
            "receivedAt": r["received_at"].isoformat(),
            "remoteIp": r["remote_ip"],
            "statusCode": r["status_code"],
            "rejectReason": r["reject_reason"],
            "bodyBytes": r["body_bytes"],
            "runId": r["run_id"],
        }
        for r in rows
    ]


# ---------------------------------------------------------------- 触发器预写

# 和前端 src/lib/secrets.ts 的 isSensitiveHeaderName 是**同一条规则的镜像**，
# 改任何一边都要同步另一边。x-webhook-secret 命中 secret、x-signature 命中
# signature —— 都是自家认证头，签名 + 原始 body 就能重放那次请求，等同凭证
_EXACT_SENSITIVE_HEADERS = {
    "authorization", "proxy-authorization", "cookie", "set-cookie",
    "x-api-key", "api-key", "x-auth-token",
}
_SENSITIVE_HEADER_RE = re.compile(r"token|secret|api[-_]?key|signature", re.IGNORECASE)


def redact_headers(headers: Dict[str, str]) -> Dict[str, str]:
    """把敏感请求头的值换成 [REDACTED]，其余原样。头名保留、值不落库 ——
    运行记录会被截图、贴群、进工单（和 wecom.py 打码 key 同一个理由）。"""
    return {
        k: ("[REDACTED]"
            if k.strip().lower() in _EXACT_SENSITIVE_HEADERS or _SENSITIVE_HEADER_RE.search(k)
            else v)
        for k, v in (headers or {}).items()
    }


def trigger_step_of(
    definition: Dict[str, Any],
    raw_body: bytes,
    headers: Dict[str, str],
    remote_ip: Optional[str],
) -> Optional[Dict[str, Any]]:
    """webhook 触发节点的预写步骤（node_id + output）；定义里没有该节点时 None。

    原始 body 全量只在**这里**进入运行记录 —— worker 那边触发器走 mock，
    产不出它（也不该产：body 只有收请求的这一刻在手上）。output 的形状必须和
    前端 registry 给 trigger.webhook 声明的输出结构一致，取值面板按那份 schema
    引导用户写 $.nodes.<hook>.output.body，这里少一个字段就是一处必炸的引用。

    body 在这里重新 parse 一次：map_inputs 已经验证过它是合法 JSON 对象，
    这里不会失败。不复用它的解析结果是为了不改它的签名 —— 它是纯函数，
    一堆测试直接调它。
    """
    nodes = definition.get("nodes") or []
    hook = next((n for n in nodes if n.get("type") == "trigger.webhook"), None)
    if not hook or not hook.get("id"):
        return None
    return {
        "node_id": hook["id"],
        "output": {
            "body": json.loads(raw_body or b"{}"),
            "headers": redact_headers(headers),
            "remoteIp": remote_ip,
            "receivedAt": datetime.now(timezone.utc).isoformat(),
        },
    }


# ---------------------------------------------------------------- 入参映射


def map_inputs(raw_body: bytes, inputs_schema: Dict[str, Any]) -> Dict[str, Any]:
    """body 顶层字段按 flowInputs 同名取，带类型转换和必填校验。

    **这条通道让「同一条流程手动能调、定时能跑、webhook 能触发」成立** ——
    流程主体完全不需要知道自己被谁触发。

    body 是嵌套结构或字段名对不上时走另一条通道：
    `$.nodes.<webhookNodeId>.output.body` 拿原始 body 全量。
    """
    try:
        body = json.loads(raw_body or b"{}")
    except ValueError as exc:
        raise WebhookError(400, f"请求体不是合法 JSON：{exc}")
    if not isinstance(body, dict):
        raise WebhookError(400, "请求体必须是 JSON 对象")

    props = (inputs_schema or {}).get("properties") or {}
    required = set((inputs_schema or {}).get("required") or [])
    out: Dict[str, Any] = {}

    for key, schema in props.items():
        if key not in body:
            if key in required:
                raise WebhookError(400, f"缺少必填入参 {key}")
            continue
        out[key] = _coerce(body[key], str(schema.get("type") or "string"), key, schema)

    for key in required:
        if key not in out:
            raise WebhookError(400, f"缺少必填入参 {key}")
    return out


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _coerce(value: Any, want: str, key: str, schema: Optional[Dict[str, Any]] = None) -> Any:
    """类型转换。**转不了就 400 并说清是哪个字段** ——
    报文是给上游系统的开发者看的，不是给我们自己看的。

    入参的「日期」「下拉」种类落到 schema 里是 string + format / string + enum
    （见前端 flowGraph.inputSchemaOf），这里按同一份 schema 校验，前后端认的是一样的。"""
    schema = schema or {}
    if want == "number":
        if isinstance(value, bool):
            raise WebhookError(400, f"入参 {key} 需要数字，收到布尔值")
        if isinstance(value, (int, float)):
            return value
        if isinstance(value, str):
            try:
                return float(value.strip())
            except ValueError:
                pass
        raise WebhookError(400, f"入参 {key} 需要数字，收到 {json.dumps(value, ensure_ascii=False)}")
    if want == "integer":
        if isinstance(value, bool):
            raise WebhookError(400, f"入参 {key} 需要整数，收到布尔值")
        if isinstance(value, int):
            return value
        if isinstance(value, str) and value.strip().lstrip("-").isdigit():
            return int(value)
        raise WebhookError(400, f"入参 {key} 需要整数，收到 {json.dumps(value, ensure_ascii=False)}")
    if want == "boolean":
        if isinstance(value, bool):
            return value
        if isinstance(value, str) and value.lower() in {"true", "false", "1", "0"}:
            return value.lower() in {"true", "1"}
        raise WebhookError(400, f"入参 {key} 需要布尔值，收到 {json.dumps(value, ensure_ascii=False)}")
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    if schema.get("format") == "date" and not _DATE_RE.match(text.strip()):
        raise WebhookError(400, f"入参 {key} 需要 yyyy-MM-dd 格式的日期，收到 {json.dumps(value, ensure_ascii=False)}")
    options = schema.get("enum")
    if isinstance(options, list) and options and text not in options:
        raise WebhookError(400, f"入参 {key} 只能是 {' / '.join(map(str, options))}，收到 {json.dumps(value, ensure_ascii=False)}")
    return text


# ---------------------------------------------------------------- 认证与限流


def _check_auth(row: Dict[str, Any], headers: Dict[str, str], raw_body: bytes) -> None:
    mode = row["auth_mode"]
    if mode == "none":
        return

    if mode == "secret":
        given = headers.get("x-webhook-secret") or ""
        # 常数时间比较：避免时序侧信道一位一位试出密钥
        if not given or not hmac.compare_digest(_hash(given), row["secret_hash"] or ""):
            raise WebhookError(401, "密钥不对")
        return

    if mode == "hmac":
        sig = (headers.get("x-signature") or "").removeprefix("sha256=")
        ts = headers.get("x-timestamp") or ""
        if not sig or not ts.isdigit():
            raise WebhookError(401, "缺少 X-Signature 或 X-Timestamp")
        # 防重放：签名再对，隔了半天的请求也不认
        if abs(time.time() - int(ts)) > HMAC_SKEW_SECONDS:
            raise WebhookError(401, f"时间戳偏差超过 {HMAC_SKEW_SECONDS} 秒，拒绝（防重放）")
        # 对 **raw body** 算，不是 parse 后重新序列化的 ——
        # key 顺序、空格差异都会让签名对不上
        expect = hmac.new(
            (row["secret_hash"] or "").encode(), f"{ts}.".encode() + raw_body, hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(sig, expect):
            raise WebhookError(401, "签名不对")
        return

    raise WebhookError(500, f"不支持的认证方式 {mode}")


def _check_rate(conn, row: Dict[str, Any]) -> None:
    n = conn.execute(
        "SELECT count(*) FROM webhook_deliveries"
        " WHERE webhook_id = %s AND received_at > now() - interval '1 minute'"
        "   AND status_code < 400",
        (row["id"],),
    ).fetchone()[0]
    if n >= row["rate_limit_per_min"]:
        raise WebhookError(429, f"超过每分钟 {row['rate_limit_per_min']} 次的上限")


def _idempotency_key(headers: Dict[str, str]) -> Optional[str]:
    """只有调用方明确要求才去重；相同 body 默认代表两次独立触发。"""
    value = (headers.get("idempotency-key") or "").strip()
    return value or None


def _end_node_ids(definition: Dict[str, Any]) -> set:
    return {
        str(node.get("id"))
        for node in (definition.get("nodes") or [])
        if node.get("type") == "flow.end" and node.get("id")
    }


def _status_url(run_id: str) -> str:
    """外部相对地址需包含反向代理挂载前缀。"""
    prefix = "/" + os.getenv("PUBLIC_BASE_PATH", "").strip("/ ")
    if prefix == "/":
        prefix = ""
    return f"{prefix}/api/runs/{run_id}"


def wait_for_result(
    run_id: str,
    definition: Dict[str, Any],
    timeout_seconds: float = SYNC_TIMEOUT_SECONDS,
    poll_seconds: float = SYNC_POLL_SECONDS,
) -> Tuple[int, Dict[str, Any]]:
    """等待运行终态，成功时直接返回最后一个已执行结束节点的输出。

    超时不取消流程：调用方拿 202 + runId 后仍可继续查询。幂等命中一条已经结束
    的运行时，第一次读取就会直接返回原结果。
    """
    end_ids = _end_node_ids(definition)
    if not end_ids:
        return 500, {
            "error": "同步响应需要流程中存在「结束」节点",
            "runId": run_id,
            "statusUrl": _status_url(run_id),
        }

    deadline = time.monotonic() + max(0.0, timeout_seconds)
    while True:
        run = runstore.get_run(run_id)
        status = str(run.get("status") or "queued")
        if status == "success":
            ends = [
                step for step in (run.get("steps") or [])
                if step.get("nodeId") in end_ids and step.get("status") == "success"
            ]
            if not ends:
                return 500, {
                    "error": "流程成功，但没有执行到「结束」节点",
                    "runId": run_id,
                    "statusUrl": _status_url(run_id),
                }
            output = max(ends, key=lambda step: int(step.get("seq") or 0)).get("output")
            return 200, output if isinstance(output, dict) else {"result": output}
        if status in {"error", "canceled"}:
            return 500, {
                "error": run.get("error") or f"流程运行{status}",
                "runId": run_id,
                "status": status,
                "statusUrl": _status_url(run_id),
            }
        if time.monotonic() >= deadline:
            return 202, {
                "runId": run_id,
                "status": status,
                "statusUrl": _status_url(run_id),
                "timedOut": True,
            }
        time.sleep(max(0.01, poll_seconds))


# ---------------------------------------------------------------- 入口


def handle(
    token: str,
    raw_body: bytes,
    headers: Dict[str, str],
    remote_ip: Optional[str],
) -> Tuple[int, Dict[str, Any]]:
    """处理一次 webhook 请求。返回 (状态码, 响应体)。

    每一条拒绝都要落进 webhook_deliveries —— 「上游说发了但没跑」是这类集成
    最常见的争议，没有记录就说不清。
    """
    headers = {k.lower(): v for k, v in headers.items()}
    digest = hashlib.sha256(raw_body or b"").hexdigest()[:16]

    with db.pool().connection() as conn:
        row = _one(conn, "SELECT * FROM webhooks WHERE token = %s", (token,))
        # 404 而不是 403：不泄露「这个 token 存在但你没权限」
        if not row or not row["enabled"]:
            raise WebhookError(404, "地址不存在或已停用")

        def record(status: int, reason: Optional[str], run_id: Optional[str] = None) -> None:
            conn.execute(
                "INSERT INTO webhook_deliveries"
                " (webhook_id, run_id, remote_ip, status_code, reject_reason, body_bytes, body_digest)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s)",
                (row["id"], run_id, remote_ip, status, reason, len(raw_body or b""), digest),
            )
            conn.commit()

        try:
            if len(raw_body or b"") > MAX_BODY_BYTES:
                raise WebhookError(413, f"请求体超过 {MAX_BODY_BYTES // 1024} KB 上限")
            _check_rate(conn, row)
            _check_auth(row, headers, raw_body)

            flow = _one(
                conn,
                "SELECT f.active_version, v.definition FROM flows f"
                " LEFT JOIN flow_versions v ON v.flow_id = f.id AND v.version = f.active_version"
                " WHERE f.id = %s AND f.archived_at IS NULL",
                (row["flow_id"],),
            )
            if not flow:
                raise WebhookError(404, "流程不存在或已归档")
            if flow["active_version"] is None:
                # 草稿改坏了不该影响线上，这是 active_version 存在的全部理由
                raise WebhookError(409, "流程尚未发布，webhook 只触发已发布的版本")

            inputs = map_inputs(raw_body, (flow["definition"] or {}).get("inputs") or {})
        except WebhookError as exc:
            record(exc.status, str(exc))
            raise

        # 幂等是调用方的明确选择。没有 Idempotency-Key 时每个 POST 都是一次新触发。
        idem = _idempotency_key(headers)

    result = runstore.create_run(
        row["flow_id"],
        inputs=inputs,
        mode="production",
        trigger_kind="webhook",
        # 显式传上面刚校验过的那一版，**别让 create_run 再读一次 active_version**：
        # 两次读之间发生一次发布的话，map_inputs 和 wait_for_result 用的是旧定义，
        # 实际跑的却是新版本。窗口很窄，但它是真的
        version=flow["active_version"],
        idempotency_key=idem,
        # 触发器这一步在**收请求的此刻**替 worker 写好（原始 body / 打码后的
        # 请求头 / 来源）。必须托付给 create_run 和 runs 行同一个事务落库，
        # 不能在它返回后补写 —— worker 每秒扫队列，两次写之间它就能认领并把
        # 触发器跑成 mock 的 {}，谁赢由毫秒决定，而且只在线上偶发
        trigger_step=trigger_step_of(flow["definition"] or {}, raw_body, headers, remote_ip),
    )

    with db.pool().connection() as conn:
        delivery_id = conn.execute(
            "INSERT INTO webhook_deliveries"
            " (webhook_id, run_id, remote_ip, status_code, body_bytes, body_digest)"
            " VALUES (%s,%s,%s,202,%s,%s) RETURNING id",
            (row["id"], result["runId"], remote_ip, len(raw_body or b""), digest),
        ).fetchone()[0]
        conn.commit()

    immediate = {
        "runId": result["runId"],
        "status": result.get("status", "queued"),
        "statusUrl": _status_url(result["runId"]),
        **({"deduplicated": True} if result.get("deduplicated") else {}),
    }
    if row["response_mode"] == "immediate":
        return 202, immediate

    status, body = wait_for_result(
        result["runId"],
        flow["definition"] or {},
        timeout_seconds=float(row["response_timeout_seconds"]),
    )
    with db.pool().connection() as conn:
        conn.execute(
            "UPDATE webhook_deliveries SET status_code = %s, reject_reason = %s WHERE id = %s",
            (status, body.get("error") if status >= 400 else None, delivery_id),
        )
        conn.commit()
    return status, body
