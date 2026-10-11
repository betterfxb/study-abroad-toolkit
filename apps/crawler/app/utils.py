"""通用工具：日志、令牌桶限流、重试。零第三方依赖。"""

from __future__ import annotations

import functools
import logging
import random
import threading
import time
from typing import Any, Callable, TypeVar

T = TypeVar("T")

_LOG_FORMAT = "%(asctime)s | %(levelname)-5s | %(name)s | %(message)s"


def get_logger(name: str) -> logging.Logger:
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter(_LOG_FORMAT))
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
    return logger


class TokenBucket:
    """令牌桶限流器。用于控制对单一数据源的请求频率（合规要求）。"""

    def __init__(self, rate_per_minute: int, burst: int | None = None) -> None:
        self.rate = max(1, rate_per_minute) / 60.0
        self.capacity = float(burst if burst is not None else max(1, rate_per_minute))
        self._tokens = self.capacity
        self._last = time.monotonic()
        self._lock = threading.Lock()

    def acquire(self, tokens: float = 1.0) -> float:
        """获取令牌，返回需要等待的秒数（调用方 sleep）。"""
        with self._lock:
            now = time.monotonic()
            self._tokens = min(self.capacity, self._tokens + (now - self._last) * self.rate)
            self._last = now
            if self._tokens >= tokens:
                self._tokens -= tokens
                return 0.0
            deficit = tokens - self._tokens
            wait = deficit / self.rate
            self._tokens = 0.0
            return wait


def jitter_sleep(base_seconds: float, ratio: float = 0.3) -> None:
    """随机抖动休眠，避免固定频率被识别。"""
    if base_seconds <= 0:
        return
    delta = base_seconds * ratio
    time.sleep(max(0.0, base_seconds + random.uniform(-delta, delta)))


def retry(times: int = 3, base_delay: float = 0.5, exceptions: tuple[type[Exception], ...] = (Exception,)):
    """指数退避重试装饰器。"""

    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        @functools.wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> T:
            last_exc: Exception | None = None
            for attempt in range(times):
                try:
                    return func(*args, **kwargs)
                except exceptions as exc:  # noqa: PERF203
                    last_exc = exc
                    if attempt == times - 1:
                        break
                    jitter_sleep(base_delay * (2**attempt))
            assert last_exc is not None
            raise last_exc

        return wrapper

    return decorator


def truncate(text: str | None, limit: int = 500) -> str:
    if not text:
        return ""
    text = text.strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"
