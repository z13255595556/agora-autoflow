"""节点服务的集成测试：把 SSO 和 datalego 都换成假的，跑通整条链路。

不需要真凭证，也不会打真实平台。

    cd server && .venv/bin/python test_service.py
"""
import json
import sys
import types

# 必须在导入服务之前塞好假凭证 —— robot 模块只在换票时才读，但 manifest
# 和端点常量是导入时求值的
import os
os.environ.update(
    OAUTH_CLIENT_ID="x", OAUTH_CLIENT_SECRET="x",
    OAUTH_USERNAME="x", OAUTH_PASSWORD="x",
)

from fastapi.testclient import TestClient  # noqa: E402

from sql_service import datalego, http_request, identity, main, manifest, robot, wecom  # noqa: E402

PASS, FAIL = [], []


def ok(name, got, want):
    (PASS if got == want else FAIL).append((name, got, want))


def truthy(name, got):
    (PASS if got else FAIL).append((name, got, "truthy"))


# ---------------------------------------------------------------- 假上游
JOBS = {}          # job_id -> 还要被轮询几次才完成
SUBMITTED = []     # 记下提交过的 SQL，用来断言渲染结果
CANCELLED = []


class FakeResp:
    def __init__(self, payload, status=200, url="https://upstream.example/result"):
        self._payload = payload
        self.status_code = status
        self.headers = {}
        self.text = json.dumps(payload)
        self.content = self.text.encode("utf-8")
        self.url = url

    @property
    def ok(self):
        return self.status_code < 400

    def json(self):
        return self._payload

    def raise_for_status(self):
        if not self.ok:
            raise RuntimeError(f"HTTP {self.status_code}")

    def close(self):
        pass


def fake_post(url, **kw):
    if "oauth" in url:
        return FakeResp({"access_token": "tok_" + "x" * 20, "expires_in": 7200})
    if "job/trigger" in url:
        body = kw.get("json") or {}
        # creator 是 query 参数不是 body 字段，但它决定用谁的权限 ——
        # 断言得看得见它，所以一并记下来
        SUBMITTED.append({**body, "_query": kw.get("params") or {}})
        job_id = f"job_{len(SUBMITTED):08d}"
        JOBS[job_id] = 1  # 第一次轮询未完成，第二次完成
        return FakeResp({"id": job_id})
    raise AssertionError(f"没预料到的 POST {url}")


def fake_get(url, **kw):
    job_id = url.rstrip("/").split("/")[-2]
    remaining = JOBS.get(job_id)
    if remaining is None:
        return FakeResp({}, status=404)
    if remaining > 0:
        JOBS[job_id] -= 1
        # 进度先冲到 100 但 schema 还是 None —— 复现平台的非单调进度，
        # 判完成只能看 schema
        return FakeResp({"status": "running", "progress": 100.0, "schema": None})
    return FakeResp({
        "status": "success", "progress": 100.0,
        "schema": [{"name": "vid", "type": "bigint"}, {"name": "name", "type": "string"}],
        "data": [[88031, "acme"], [88032, "globex"]],
        "sql": "SELECT ...", "createdAt": "2026-08-12T10:00:00Z",
    })


def fake_put(url, **kw):
    CANCELLED.append(url.rstrip("/").split("/")[-2])
    return FakeResp({})


fake_requests = types.SimpleNamespace(
    post=fake_post, get=fake_get, put=fake_put,
    RequestException=Exception, Response=FakeResp,
)
datalego.requests = fake_requests
robot.requests = fake_requests

# Athena is the browser-identity authority.  The test deliberately sends an
# opaque cookie: the AutoFlow process must forward it, never decode it.
ATHENA_CALLS = []
_ATHENA_EMAIL = "zhaojiwei@agora.io"


def fake_athena_get(url, **kw):
    ATHENA_CALLS.append((url, kw))
    cookie = (kw.get("headers") or {}).get("Cookie", "")
    if "rejected-session" in cookie:
        return FakeResp({"error": "Login required"}, status=401)
    if "malformed-session" in cookie:
        return FakeResp({"user": {"email": _ATHENA_EMAIL}})
    return FakeResp({"user": {
        "id": _ATHENA_EMAIL,
        "email": _ATHENA_EMAIL,
        "displayName": "Zhao Jiwei",
        "permissions": [],
        "isAdmin": True,
    }})


identity.requests = types.SimpleNamespace(get=fake_athena_get, RequestException=Exception)

