"""数据库连接：API 用 async，Worker 用 sync。"""

from __future__ import annotations

from functools import lru_cache

from .config import settings


def _sync_url(url: str) -> str:
    """把异步方言 URL 转成同步引擎可用的形式。

    * PostgreSQL：`+asyncpg` → `+psycopg`
    * SQLite：`sqlite+aiosqlite://` → `sqlite://`（同步引擎不认 aiosqlite 方言，
      否则会在同步 `create_engine` 上触发 MissingGreenlet）
    """
    if url.startswith("postgresql"):
        return url.replace("+asyncpg", "").replace("postgresql://", "postgresql+psycopg://", 1)
    return url.replace("sqlite+aiosqlite://", "sqlite://", 1)


@lru_cache(maxsize=1)
def get_sync_engine():
    from sqlalchemy import create_engine

    return create_engine(
        _sync_url(settings.database_url),
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=10,
        future=True,
    )


@lru_cache(maxsize=1)
def get_async_engine():
    from sqlalchemy.ext.asyncio import create_async_engine

    return create_async_engine(
        settings.database_url,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=10,
    )


@lru_cache(maxsize=1)
def get_session_factory():
    from sqlalchemy.orm import sessionmaker

    return sessionmaker(bind=get_sync_engine(), expire_on_commit=False, future=True)


def get_session():
    """同步会话上下文（Worker / 脚本使用）。"""
    factory = get_session_factory()
    session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def init_db() -> None:
    """建表（仅用于开发/PoC；生产走 migrations）。"""
    from .models import Base

    Base.metadata.create_all(get_sync_engine())
