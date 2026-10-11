"""适配器注册表。零第三方依赖。"""

from __future__ import annotations

from typing import Any, TypeVar

from .base import SourceAdapter

T = TypeVar("T", bound=type[SourceAdapter])

_REGISTRY: dict[str, type[SourceAdapter]] = {}


class AdapterNotFoundError(KeyError):
    pass


def register(cls: T) -> T:
    """类装饰器：把适配器登记进注册表。"""
    code = getattr(cls, "code", None)
    if not code or code == "base":
        raise ValueError(f"适配器 {cls.__name__} 必须定义唯一的 code")
    if code in _REGISTRY and _REGISTRY[code] is not cls:
        raise ValueError(f"适配器 code 冲突: {code}")
    _REGISTRY[code] = cls
    return cls


def get_adapter_class(code: str) -> type[SourceAdapter]:
    if code not in _REGISTRY:
        raise AdapterNotFoundError(
            f"未注册的适配器: {code}；已注册: {sorted(_REGISTRY)}"
        )
    return _REGISTRY[code]


def create_adapter(code: str, config: dict[str, Any] | None = None) -> SourceAdapter:
    return get_adapter_class(code)(config or {})


def list_adapters() -> list[dict[str, str]]:
    return [
        {"code": c.code, "source_type": c.source_type, "class": c.__name__}
        for c in sorted(_REGISTRY.values(), key=lambda x: x.code)
    ]
