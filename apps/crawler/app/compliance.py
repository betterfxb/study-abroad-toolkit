"""合规层：robots.txt 遵守、域名策略、下架登记。

设计原则：
  - 合规是**硬约束**，不是可选优化；所有 HTTP 采集必须过这一层。
  - 仅采集公开信息，不绕过登录墙与验证码。
  - robots.txt 不可达时默认放行（与主流爬虫一致），但记录告警。

零第三方依赖，便于冒烟测试。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable, Iterable
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

from .utils import get_logger

log = get_logger(__name__)


class RobotsDisallowed(RuntimeError):
    """目标 URL 被 robots.txt 禁止抓取。"""


class DomainBlocked(RuntimeError):
    """目标域名在禁采名单中。"""


@dataclass
class RobotsRule:
    parser: RobotFileParser
    fetched_at: float
    ok: bool = True


class RobotsCache:
    """robots.txt 抓取与缓存。

    fetcher: 接收 robots.txt 的完整 URL，返回文本内容；返回 None 表示不可达。
    """

    def __init__(
        self,
        fetcher: Callable[[str], str | None],
        user_agent: str,
        ttl_seconds: int = 3600,
        allow_on_error: bool = True,
    ) -> None:
        self._fetcher = fetcher
        self._ua = user_agent
        self._ttl = ttl_seconds
        self._allow_on_error = allow_on_error
        self._cache: dict[str, RobotsRule] = {}

    def _robots_url(self, url: str) -> tuple[str, str]:
        parsed = urlparse(url)
        host = parsed.netloc
        robots_url = f"{parsed.scheme}://{host}/robots.txt"
        return host, robots_url

    def _get_rule(self, url: str) -> RobotsRule:
        host, robots_url = self._robots_url(url)
        cached = self._cache.get(host)
        if cached and (time.monotonic() - cached.fetched_at) < self._ttl:
            return cached

        parser = RobotFileParser()
        ok = True
        try:
            content = self._fetcher(robots_url)
        except Exception as exc:  # noqa: BLE001
            log.warning("robots.txt 抓取异常 host=%s err=%s", host, exc)
            content = None

        if content is None:
            # 不可达：按 allow_on_error 处理。必须调用 modified() 设置 last_checked，
            # 否则 RobotFileParser.can_fetch 会因「尚未读取」而一律返回 False。
            ok = False
            if self._allow_on_error:
                parser.allow_all = True
            else:
                parser.disallow_all = True
            parser.modified()
            log.info("robots.txt 不可达，按 allow_on_error=%s 处理 host=%s", self._allow_on_error, host)
        else:
            parser.parse(content.splitlines())

        rule = RobotsRule(parser=parser, fetched_at=time.monotonic(), ok=ok)
        self._cache[host] = rule
        return rule

    def allowed(self, url: str, user_agent: str | None = None) -> bool:
        rule = self._get_rule(url)
        if not rule.ok and not self._allow_on_error:
            return False
        try:
            return rule.parser.can_fetch(user_agent or self._ua, url)
        except Exception:  # noqa: BLE001 - 解析异常时保守放行
            return True

    def crawl_delay(self, url: str, user_agent: str | None = None) -> float | None:
        rule = self._get_rule(url)
        try:
            return rule.parser.crawl_delay(user_agent or self._ua)
        except Exception:  # noqa: BLE001
            return None

    def clear(self) -> None:
        self._cache.clear()


@dataclass
class DomainPolicy:
    """域名白名单 / 禁采名单。"""

    allowlist: set[str] = field(default_factory=set)
    denylist: set[str] = field(default_factory=set)

    @classmethod
    def from_iterables(
        cls,
        allowlist: Iterable[str] | None = None,
        denylist: Iterable[str] | None = None,
    ) -> "DomainPolicy":
        return cls(
            allowlist={_norm_host(h) for h in (allowlist or []) if h},
            denylist={_norm_host(h) for h in (denylist or []) if h},
        )

    def check(self, url: str) -> None:
        host = _norm_host(urlparse(url).netloc)
        if host in self.denylist:
            raise DomainBlocked(f"域名在禁采名单中: {host}")
        if self.allowlist and host not in self.allowlist:
            raise DomainBlocked(f"域名不在白名单中: {host}")


def _norm_host(host: str) -> str:
    return host.lower().lstrip(".").removeprefix("www.")


class TakedownRegistry:
    """下架登记：权利人投诉后，对应 URL / 域名永久跳过采集。"""

    def __init__(self) -> None:
        self._urls: set[str] = set()
        self._hosts: set[str] = set()

    def register_url(self, url: str) -> None:
        self._urls.add(url.strip())
        log.info("登记下架 URL: %s", url)

    def register_host(self, host: str) -> None:
        self._hosts.add(_norm_host(host))
        log.info("登记下架域名: %s", host)

    def is_blocked(self, url: str) -> bool:
        if url.strip() in self._urls:
            return True
        return _norm_host(urlparse(url).netloc) in self._hosts

    def snapshot(self) -> dict[str, int]:
        return {"urls": len(self._urls), "hosts": len(self._hosts)}


class ComplianceGuard:
    """合规总闸：把 robots、域名策略、下架登记串成一次检查。"""

    def __init__(
        self,
        robots: RobotsCache | None = None,
        policy: DomainPolicy | None = None,
        takedown: TakedownRegistry | None = None,
        enabled: bool = True,
    ) -> None:
        self.robots = robots
        self.policy = policy or DomainPolicy()
        self.takedown = takedown or TakedownRegistry()
        self.enabled = enabled

    def check(self, url: str) -> None:
        """不通过则抛异常；通过则返回 None。"""
        if not self.enabled:
            return
        if self.takedown.is_blocked(url):
            raise DomainBlocked(f"该 URL 已下架，跳过采集: {url}")
        self.policy.check(url)
        if self.robots is not None and not self.robots.allowed(url):
            raise RobotsDisallowed(f"robots.txt 禁止抓取: {url}")

    def delay_for(self, url: str) -> float | None:
        if not self.enabled or self.robots is None:
            return None
        return self.robots.crawl_delay(url)
