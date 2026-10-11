"""RSS 适配器：用于自建 wechat2rss / RSSHub 等中转源。

配置示例::

    {"feed_url": "https://rss.example.com/feed/xxx.xml", "account_name": "XX实习"}
"""

from __future__ import annotations

from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

from ..utils import get_logger
from .base import FetchResult, RawItem, SourceAdapter
from .registry import register

log = get_logger(__name__)


@register
class RssAdapter(SourceAdapter):
    code = "rss"
    source_type = "rss"

    def fetch(self, limit: int = 50) -> FetchResult:
        try:
            import feedparser  # 延迟导入，保证核心模块零依赖
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError("RSS 适配器需要 feedparser，请先安装依赖") from exc

        feed_url = self.cfg("feed_url")
        if not feed_url:
            raise ValueError("rss 适配器缺少配置项 feed_url")

        # 统一走 HttpClient：robots 检查 + 按域频控 + 重试 + UA/代理
        client = self.http_client()
        try:
            resp = client.get(feed_url)
        except Exception as exc:  # noqa: BLE001 - 合规拦截或网络异常
            log.warning("RSS 抓取失败 feed=%s err=%s", feed_url, exc)
            return FetchResult(items=[], message=str(exc))

        if not resp.ok:
            return FetchResult(
                items=[],
                rate_limited=resp.rate_limited,
                http_status=resp.status,
                message=f"HTTP {resp.status}",
            )

        parsed = feedparser.parse(resp.text)
        account = self.cfg("account_name") or getattr(parsed.feed, "title", "") or ""
        items: list[RawItem] = []
        for entry in parsed.entries[:limit]:
            items.append(
                RawItem(
                    url=getattr(entry, "link", ""),
                    title=getattr(entry, "title", ""),
                    account_name=account,
                    published_at=_parse_time(entry),
                    summary=_clean(getattr(entry, "summary", "")),
                    content=_clean(_entry_content(entry)),
                    extra={"adapter": self.code, "feed": feed_url},
                )
            )

        log.info("RSS 采集完成 feed=%s items=%d status=%s", feed_url, len(items), resp.status)
        return FetchResult(items=items, http_status=resp.status)


def _entry_content(entry) -> str:
    contents = getattr(entry, "content", None)
    if contents:
        return contents[0].get("value", "")
    return getattr(entry, "summary", "")


def _parse_time(entry) -> datetime | None:
    for key in ("published", "updated"):
        raw = getattr(entry, key, None)
        if not raw:
            continue
        try:
            dt = parsedate_to_datetime(raw)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            continue
    struct = getattr(entry, "published_parsed", None) or getattr(entry, "updated_parsed", None)
    if struct:
        try:
            return datetime(*struct[:6], tzinfo=timezone.utc)
        except (TypeError, ValueError):
            return None
    return None


def _clean(html: str | None) -> str:
    if not html:
        return ""
    try:
        from trafilatura import extract  # 延迟导入

        text = extract(html)
        if text:
            return text.strip()
    except Exception:  # noqa: BLE001 - 抽取失败则退化为原始文本
        pass
    return html.strip()
