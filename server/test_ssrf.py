"""http.request 节点的出网防护测试。

    cd server && .venv/bin/python test_ssrf.py

这层是安全边界：服务端目前没有任何认证，而这个进程同时持有数据平台机器人票
和企微 webhook 地址。没有它，任何能打开编辑器的人都能让服务去打内网任意地址。
"""
import ipaddress
import os
import sys

import requests

from sql_service import http_request as h
from sql_service.http_request import HttpRequestError

PASS, FAIL = [], []


def ok(name, got, want):
    (PASS if got == want else FAIL).append((name, got, want))


def blocks(name, fn, fragment=""):
    try:
        fn()
    except HttpRequestError as exc:
        if fragment and fragment not in str(exc):
            FAIL.append((name, f"拦了但内容不符: {exc}", f"包含 {fragment!r}"))
        else:
            PASS.append((name, "blocked", "blocked"))
    except Exception as exc:  # noqa: BLE001
        FAIL.append((name, f"抛了 {type(exc).__name__}: {exc}", "HttpRequestError"))
    else:
        FAIL.append((name, "放行了", "HttpRequestError"))


def allows(name, fn):
    try:
        fn()
    except Exception as exc:  # noqa: BLE001
        FAIL.append((name, f"被拦: {exc}", "放行"))
    else:
        PASS.append((name, "allowed", "allowed"))


# ---------------------------------------------------------------- IP 分类

def is_public(s):
    return h._is_public_ip(ipaddress.ip_address(s))


for addr in ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "0.0.0.0",
             "::1", "fc00::1", "fe80::1"]:
    ok(f"{addr} 被拦", is_public(addr), False)

# 云元数据地址 —— SSRF 最主要的目标
ok("169.254.169.254（云元数据）被拦", is_public("169.254.169.254"), False)

# IPv4-mapped IPv6：不还原成 v4 的话一条网段都匹配不上，等于绕过全部检查
ok("::ffff:127.0.0.1 被拦", is_public("::ffff:127.0.0.1"), False)
ok("::ffff:169.254.169.254 被拦", is_public("::ffff:169.254.169.254"), False)

ok("公网地址放行", is_public("8.8.8.8"), True)

# 198.18.0.0/15 是 RFC2544 基准测试段，ipaddress.is_private 认它是内网。
# Zscaler/AnyConnect 这类代理型 DNS 把所有外部域名解析到这一段 —— 用 is_private
# 判会把企微 webhook 一起拦掉，一个安全修复变成"所有出网都不通"。
ok("198.18/15 不拦（代理型 DNS 会解析到这里）", is_public("198.18.4.216"), True)

# ---------------------------------------------------------------- URL 校验

blocks("回环地址被拦", lambda: h._check_destination("http://127.0.0.1/x"), "内网")
blocks("元数据地址被拦", lambda: h._check_destination("http://169.254.169.254/latest/meta-data/"), "内网")
blocks("localhost 被拦", lambda: h._check_destination("http://localhost:8791/health"), "内网")
blocks("v6 回环被拦", lambda: h._check_destination("http://[::1]/x"), "内网")

blocks("非 http(s) 协议被拒", lambda: h._url("file:///etc/passwd"), "http")
blocks("URL 里带凭证被拒", lambda: h._url("http://u:p@example.com/"), "用户名")

# ---------------------------------------------------------------- 白名单

os.environ["HTTP_NODE_ALLOWED_HOSTS"] = "internal.corp, 127.0.0.1"
allows("白名单里的内网主机放行", lambda: h._check_destination("http://127.0.0.1/x"))
blocks("设了白名单后，没列出的主机一律拒绝",
       lambda: h._check_destination("https://example.com/"), "白名单")
del os.environ["HTTP_NODE_ALLOWED_HOSTS"]

# ---------------------------------------------------------------- 重定向

class FakeResponse:
    def __init__(self, status, location=None):
        self.status_code = status
        self.headers = {"location": location} if location else {}
        self.content = b""
        self.text = ""
        self.url = ""

    def close(self):
        pass


def fake_upstream(script):
    """按脚本依次返回响应，并把每次调用记下来。"""
    calls = []

    def request(method, url, **kw):
        calls.append({"method": method, "url": url, **kw})
        return script[len(calls) - 1]

    return request, calls


def with_fake(script, fn):
    real = requests.request
    request, calls = fake_upstream(script)
    requests.request = request
    try:
        result = fn()
        return result, calls
    finally:
        requests.request = real


def send(url, method="GET", headers=None, body=None):
    return h._send(method, url, headers=headers or {}, query={}, body=body,
                   timeout=1, verify=True)


os.environ["HTTP_NODE_ALLOWED_HOSTS"] = "a.test b.test"

# 跨主机跳转必须剥掉 Authorization：requests 自动跳转时会做这件事，
# 改成手动跳转后必须自己补上，否则恶意跳转能直接把 token 收走
_, calls = with_fake(
    [FakeResponse(302, "http://b.test/next"), FakeResponse(200)],
    lambda: send("http://a.test/start", headers={"Authorization": "Bearer secret"}),
)
ok("跨主机跳转发了两跳", len(calls), 2)
ok("第一跳带 Authorization", "Authorization" in calls[0]["headers"], True)
ok("跨主机跳转剥掉 Authorization", "Authorization" in calls[1]["headers"], False)
ok("跳转不再重复拼查询参数", calls[1]["params"], None)
ok("全程 allow_redirects=False", [c["allow_redirects"] for c in calls], [False, False])

# 同主机跳转保留 Authorization
_, calls = with_fake(
    [FakeResponse(302, "http://a.test/next"), FakeResponse(200)],
    lambda: send("http://a.test/start", headers={"Authorization": "Bearer secret"}),
)
ok("同主机跳转保留 Authorization", "Authorization" in calls[1]["headers"], True)

# 303、以及 301/302 遇到非 GET，按惯例降级成 GET 并丢掉请求体
_, calls = with_fake(
    [FakeResponse(303, "http://a.test/next"), FakeResponse(200)],
    lambda: send("http://a.test/start", method="POST", body=b"payload"),
)
ok("303 降级成 GET", calls[1]["method"], "GET")
ok("303 丢掉请求体", calls[1]["data"], None)

# 307 保留方法和请求体
_, calls = with_fake(
    [FakeResponse(307, "http://a.test/next"), FakeResponse(200)],
    lambda: send("http://a.test/start", method="POST", body=b"payload"),
)
ok("307 保留方法", calls[1]["method"], "POST")
ok("307 保留请求体", calls[1]["data"], b"payload")

# 跳转链过长要有上限，不能无限跟
blocks(
    "超过跳转上限报错",
    lambda: with_fake(
        [FakeResponse(302, "http://a.test/loop")] * (h.MAX_REDIRECTS + 1),
        lambda: send("http://a.test/start"),
    ),
    "重定向次数",
)

# ★ 核心：跳转目标也要过校验。只校验第一跳等于没校验 ——
# 一个指向 169.254.169.254 的 302 就能绕过全部检查
blocks(
    "跳转到未授权主机被拦",
    lambda: with_fake(
        [FakeResponse(302, "http://169.254.169.254/latest/meta-data/")],
        lambda: send("http://a.test/start"),
    ),
    "白名单",
)

del os.environ["HTTP_NODE_ALLOWED_HOSTS"]

# ---------------------------------------------------------------- 结果

for name, got, want in FAIL:
    print(f"✗ {name}\n    实际: {got!r}\n    期望: {want!r}")
print(f"\n{len(PASS)} 通过, {len(FAIL)} 失败")
sys.exit(1 if FAIL else 0)
