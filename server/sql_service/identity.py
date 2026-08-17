"""这次查询以谁的身份提交给数据平台。

`creator` **决定数据权限**（平台按这个人的授权裁决能不能查这张表），不是署名。
所以它有两条铁律：

1. **只能由服务端从登录态里解出来，绝不能来自请求体。** 节点参数是编流程的人
   随手填的一个字符串，信它等于让任何人以任何人的权限查数 —— 那不是隔离，
   是一条现成的提权路径。曾经 manifest 里有个「记账邮箱」输入框，就是这个东西，
   已经去掉了。
2. **解不出来就不带。** 不带 = 用机器人账号自己的权限（平台的既有行为），
   而不是猜一个邮箱填进去。猜错的后果是"以别人的名义查数"，比查不到严重得多。

身份来源是 athena 的 `HCIAuthToken` cookie —— 一个 JWT，我们**不验签**：
我们不是签发方，只是从这个 base64 信封里读个邮箱。副作用是过期的 cookie
一样能读出身份，这正合适：过期的是里面那张票，不是那个人。

**别用 `accessToken` 那个 cookie。** 它是某次登录留下的副本，之后不再续期，
几小时后必然过期。活的登录态只在 `HCIAuthToken` 里。

与 `_actor()` 的分工：那个读的是反向代理注入的 `X-Forwarded-User`（basic auth
的用户名），只进审计表，回答"谁改的流程"。**两者不可互换** —— 一个是用户名
不是邮箱，数据平台不认；而且审计写错了是记录不准，权限用错了是越权。
"""
import base64
import binascii
import hmac
import json
import os
import re
from http.cookies import SimpleCookie
from typing import Optional

from fastapi import Request

JWT_COOKIE = os.getenv("ATHENA_JWT_COOKIE", "HCIAuthToken")
EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,64}$")


def _env(name: str) -> Optional[str]:
    return (os.getenv(name, "") or "").strip() or None


def _cookie(cookie_header: str, name: str) -> Optional[str]:
    jar = SimpleCookie()
    try:
        jar.load(cookie_header)
    except Exception:  # noqa: BLE001 —— cookie 是外部输入，怎么坏都不该 500
        return None
    morsel = jar.get(name)
    return morsel.value if morsel and morsel.value else None


def _jwt_payload(token: str) -> Optional[dict]:
    """解出 JWT 的 payload，不验签。理由见模块开头。"""
    parts = token.split(".")
    if len(parts) != 3:
        return None
    try:
        # JWT 用无填充的 urlsafe base64，补齐再解
        raw = base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4))
        data = json.loads(raw)
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


def email_from_cookie(cookie_header: str) -> Optional[str]:
    """从 HCIAuthToken 里读邮箱。**过期的 cookie 一样读得出来。**"""
    if not cookie_header:
        return None
    jwt = _cookie(cookie_header, JWT_COOKIE)
    if not jwt:
        return None
    user = (_jwt_payload(jwt) or {}).get("user")
    if isinstance(user, dict):
        candidate = user.get("email") or user.get("id")
        if isinstance(candidate, str) and EMAIL_RE.match(candidate):
            return candidate
    return None


def creator_for(request: Optional[Request]) -> Optional[str]:
    """这次查询用谁的权限。认不出返回 None（= 用机器人账号自己的权限）。

    优先级：请求自带 cookie > worker 代提交 > DEV_COOKIE > DATALEGO_USER。

    最后两个是**本地调试用**的：本机没有 athena 的 cookie，不给个口子就没法
    对着真实平台试。生产必须留空 —— 配上 DATALEGO_USER 之后所有人都以那一个
    人的权限查数，隔离就整个没有了，而且从界面上完全看不出来。
    """
    cookie_header = ""
    if request is not None:
        cookie_header = request.headers.get("cookie") or ""
    return (
        email_from_cookie(cookie_header)
        or delegated_creator(request)
        or email_from_cookie(_env("DEV_COOKIE") or "")
        or _env("DATALEGO_USER")
    )


def delegated_creator(request: Optional[Request]) -> Optional[str]:
    """worker 代跑时，以谁的名义提交。

    定时和 webhook 触发的运行没有登录用户 —— 浏览器根本不在场。这时身份来自
    **发布者**（flow_versions.created_by）：谁把这一版发上线，就以谁的名义跑。
    worker 从库里读出来，通过 X-Run-Creator 带过来。

    **这个头必须验密钥才能认。** 不验的话，任何能打到 /nodes/* 的人加一个头
    就能以任意邮箱查数 —— 那比没有隔离更糟，因为界面上看着是隔离的。
    没配 WORKER_TOKEN 就一律不认（fail closed）：宁可定时任务退回机器人权限，
    也不能留一个"配漏了就等于敞开"的开关。
    """
    if request is None:
        return None
    secret = _env("WORKER_TOKEN")
    if not secret:
        return None
    # compare_digest 而不是 == ：这是密钥比较，不给计时攻击留缝
    presented = request.headers.get("x-worker-token") or ""
    if not hmac.compare_digest(presented, secret):
        return None
    email = (request.headers.get("x-run-creator") or "").strip()
    # 老版本发布记录里存的可能是 basic auth 用户名而不是邮箱，数据平台不认，
    # 与其发出去被拒，不如不带（退回机器人账号的权限）
    return email if EMAIL_RE.match(email) else None


def user_for(request: Optional[Request], forwarded_user: Optional[str] = None) -> Optional[str]:
    """当前操作者是谁 —— 流程归属和审计都用它。

    邮箱优先，取不到才回退反向代理注入的用户名（`X-Forwarded-User`）。
    两者形态不同（邮箱 / 用户名），所以 owner 列里可能两种都有，取决于部署 ——
    这是刻意的折中：只认邮箱的话，没接 athena SSO 的部署会连流程都建不了。

    **都取不到就是 None，也就是匿名。** 匿名不是一个人：它看得到的只有同样
    无主的流程（见 flowstore）。不给匿名编一个"default 用户"，那等于把所有
    认不出身份的人合并成同一个人，而且合并得毫无痕迹。
    """
    return creator_for(request) or ((forwarded_user or "").strip() or None)


def source_of(request: Optional[Request]) -> str:
    """这个身份是从哪来的。只用于 /whoami 自检和日志 —— 排查"为什么说我没权限"
    时，第一个要回答的就是"这次到底用了谁"。"""
    if request is not None and email_from_cookie(request.headers.get("cookie") or ""):
        return "cookie"
    if delegated_creator(request):
        return "worker"
    if email_from_cookie(_env("DEV_COOKIE") or ""):
        return "DEV_COOKIE"
    if _env("DATALEGO_USER"):
        return "DATALEGO_USER"
    return "none"
