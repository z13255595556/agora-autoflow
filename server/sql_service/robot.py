"""机器人账号换 accessToken，带缓存。

**凭证只有一个来源：机器人账号。** 四项从环境变量或 .env 读，绝不接受调用方
传入 —— 那样会进日志、进流程定义、进 git。

不用用户自己的票：那张票只活 2 小时，浏览数据平台不会给它续期（网站验的是
cookie 本身，从不读里面那张票），结果是用户看网站一切正常、工作流却说凭证
过期，除了退出重登没有别的办法。

票缓存在进程内，提前 2 分钟续 —— 一条流程里几十个 SQL 节点不该换几十次票。
"""
import os
import threading
import time
from typing import Optional

import requests

TOKEN_URL_DEFAULT = "https://oauth.agoralab.co/oauth/token"
CREDENTIALS = ("OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "OAUTH_USERNAME", "OAUTH_PASSWORD")
HTTP_TIMEOUT = 30
RENEW_MARGIN = 120  # 提前这么多秒续票


class RobotError(RuntimeError):
    """机器人账号不可用 —— 服务端配置或连通性问题。"""


_lock = threading.Lock()
_token: Optional[str] = None
_expires_at: float = 0.0


def missing_credentials() -> list:
    return [name for name in CREDENTIALS if not os.getenv(name, "").strip()]


def invalidate() -> None:
    """作废缓存的票。数据平台回 401 时调用，下次请求会重新换。"""
    global _token, _expires_at
    with _lock:
        _token, _expires_at = None, 0.0


def get_token() -> str:
    global _token, _expires_at
    with _lock:
        if _token and time.time() < _expires_at - RENEW_MARGIN:
            return _token

        missing = missing_credentials()
        if missing:
            raise RobotError(
                "缺少凭证: " + "、".join(missing)
                + "。在 server/.env 里填好，或 export 到环境变量。"
                + "注意机器人名（如 cs_help_robot）是 USERNAME，不是 CLIENT_ID。"
            )

        try:
            resp = requests.post(
                os.getenv("OAUTH_TOKEN_URL", TOKEN_URL_DEFAULT),
                # 凭证放请求体，不是 Authorization: Basic —— 这个 SSO 只认前者
                data={
                    "grant_type": "password",
                    "client_id": os.environ["OAUTH_CLIENT_ID"].strip(),
                    "client_secret": os.environ["OAUTH_CLIENT_SECRET"].strip(),
                    "username": os.environ["OAUTH_USERNAME"].strip(),
                    "password": os.environ["OAUTH_PASSWORD"].strip(),
                },
                timeout=HTTP_TIMEOUT,
            )
        except requests.RequestException as exc:
            raise RobotError(f"连不上 SSO：{exc}")

        # 这个 SSO 出错时返回 text/plain，成功才是 JSON
        try:
            payload = resp.json()
        except ValueError:
            payload = {}
        if not resp.ok:
            reason = payload.get("error_description") or payload.get("error") or resp.text[:200]
            raise RobotError(f"SSO 拒绝发 token（HTTP {resp.status_code}）：{reason}")

        token = payload.get("access_token")
        if not token:
            raise RobotError(f"SSO 返回里没有 access_token：{resp.text[:200]!r}")

        _token = token
        _expires_at = time.time() + float(payload.get("expires_in") or 7200)
        return _token