# 企微也必须换成假的。去掉 dry_run 之后，执行端点是真的会往外发 HTTP 的 ——
# 这个文件以前只假了 datalego，靠 dry_run 短路才没打出去。
WECOM_POSTED = []


def fake_wecom_post(url, **kw):
    WECOM_POSTED.append((url, kw.get("json")))
    return FakeResp({"errcode": 0, "errmsg": "ok"})


wecom.requests = types.SimpleNamespace(post=fake_wecom_post, RequestException=Exception)

# 通用 HTTP 节点也只打假上游，同时记下完整请求供断言。
HTTP_REQUESTED = []
HTTP_FLAKY_ATTEMPTS = {}


def fake_http_request(method, url, **kw):
    HTTP_REQUESTED.append((method, url, kw))
    if url.endswith("/flaky"):
        HTTP_FLAKY_ATTEMPTS[url] = HTTP_FLAKY_ATTEMPTS.get(url, 0) + 1
        status = 503 if HTTP_FLAKY_ATTEMPTS[url] < 3 else 200
    else:
        status = 503 if url.endswith("/error-503") else 200
    payload = {"error": "temporarily unavailable"} if status == 503 else {"token": "007-token"}
    response = FakeResp(payload, status=status, url=url)
    response.headers = {"Content-Type": "application/json", "Set-Cookie": "sid=secret"}
    return response


http_request.requests = types.SimpleNamespace(
    request=fake_http_request,
    Timeout=TimeoutError,
    RequestException=Exception,
)

client = TestClient(main.app)

# ---------------------------------------------------------------- 注册表
r = client.get("/health").json()
ok("health.ok", r["ok"], True)
ok("health 没有缺凭证", r["missingCredentials"], [])

nodes = client.get("/registry/nodes").json()["nodes"]
by_type = {n["type"]: n for n in nodes}
ok("注册表上报四个节点", sorted(by_type), ["http.request", "notify.wecom", "postgres.workspace", "sql.query"])
ok("SQL 是异步节点", by_type["sql.query"]["runtime"]["kind"], "http-async")
ok("DataLego SQL 保留旧 type", by_type["sql.query"]["name"], "DataLego SQL")
ok("自建 PostgreSQL 是同步节点", by_type["postgres.workspace"]["runtime"]["kind"], "http")
ok("自建 PostgreSQL 不接受连接参数",
   sorted(by_type["postgres.workspace"]["input"]["properties"]), ["limit", "params", "sql"])
ok("企微是同步节点", by_type["notify.wecom"]["runtime"]["kind"], "http")
ok("HTTP 调用是同步真实节点", by_type["http.request"]["runtime"]["kind"], "http")
truthy("输出结构标了动态探测", by_type["sql.query"]["output"].get("x-dynamic") == "probe")
truthy("HTTP 响应结构标了运行时学习", by_type["http.request"]["output"].get("x-dynamic") == "run")
ok("HTTP 默认拒绝错误状态码",
   by_type["http.request"]["input"]["properties"]["allowHttpErrors"].get("default"), False)
ok("HTTP 请求头声明敏感键遮罩",
   by_type["http.request"]["input"]["properties"]["headers"]["x-ui"].get("sensitiveKeys"), True)
truthy("HTTP 支持独立查询参数", "query" in by_type["http.request"]["input"]["properties"])
truthy("HTTP 支持 HEAD", "HEAD" in by_type["http.request"]["input"]["properties"]["method"]["enum"])
ok("HTTP 默认校验 SSL", by_type["http.request"]["input"]["properties"]["verifySsl"].get("default"), True)
ok("HTTP 新节点默认没有请求体", by_type["http.request"]["input"]["properties"]["bodyType"].get("default"), "none")
ok("HTTP 默认不重试非幂等请求", by_type["http.request"]["input"]["properties"]["retryEnabled"].get("default"), False)
truthy("HTTP 支持连接和读取分离超时",
       all(k in by_type["http.request"]["input"]["properties"] for k in ("connectTimeoutMs", "readTimeoutMs")))
truthy("SQL 字段声明了自有占位符语法",
       by_type["sql.query"]["input"]["properties"]["sql"].get("x-placeholders") == {"valuesFrom": "params"})
# 企微：@成员字段在 markdown_v2 下要隐藏（企微不支持）
ok("markdown_v2 隐藏 @成员字段",
   by_type["notify.wecom"]["input"]["properties"]["mentioned"].get("x-hide"),
   {"msgtype": ["markdown_v2"]})
