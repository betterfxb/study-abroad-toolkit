"""运行配置。零第三方依赖，便于冒烟测试直接导入。"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _env(key: str, default: str) -> str:
    return os.environ.get(key, default)


def _env_int(key: str, default: int) -> int:
    raw = os.environ.get(key)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_bool(key: str, default: bool) -> bool:
    raw = os.environ.get(key)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    app_name: str = "crawler-service"
    version: str = "0.1.0"
    env: str = _env("APP_ENV", "dev")
    log_level: str = _env("LOG_LEVEL", "INFO")

    # 存储
    database_url: str = _env(
        "DATABASE_URL",
        "postgresql+asyncpg://postgres:postgres@localhost:5432/study_abroad",
    )
    redis_url: str = _env("REDIS_URL", "redis://localhost:6379/0")

    # LLM
    llm_provider: str = _env("LLM_PROVIDER", "openai")
    llm_base_url: str = _env("LLM_BASE_URL", "https://api.openai.com/v1")
    llm_api_key: str = _env("LLM_API_KEY", "")
    llm_model_fast: str = _env("LLM_MODEL_FAST", "gpt-4o-mini")
    llm_model_strong: str = _env("LLM_MODEL_STRONG", "gpt-4o")
    llm_timeout_s: int = _env_int("LLM_TIMEOUT_S", 30)
    llm_max_retries: int = _env_int("LLM_MAX_RETRIES", 3)

    # 采集
    user_agent: str = _env(
        "CRAWLER_UA",
        "Mozilla/5.0 (compatible; StudyAbroadBot/0.1; +https://example.com/bot)",
    )
    proxy_url: str = _env("CRAWLER_PROXY", "")
    request_timeout_s: int = _env_int("CRAWLER_TIMEOUT_S", 20)
    default_rate_limit: int = _env_int("CRAWLER_RATE_LIMIT", 10)
    max_concurrency: int = _env_int("CRAWLER_CONCURRENCY", 4)

    # 合规开关
    respect_robots: bool = _env_bool("CRAWLER_RESPECT_ROBOTS", True)
    store_full_text: bool = _env_bool("CRAWLER_STORE_FULLTEXT", False)
    degrade_level: int = _env_int("CRAWLER_DEGRADE_LEVEL", 0)

    # 去重
    simhash_bits: int = _env_int("DEDUP_SIMHASH_BITS", 64)
    simhash_threshold: int = _env_int("DEDUP_SIMHASH_THRESHOLD", 8)

    @property
    def is_prod(self) -> bool:
        return self.env.lower() in {"prod", "production"}


settings = Settings()
