"""API 公共依赖。

`get_db` 统一处理「数据库不可用 → 503」的降级语义：
数据库依赖缺失或连接初始化失败时返回 503，而不是 500，且不影响 /health 等无库接口。
"""

from __future__ import annotations

from fastapi import HTTPException


def get_db():
    try:
        from ..db import get_session_factory
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=503, detail=f"数据库依赖不可用: {exc}") from exc

    try:
        factory = get_session_factory()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"数据库连接初始化失败: {exc}") from exc

    session = factory()
    try:
        yield session
        session.commit()
    except HTTPException:
        session.rollback()
        raise
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
