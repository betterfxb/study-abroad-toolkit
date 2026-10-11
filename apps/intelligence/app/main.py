"""FastAPI 应用入口。

启动: uvicorn app.main:app --host 0.0.0.0 --port 8090 --reload
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .api.ext import router as ext_router
from .api.internal import router as internal_router
from .config import settings
from .dictionary import load_dictionary
from .utils import get_logger

log = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("%s v%s 启动 (env=%s)", settings.app_name, __version__, settings.env)
    try:
        slots = load_dictionary()
        log.info("字段词典已加载：%s 个语义槽位", len(slots))
    except FileNotFoundError as exc:
        log.error("字段词典加载失败：%s", exc)
    log.info(
        "匹配阈值：自动填 %.2f / 复核 %.2f",
        settings.auto_fill_threshold, settings.review_threshold,
    )
    yield
    log.info("%s 关闭", settings.app_name)


app = FastAPI(
    title="intelligence-service",
    version=__version__,
    description="留学网申字段语义匹配与值转换服务",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if not settings.is_prod else [],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ext_router)
app.include_router(internal_router)


@app.get("/", tags=["meta"])
def root() -> dict[str, str]:
    return {"service": settings.app_name, "version": __version__, "docs": "/docs"}


@app.get("/health", tags=["meta"])
def health() -> dict[str, object]:
    try:
        count = len(load_dictionary())
    except FileNotFoundError:
        count = -1
    return {
        "ok": count > 0,
        "service": settings.app_name,
        "version": __version__,
        "env": settings.env,
        "dictionary_slots": count,
        "auto_fill_threshold": settings.auto_fill_threshold,
        "review_threshold": settings.review_threshold,
    }
