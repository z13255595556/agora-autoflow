"""Generic outbound HTTP node.

The browser never calls the target directly: doing so would expose the workflow to
CORS and make behavior depend on the operator's machine.  This module executes the
request from the node service and returns a JSON-serializable response envelope.
"""
import ipaddress
import json
import os
import re
import socket
import time
from base64 import b64encode
from typing import Any, Dict, Optional
from urllib.parse import urljoin, urlparse

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


MAX_REDIRECTS = 5
_REDIRECT_STATUS = {301, 302, 303, 307, 308}


def _allowed_hosts() -> set:
    """显式放行的主机名。

    设了就是**严格白名单**：只有列出的主机能访问（内网地址也放行，因为那是
    运维明确同意的）。没设就退回"公网可以、内网一律拒绝"。

    之所以不默认严格：http.request 节点已经在用了，默认拒绝全部会当场打断
    现有流程。默认拦住的是真正的漏洞面（内网与元数据地址），而不是所有出网。
    """
    raw = os.getenv("HTTP_NODE_ALLOWED_HOSTS", "").replace(",", " ")
    return {h.strip().lower() for h in raw.split() if h.strip()}


"""禁止访问的网段。

**显式列网段，不用 ipaddress 的 is_private/is_reserved。** 那几个属性是个大杂烩：
198.18.0.0/15（RFC2544 基准测试段）也算 is_private，而 Zscaler / AnyConnect 这类
代理型 DNS 恰好把所有外部域名解析到这一段 —— 用 is_private 判会把企微 webhook
一起拦掉，一个安全修复变成"所有出网都不通"。

列在这里的是 SSRF 真正要防的目标：本机、内网、云元数据。
需要再加（比如 k8s 用了 100.64.0.0/10）就用 HTTP_NODE_BLOCKED_CIDRS 追加。
"""
_BLOCKED_CIDRS_DEFAULT = (
    "0.0.0.0/8",        # 本机 / 未指定
    "10.0.0.0/8",       # RFC1918 内网
    "127.0.0.0/8",      # 回环
    "169.254.0.0/16",   # 链路本地 —— 云元数据 169.254.169.254 在这里
    "172.16.0.0/12",    # RFC1918 内网
    "192.168.0.0/16",   # RFC1918 内网
    "224.0.0.0/4",      # 组播
    "::/128",           # 未指定
    "::1/128",          # 回环
    "fc00::/7",         # 唯一本地地址（v6 的内网）
    "fe80::/10",        # 链路本地
    "ff00::/8",         # 组播
)


def _blocked_networks() -> tuple:
    extra = os.getenv("HTTP_NODE_BLOCKED_CIDRS", "").replace(",", " ").split()
    nets = []
    for cidr in (*_BLOCKED_CIDRS_DEFAULT, *extra):
        try:
            nets.append(ipaddress.ip_network(cidr.strip(), strict=False))
        except ValueError:
            continue  # 配错了不能让整个节点不可用，跳过这一条
    return tuple(nets)


def _is_public_ip(ip: Any) -> bool:
    # IPv4-mapped IPv6（::ffff:127.0.0.1）要还原成 v4 再判，否则一条都匹配不上
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    return not any(ip in net for net in _blocked_networks() if net.version == ip.version)


def _check_destination(url: str) -> None:
    """校验目的地址，拒绝内网/回环/链路本地/保留段。

    这个进程同时持有数据平台的机器人票（robot.py）和企微 webhook 地址
    （wecom.py），而服务端目前没有任何认证 —— 没有这道校验，任何能打开编辑器
    的人都能让它去打内网任意地址（含 169.254.169.254 云元数据）并把响应体读回
    画布。原来的 _url() 只查了 scheme、hostname 非空、不带 userinfo。

    **解析出的每个地址都要过**，不能只看第一个：一个域名同时解析出公网 IP 和
    127.0.0.1 时，只查第一个就可能放过去。

    残余风险（诚实记录，不假装解决了）：校验和实际连接之间有 TOCTOU 窗口，
    DNS rebinding 理论上仍可绕过。彻底解决要固定已校验的 IP 去建连（自定义
    连接池适配器），成本远超这次修复的范围；每一跳重新校验已经挡住了实践中
    绝大多数利用方式（302 跳转到内网）。
    """
    host = (urlparse(url).hostname or "").lower()
    if not host:
        raise HttpRequestError("URL 缺少主机名")

    allowed = _allowed_hosts()
    if allowed:
        if host not in allowed:
            raise HttpRequestError(
                f"目的主机 {host} 不在出网白名单里（HTTP_NODE_ALLOWED_HOSTS）"
            )
        return

    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise HttpRequestError(f"无法解析主机名 {host}：{exc}")

    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        if not _is_public_ip(ip):
            raise HttpRequestError(
                f"不允许访问内网地址（{host} → {ip}）。"
                f"确需访问内部服务请把主机名加进 HTTP_NODE_ALLOWED_HOSTS"
            )


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


def _send(
    method: str,
    url: str,
    *,
    headers: Dict[str, str],
    query: Dict[str, str],
    body: Any,
    timeout: Any,
    verify: bool,
) -> Any:
    """发一次请求，自己处理重定向。

    **必须自己处理**：requests 默认 allow_redirects=True，跳转后的地址不会再过
    _check_destination —— 只校验第一跳等于没校验，一个指向 169.254.169.254 的
    302 就能绕过全部检查。

    顺带补上 requests 自动跳转时替我们做、现在得自己做的两件事：
    - 跨主机跳转要**剥掉 Authorization**，否则恶意跳转能直接把 token 收走
    - 303、以及 301/302 遇到非 GET 请求，按惯例降级成 GET 并丢掉请求体
    """
    origin_host = (urlparse(url).hostname or "").lower()
    current_method, current_url = method, url
    current_headers = dict(headers)
    current_body: Any = body
    current_query: Optional[Dict[str, str]] = query

    for hop in range(MAX_REDIRECTS + 1):
        _check_destination(current_url)
        response = requests.request(
            current_method,
            current_url,
            headers=current_headers,
            params=current_query,
            data=current_body,
            timeout=timeout,
            verify=verify,
            allow_redirects=False,
        )
        location = response.headers.get("location")
        if response.status_code not in _REDIRECT_STATUS or not location:
            return response
        if hop == MAX_REDIRECTS:
            response.close()
            raise HttpRequestError(f"重定向次数超过 {MAX_REDIRECTS} 次上限")

        target = _url(urljoin(current_url, location))
        status = response.status_code
        response.close()

        if (urlparse(target).hostname or "").lower() != origin_host:
            # 新建而不是原地 del：原地改会让"已经发出去的那一跳"和"下一跳"共享
            # 同一个 dict，调试时看到的是改完的样子，对不上真正发出去的东西
            current_headers = {
                k: v for k, v in current_headers.items() if k.lower() != "authorization"
            }

        if status == 303 or (status in {301, 302} and current_method not in {"GET", "HEAD"}):
            current_method = "GET"
            current_body = None
        # 查询参数已经体现在上一跳的 URL 里，Location 给的是完整目标，不能再拼一遍
        current_query = None
        current_url = target

    raise HttpRequestError("重定向处理异常")


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
            response = _send(
                method,
                url,
                headers=headers,
                query=query,
                body=body,
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
