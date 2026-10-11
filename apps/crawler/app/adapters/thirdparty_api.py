"""第三方数据服务适配器（主源 A：新榜 / 清博 / 西瓜数据等）。

接入步骤（TODO）：
  1. 在配置中填入 ``base_url`` / ``api_key`` / ``secret``；
  2. 按供应商文档实现 ``_request()`` 的鉴权与签名；
  3. 在 ``_map()`` 中把供应商返回字段映射为 RawItem。

配置示例::

    {"base_url": "https://api.example.com", "api_key": "...", "account_ids": ["..."]}
"""

from __future__ import annotations

from typing import Any

from ..config import settings
from ..utils import retry
from .base import FetchResult, RawItem, SourceAdapter
from .registry import register


@register
class ThirdPartyApiAdapter(SourceAdapter):
    code = "thirdparty_api"
    source_type = "thirdparty_api"

    def fetch(self, limit: int = 50) -> FetchResult:
        base_url = self.cfg("base_url")
        api_key = self.cfg("api_key")
        if not base_url or not api_key:
            raise NotImplementedError(
                "thirdparty_api 适配器未配置 base_url / api_key，"
                "请先在 crawl_sources.config 中补齐后启用"
            )

        payload = self._request(base_url, api_key, limit)
        items = [self._map(row) for row in payload.get("data", [])[:limit]]
        return FetchResult(items=items, http_status=200)

    @retry(times=3, base_delay=1.0)
    def _request(self, base_url: str, api_key: str, limit: int) -> dict[str, Any]:
        """按供应商文档实现。此处为占位实现。"""
        raise NotImplementedError(
            "请按所选数据服务商的鉴权方式实现 _request()（签名 / 时效参数 / 分页）"
        )

    def _map(self, row: dict[str, Any]) -> RawItem:
        """把供应商返回字段映射为统一结构。"""
        return RawItem(
            url=row.get("url", ""),
            title=row.get("title", ""),
            account_name=row.get("account_name", ""),
            summary=row.get("digest", ""),
            content=row.get("content", ""),
            extra={"adapter": self.code, "raw": row},
        )

    def health_check(self) -> dict[str, Any]:
        ok = bool(self.cfg("base_url")) and bool(self.cfg("api_key"))
        return {
            "ok": ok,
            "adapter": self.code,
            "message": "已配置" if ok else "缺少 base_url / api_key",
            "provider": settings.llm_provider,
        }
