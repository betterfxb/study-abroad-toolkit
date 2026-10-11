"""岗位库接口：列表 / 详情 / 聚合筛选项 / CSV 导出。

对应 docs/02-详细设计/03-接口契约.md §6.1。
依赖数据库；数据库不可用时返回 503（与 /admin/* 一致），不影响 /health。
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from ..services import jobs_query
from ..services.jobs_query import JobFilter
from ..utils import get_logger
from .deps import get_db

log = get_logger(__name__)
router = APIRouter(prefix="/jobs", tags=["jobs"])


def _build_filter(
    keyword: str | None,
    city: str | None,
    company: str | None,
    education: str | None,
    status: str,
    min_confidence: float | None,
    date_from: date | None,
    date_to: date | None,
    has_deadline: bool | None,
    sort: str,
    page: int,
    size: int,
) -> JobFilter:
    return JobFilter(
        keyword=keyword,
        city=city,
        company=company,
        education=education,
        status=status,
        min_confidence=min_confidence,
        date_from=date_from,
        date_to=date_to,
        has_deadline=has_deadline,
        sort=sort,
        page=page,
        size=size,
    )


# ------------------------------------------------------------------ 静态路径需先注册
@router.get("/facets", summary="聚合筛选项（城市/公司/学历/标签）")
def job_facets(
    keyword: str | None = None,
    city: str | None = None,
    company: str | None = None,
    education: str | None = None,
    status: str = "active",
    min_confidence: float | None = Query(None, ge=0, le=1),
    date_from: date | None = None,
    date_to: date | None = None,
    has_deadline: bool | None = None,
    top: int = Query(20, ge=1, le=100),
    session=Depends(get_db),
) -> dict[str, Any]:
    f = _build_filter(
        keyword, city, company, education, status, min_confidence,
        date_from, date_to, has_deadline, jobs_query.DEFAULT_SORT, 1, jobs_query.DEFAULT_SIZE,
    )
    return jobs_query.facets(session, f, top=top)


@router.get("/export.csv", summary="导出岗位汇总表（CSV，带 BOM）")
def export_jobs(
    keyword: str | None = None,
    city: str | None = None,
    company: str | None = None,
    education: str | None = None,
    status: str = "active",
    min_confidence: float | None = Query(None, ge=0, le=1),
    date_from: date | None = None,
    date_to: date | None = None,
    has_deadline: bool | None = None,
    sort: str = jobs_query.DEFAULT_SORT,
    max_rows: int = Query(5000, ge=1, le=50000),
    session=Depends(get_db),
) -> Response:
    f = _build_filter(
        keyword, city, company, education, status, min_confidence,
        date_from, date_to, has_deadline, sort, 1, jobs_query.DEFAULT_SIZE,
    )
    csv_text, total = jobs_query.export_jobs(session, f, max_rows=max_rows)
    log.info("导出岗位 CSV：命中 %s 条，导出上限 %s", total, max_rows)
    return Response(
        content=csv_text.encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="jobs.csv"'},
    )


@router.get("/{job_id}", summary="岗位详情")
def job_detail(job_id: int, session=Depends(get_db)) -> dict[str, Any]:
    data = jobs_query.get_job(session, job_id)
    if data is None:
        raise HTTPException(status_code=404, detail="岗位不存在")
    return data


@router.get("", summary="岗位列表（分页 + 筛选）")
def job_list(
    keyword: str | None = Query(None, description="关键词：公司/岗位/专业/文章标题"),
    city: str | None = Query(None, description="城市（已归一化，如 北京）"),
    company: str | None = Query(None, description="公司名，模糊匹配"),
    education: str | None = Query(None, description="学历要求，如 本科"),
    status: str = Query("active", description="active / expired / removed / all"),
    min_confidence: float | None = Query(None, ge=0, le=1, description="最低置信度"),
    date_from: date | None = Query(None, description="发布时间起（含）"),
    date_to: date | None = Query(None, description="发布时间止（含）"),
    has_deadline: bool | None = Query(None, description="是否已解析出截止日期"),
    sort: str = Query(jobs_query.DEFAULT_SORT, description="字段:方向，如 published_at:desc"),
    page: int = Query(1, ge=1),
    size: int = Query(jobs_query.DEFAULT_SIZE, ge=1, le=jobs_query.MAX_SIZE),
    session=Depends(get_db),
) -> dict[str, Any]:
    f = _build_filter(
        keyword, city, company, education, status, min_confidence,
        date_from, date_to, has_deadline, sort, page, size,
    )
    return jobs_query.list_jobs(session, f)
