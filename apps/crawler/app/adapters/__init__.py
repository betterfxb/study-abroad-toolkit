"""采集源适配器：插件式，新增源只需实现 SourceAdapter 并注册。"""

from .base import RawItem, SourceAdapter
from .registry import create_adapter, get_adapter_class, list_adapters, register

# 触发各适配器模块的注册（导入即注册）
from . import company_site, job_platform, manual, rss, thirdparty_api  # noqa: E402,F401

__all__ = [
    "RawItem",
    "SourceAdapter",
    "register",
    "create_adapter",
    "get_adapter_class",
    "list_adapters",
]
