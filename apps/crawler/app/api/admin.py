"""管理接口：源管理、手动触发、健康度、降级开关、任务查询。

对应 docs/02-详细设计/03-接口契约.md §6.3。
依赖数据库；数据库不可用时返回 503，不影响 /health 与 /internal/* 的可用性。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..adapters import create_adapter, list_adapters
from ..services import degrade
from ..utils import get_logger
from .deps import get_db

log = get_logger(__name__)
router = APIRouter(prefix="/admin", tags=["admin"])

DEGRADE_KEY = "crawler.degrade_level"


# ------------------------------------------------------------------ 模型
class SourceIn(BaseModel):
    code: str
    name: str
    source_type: str
    adapter: str
    config: dict[str, Any] = Field(default_factory=dict)
    interval_cron: str | None = None
    rate_limit: int = 10
    enabled: bool = True
    priority: int = 100


class SourcePatch(BaseModel):
    name: str | None = None
    config: dict[str, Any] | None = None
    interval_cron: str | None = None
    rate_limit: int | None = None
    enabled: bool | None = None
    priority: int | None = None


class DegradeIn(BaseModel):
    level: int = Field(..., ge=0, le=3)
    reason: str = ""


# ------------------------------------------------------------------ 工具
def _read_degrade_level(session) -> int:
    from ..models import SystemConfig

    row = session.execute(
        select(SystemConfig).where(SystemConfig.key == DEGRADE_KEY)
    ).scalar_one_or_none()
    if row is None:
        return 0
    value = row.value or {}
    return int(value.get("level", value) if isinstance(value, dict) else value)


def _write_degrade_level(session, level: int, reason: str) -> None:
    from ..models import SystemConfig

    row = session.execute(
        select(SystemConfig).where(SystemConfig.key == DEGRADE_KEY)
    ).scalar_one_or_none()
    payload = {"level": level, "reason": reason, "updated_at": datetime.now(timezone.utc).isoformat()}
    if row is None:
        session.add(
            SystemConfig(key=DEGRADE_KEY, value=payload, description="采集降级层级: 0=全自动 1=切源 2=半自动 3=人工")
        )
    else:
        row.value = payload


def _source_dict(row) -> dict[str, Any]:
    return {
        "id": row.id,
        "code": row.code,
        "name": row.name,
        "source_type": row.source_type,
        "adapter": row.adapter,
        "config": row.config or {},
        "interval_cron": row.interval_cron,
        "rate_limit": row.rate_limit,
        "enabled": row.enabled,
        "priority": row.priority,
    }


# ------------------------------------------------------------------ 元信息
@router.get("/adapters")
def adapters() -> list[dict[str, str]]:
    return list_adapters()


@router.get("/degrade")
def get_degrade(session=Depends(get_db)) -> dict[str, Any]:
    level = _read_degrade_level(session)
    return {"current": degrade.describe(level), "levels": {k: v[1] for k, v in degrade.LEVELS.items()}}


@router.post("/degrade")
def set_degrade(payload: DegradeIn, session=Depends(get_db)) -> dict[str, Any]:
    _write_degrade_level(session, payload.level, payload.reason or "手动切换")
    log.warning("降级层级手动切换为 %s：%s", payload.level, payload.reason)
    return {"ok": True, "current": degrade.describe(payload.level)}


@router.post("/degrade/evaluate")
def evaluate_degrade(session=Depends(get_db)) -> dict[str, Any]:
    """依据源健康度自动评估应处的降级层级（不落库）。"""
    snapshots = _build_snapshots(session)
    current = _read_degrade_level(session)
    decision = degrade.evaluate(snapshots, current)
    return {"current_level": current, "decision": decision.to_dict()}


def _build_snapshots(session) -> list[degrade.SourceHealthSnapshot]:
    from ..models import CrawlSource, CrawlTask

    snapshots: list[degrade.SourceHealthSnapshot] = []
    sources = session.execute(select(CrawlSource)).scalars().all()
    for src in sources:
        tasks = (
            session.execute(
                select(CrawlTask)
                .where(CrawlTask.source_id == src.id)
                .order_by(CrawlTask.created_at.desc())
                .limit(20)
            )
            .scalars()
            .all()
        )
        if tasks:
            success = sum(1 for t in tasks if t.status == "success")
            success_rate = success / len(tasks)
            consecutive = 0
            for t in tasks:
                if t.status == "success":
                    break
                consecutive += 1
            item_count = sum(t.item_count or 0 for t in tasks)
        else:
            success_rate, consecutive, item_count = 1.0, 0, 0
        snapshots.append(
            degrade.SourceHealthSnapshot(
                code=src.code,
                source_type=src.source_type,
                enabled=src.enabled,
                success_rate=success_rate,
                consecutive_failures=consecutive,
                item_count=item_count,
            )
        )
    return snapshots


# ------------------------------------------------------------------ 源管理
@router.get("/sources")
def list_sources(session=Depends(get_db)) -> list[dict[str, Any]]:
    from ..models import CrawlSource

    rows = session.execute(select(CrawlSource).order_by(CrawlSource.priority)).scalars().all()
    return [_source_dict(r) for r in rows]


@router.post("/sources", status_code=201)
def create_source(payload: SourceIn, session=Depends(get_db)) -> dict[str, Any]:
    from ..models import CrawlSource

    if session.execute(select(CrawlSource).where(CrawlSource.code == payload.code)).scalar_one_or_none():
        raise HTTPException(status_code=409, detail=f"源 code 已存在: {payload.code}")
    try:
        create_adapter(payload.adapter, payload.config)
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    row = CrawlSource(**payload.model_dump())
    session.add(row)
    session.flush()
    return _source_dict(row)


@router.patch("/sources/{source_id}")
def update_source(source_id: int, payload: SourcePatch, session=Depends(get_db)) -> dict[str, Any]:
    from ..models import CrawlSource

    row = session.get(CrawlSource, source_id)
    if row is None:
        raise HTTPException(status_code=404, detail="源不存在")
    for key, value in payload.model_dump(exclude_none=True).items():
        setattr(row, key, value)
    session.flush()
    return _source_dict(row)


@router.post("/sources/{source_id}/run")
def run_source(source_id: int, limit: int = Query(50, ge=1, le=500), use_llm: bool = True) -> dict[str, Any]:
    """手动触发一次采集（异步，经 Celery）。"""
    try:
        from ..tasks import run_source_task
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=503, detail=f"任务队列不可用: {exc}") from exc
    async_result = run_source_task.delay(source_id, limit=limit, use_llm=use_llm)
    return {"ok": True, "task_id": async_result.id}


@router.get("/sources/{source_id}/health")
def source_health(source_id: int, hours: int = Query(24, ge=1, le=720), session=Depends(get_db)) -> dict[str, Any]:
    from ..models import SourceHealth

    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    rows = (
        session.execute(
            select(SourceHealth)
            .where(SourceHealth.source_id == source_id, SourceHealth.measured_at >= since)
            .order_by(SourceHealth.measured_at.desc())
            .limit(200)
        )
        .scalars()
        .all()
    )
    return {
        "source_id": source_id,
        "hours": hours,
        "points": [
            {
                "success_rate": float(r.success_rate),
                "avg_latency_ms": r.avg_latency_ms,
                "item_count": r.item_count,
                "score": float(r.score),
                "measured_at": r.measured_at.isoformat() if r.measured_at else None,
            }
            for r in rows
        ],
    }


# ------------------------------------------------------------------ 岗位过期下架
@router.post("/jobs/expire")
def expire_jobs_now(session=Depends(get_db)) -> dict[str, Any]:
    """手动触发过期下架（定时由 Beat 每日执行，本接口用于验证与补跑）。"""
    from ..services.expiry import expire_jobs

    result = expire_jobs(session)
    log.info("手动过期下架：%s 条", result["expired"])
    return result


# ------------------------------------------------------------------ 任务
@router.get("/tasks")
def list_tasks(
    source_id: int | None = None,
    status: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    session=Depends(get_db),
) -> list[dict[str, Any]]:
    from ..models import CrawlTask

    stmt = select(CrawlTask).order_by(CrawlTask.created_at.desc()).limit(limit)
    if source_id is not None:
        stmt = stmt.where(CrawlTask.source_id == source_id)
    if status:
        stmt = stmt.where(CrawlTask.status == status)
    rows = session.execute(stmt).scalars().all()
    return [
        {
            "id": r.id,
            "source_id": r.source_id,
            "status": r.status,
            "item_count": r.item_count,
            "error": r.error,
            "started_at": r.started_at.isoformat() if r.started_at else None,
            "finished_at": r.finished_at.isoformat() if r.finished_at else None,
        }
        for r in rows
    ]
