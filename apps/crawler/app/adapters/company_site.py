"""企业官网招聘页适配器（兜底源 B，稳定性最高）。

配置示例::

    {"urls": ["https://careers.example.com/intern"], "account_name": "企业官网"}

会抓取给定 URL 的 HTML 并抽取正文，再交由结构化抽取环节处理。
统一走 HttpClient：robots 检查 + 按域频控 + 重试 + UA/代理。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from ..utils import get_logger
from .base import FetchResult, RawItem, SourceAdapter
from .registry import register

log = get_logger(__name__)


@register
class CompanySiteAdapter(SourceAdapter):
    code = "company_site"
    source_type = "company_site"

    def fetch(self, limit: int = 50) -> FetchResult:
        urls = self.cfg("urls") or []
        if not urls:
            raise NotImplementedError("company_site 适配器缺少配置项 urls")

        client = self.http_client()
        items: list[RawItem] = []
        last_status: int | None = None
        rate_limited = False

        for url in urls[:limit]:
            try:
                resp = client.get(url)
            except Exception as exc:  # noqa: BLE001 - 合规拦截或网络异常
                log.warning("抓取失败 url=%s err=%s", url, exc)
                continue

            last_status = resp.status
            if resp.rate_limited:
                rate_limited = True
            if not resp.ok:
                continue

            items.append(
                RawItem(
                    url=url,
                    title=self.cfg("account_name", ""),
                    account_name=self.cfg("account_name", "企业官网"),
                    published_at=datetime.now(timezone.utc),
                    content=self._extract(resp.text),
                    extra={"adapter": self.code, "http_status": resp.status},
                )
            )

        return FetchResult(items=items, rate_limited=rate_limited, http_status=last_status)

    @staticmethod
    def _extract(html: str) -> str:
        try:
            from trafilatura import extract

            return (extract(html) or "").strip()
        except Exception:  # noqa: BLE001
            from ..services.extract import strip_tags

            return strip_tags(html)

    def health_check(self) -> dict[str, Any]:
        urls = self.cfg("urls") or []
        return {"ok": bool(urls), "adapter": self.code, "url_count": len(urls)}
