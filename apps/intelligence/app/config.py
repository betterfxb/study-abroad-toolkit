"""intelligence-service 运行配置。零第三方依赖，便于冒烟测试直接导入。"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


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


def _env_float(key: str, default: float) -> float:
    raw = os.environ.get(key)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_bool(key: str, default: bool) -> bool:
    raw = os.environ.get(key)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# 仓库根目录：apps/intelligence/app/config.py → parents[3]
ROOT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class Settings:
    app_name: str = "intelligence-service"
    version: str = "0.1.0"
    env: str = _env("APP_ENV", "dev")
    log_level: str = _env("LOG_LEVEL", "INFO")

    # 字段词典（共享资产，插件 TS 端也读同一份）
    dictionary_path: str = _env(
        "FIELD_DICTIONARY_PATH",
        str(ROOT / "packages" / "field-dictionary" / "fields.json"),
    )

    # 匹配阈值（对应架构详设 §3 置信度分级）
    auto_fill_threshold: float = _env_float("MATCH_AUTO_THRESHOLD", 0.90)
    review_threshold: float = _env_float("MATCH_REVIEW_THRESHOLD", 0.60)

    # LLM（三级匹配的第三级兜底；不可用时自动跳过）
    llm_provider: str = _env("LLM_PROVIDER", "openai")
    llm_base_url: str = _env("LLM_BASE_URL", "https://api.openai.com/v1")
    llm_api_key: str = _env("LLM_API_KEY", "")
    llm_model_fast: str = _env("LLM_MODEL_FAST", "gpt-4o-mini")
    llm_model_strong: str = _env("LLM_MODEL_STRONG", "gpt-4o")
    llm_timeout_s: int = _env_int("LLM_TIMEOUT_S", 30)
    llm_max_retries: int = _env_int("LLM_MAX_RETRIES", 3)

    # 服务
    host: str = _env("HOST", "0.0.0.0")
    port: int = _env_int("PORT", 8090)

    # 合规：敏感字段默认不上云（架构详设 §3 关键设计点 5）
    local_only_fields: tuple[str, ...] = (
        "basic_info.passport_name",
        "basic_info.passport_number",
        "documents.transcript",
    )

    @property
    def is_prod(self) -> bool:
        return self.env.lower() in {"prod", "production"}


settings = Settings()
