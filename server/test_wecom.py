"""企微节点的测试。不发真实消息 —— requests 全部换成假的。

    cd server && python3 test_wecom.py
"""
import sys
import types

from sql_service import wecom
from sql_service.wecom import WecomError, build_payload, mask, parse_webhook, send

OK_URL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcd1234efgh5678ijkl"

PASS, FAIL = [], []


def ok(name, got, want):
    (PASS if got == want else FAIL).append((name, got, want))


def raises(name, fn, fragment=""):
    try:
        fn()
    except WecomError as exc:
        if fragment and fragment not in str(exc):
            FAIL.append((name, f"报错但内容不符: {exc}", f"包含 {fragment!r}"))
        else:
            PASS.append((name, "raised", "raised"))
    except Exception as exc:  # noqa: BLE001
        FAIL.append((name, f"抛了 {type(exc).__name__}: {exc}", "WecomError"))
    else:
        FAIL.append((name, "没有报错", "WecomError"))


# ---------------------------------------------------------------- 地址校验
ok("合法地址取出 key", parse_webhook(OK_URL), "abcd1234efgh5678ijkl")
raises("空地址被拒", lambda: parse_webhook(""), "没填")
raises("别的域名被拒", lambda: parse_webhook("https://evil.com/send?key=abcd1234efgh5678ijkl"), "不是合法")
raises("缺 key 被拒", lambda: parse_webhook("https://qyapi.weixin.qq.com/cgi-bin/webhook/send"), "不是合法")
ok("打码只露头尾", mask(OK_URL), "…key=abcd***kl")
ok("非法地址打码不炸", mask("garbage"), "(未填)")

# ---------------------------------------------------------------- 消息体
ok("markdown_v2 请求体",
   build_payload("markdown_v2", "# hi"),
   {"msgtype": "markdown_v2", "markdown_v2": {"content": "# hi"}})
ok("text 请求体", build_payload("text", "hi"), {"msgtype": "text", "text": {"content": "hi"}})
raises("未知类型被拒", lambda: build_payload("card", "x"), "不支持的消息类型")
raises("空内容被拒", lambda: build_payload("text", "   "), "为空")

# ---------------------------------------------------------------- 字节上限（不是字符数）
raises("text 超 2048 字节被拒", lambda: build_payload("text", "x" * 2049), "2048")
# 中文一个字 3 字节：683 字 = 2049 字节，按字符数算会漏过去
raises("中文按字节算不按字符算", lambda: build_payload("text", "中" * 683), "2048")
ok("682 个中文（2046 字节）放行",
   build_payload("text", "中" * 682)["text"]["content"][:1], "中")
ok("markdown 上限更宽（4096）",
   build_payload("markdown", "x" * 4096)["markdown"]["content"][-1:], "x")

# ---------------------------------------------------------------- @成员
p = build_payload("text", "hi", ["zhangsan", "13800001111"])
ok("text 的 userid 进 mentioned_list", p["text"]["mentioned_list"], ["zhangsan"])
ok("text 的手机号进 mentioned_mobile_list", p["text"]["mentioned_mobile_list"], ["13800001111"])
ok("markdown 的 @ 写进正文",
   build_payload("markdown", "hi", ["zhangsan"])["markdown"]["content"], "hi\n<@zhangsan>")
raises("markdown_v2 不支持 @（企微限制）",
       lambda: build_payload("markdown_v2", "hi", ["zhangsan"]), "不支持 @成员")

# ---------------------------------------------------------------- 真实发送（假 requests）
posted = []


class FakeResp:
    def __init__(self, payload):
        self._p, self.status_code, self.text = payload, 200, str(payload)

    def json(self):
        return self._p


def fake_post(url, **kw):
    posted.append((url, kw.get("json")))
    return FakeResp({"errcode": 0, "errmsg": "ok"})


wecom.requests = types.SimpleNamespace(post=fake_post, RequestException=Exception)

r = send(OK_URL, "markdown_v2", "hello")
ok("调用即发送", r["sent"], True)
ok("打到了企微地址", posted[-1][0], OK_URL)
ok("请求体正确", posted[-1][1], {"msgtype": "markdown_v2", "markdown_v2": {"content": "hello"}})
ok("成功结果里不含完整 key", "abcd1234efgh5678ijkl" in str(r), False)
ok("结果里不再有 dryRun 字段", "dryRun" in r, False)
# 地址不合法必须在打出去之前就拦下来
before = len(posted)
raises("非法地址不发送", lambda: send("nope", "text", "hi"), "不是合法")
ok("非法地址确实一个请求都没发", len(posted), before)


def fake_post_err(url, **kw):
    return FakeResp({"errcode": 93000, "errmsg": "invalid webhook url"})


wecom.requests = types.SimpleNamespace(post=fake_post_err, RequestException=Exception)
raises("企微 errcode 非 0 要报错（它 HTTP 也返回 200）",
       lambda: send(OK_URL, "text", "hi"), "93000")

# ---------------------------------------------------------------- 限流
wecom.requests = types.SimpleNamespace(post=fake_post, RequestException=Exception)
wecom._sent.clear()
for i in range(wecom.RATE_LIMIT):
    send(OK_URL, "text", f"msg {i}")
raises("超过 20 条/分钟被本地挡下", lambda: send(OK_URL, "text", "第 21 条"), "20 条/分钟")

for name, got, want in FAIL:
    print(f"✗ {name}\n    实际: {got!r}\n    期望: {want!r}")
print(f"\n{len(PASS)} 通过, {len(FAIL)} 失败")
sys.exit(1 if FAIL else 0)
