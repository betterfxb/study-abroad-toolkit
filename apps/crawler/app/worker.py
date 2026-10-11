"""Celery 应用。

启动 Worker: celery -A app.worker:celery_app worker -l info
启动 Beat:   celery -A app.worker:celery_app beat -l info
"""

from __future__ import annotations

from celery import Celery
from celery.schedules import crontab

from .config import settings

celery_app = Celery(
    "crawler",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["app.tasks"],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="Asia/Shanghai",
    enable_utc=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    task_time_limit=600,
    task_soft_time_limit=540,
    broker_connection_retry_on_startup=True,
)

# 定时任务：默认每日 3 次错峰采集（可按源在 crawl_sources.interval_cron 覆盖）
celery_app.conf.beat_schedule = {
    "crawl-daily-morning": {
        "task": "app.tasks.run_all_sources",
        "schedule": crontab(hour=7, minute=30),
    },
    "crawl-daily-noon": {
        "task": "app.tasks.run_all_sources",
        "schedule": crontab(hour=12, minute=30),
    },
    "crawl-daily-evening": {
        "task": "app.tasks.run_all_sources",
        "schedule": crontab(hour=19, minute=30),
    },
    "refresh-source-health": {
        "task": "app.tasks.refresh_source_health",
        "schedule": crontab(minute="*/30"),
    },
    # 过期下架：每日凌晨执行一次（错开 3 次采集节拍）
    "expire-jobs-daily": {
        "task": "app.tasks.expire_jobs",
        "schedule": crontab(hour=2, minute=5),
    },
}
