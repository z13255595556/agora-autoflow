"""Resolve the authenticated AutoFlow user through Athena.

The browser cookie is deliberately opaque to this service.  It is forwarded only
to Athena's fixed ``/api/me`` endpoint, which validates the login session and
returns the user record.  AutoFlow must never decode a token or trust a user
identity supplied by the client.

Worker-triggered runs have no browser session.  They keep their separate
``X-Run-Creator`` delegation path, protected by ``WORKER_TOKEN``.
"""
import hmac
import os
import re
from dataclasses import dataclass
from typing import Any, Optional

import requests
from fastapi import Request

ATHENA_ME_URL = "https://athena.agoralab.co/api/me"
ATHENA_ME_TIMEOUT_SECONDS = 3
EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,64}$")


@dataclass(frozen=True)
class CurrentUser:
    id: str
    email: str
    display_name: str
    permissions: tuple[str, ...]
    is_admin: bool


def _env(name: str) -> Optional[str]:
    return (os.getenv(name, "") or "").strip() or None


def _parse_user(payload: Any) -> Optional[CurrentUser]:
    """Validate Athena's response before it reaches authorization code."""
    if not isinstance(payload, dict):
        return None
    raw = payload.get("user")
    if not isinstance(raw, dict):
        return None

    user_id = raw.get("id")
    email = raw.get("email")
    display_name = raw.get("displayName")
    permissions = raw.get("permissions")
    is_admin = raw.get("isAdmin")
    if (
        not isinstance(user_id, str) or not user_id.strip()
        or not isinstance(email, str) or not EMAIL_RE.fullmatch(email)
        or not isinstance(display_name, str)
        or not isinstance(permissions, list) or not all(isinstance(p, str) for p in permissions)
        or not isinstance(is_admin, bool)
    ):
        return None
    return CurrentUser(
        id=user_id.strip(),
        email=email,
        display_name=display_name,
        permissions=tuple(permissions),
        is_admin=is_admin,
    )


def _athena_user(cookie_header: str) -> Optional[CurrentUser]:
    """Ask Athena to validate an opaque browser cookie.

    Authentication failures, malformed responses, timeouts, and redirects all
    mean no user.  There is intentionally no fallback that interprets Cookie.
    """
    if not cookie_header:
        return None
    try:
        response = requests.get(
            ATHENA_ME_URL,
            headers={"Cookie": cookie_header},
            timeout=ATHENA_ME_TIMEOUT_SECONDS,
            allow_redirects=False,
        )
    except requests.RequestException:
        return None
    if response.status_code != 200:
        return None
    try:
        return _parse_user(response.json())
    except (TypeError, ValueError):
        return None


def current_user_for(request: Optional[Request]) -> Optional[CurrentUser]:
    """Return the verified browser user, cached for the lifetime of a request."""
    if request is None:
        return None
    cookie_header = request.headers.get("cookie") or ""
    if not cookie_header:
        return None

    cache_key = "_autoflow_athena_user"
    if hasattr(request.state, cache_key):
        return getattr(request.state, cache_key)
    user = _athena_user(cookie_header)
    setattr(request.state, cache_key, user)
    return user


def creator_for(request: Optional[Request]) -> Optional[str]:
    """Return the data-platform creator for this call, if it is trustworthy."""
    user = current_user_for(request)
    if user is not None:
        return user.email

    # A request carrying a browser Cookie has attempted user authentication.
    # A failed Athena check must not be converted into a worker identity.
    if request is not None and request.headers.get("cookie"):
        return None
    return delegated_creator(request)


def delegated_creator(request: Optional[Request]) -> Optional[str]:
    """Resolve a Worker-published creator after verifying its shared secret."""
    if request is None:
        return None
    secret = _env("WORKER_TOKEN")
    if not secret:
        return None
    presented = request.headers.get("x-worker-token") or ""
    if not hmac.compare_digest(presented, secret):
        return None
    email = (request.headers.get("x-run-creator") or "").strip()
    return email if EMAIL_RE.fullmatch(email) else None


def is_admin(request: Optional[Request]) -> bool:
    """Is this an AutoFlow administrator?

    The flag comes from Athena's verified ``/api/me`` response, never from a
    request header: a header would let anyone grant themselves every flow in
    the system.  Worker delegation is deliberately excluded — a background run
    has no browser session and must never widen its own visibility.
    """
    user = current_user_for(request)
    return bool(user and user.is_admin)


def user_for(request: Optional[Request], forwarded_user: Optional[str] = None) -> Optional[str]:
    """Return the verified user identity used for ownership and audit.

    ``forwarded_user`` remains an argument for endpoint compatibility but is
    intentionally ignored: a proxy header is not an Athena-verified identity.
    """
    del forwarded_user
    return creator_for(request)


def source_of(request: Optional[Request]) -> str:
    """Report identity provenance for ``/whoami`` diagnostics."""
    if current_user_for(request) is not None:
        return "athena"
    if delegated_creator(request):
        return "worker"
    return "none"
