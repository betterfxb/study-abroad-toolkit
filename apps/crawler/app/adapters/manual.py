"""人工投递适配器（降级方案 L2）。

运营人员把公众号文章转发到统一入口（企微/邮箱/表单），落成 JSON 文件放进
inbox 目录，本适配器负责读取入库。零第三方依赖，可离线运行。

配置示例::

    {"inbox_dir": "./inbox", "account_name": "人工投递"}

inbox 中每个 JSON 文件形如::

    {"url": "https://mp.weixin.qq.com/s/xxx", "title": "...",
     "account_name": "XX实习", "published_at": "2026-10-08T09:00:00Z",
     "content": "正文……"}
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from ..utils import get_logger
from .base import FetchResult, RawItem, SourceAdapter
from .registry import register

log = get_logger(__name__)


@register
class ManualAdapter(SourceAdapter):
    code = "manual"
    source_type = "manual"

    def fetch(self, limit: int = 50) -> FetchResult:
        inbox = Path(self.cfg("inbox_dir", "./inbox"))
        if not inbox.exists():
            log.warning("人工投递目录不存在: %s", inbox)
            return FetchResult(items=[], message=f"inbox not found: {inbox}")

        default_account = self.cfg("account_name", "人工投递")
        items: list[RawItem] = []
        for path in sorted(inbox.glob("*.json"))[:limit]:
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                log.warning("跳过无法解析的文件 %s: %s", path.name, exc)
                continue
            url = payload.get("url")
            if not url:
                log.warning("跳过缺少 url 的文件: %s", path.name)
                continue
            items.append(
                RawItem(
                    url=url,
                    title=payload.get("title", ""),
                    account_name=payload.get("account_name", default_account),
                    published_at=_parse_dt(payload.get("published_at")),
                    cover_url=payload.get("cover_url", ""),
                    summary=payload.get("summary", ""),
                    content=payload.get("content", ""),
                    extra={"adapter": self.code, "source_file": path.name},
                )
            )

        log.info("人工投递读取完成 dir=%s items=%d", inbox, len(items))
        return FetchResult(items=items)


def _parse_dt(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
