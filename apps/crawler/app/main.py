"""FastAPI 应用入口。

启动: uvicorn app.main:app --host 0.0.0.0 --port 8100 --reload
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .api.admin import router as admin_router
from .api.internal import router as internal_router
from .api.jobs import router as jobs_router
from .config import settings
from .utils import get_logger

log = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("%s v%s 启动 (env=%s)", settings.app_name, __version__, settings.env)
    if not settings.store_full_text:
        log.info("合规模式：仅存储摘要 + 原文链接，不存全文")
    yield
    log.info("%s 关闭", settings.app_name)


app = FastAPI(
    title="crawler-service",
    version=__version__,
    description="实习信息多源采集与结构化服务",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if not settings.is_prod else [],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(internal_router)
app.include_router(admin_router)
app.include_router(jobs_router)


@app.get("/", tags=["meta"])
def root() -> dict[str, str]:
    return {"service": settings.app_name, "version": __version__, "docs": "/docs"}


@app.get("/health", tags=["meta"])
def health() -> dict[str, object]:
    return {
        "ok": True,
        "service": settings.app_name,
        "version": __version__,
        "env": settings.env,
        "degrade_level": settings.degrade_level,
        "respect_robots": settings.respect_robots,
        "store_full_text": settings.store_full_text,
    }
