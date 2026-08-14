"""Generic outbound HTTP node.

The browser never calls the target directly: doing so would expose the workflow to
CORS and make behavior depend on the operator's machine.  This module executes the
request from the node service and returns a JSON-serializable response envelope.
"""
import json
import re
import time
from base64 import b64encode
from typing import Any, Dict
from urllib.parse import urlparse

import requests


class HttpRequestError(ValueError):
    pass


class HttpStatusError(HttpRequestError):
    """The request completed, but the upstream status is considered a failure."""

    def __init__(self, status: int, body: Any):
        self.status = status
        if isinstance(body, (dict, list)):
            text = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
        elif body is None:
            text = ""
        else:
            text = re.sub(r"\s+", " ", str(body)).strip()
        if len(text) > 500:
            text = text[:500] + "…"
        super().__init__(f"上游返回 HTTP {status}" + (f"：{text}" if text else ""))


METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"}
MAX_TIMEOUT_MS = 120_000
MAX_RETRIES = 5
MAX_RETRY_INTERVAL_MS = 10_000
MAX_RESPONSE_BYTES = 5 * 1024 * 1024
_RETRYABLE_STATUS = {429, 500, 502, 503, 504}
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


def _string_map(value: Any, name: str) -> Dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise HttpRequestError(f"{name} 必须是对象")
    result: Dict[str, str] = {}
    for raw_key, raw_value in value.items():
        key = str(raw_key).strip()
        if not key:
            raise HttpRequestError(f"{name} 的键不能为空")
        result[key] = str(raw_value)
    return result


def _set_header(headers: Dict[str, str], name: str, value: str) -> None:
    for existing in list(headers):
        if existing.lower() == name.lower():
            del headers[existing]
    headers[name] = value


def _apply_auth(params: Dict[str, Any], headers: Dict[str, str]) -> None:
    auth_type = str(params.get("authType") or "none")
    if auth_type == "none":
        return
    if auth_type == "bearer":
        token = str(params.get("bearerToken") or "").strip()
        if not token:
            raise HttpRequestError("Bearer Token 不能为空")
        _set_header(headers, "Authorization", f"Bearer {token}")
        return
    if auth_type == "basic":
        username = str(params.get("basicUsername") or "")
        password = str(params.get("basicPassword") or "")
        if not username:
            raise HttpRequestError("Basic Auth 用户名不能为空")
        encoded = b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
        _set_header(headers, "Authorization", f"Basic {encoded}")
        return
    if auth_type == "header":
        name = str(params.get("authHeaderName") or "").strip()
        value = str(params.get("authHeaderValue") or "")
        auth_header = _headers({name: value})
        name, value = next(iter(auth_header.items()))
        _set_header(headers, name, value)
        return
    raise HttpRequestError(f"不支持的认证方式 {auth_type!r}")


def _request_body(params: Dict[str, Any], headers: Dict[str, str]) -> Any:
    # Old saved workflows only have `body`; treating that as raw preserves their
    # exact request bytes after the richer body selector is introduced.
    body_type = str(params.get("bodyType") or ("raw" if params.get("body") is not None else "none"))
    if body_type == "none":
        return None
    if body_type in {"json", "raw"}:
        body = params.get("body")
        if body is not None and not isinstance(body, str):
            raise HttpRequestError("body 必须是字符串")
        text = body or ""
        if body_type == "json":
            try:
                json.loads(text)
            except (TypeError, ValueError) as exc:
                raise HttpRequestError(f"JSON 请求体格式错误：{exc}")
            if not any(k.lower() == "content-type" for k in headers):
                headers["Content-Type"] = "application/json"
        return text.encode("utf-8")
    if body_type == "form-urlencoded":
        if not any(k.lower() == "content-type" for k in headers):
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        return _string_map(params.get("formBody"), "表单请求体")
    raise HttpRequestError(f"不支持的请求体类型 {body_type!r}")


