"""岗位库查询：列表 / 详情 / 聚合筛选项 / CSV 导出。

读侧统一入口，供 `/jobs` 系列接口与「实习信息汇总表」导出复用。
查询条件全部用 SQLAlchemy 表达式构造，PostgreSQL 与 SQLite 通用。
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, replace
from datetime import date, datetime, time, timezone
from typing import Any

from ..utils import get_logger

log = get_logger(__name__)

DEFAULT_SIZE = 50
MAX_SIZE = 200

# 可排序字段 → 归属表（published_at 在 articles 上，其余在 jobs 上）
SORT_FIELDS: dict[str, str] = {
    "published_at": "article",
    "created_at": "job",
    "deadline": "job",
    "confidence": "job",
    "company": "job",
    "city": "job",
}
DEFAULT_SORT = "published_at:desc"

# 汇总表 / CSV 列（顺序即导出顺序）
CSV_COLUMNS: list[tuple[str, str]] = [
    ("id", "ID"),
    ("company", "公司"),
    ("title", "岗位"),
    ("city", "城市"),
    ("salary", "薪资"),
    ("duration", "实习时长"),
    ("education_req", "学历要求"),
    ("major_req", "专业要求"),
    ("retain_chance", "留用机会"),
    ("deadline", "截止日期"),
    ("apply_method", "投递方式"),
    ("apply_url", "投递链接"),
    ("confidence", "置信度"),
    ("status", "状态"),
    ("tags", "标签"),
    ("source_account", "来源公众号"),
    ("article_url", "原文链接"),
    ("published_at", "发布时间"),
]


@dataclass
class JobFilter:
    """岗位查询条件。"""

    keyword: str | None = None
    city: str | None = None
    company: str | None = None
    education: str | None = None
    status: str = "active"
    min_confidence: float | None = None
    date_from: date | None = None
    date_to: date | None = None
    has_deadline: bool | None = None
    sort: str = DEFAULT_SORT
    page: int = 1
    size: int = DEFAULT_SIZE

    def normalized(self) -> "JobFilter":
        """收敛非法取值，保证下游查询不会因脏参数报错。"""
        page = max(1, int(self.page or 1))
        size = int(self.size or DEFAULT_SIZE)
        size = max(1, min(size, MAX_SIZE))
        status = (self.status or "active").strip() or "active"
        return replace(
            self,
            page=page,
            size=size,
            status=status,
            keyword=(self.keyword or "").strip() or None,
            city=(self.city or "").strip() or None,
            company=(self.company or "").strip() or None,
            education=(self.education or "").strip() or None,
            sort=_normalize_sort(self.sort),
        )

    def offset(self) -> int:
        return (self.page - 1) * self.size


def _normalize_sort(raw: str | None) -> str:
    if not raw:
        return DEFAULT_SORT
    field, _, direction = str(raw).partition(":")
    field = field.strip()
    direction = (direction or "desc").strip().lower()
    if field not in SORT_FIELDS:
        return DEFAULT_SORT
    if direction not in ("asc", "desc"):
        direction = "desc"
    return f"{field}:{direction}"


# ------------------------------------------------------------------ 查询构造
def _base_query(f: JobFilter):
    """构造带筛选条件的 `select(Job, Article)`。"""
    from sqlalchemy import or_, select

    from ..models import Article, Job

    stmt = select(Job, Article).join(Article, Job.article_id == Article.id)
    stmt = stmt.where(Job.deleted_at.is_(None), Article.deleted_at.is_(None))

    if f.status != "all":
        stmt = stmt.where(Job.status == f.status)
    if f.city:
        stmt = stmt.where(Job.city == f.city)
    if f.company:
        stmt = stmt.where(Job.company.ilike(f"%{f.company}%"))
    if f.education:
        stmt = stmt.where(Job.education_req == f.education)
    if f.min_confidence is not None:
        stmt = stmt.where(Job.confidence >= f.min_confidence)
    if f.keyword:
        pat = f"%{f.keyword}%"
        stmt = stmt.where(
            or_(
                Job.company.ilike(pat),
                Job.title.ilike(pat),
                Job.major_req.ilike(pat),
                Article.title.ilike(pat),
            )
        )
    if f.date_from:
        stmt = stmt.where(Article.published_at >= datetime.combine(f.date_from, time.min, tzinfo=timezone.utc))
    if f.date_to:
        stmt = stmt.where(Article.published_at <= datetime.combine(f.date_to, time.max, tzinfo=timezone.utc))
    if f.has_deadline is True:
        stmt = stmt.where(Job.deadline.is_not(None))
    elif f.has_deadline is False:
        stmt = stmt.where(Job.deadline.is_(None))

    return stmt


def _order_by(f: JobFilter):
    from sqlalchemy import asc, desc

    from ..models import Article, Job

    field, _, direction = f.sort.partition(":")
    owner = SORT_FIELDS[field]
    column = Article.published_at if owner == "article" else getattr(Job, field)
    primary = desc(column) if direction == "desc" else asc(column)
    # 次级排序保证分页稳定（同一排序值下顺序不会漂移）
    return [primary, desc(Job.id)]


# ------------------------------------------------------------------ 序列化
def job_to_dict(job: Any, article: Any, tags: list[str] | None = None) -> dict[str, Any]:
    """岗位 → 对外 JSON（对齐 docs/02-详细设计/03-接口契约.md §6.1）。"""
    return {
        "id": job.id,
        "company": job.company,
        "title": job.title,
        "city": job.city,
        "salary": job.salary,
        "duration": job.duration,
        "education_req": job.education_req,
        "major_req": job.major_req,
        "retain_chance": job.retain_chance,
        "apply_method": job.apply_method,
        "apply_url": job.apply_url,
        "deadline": job.deadline.isoformat() if job.deadline else None,
        "confidence": float(job.confidence) if job.confidence is not None else None,
        "status": job.status,
        "tags": tags or [],
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "article": {
            "id": article.id,
            "title": article.title,
            "account_name": article.account_name,
            "url": article.url,
            "published_at": article.published_at.isoformat() if article.published_at else None,
        },
    }


def _fetch_tags(session: Any, job_ids: list[int]) -> dict[int, list[str]]:
    from sqlalchemy import select

    from ..models import JobTag

    if not job_ids:
        return {}
    rows = session.execute(
        select(JobTag.job_id, JobTag.tag).where(JobTag.job_id.in_(job_ids))
    ).all()
    out: dict[int, list[str]] = {}
    for job_id, tag in rows:
        out.setdefault(job_id, []).append(tag)
    return out


# ------------------------------------------------------------------ 对外方法
def list_jobs(session: Any, f: JobFilter) -> dict[str, Any]:
    """分页查询岗位列表。"""
    from sqlalchemy import func

    f = f.normalized()
    total = int(session.execute(_base_query(f).with_only_columns(func.count())).scalar_one())

    rows = session.execute(
        _base_query(f).order_by(*_order_by(f)).limit(f.size).offset(f.offset())
    ).all()
    tags_map = _fetch_tags(session, [j.id for j, _ in rows])
    items = [job_to_dict(j, a, tags_map.get(j.id)) for j, a in rows]

    return {"total": total, "page": f.page, "size": f.size, "items": items}


def get_job(session: Any, job_id: int) -> dict[str, Any] | None:
    """岗位详情（含软删除过滤）。"""
    from sqlalchemy import select

    from ..models import Article, Job

    row = session.execute(
        select(Job, Article)
        .join(Article, Job.article_id == Article.id)
        .where(Job.id == job_id, Job.deleted_at.is_(None))
    ).first()
    if row is None:
        return None
    job, article = row
    return job_to_dict(job, article, _fetch_tags(session, [job.id]).get(job.id))


def facets(session: Any, f: JobFilter, top: int = 20) -> dict[str, Any]:
    """聚合筛选项。各维度统计时**排除自身筛选条件**（标准分面搜索行为）。"""
    from sqlalchemy import func, select

    from ..models import Job, JobTag

    def _group(column, exclude_field: str) -> list[dict[str, Any]]:
        sub = replace(f.normalized(), **{exclude_field: None})
        stmt = (
            _base_query(sub)
            .with_only_columns(column, func.count())
            .where(column.is_not(None), column != "")
            .group_by(column)
            .order_by(func.count().desc(), column.asc())
            .limit(top)
        )
        return [{"value": v, "count": c} for v, c in session.execute(stmt).all()]

    # 标签统计：先取符合条件的岗位 id，再按标签聚合
    sub_ids = _base_query(f.normalized()).with_only_columns(Job.id).subquery()
    tag_rows = session.execute(
        select(JobTag.tag, func.count())
        .where(JobTag.job_id.in_(select(sub_ids.c.id)))
        .group_by(JobTag.tag)
        .order_by(func.count().desc(), JobTag.tag.asc())
        .limit(top)
    ).all()

    return {
        "cities": _group(Job.city, "city"),
        "companies": _group(Job.company, "company"),
        "educations": _group(Job.education_req, "education"),
        "tags": [{"value": t, "count": c} for t, c in tag_rows],
    }


def to_csv(items: list[dict[str, Any]]) -> str:
    """把岗位列表渲染为 CSV 文本（带 UTF-8 BOM，Excel 直接打开不乱码）。"""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([label for _, label in CSV_COLUMNS])
    for it in items:
        article = it.get("article") or {}
        row = []
        for key, _ in CSV_COLUMNS:
            if key == "tags":
                value = "、".join(it.get("tags") or [])
            elif key == "source_account":
                value = article.get("account_name")
            elif key == "article_url":
                value = article.get("url")
            elif key == "published_at":
                value = article.get("published_at")
            else:
                value = it.get(key)
            row.append("" if value is None else value)
        writer.writerow(row)
    return "\ufeff" + buf.getvalue()


def export_jobs(session: Any, f: JobFilter, max_rows: int = 5000) -> tuple[str, int]:
    """导出符合条件的岗位为 CSV，返回 (csv_text, 符合条件的总数)。"""
    from sqlalchemy import func

    f = replace(f.normalized(), page=1, size=max_rows)
    total = int(session.execute(_base_query(f).with_only_columns(func.count())).scalar_one())

    rows = session.execute(_base_query(f).order_by(*_order_by(f)).limit(max_rows)).all()
    tags_map = _fetch_tags(session, [j.id for j, _ in rows])
    items = [job_to_dict(j, a, tags_map.get(j.id)) for j, a in rows]
    return to_csv(items), total