ok("不再有 dryRun 参数（调用即发送）",
   "dryRun" in by_type["notify.wecom"]["input"]["properties"], False)

# 必须有可验证的 OA 身份；绝不能退化为共享工作区。
workspace_anon = client.post("/nodes/postgres.workspace/execute", json={"params": {"sql": "SELECT 1"}})
ok("自建 PostgreSQL 缺身份 → 403", workspace_anon.status_code, 403)
ok("自建 PostgreSQL 缺身份有明确错误码",
   workspace_anon.json()["detail"]["code"], "WORKSPACE_IDENTITY")

# 企微节点的执行端点。requests 是假的，不会真打到企微
r = client.post("/nodes/notify.wecom/execute", json={"params": {
    "webhook": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcd1234efgh5678ijkl",
    "msgtype": "markdown_v2", "content": "# hi",
}})
ok("企微执行成功", r.status_code, 200)
ok("确实发出去了", r.json()["output"]["sent"], True)
ok("输出里 key 已打码", r.json()["output"]["target"], "…key=abcd***kl")
ok("真的打了一次请求", len(WECOM_POSTED), 1)

_before = len(WECOM_POSTED)
ok("非法 webhook → 400",
   client.post("/nodes/notify.wecom/execute", json={"params": {
       "webhook": "https://evil.com/send?key=x", "msgtype": "text", "content": "hi"}}).status_code, 400)
ok("非法 webhook 一个请求都不发", len(WECOM_POSTED), _before)

# HTTP 节点的执行端点。保证请求参数真实传给上游，响应也不被 mock 改写。
r = client.post("/nodes/http.request/execute", json={"params": {
    "method": "POST",
    "url": "https://athena.example/generate-007",
    "headers": {"Content-Type": "application/json", "Authorization": "Bearer test"},
    "body": '{"uid":"123"}',
    "timeoutMs": 30000,
}})
ok("HTTP 节点执行成功", r.status_code, 200)
ok("HTTP 节点返回真实 body", r.json()["output"]["body"], {"token": "007-token"})
ok("HTTP 节点返回状态码", r.json()["output"]["status"], 200)
ok("HTTP 节点返回尝试次数", r.json()["output"]["attempts"], 1)
ok("响应不持久化 Set-Cookie", "set-cookie" in r.json()["output"]["headers"], False)
method, url, request_kw = HTTP_REQUESTED[-1]
ok("请求方法透传", method, "POST")
ok("请求 URL 透传", url, "https://athena.example/generate-007")
ok("请求头透传", request_kw["headers"]["Authorization"], "Bearer test")
ok("请求体按 UTF-8 原样发送", request_kw["data"], b'{"uid":"123"}')
ok("超时转成秒", request_kw["timeout"], 30.0)
ok("默认校验 SSL", request_kw["verify"], True)
ok("没有查询参数时传空对象", request_kw["params"], {})

r = client.post("/nodes/http.request/execute", json={"params": {
    "method": "HEAD",
    "url": "https://athena.example/resource",
    "query": {"uid": "123", "scope": "rtc"},
    "authType": "bearer",
    "bearerToken": "generated-test-token",
    "headers": {"authorization": "old-value"},
    "verifySsl": False,
}})
ok("HEAD + Bearer 请求成功", r.status_code, 200)
method, _, request_kw = HTTP_REQUESTED[-1]
ok("HEAD 方法透传", method, "HEAD")
ok("查询参数独立透传", request_kw["params"], {"uid": "123", "scope": "rtc"})
ok("Bearer 覆盖已有同名请求头", request_kw["headers"], {"Authorization": "Bearer generated-test-token"})
ok("可关闭 SSL 校验", request_kw["verify"], False)

r = client.post("/nodes/http.request/execute", json={"params": {
    "method": "POST", "url": "https://athena.example/form",
    "authType": "basic", "basicUsername": "user", "basicPassword": "pass",
    "bodyType": "form-urlencoded", "formBody": {"uid": "123", "role": "publisher"},
}})
ok("Basic + 表单请求成功", r.status_code, 200)
_, _, request_kw = HTTP_REQUESTED[-1]
ok("Basic Auth 编码正确", request_kw["headers"]["Authorization"], "Basic dXNlcjpwYXNz")
ok("表单 Content-Type 自动补齐", request_kw["headers"]["Content-Type"], "application/x-www-form-urlencoded")
ok("表单字段交给 HTTP 客户端编码", request_kw["data"], {"uid": "123", "role": "publisher"})