def _timeout_ms(value: Any, name: str, default: int) -> int:
    try:
        timeout_ms = int(value if value is not None else default)
    except (TypeError, ValueError):
        raise HttpRequestError(f"{name} 必须是整数")
    if not 1 <= timeout_ms <= MAX_TIMEOUT_MS:
        raise HttpRequestError(f"{name} 必须在 1 到 {MAX_TIMEOUT_MS} 之间")
    return timeout_ms


def _timeout(params: Dict[str, Any]) -> Any:
    fallback = _timeout_ms(params.get("timeoutMs"), "timeoutMs", 30_000)
    if params.get("connectTimeoutMs") is None and params.get("readTimeoutMs") is None:
        return fallback / 1000
    connect = _timeout_ms(params.get("connectTimeoutMs"), "connectTimeoutMs", fallback)
    read = _timeout_ms(params.get("readTimeoutMs"), "readTimeoutMs", fallback)
    return (connect / 1000, read / 1000)


def _retry(params: Dict[str, Any]) -> tuple:
    enabled = params.get("retryEnabled", False)
    if not isinstance(enabled, bool):
        raise HttpRequestError("retryEnabled 必须是布尔值")
    if not enabled:
        return 0, 0
    try:
        retries = int(params.get("maxRetries", 2))
        interval_ms = int(params.get("retryIntervalMs", 500))
    except (TypeError, ValueError):
        raise HttpRequestError("重试次数和间隔必须是整数")
    if not 1 <= retries <= MAX_RETRIES:
        raise HttpRequestError(f"maxRetries 必须在 1 到 {MAX_RETRIES} 之间")
    if not 0 <= interval_ms <= MAX_RETRY_INTERVAL_MS:
        raise HttpRequestError(f"retryIntervalMs 必须在 0 到 {MAX_RETRY_INTERVAL_MS} 之间")
    return retries, interval_ms


def execute(params: Dict[str, Any]) -> Dict[str, Any]:
    method = str(params.get("method") or "GET").upper()
    if method not in METHODS:
        raise HttpRequestError(f"不支持的 HTTP 方法 {method!r}")

    headers = _headers(params.get("headers"))
    _apply_auth(params, headers)
    body = _request_body(params, headers)
    verify_ssl = params.get("verifySsl", True)
    if not isinstance(verify_ssl, bool):
        raise HttpRequestError("verifySsl 必须是布尔值")

    url = _url(params.get("url"))
    query = _string_map(params.get("query"), "查询参数")
    timeout = _timeout(params)
    max_retries, retry_interval_ms = _retry(params)
    response = None
    attempts = 0
    for attempt in range(max_retries + 1):
        attempts = attempt + 1
        try:
            response = requests.request(
                method,
                url,
                headers=headers,
                params=query,
                data=body,
                timeout=timeout,
                verify=verify_ssl,
            )
        except requests.Timeout:
            if attempt < max_retries:
                time.sleep(retry_interval_ms / 1000)
                continue
            raise HttpRequestError(f"HTTP 请求超时（共尝试 {attempts} 次）")
        except requests.RequestException as exc:
            if attempt < max_retries:
                time.sleep(retry_interval_ms / 1000)
                continue
            raise HttpRequestError(f"HTTP 请求失败（共尝试 {attempts} 次）：{exc}")
        if response.status_code in _RETRYABLE_STATUS and attempt < max_retries:
            if hasattr(response, "close"):
                response.close()
            time.sleep(retry_interval_ms / 1000)
            continue
        break
    if response is None:
        raise HttpRequestError("HTTP 请求没有返回响应")

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
    if response.status_code >= 400 and params.get("allowHttpErrors") is not True:
        raise HttpStatusError(response.status_code, response_body)
    return {
        "status": response.status_code,
        "body": response_body,
        "headers": response_headers,
        "url": response.url,
        "attempts": attempts,
    }
