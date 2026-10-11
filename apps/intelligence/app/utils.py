"""通用工具：日志、文本截断。零第三方依赖。"""

from __future__ import annotations

import logging

_LOG_FORMAT = "%(asctime)s | %(levelname)-5s | %(name)s | %(message)s"


def get_logger(name: str) -> logging.Logger:
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter(_LOG_FORMAT))
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
    return logger


def truncate(text: str | None, limit: int = 500) -> str:
    if not text:
        return ""
    text = str(text).strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"
