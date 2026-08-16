"""Webhook 的入参映射与认证测试。**纯逻辑，不需要数据库。**

映射那部分是这条链路上最容易静默出错的地方：类型转错了不会报错，
只会让下游的 SQL 拿到一个字符串 '7' 去和整数比。
"""
import hashlib
import hmac
import json
import sys
import time
from datetime import datetime, timezone

from sql_service import webhooks
from sql_service.webhooks import WebhookError

PASS, FAIL = [], []


def ok(name, got, want):
    (PASS if got == want else FAIL).append((name, got, want))


def rejects(name, fn, status=None, fragment=""):
    try:
        fn()
    except WebhookError as exc:
        bad = []
        if status is not None and exc.status != status:
            bad.append(f"状态码 {exc.status} != {status}")
        if fragment and fragment not in str(exc):
            bad.append(f"报文 {exc!s} 不含 {fragment!r}")
        (FAIL if bad else PASS).append((name, "；".join(bad) or "rejected", "rejected"))
    except Exception as exc:  # noqa: BLE001
        FAIL.append((name, f"抛了 {type(exc).__name__}: {exc}", "WebhookError"))
    else:
        FAIL.append((name, "放行了", "WebhookError"))


SCHEMA = {
    "type": "object",
    "properties": {
        "vid": {"type": "integer"},
        "days": {"type": "integer"},
        "name": {"type": "string"},
        "dry": {"type": "boolean"},
    },
    "required": ["vid"],
}

def m(body):
    return webhooks.map_inputs(json.dumps(body).encode(), SCHEMA)


# ---------------------------------------------------------------- 入参映射

ok("按 flowInputs 同名取顶层字段", m({"vid": 1, "days": 7}), {"vid": 1, "days": 7})
ok("body 里多余的字段忽略（不报错）", m({"vid": 1, "extra": "x"}), {"vid": 1})
ok("可选字段缺失就不出现", m({"vid": 1}), {"vid": 1})

# 类型转换：上游 JSON 里的字符串数字是常态
ok("字符串数字转整数", m({"vid": "12345"}), {"vid": 12345})
ok("负数也认", m({"vid": "-5"}), {"vid": -5})
ok("布尔的字符串写法", m({"vid": 1, "dry": "true"}), {"vid": 1, "dry": True})
ok("布尔的 0/1 写法", m({"vid": 1, "dry": "0"}), {"vid": 1, "dry": False})
ok("整数转字符串字段", m({"vid": 1, "name": 42}), {"vid": 1, "name": "42"})

rejects("必填缺失 → 400", lambda: m({"days": 7}), 400, "vid")
rejects("整数字段收到 abc → 400 且指明字段", lambda: m({"vid": "abc"}), 400, "vid")
rejects("整数字段收到小数 → 400", lambda: m({"vid": 7.5}), 400, "vid")
rejects("★ 整数字段收到布尔 → 400", lambda: m({"vid": True}), 400, "vid")
rejects("body 不是 JSON → 400", lambda: webhooks.map_inputs(b"nope", SCHEMA), 400, "JSON")
rejects("body 是数组不是对象 → 400", lambda: webhooks.map_inputs(b"[1,2]", SCHEMA), 400, "对象")

# 没有声明入参的流程：body 随便传，什么都不映射
ok("流程没有入参时映射出空", webhooks.map_inputs(b'{"a":1}', {}), {})


# ---------------------------------------------------------------- 认证

def row(mode, secret=None):
    return {
        "auth_mode": mode,
        "secret_hash": hashlib.sha256(secret.encode()).hexdigest() if secret else None,
    }


webhooks._check_auth(row("none"), {}, b"{}")
PASS.append(("none 模式直接放行", "ok", "ok"))

rejects("secret 模式缺头 → 401", lambda: webhooks._check_auth(row("secret", "s3cret"), {}, b"{}"), 401)
rejects("secret 错 → 401",
        lambda: webhooks._check_auth(row("secret", "s3cret"), {"x-webhook-secret": "wrong"}, b"{}"), 401)
webhooks._check_auth(row("secret", "s3cret"), {"x-webhook-secret": "s3cret"}, b"{}")
PASS.append(("secret 对 → 放行", "ok", "ok"))