r = client.post("/nodes/http.request/execute", json={"params": {
    "method": "POST", "url": "https://athena.example/json",
    "bodyType": "json", "body": '{"uid":"123"}',
}})
ok("JSON 请求成功", r.status_code, 200)
_, _, request_kw = HTTP_REQUESTED[-1]
ok("JSON Content-Type 自动补齐", request_kw["headers"]["Content-Type"], "application/json")
ok("JSON 保留用户原始字节", request_kw["data"], b'{"uid":"123"}')

_before = len(HTTP_REQUESTED)
bad_json = client.post("/nodes/http.request/execute", json={"params": {
    "method": "POST", "url": "https://athena.example/json", "bodyType": "json", "body": "{bad",
}})
ok("非法 JSON 请求体返回 400", bad_json.status_code, 400)
ok("非法 JSON 不发请求", len(HTTP_REQUESTED), _before)

r = client.post("/nodes/http.request/execute", json={"params": {
    "method": "GET", "url": "https://athena.example/flaky",
    "connectTimeoutMs": 1500, "readTimeoutMs": 4500,
    "retryEnabled": True, "maxRetries": 2, "retryIntervalMs": 0,
}})
ok("可重试状态最终成功", r.status_code, 200)
ok("返回真实尝试次数", r.json()["output"]["attempts"], 3)
ok("分离超时按 requests 元组传递", HTTP_REQUESTED[-1][2]["timeout"], (1.5, 4.5))
ok("可重试状态实际请求三次", HTTP_FLAKY_ATTEMPTS["https://athena.example/flaky"], 3)

failed_status = client.post("/nodes/http.request/execute", json={"params": {
    "method": "GET", "url": "https://athena.example/error-503",
}})
ok("上游 5xx 默认让节点失败", failed_status.status_code, 502)
truthy("5xx 错误包含状态码和响应摘要",
       "HTTP 503" in failed_status.json()["detail"] and "temporarily unavailable" in failed_status.json()["detail"])

accepted_status = client.post("/nodes/http.request/execute", json={"params": {
    "method": "GET", "url": "https://athena.example/error-503", "allowHttpErrors": True,
}})
ok("允许错误状态码时执行成功", accepted_status.status_code, 200)
ok("允许后保留真实状态码", accepted_status.json()["output"]["status"], 503)
ok("允许后保留错误响应体", accepted_status.json()["output"]["body"], {"error": "temporarily unavailable"})

_before = len(HTTP_REQUESTED)
bad_http = client.post("/nodes/http.request/execute", json={"params": {
    "method": "GET", "url": "file:///etc/passwd",
}})
ok("非 HTTP URL → 400", bad_http.status_code, 400)
ok("非法 URL 不发请求", len(HTTP_REQUESTED), _before)

opts = client.get("/options/sql.engines").json()["options"]
ok("引擎选项", [o["value"] for o in opts], ["hive", "doris", "clickhouse"])
ok("未知选项集 404", client.get("/options/nope").status_code, 404)

# ---------------------------------------------------------------- 提交
resp = client.post("/nodes/sql.query/submit", json={"params": {
    "engine": "hive",
    "sql": "SELECT vid, name FROM ods.vendor WHERE vid = :vid",
    "params": {"vid": 88031},
    "limit": 500,
}})
ok("submit 成功", resp.status_code, 200)
handle = resp.json()["handle"]
truthy("拿到 handle", handle)
ok("占位符已渲染且套了 LIMIT",
   SUBMITTED[-1]["sql"],
   "SELECT * FROM (\nSELECT vid, name FROM ods.vendor WHERE vid = 88031\n) AS __wf_limited LIMIT 500")
ok("引擎透传", SUBMITTED[-1]["engine"], "hive")
ok("没有登录态就不带 creator（= 用机器人账号的权限）", SUBMITTED[-1]["_query"], {})

# ------------------------------------------------- creator 只认 Athena 验证结果，不认参数
#
# 这两条是权限隔离的全部依据，错一条就是越权：
#   1. Athena 验证的邮箱要真的发出去；
#   2. 请求体里带的 creator 一律无视 —— 那是编流程的人能随手改的字符串。
_COOKIE = {"HCIAuthToken": "opaque-session"}

