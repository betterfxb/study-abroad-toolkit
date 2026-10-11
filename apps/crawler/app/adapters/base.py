"""适配器基类与数据结构。零第三方依赖。"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass
class RawItem:
    """采集到的一条原始记录（文章或岗位）。

    `job` 用于**已结构化**的源（如 JSON 招聘 API）：若已给出岗位字段，
    流水线会跳过 LLM / 规则抽取，直接进入标准化与去重。
    """

    url: str
    title: str = ""
    account_name: str = ""
    published_at: datetime | None = None
    cover_url: str = ""
    summary: str = ""
    content: str = ""
    job: dict[str, Any] | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "url": self.url,
            "title": self.title,
            "account_name": self.account_name,
            "published_at": self.published_at.isoformat() if self.published_at else None,
            "cover_url": self.cover_url,
            "summary": self.summary,
            "content_length": len(self.content or ""),
            "pre_structured": self.job is not None,
            "extra": self.extra,
        }


@dataclass
class FetchResult:
    """一次采集的结果。"""

    items: list[RawItem] = field(default_factory=list)
    rate_limited: bool = False
    http_status: int | None = None
    message: str = ""

    @property
    def count(self) -> int:
        return len(self.items)


class SourceAdapter(ABC):
    """所有采集源的统一接口。

    新增一个源只需要：
      1. 继承本类，设置 code / source_type；
      2. 实现 fetch()；
      3. 用 @register 装饰，或在 registry 中登记。
    """

    code: str = "base"
    source_type: str = "base"

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        self.config = config or {}

    @abstractmethod
    def fetch(self, limit: int = 50) -> FetchResult:
        """拉取原始记录。实现方需自行遵守频控与 robots。"""
        raise NotImplementedError

    def health_check(self) -> dict[str, Any]:
        """源健康检查，默认返回自身可构造即视为健康。"""
        return {"ok": True, "adapter": self.code, "source_type": self.source_type}

    # ---- 便捷读取配置 ----
    def cfg(self, key: str, default: Any = None) -> Any:
        return self.config.get(key, default)

    def http_client(self):
        """获取统一 HTTP 客户端（合规感知 + 按域频控）。

        可在 config 中注入 `guard`（ComplianceGuard）或 `transport`（测试用）。
        """
        client = getattr(self, "_http_client", None)
        if client is None:
            from ..http import HttpClient

            client = HttpClient(
                guard=self.cfg("guard"),
                user_agent=self.cfg("user_agent"),
                rate_limit_per_minute=self.cfg("rate_limit"),
                transport=self.cfg("transport"),
            )
            self._http_client = client
        return client

    def __repr__(self) -> str:  # pragma: no cover
        return f"<{type(self).__name__} code={self.code!r}>"