def sign(secret_hash, ts, body):
    return hmac.new(secret_hash.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()


r = row("hmac", "s3cret")
body = b'{"vid":1}'
now = str(int(time.time()))
webhooks._check_auth(r, {"x-signature": "sha256=" + sign(r["secret_hash"], now, body), "x-timestamp": now}, body)
PASS.append(("hmac 签名对 → 放行", "ok", "ok"))

rejects("hmac 签名不对 → 401",
        lambda: webhooks._check_auth(r, {"x-signature": "sha256=deadbeef", "x-timestamp": now}, body), 401)

old = str(int(time.time()) - 3600)
rejects("★ hmac 时间戳过期 → 401（防重放）",
        lambda: webhooks._check_auth(
            r, {"x-signature": "sha256=" + sign(r["secret_hash"], old, body), "x-timestamp": old}, body),
        401, "重放")

# 签名必须对 **raw body** 算：parse 后重新序列化，key 顺序和空格差异都会对不上
reordered = b'{"vid": 1}'
rejects("★ 签名对的是原始字节，改一个空格就不认",
        lambda: webhooks._check_auth(
            r, {"x-signature": "sha256=" + sign(r["secret_hash"], now, body), "x-timestamp": now}, reordered),
        401)


# ---------------------------------------------------------------- 配置校验
#
# 画布上那两个字段（认证方式 / 每分钟上限）以前**只是装饰** —— 建 webhook 的
# 接口根本不读它们。现在它们会一路写进库，所以边界必须在这里挡住：
# auth_mode 写错一个字母就是"没有匹配的分支 → 500"，而限流写成 0 等于关掉限流。

for mode in ("secret", "hmac", "none"):
    ok(f"认证方式 {mode} 合法", webhooks._valid_auth(mode), mode)

rejects("认证方式拼错 → 400", lambda: webhooks._valid_auth("secrets"), 400)
rejects("认证方式为空 → 400", lambda: webhooks._valid_auth(""), 400)
rejects("认证方式传 None → 400", lambda: webhooks._valid_auth(None), 400)

ok("限流下界 1 合法", webhooks._valid_rate(1), 1)
ok("限流上界 600 合法", webhooks._valid_rate(600), 600)
rejects("★ 限流 0 → 400（0 等于把闸关掉，不是「不限」）", lambda: webhooks._valid_rate(0), 400)
rejects("限流超上界 → 400", lambda: webhooks._valid_rate(601), 400)
rejects("限流传字符串 → 400", lambda: webhooks._valid_rate("60"), 400)
rejects("限流传小数 → 400", lambda: webhooks._valid_rate(1.5), 400)
# True 在 Python 里 == 1，不挡住就会被当成"每分钟 1 次"存进去
rejects("★ 限流传布尔 → 400", lambda: webhooks._valid_rate(True), 400)

for mode in ("immediate", "lastNode"):
    ok(f"响应方式 {mode} 合法", webhooks._valid_response_mode(mode), mode)
rejects("响应方式拼错 → 400", lambda: webhooks._valid_response_mode("sync"), 400, "响应方式")

ok("同步等待默认值 300 秒合法", webhooks._valid_response_timeout(300), 300)
ok("同步等待上界合法", webhooks._valid_response_timeout(1800), 1800)
rejects("同步等待不能为 0", lambda: webhooks._valid_response_timeout(0), 400, "同步等待")
rejects("同步等待不能是布尔值", lambda: webhooks._valid_response_timeout(True), 400, "同步等待")

ok("不传幂等键就不去重", webhooks._idempotency_key({}), None)
ok("显式幂等键原样使用", webhooks._idempotency_key({"idempotency-key": " request-1 "}), "request-1")


# ---------------------------------------------------------------- 同步响应

END_DEF = {"nodes": [{"id": "end1", "type": "flow.end"}]}
original_get_run = webhooks.runstore.get_run

try:
    webhooks.runstore.get_run = lambda _run_id: {
        "status": "success",
        "steps": [{"nodeId": "end1", "status": "success", "seq": 3, "output": {"result": "done"}}],
    }
    status, body = webhooks.wait_for_result("run_1", END_DEF, timeout_seconds=0)
    ok("同步成功返回结束节点输出和 200", (status, body), (200, {"result": "done"}))

    webhooks.runstore.get_run = lambda _run_id: {
        "status": "error", "error": "SQL failed", "steps": [],
    }
    status, body = webhooks.wait_for_result("run_2", END_DEF, timeout_seconds=0)
    ok("运行失败同步返回 500", (status, body["error"]), (500, "SQL failed"))

    webhooks.runstore.get_run = lambda _run_id: {"status": "running", "steps": []}
    status, body = webhooks.wait_for_result("run_3", END_DEF, timeout_seconds=0)
    ok("等待超时降级为 202 且流程继续", (status, body["timedOut"]), (202, True))

    status, body = webhooks.wait_for_result("run_4", {"nodes": []}, timeout_seconds=0)
    ok("同步模式没有结束节点返回可操作错误", (status, "结束" in body["error"]), (500, True))
finally:
    webhooks.runstore.get_run = original_get_run


# ---------------------------------------------------------------- 管理接口回显

public = webhooks._public({
    "id": "wh_1",
    "flow_id": "flow_1",
    "token": "token_1",
    "secret_hash": "绝不能返回",
    "secret_plain": "visible-secret",
    "auth_mode": "secret",
    "response_mode": "immediate",
    "response_timeout_seconds": 300,
    "enabled": True,
    "rate_limit_per_min": 60,
    "created_at": datetime.now(timezone.utc),
    "rotated_at": None,
})
ok("管理接口持续返回密钥原文", public["secret"], "visible-secret")
ok("管理接口不返回认证 hash", "secret_hash" in public, False)
ok("管理接口返回同步等待时间", public["responseTimeoutSeconds"], 300)


for name, got, want in FAIL:
    print(f"✗ {name}\n    实际: {got!r}\n    期望: {want!r}")
print(f"\n{len(PASS)} 通过, {len(FAIL)} 失败")
sys.exit(1 if FAIL else 0)
