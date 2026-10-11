"""内部接口：供 scheduler / api-gateway 调用。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..adapters import create_adapter, list_adapters
from ..services import dedup, extract
from ..services.pipeline import InMemoryRepository, Pipeline

router = APIRouter(prefix="/internal", tags=["internal"])


class RunRequest(BaseModel):
    source_code: str = Field(..., description="源唯一标识")
    adapter: str = Field(..., description="适配器 code")
    config: dict[str, Any] = Field(default_factory=dict)
    source_id: int = 0
    limit: int = 50
    use_llm: bool = True


class ExtractRequest(BaseModel):
    content: str
    use_llm: bool = True


class DedupRequest(BaseModel):
    text_a: str
    text_b: str
    threshold: int = 3


@router.get("/health")
def health() -> dict[str, Any]:
    from ..config import settings

    return {
        "ok": True,
        "service": settings.app_name,
        "version": settings.version,
        "env": settings.env,
        "degrade_level": settings.degrade_level,
        "adapters": list_adapters(),
    }


@router.get("/adapters")
def adapters() -> list[dict[str, str]]:
    return list_adapters()


@router.post("/crawl/run")
def run_crawl(req: RunRequest) -> dict[str, Any]:
    """按源执行一次采集（内存仓储，用于连通性验证）。

    真实入库请走 Celery 任务 ``tasks.run_source_task``。
    """
    try:
        adapter = create_adapter(req.adapter, req.config)
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    repo = InMemoryRepository()
    result = Pipeline(use_llm=req.use_llm).run(adapter, req.source_id, repo, limit=req.limit)
    payload = result.to_dict()
    payload["articles"] = list(repo.articles.values())[:20]
    payload["jobs"] = list(repo.jobs.values())[:50]
    return payload


@router.post("/extract")
def run_extract(req: ExtractRequest) -> dict[str, Any]:
    jobs = extract.structure_jobs(req.content, use_llm=req.use_llm)
    return {"count": len(jobs), "jobs": jobs}


@router.post("/dedup/check")
def dedup_check(req: DedupRequest) -> dict[str, Any]:
    distance = dedup.hamming(dedup.simhash(req.text_a), dedup.simhash(req.text_b))
    return {
        "distance": distance,
        "threshold": req.threshold,
        "duplicate": distance <= req.threshold,
        "fingerprint_a": dedup.content_hash(req.text_a),
        "fingerprint_b": dedup.content_hash(req.text_b),
    }