client.post("/nodes/sql.query/submit", json={"params": {
    "engine": "hive", "sql": "SELECT 1", "params": {},
}}, cookies=_COOKIE)
ok("Athena 验证的邮箱作为 creator 发给平台", SUBMITTED[-1]["_query"], {"creator": _ATHENA_EMAIL})
ok("Cookie 仅透传给固定 Athena 地址", ATHENA_CALLS[-1][0], identity.ATHENA_ME_URL)
ok("Cookie 透传不丢失", "HCIAuthToken=opaque-session" in ATHENA_CALLS[-1][1]["headers"]["Cookie"], True)
ok("Athena 调用使用短超时且禁止跳转",
   (ATHENA_CALLS[-1][1]["timeout"], ATHENA_CALLS[-1][1]["allow_redirects"]),
   (identity.ATHENA_ME_TIMEOUT_SECONDS, False))

client.post("/nodes/sql.query/submit", json={"params": {
    "engine": "hive", "sql": "SELECT 1", "params": {},
    "creator": "someone.else@agora.io",
}}, cookies=_COOKIE)
ok("参数里的 creator 被无视，以 Athena 为准", SUBMITTED[-1]["_query"], {"creator": _ATHENA_EMAIL})

client.post("/nodes/sql.query/submit", json={"params": {
    "engine": "hive", "sql": "SELECT 1", "params": {},
    "creator": "someone.else@agora.io",
}})
ok("没登录态时参数里的 creator 也不认", SUBMITTED[-1]["_query"], {})

# ---------------------------------------------- worker 代提交：定时任务用发布者的名义
#
# 定时和 webhook 触发时浏览器不在场，没有 cookie。身份来自发布者，由 worker 从库里
# 读出来带过来。**这个头必须验密钥**：不验的话任何人加一个头就能以别人的权限查数。
_PUBLISHER = {"X-Run-Creator": "publisher@agora.io", "X-Worker-Token": "s3cret"}

client.post("/nodes/sql.query/submit", json={"params": {
    "engine": "hive", "sql": "SELECT 1", "params": {},
}}, headers=_PUBLISHER)
ok("没配 WORKER_TOKEN 时代提交的头一律不认（fail closed）", SUBMITTED[-1]["_query"], {})

os.environ["WORKER_TOKEN"] = "s3cret"
try:
    client.post("/nodes/sql.query/submit", json={"params": {
        "engine": "hive", "sql": "SELECT 1", "params": {},
    }}, headers=_PUBLISHER)
    ok("密钥对上了才以发布者的名义提交", SUBMITTED[-1]["_query"], {"creator": "publisher@agora.io"})

    client.post("/nodes/sql.query/submit", json={"params": {
        "engine": "hive", "sql": "SELECT 1", "params": {},
    }}, headers={**_PUBLISHER, "X-Worker-Token": "wrong"})
    ok("密钥不对就当没这个头", SUBMITTED[-1]["_query"], {})

    client.post("/nodes/sql.query/submit", json={"params": {
        "engine": "hive", "sql": "SELECT 1", "params": {},
    }}, headers={**_PUBLISHER, "X-Run-Creator": "not-an-email"}, )
    ok("发布记录里不是邮箱就不带（老版本存的是用户名）", SUBMITTED[-1]["_query"], {})

    # 人在场时 Athena 为准：worker 的头只在没有浏览器登录态时才轮得到
    client.post("/nodes/sql.query/submit", json={"params": {
        "engine": "hive", "sql": "SELECT 1", "params": {},
    }}, headers=_PUBLISHER, cookies=_COOKIE)
    ok("有登录 cookie 时以 Athena 用户为准", SUBMITTED[-1]["_query"], {"creator": _ATHENA_EMAIL})

    # 不透明 Cookie 可以长得像伪造 JWT，但 Athena 拒绝后不能信它，也不能
    # 因为同时携带 Worker 头而绕过浏览器身份校验。
    rejected = {"HCIAuthToken": "rejected-session.payload.claiming-admin"}
    client.post("/nodes/sql.query/submit", json={"params": {
        "engine": "hive", "sql": "SELECT 1", "params": {},
    }}, headers=_PUBLISHER, cookies=rejected)
    ok("Athena 拒绝的 Cookie 不会成为 creator 或回退 Worker", SUBMITTED[-1]["_query"], {})

    malformed = {"HCIAuthToken": "malformed-session"}
    client.post("/nodes/sql.query/submit", json={"params": {
        "engine": "hive", "sql": "SELECT 1", "params": {},
    }}, cookies=malformed)
    ok("Athena 异常响应不会成为 creator", SUBMITTED[-1]["_query"], {})
