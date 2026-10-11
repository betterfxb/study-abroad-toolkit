"""统一 HTTP 客户端：合规感知 + 按域频控 + 重试 + 可注入传输层。

所有采集适配器都应通过本客户端发起请求，确保 robots、频控、UA、代理统一生效。
transport 可注入，便于零依赖单测（不需要 httpx，也不发真实请求）。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import urlparse

from .compliance import ComplianceGuard, RobotsCache
from .config import settings
from .utils import TokenBucket, get_logger, jitter_sleep

log = get_logger(__name__)

Transport = Callable[[str, dict[str, str]], tuple[int, str]]


@dataclass
class HttpResponse:
    url: str
    status: int
    text: str
    headers: dict[str, str] = field(default_factory=dict)
    elapsed_ms: int = 0

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    @property
    def rate_limited(self) -> bool:
        return self.status in (429, 403, 503)


class HttpError(RuntimeError):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class HttpClient:
    def __init__(
        self,
        guard: ComplianceGuard | None = None,
        user_agent: str | None = None,
        proxy: str | None = None,
        timeout: int | None = None,
        rate_limit_per_minute: int | None = None,
        retries: int = 3,
        transport: Transport | None = None,
    ) -> None:
        self.user_agent = user_agent or settings.user_agent
        self.proxy = proxy if proxy is not None else settings.proxy_url
        self.timeout = timeout or settings.request_timeout_s
        self.rate_limit = rate_limit_per_minute or settings.default_rate_limit
        self.retries = retries
        self._transport = transport
        self._buckets: dict[str, TokenBucket] = {}
        self.guard = guard if guard is not None else ComplianceGuard(enabled=False)

    # ---------------- 频控 ----------------
    def _bucket_for(self, url: str) -> TokenBucket:
        host = urlparse(url).netloc.lower()
        if host not in self._buckets:
            self._buckets[host] = TokenBucket(self.rate_limit)
        return self._buckets[host]

    def _throttle(self, url: str) -> None:
        wait = self._bucket_for(url).acquire()
        delay = self.guard.delay_for(url)
        if delay:
            wait = max(wait, float(delay))
        if wait > 0:
            jitter_sleep(wait, ratio=0.15)

    # ---------------- 传输 ----------------
    def _raw_get(self, url: str, headers: dict[str, str]) -> tuple[int, str]:
        if self._transport is not None:
            return self._transport(url, headers)
        try:
            import httpx  # 延迟导入
        except ImportError as exc:  # pragma: no cover
            raise HttpError("缺少 httpx 依赖，无法发起真实请求") from exc

        with httpx.Client(
            timeout=self.timeout,
            headers=headers,
            proxy=self.proxy or None,
            follow_redirects=True,
        ) as client:
            resp = client.get(url)
            return resp.status_code, resp.text

    # ---------------- 对外接口 ----------------
    def get(
        self,
        url: str,
        *,
        check_robots: bool = True,
        headers: dict[str, str] | None = None,
    ) -> HttpResponse:
        """发起 GET。check_robots=False 仅用于抓取 robots.txt 自身。"""
        if check_robots:
            self.guard.check(url)

        req_headers = {"User-Agent": self.user_agent, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"}
        if headers:
            req_headers.update(headers)

        last_exc: Exception | None = None
        for attempt in range(self.retries):
            self._throttle(url)
            started = time.monotonic()
            try:
                status, text = self._raw_get(url, req_headers)
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                if attempt == self.retries - 1:
                    break
                jitter_sleep(0.5 * (2**attempt))
                continue

            elapsed = int((time.monotonic() - started) * 1000)
            resp = HttpResponse(url=url, status=status, text=text, elapsed_ms=elapsed)

            if status in (429, 403, 503) and attempt < self.retries - 1:
                backoff = float(resp.headers.get("Retry-After", 0) or 0) or (1.0 * (2**attempt))
                log.warning("被限流 status=%s，%.1fs 后重试 url=%s", status, backoff, url)
                jitter_sleep(backoff)
                continue

            if not resp.ok:
                log.warning("请求失败 status=%s url=%s", status, url)
            return resp

        raise HttpError(f"请求最终失败: {url}", status=None) from last_exc

    def get_text(self, url: str, **kwargs: Any) -> str | None:
        try:
            resp = self.get(url, **kwargs)
        except Exception as exc:  # noqa: BLE001
            log.warning("get_text 失败 url=%s err=%s", url, exc)
            return None
        return resp.text if resp.ok else None


def build_default_client(guard: ComplianceGuard | None = None, **kwargs: Any) -> HttpClient:
    return HttpClient(guard=guard, **kwargs)


def build_robots_cache(client: HttpClient, user_agent: str | None = None) -> RobotsCache:
    """用同一个客户端抓 robots.txt（不走 robots 检查，避免递归）。"""

    def _fetch(robots_url: str) -> str | None:
        resp = client.get(robots_url, check_robots=False)
        if resp.status in (401, 403):
            # 明确禁止：返回空内容，由 RobotFileParser 解析为「不允许」
            return "User-agent: *\nDisallow: /\n"
        if resp.status == 404:
            # 不存在：视为允许全部
            return ""
        if not resp.ok:
            return None
        return resp.text

    return RobotsCache(fetcher=_fetch, user_agent=user_agent or client.user_agent)
