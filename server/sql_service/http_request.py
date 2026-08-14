"""Generic outbound HTTP node.

The browser never calls the target directly: doing so would expose the workflow to
CORS and make behavior depend on the operator's machine.  This module executes the
request from the node service and returns a JSON-serializable response envelope.
"""
from typing import Any, Dict
from urllib.parse import urlparse

import requests


class HttpRequestError(ValueError):
    pass


METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}
MAX_TIMEOUT_MS = 120_000
MAX_RESPONSE_BYTES = 5 * 1024 * 1024
_FORBIDDEN_HEADERS = {"content-length", "host", "transfer-encoding"}


def _url(value: Any) -> str:
    url = str(value or "").strip()
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HttpRequestError("URL 必须是有效的 http:// 或 https:// 地址")
    if parsed.username or parsed.password:
        raise HttpRequestError("URL 不能包含用户名或密码，请放到 Authorization 请求头中")
    return url


def _headers(value: Any) -> Dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise HttpRequestError("headers 必须是对象")

    result: Dict[str, str] = {}
    for raw_name, raw_value in value.items():
        name = str(raw_name).strip()
        if not name:
            raise HttpRequestError("请求头名不能为空")
        if name.lower() in _FORBIDDEN_HEADERS:
            raise HttpRequestError(f"不允许手动设置请求头 {name}")
        if "\r" in name or "\n" in name:
            raise HttpRequestError("请求头名不能包含换行符")
        text = str(raw_value)
        if "\r" in text or "\n" in text:
            raise HttpRequestError(f"请求头 {name} 的值不能包含换行符")
        result[name] = text
    return result


def _timeout(value: Any) -> float:
    try:
        timeout_ms = int(value if value is not None else 30_000)
    except (TypeError, ValueError):
        raise HttpRequestError("timeoutMs 必须是整数")
    if not 1 <= timeout_ms <= MAX_TIMEOUT_MS:
        raise HttpRequestError(f"timeoutMs 必须在 1 到 {MAX_TIMEOUT_MS} 之间")
    return timeout_ms / 1000


def execute(params: Dict[str, Any]) -> Dict[str, Any]:
    method = str(params.get("method") or "GET").upper()
    if method not in METHODS:
        raise HttpRequestError(f"不支持的 HTTP 方法 {method!r}")

    body = params.get("body")
    if body is not None and not isinstance(body, str):
        raise HttpRequestError("body 必须是字符串")

    try:
        response = requests.request(
            method,
            _url(params.get("url")),
            headers=_headers(params.get("headers")),
            data=body.encode("utf-8") if body is not None else None,
            timeout=_timeout(params.get("timeoutMs")),
        )
    except requests.Timeout:
        raise HttpRequestError("HTTP 请求超时")
    except requests.RequestException as exc:
        raise HttpRequestError(f"HTTP 请求失败：{exc}")

    content = response.content
    if len(content) > MAX_RESPONSE_BYTES:
        raise HttpRequestError(f"响应体超过 {MAX_RESPONSE_BYTES // 1024 // 1024} MiB 上限")

    if not content:
        response_body: Any = None
    else:
        try:
            response_body = response.json()
        except ValueError:
            response_body = response.text

    # Set-Cookie is intentionally excluded: run output is inspectable and may be
    # exported, so persisting an upstream session cookie would leak credentials.
    response_headers = {
        str(k).lower(): str(v)
        for k, v in response.headers.items()
        if str(k).lower() != "set-cookie"
    }
    return {
        "status": response.status_code,
        "body": response_body,
        "headers": response_headers,
        "url": response.url,
    }
