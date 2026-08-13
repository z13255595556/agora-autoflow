"""企微群机器人推送。

节点参数里直接填 webhook 地址。注意它等同于凭证 —— 拿到的人就能往群里发，
而它会随流程定义一起导出、入库。所以流程 JSON 要当凭证管。

节点**输出**里的 webhook 会打码：运行记录会被截图、贴群、进工单，没必要
在那里再复制一份完整的 key。

三种消息类型的能力不一样（官方文档 developer.work.weixin.qq.com/document/path/99110）：

    text         2048 字节  支持 @成员            不支持任何 markdown
    markdown     4096 字节  支持 @成员、字体颜色  **不支持表格、列表**
    markdown_v2  4096 字节  **支持表格、列表**    不支持 @成员、不支持字体颜色

要发查询结果表格就得用 markdown_v2，但那样 @不到人 —— 这是企微的限制。
"""
import re
import threading
import time
from collections import deque
from typing import Any, Dict, List, Optional

import requests

HTTP_TIMEOUT = 15

# 官方限制：单个机器人 20 条/分钟
RATE_LIMIT = 20
RATE_WINDOW = 60

MSGTYPES = ("text", "markdown", "markdown_v2")
MAX_BYTES = {"text": 2048, "markdown": 4096, "markdown_v2": 4096}
# @成员只有 text 和 markdown 支持，markdown_v2 明确不支持
MENTION_SUPPORTED = ("text", "markdown")

WEBHOOK_RE = re.compile(
    r"^https://qyapi\.weixin\.qq\.com/cgi-bin/webhook/send\?key=(?P<key>[\w-]{16,})$"
)


class WecomError(RuntimeError):
    """发送失败。调用方能看懂、能改的错。"""


_lock = threading.Lock()
_sent: Dict[str, deque] = {}


def parse_webhook(url: str) -> str:
    """校验地址并取出 key。地址配错会把消息发到不知道哪里去，宁可拒绝。"""
    url = (url or "").strip()
    if not url:
        raise WecomError("没填 webhook 地址")
    m = WEBHOOK_RE.match(url)
    if not m:
        raise WecomError(
            "不是合法的企微 webhook 地址，应形如 "
            "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx"
        )
    return m.group("key")


def mask(url: str) -> str:
    """把 key 打码后回显。运行记录会被截图外传，不该在那里留完整 key。"""
    m = WEBHOOK_RE.match((url or "").strip())
    if not m:
        return "(未填)"
    key = m.group("key")
    return f"…key={key[:4]}***{key[-2:]}"


def _check_rate(key: str) -> None:
    now = time.time()
    with _lock:
        q = _sent.setdefault(key, deque())
        while q and now - q[0] > RATE_WINDOW:
            q.popleft()
        if len(q) >= RATE_LIMIT:
            wait = int(RATE_WINDOW - (now - q[0])) + 1
            raise WecomError(
                f"这个机器人 1 分钟内已经发了 {len(q)} 条（企微上限 {RATE_LIMIT} 条/分钟），"
                f"{wait} 秒后再试"
            )
        q.append(now)


def build_payload(
    msgtype: str,
    content: str,
    mentioned: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """拼请求体，顺便把企微的各种限制在本地先挡掉。"""
    if msgtype not in MSGTYPES:
        raise WecomError(f"不支持的消息类型 {msgtype!r}，可选：{'、'.join(MSGTYPES)}")
    if not content.strip():
        raise WecomError("消息内容为空")

    # 限制是**字节**不是字符 —— 中文一个字 3 字节，按字符数算会超
    size = len(content.encode("utf-8"))
    limit = MAX_BYTES[msgtype]
    if size > limit:
        raise WecomError(
            f"内容 {size} 字节，超过 {msgtype} 的 {limit} 字节上限。"
            f"把明细换成 | count 只报条数，或改用报告节点出链接"
        )

    body: Dict[str, Any] = {"msgtype": msgtype, msgtype: {"content": content}}

    mentioned = [m for m in (mentioned or []) if m.strip()]
    if mentioned:
        if msgtype not in MENTION_SUPPORTED:
            raise WecomError(f"{msgtype} 不支持 @成员（企微限制）。要 @人请用 text 或 markdown")
        if msgtype == "text":
            # 手机号和 userid 分开放，看着像手机号的走 mobile 列表
            body["text"]["mentioned_mobile_list"] = [
                m for m in mentioned if re.fullmatch(r"\d{11}", m) or m == "@all"
            ]
            body["text"]["mentioned_list"] = [m for m in mentioned if not re.fullmatch(r"\d{11}", m)]
        else:
            # markdown 的 @ 是写在正文里的 <@userid>
            body["markdown"]["content"] = content + "\n" + " ".join(f"<@{m}>" for m in mentioned)
    return body


def send(
    webhook: str,
    msgtype: str,
    content: str,
    mentioned: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """发一条，真发。

    以前有个 dry_run 只渲染不发送，用来防止调格式时把群刷屏。现在编辑器里
    有实时预览（同一个渲染器渲染出成品 + 字节数），"看看长什么样"不再需要
    发一次，所以这个开关去掉了。**调用即发送**，限流仍是最后一道闸。
    """
    payload = build_payload(msgtype, content, mentioned)
    key = parse_webhook(webhook)

    base = {
        "target": mask(webhook),
        "msgtype": msgtype,
        "bytes": len(content.encode("utf-8")),
    }

    _check_rate(key)
    try:
        resp = requests.post(webhook.strip(), json=payload, timeout=HTTP_TIMEOUT)
    except requests.RequestException as exc:
        raise WecomError(f"连不上企微：{exc}")

    try:
        result = resp.json()
    except ValueError:
        raise WecomError(f"企微返回了非 JSON（HTTP {resp.status_code}）：{resp.text[:200]}")

    # 企微失败时也返回 HTTP 200，错在 errcode 里
    if result.get("errcode") != 0:
        raise WecomError(
            f"企微拒绝了这条消息（errcode={result.get('errcode')}）：{result.get('errmsg')}"
        )

    return {**base, "sent": True}
