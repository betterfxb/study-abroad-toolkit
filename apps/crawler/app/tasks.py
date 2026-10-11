"""Celery 任务：单源采集、全源调度、健康度刷新。"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .adapters import create_adapter
from .db import get_session
from .models import CrawlLog, CrawlSource, CrawlTask, SourceHealth
from .services.pipeline import Pipeline, SqlRepository
from .utils import get_logger
from .worker import celery_app

log = get_logger(__name__)


def _idem_key(source_id: int, window_minutes: int = 30) -> str:
    """幂等键：源 + 时间窗。"""
    bucket = int(datetime.now(timezone.utc).timestamp() // (window_minutes * 60))
    return f"src{source_id}:{bucket}"


@celery_app.task(name="app.tasks.run_source", bind=True, max_retries=2)
def run_source_task(self, source_id: int, limit: int = 50, use_llm: bool = True) -> dict[str, Any]:
    """执行单个源的采集。"""
    gen = get_session()
    session = next(gen)
    task_row: CrawlTask | None = None
    try:
        source = session.get(CrawlSource, source_id)
        if source is None:
            return {"ok": False, "error": f"source {source_id} 不存在"}
        if not source.enabled:
            return {"ok": False, "error": f"source {source_id} 已停用"}

        idem = _idem_key(source_id)
        existing = (
            session.query(CrawlTask)
            .filter(CrawlTask.idem_key == idem)
            .one_or_none()
        )
        if existing and existing.status == "success":
            return {"ok": True, "skipped": True, "reason": "本时间窗已成功执行"}

        task_row = existing or CrawlTask(source_id=source_id, idem_key=idem, status="running")
        task_row.status = "running"
        task_row.started_at = datetime.now(timezone.utc)
        if existing is None:
            session.add(task_row)
        session.commit()

        adapter = create_adapter(source.adapter, source.config or {})
        repo = SqlRepository(session)
        result = Pipeline(use_llm=use_llm).run(adapter, source.id, repo, limit=limit)

        task_row.status = "failed" if result.errors and result.new_articles == 0 else "success"
        task_row.finished_at = datetime.now(timezone.utc)
        task_row.item_count = result.new_jobs
        task_row.error = "; ".join(result.errors[:5]) or None
        session.add(
            CrawlLog(
                task_id=task_row.id,
                level="warn" if result.errors else "info",
                message=str(result.to_dict())[:2000],
                http_status=result.http_status,
                rate_limited=result.rate_limited,
            )
        )
        session.commit()
        return {"ok": True, **result.to_dict()}

    except Exception as exc:  # noqa: BLE001
        session.rollback()
        log.exception("采集任务失败 source_id=%s", source_id)
        if task_row is not None:
            task_row.status = "failed"
            task_row.error = str(exc)[:2000]
            task_row.finished_at = datetime.now(timezone.utc)
            session.add(task_row)
            session.commit()
        raise self.retry(exc=exc, countdown=60)
    finally:
        try:
            next(gen)
        except StopIteration:
            pass


@celery_app.task(name="app.tasks.run_all_sources")
def run_all_sources(limit: int = 50) -> dict[str, Any]:
    """按优先级遍历所有启用的源，逐个下发采集任务。"""
    gen = get_session()
    session = next(gen)
    try:
        sources = (
            session.query(CrawlSource)
            .filter(CrawlSource.enabled.is_(True))
            .order_by(CrawlSource.priority.asc())
            .all()
        )
        dispatched = []
        for source in sources:
            run_source_task.delay(source.id, limit=limit)
            dispatched.append(source.code)
        log.info("已下发 %d 个源: %s", len(dispatched), dispatched)
        return {"ok": True, "dispatched": dispatched}
    finally:
        try:
            next(gen)
        except StopIteration:
            pass


@celery_app.task(name="app.tasks.expire_jobs")
def expire_jobs_task() -> dict[str, Any]:
    """过期下架：deadline 早于今天的 active 岗位批量置 expired（每日节拍调用）。"""
    from .services.expiry import expire_jobs

    gen = get_session()
    session = next(gen)
    try:
        result = expire_jobs(session)
        log.info("过期下架完成：%s 条", result["expired"])
        return result
    finally:
        try:
            next(gen)
        except StopIteration:
            pass


@celery_app.task(name="app.tasks.refresh_source_health")
def refresh_source_health() -> dict[str, Any]:
    """刷新各源健康度评分（成功率 60% + 时延 20% + 产出 20%）。"""
    gen = get_session()
    session = next(gen)
    try:
        sources = session.query(CrawlSource).all()
        updated = 0
        for source in sources:
            tasks = (
                session.query(CrawlTask)
                .filter(CrawlTask.source_id == source.id)
                .order_by(CrawlTask.created_at.desc())
                .limit(20)
                .all()
            )
            if not tasks:
                continue
            total = len(tasks)
            success = sum(1 for t in tasks if t.status == "success")
            success_rate = success / total
            item_count = sum(t.item_count or 0 for t in tasks)
            score = round(success_rate * 60 + min(item_count / 100, 1) * 20 + 20 * success_rate, 2)
            session.add(
                SourceHealth(
                    source_id=source.id,
                    success_rate=success_rate,
                    item_count=item_count,
                    score=score,
                )
            )
            updated += 1
        session.commit()
        return {"ok": True, "updated": updated}
    finally:
        try:
            next(gen)
        except StopIteration:
            pass