finally:
    os.environ.pop("WORKER_TOKEN", None)

_who = client.get("/whoami", cookies=_COOKIE).json()
ok("whoami 报告 Athena 用户", (_who["creator"], _who["source"]), (_ATHENA_EMAIL, "athena"))
ok("whoami 返回经验证的用户资料", _who["user"], {
    "id": _ATHENA_EMAIL, "email": _ATHENA_EMAIL, "displayName": "Zhao Jiwei",
    "permissions": [], "isAdmin": True,
})
truthy("认不出身份时 whoami 说清后果", client.get("/whoami").json()["note"])
ok("节点参数里不再有 creator 输入框",
   "creator" in manifest.SQL_QUERY["input"]["properties"], False)

# ---------------------------------------------------------------- 轮询
first = client.get(f"/nodes/sql.query/poll?handle={handle}&limit=500").json()
ok("进度到 100 但没 schema 时仍是未完成", first["done"], False)

second = client.get(f"/nodes/sql.query/poll?handle={handle}&limit=500").json()
ok("第二次完成", second["done"], True)
ok("行数", second["output"]["rowCount"], 2)
ok("行转成了对象", second["output"]["rows"][0], {"vid": 88031, "name": "acme"})
ok("列信息带类型", second["output"]["columns"][0], {"name": "vid", "type": "bigint"})
ok("没到上限不算截断", second["output"]["truncated"], False)

# ---------------------------------------------------------------- 截断标记
ok("行数顶到上限即标截断",
   client.get(f"/nodes/sql.query/poll?handle={handle}&limit=2").json()["output"]["truncated"], True)

# ---------------------------------------------------------------- 探测
resp = client.post("/nodes/sql.query/probe", json={"params": {
    "engine": "hive", "sql": "SELECT * FROM t", "params": {}, "limit": 9999,
}})
ok("probe 成功", resp.status_code, 200)
ok("probe 强制 LIMIT 1（不受节点 limit 影响）",
   SUBMITTED[-1]["sql"], "SELECT * FROM (\nSELECT * FROM t\n) AS __wf_limited LIMIT 1")

# ---------------------------------------------------------------- 参数错误
def detail_text(resp):
    """错误报文。服务端现在返回 {code, retryable, message}，老格式是字符串。

    引擎靠 code 判定重试（不再匹配中文串），人靠 message 看懂发生了什么。
    """
    d = resp.json()["detail"]
    return d["message"] if isinstance(d, dict) else d


def detail_code(resp):
    d = resp.json()["detail"]
    return d.get("code") if isinstance(d, dict) else None


bad = client.post("/nodes/sql.query/submit", json={"params": {
    "sql": "SELECT :a, :b", "params": {"a": 1},
}})
ok("缺参数 → 400", bad.status_code, 400)
truthy("错误里点名了缺哪个", ":b" in detail_text(bad))
ok("参数错的 code 是 SQL_PARAM_ERROR（引擎据此判定不重试）", detail_code(bad), "SQL_PARAM_ERROR")

bad = client.post("/nodes/sql.query/submit", json={"params": {
    "sql": "DROP TABLE t", "params": {},
}})
ok("写操作 → 400", bad.status_code, 400)
truthy("说清只读限制", "只读" in detail_text(bad))

bad = client.post("/nodes/sql.query/submit", json={"params": {
    "sql": "SELECT 1", "params": {}, "engine": "mysql",
}})
ok("未知引擎 → 400", bad.status_code, 400)

# ---------------------------------------------------------------- 失效 / 取消
gone = client.get("/nodes/sql.query/poll?handle=job_99999999")
ok("结果被清理 → 410", gone.status_code, 410)

ok("非法 handle 不拼进 URL", client.get("/nodes/sql.query/poll?handle=../../etc").status_code, 400)

ok("取消", client.post("/nodes/sql.query/cancel", json={"handle": handle}).json()["cancelled"], True)
truthy("取消请求确实发给了平台", handle in CANCELLED)

for name, got, want in FAIL:
    print(f"✗ {name}\n    实际: {got!r}\n    期望: {want!r}")
print(f"\n{len(PASS)} 通过, {len(FAIL)} 失败")
sys.exit(1 if FAIL else 0)
