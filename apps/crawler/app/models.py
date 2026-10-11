"""SQLAlchemy ORM 模型（模块二相关表）。

与 db/migrations/0001_init.sql 保持一致。仅覆盖采集服务需要的表。
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    JSON,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

# 跨方言类型别名：
#   * 生产（PostgreSQL）保持 BIGINT / JSONB，行为与 db/migrations/0001_init.sql 一致；
#   * 本地无 PG 时（SQLite）自动降级为 INTEGER / JSON，使端到端链路可在无 Docker 环境验证。
# 注意：SQLite 仅支持 INTEGER 主键自增，因此主键必须带 sqlite 变体。
JSONType = JSON().with_variant(JSONB, "postgresql")
BigIntPK = BigInteger().with_variant(Integer, "sqlite")


class Base(DeclarativeBase):
    pass


class SystemConfig(Base):
    __tablename__ = "system_configs"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True)
    key: Mapped[str] = mapped_column(String(128), unique=True)
    value: Mapped[dict] = mapped_column(JSONType, default=dict)
    description: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class CrawlSource(Base):
    __tablename__ = "crawl_sources"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(128))
    source_type: Mapped[str] = mapped_column(String(24))
    adapter: Mapped[str] = mapped_column(String(64))
    config: Mapped[dict] = mapped_column(JSONType, default=dict)
    interval_cron: Mapped[str | None] = mapped_column(String(64))
    rate_limit: Mapped[int] = mapped_column(Integer, default=10)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    priority: Mapped[int] = mapped_column(Integer, default=100)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    tasks: Mapped[list["CrawlTask"]] = relationship(back_populates="source")


class CrawlTask(Base):
    __tablename__ = "crawl_tasks"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True)
    source_id: Mapped[int] = mapped_column(BigIntPK, ForeignKey("crawl_sources.id", ondelete="CASCADE"))
    idem_key: Mapped[str] = mapped_column(String(128), unique=True)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    item_count: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    source: Mapped[CrawlSource] = relationship(back_populates="tasks")


class CrawlLog(Base):
    __tablename__ = "crawl_logs"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True)
    task_id: Mapped[int] = mapped_column(BigIntPK, ForeignKey("crawl_tasks.id", ondelete="CASCADE"))
    level: Mapped[str] = mapped_column(String(8), default="info")
    message: Mapped[str | None] = mapped_column(Text)
    http_status: Mapped[int | None] = mapped_column(Integer)
    rate_limited: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Article(Base):
    __tablename__ = "articles"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True)
    source_id: Mapped[int] = mapped_column(BigIntPK, ForeignKey("crawl_sources.id", ondelete="CASCADE"))
    url: Mapped[str] = mapped_column(String(1024), unique=True)
    title: Mapped[str | None] = mapped_column(String(512))
    account_name: Mapped[str | None] = mapped_column(String(128))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cover_url: Mapped[str | None] = mapped_column(String(1024))
    summary: Mapped[str | None] = mapped_column(Text)
    content_hash: Mapped[str | None] = mapped_column(String(64))
    fingerprint: Mapped[str | None] = mapped_column(String(64))
    raw_meta: Mapped[dict] = mapped_column(JSONType, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True)
    article_id: Mapped[int] = mapped_column(BigIntPK, ForeignKey("articles.id", ondelete="CASCADE"))
    company: Mapped[str | None] = mapped_column(String(255))
    title: Mapped[str | None] = mapped_column(String(255))
    city: Mapped[str | None] = mapped_column(String(64))
    salary: Mapped[str | None] = mapped_column(String(128))
    duration: Mapped[str | None] = mapped_column(String(64))
    education_req: Mapped[str | None] = mapped_column(String(64))
    major_req: Mapped[str | None] = mapped_column(Text)
    apply_method: Mapped[str | None] = mapped_column(Text)
    apply_url: Mapped[str | None] = mapped_column(String(1024))
    deadline: Mapped[datetime | None] = mapped_column(Date)
    retain_chance: Mapped[str | None] = mapped_column(String(64))
    confidence: Mapped[float | None] = mapped_column(Numeric(4, 3))
    fingerprint: Mapped[str | None] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class JobTag(Base):
    __tablename__ = "job_tags"
    __table_args__ = (UniqueConstraint("job_id", "tag"),)

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True)
    job_id: Mapped[int] = mapped_column(BigIntPK, ForeignKey("jobs.id", ondelete="CASCADE"))
    tag: Mapped[str] = mapped_column(String(64))


class DedupIndex(Base):
    __tablename__ = "dedup_index"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True)
    fingerprint: Mapped[str] = mapped_column(String(64), unique=True)
    entity_type: Mapped[str] = mapped_column(String(16))
    entity_id: Mapped[int] = mapped_column(BigIntPK)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SourceHealth(Base):
    __tablename__ = "source_health"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True)
    source_id: Mapped[int] = mapped_column(BigIntPK, ForeignKey("crawl_sources.id", ondelete="CASCADE"))
    success_rate: Mapped[float] = mapped_column(Numeric(5, 4), default=0)
    avg_latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    item_count: Mapped[int] = mapped_column(Integer, default=0)
    score: Mapped[float] = mapped_column(Numeric(5, 2), default=0)
    measured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class LLMCallLog(Base):
    __tablename__ = "llm_call_logs"

    id: Mapped[int] = mapped_column(BigIntPK, primary_key=True)
    caller: Mapped[str] = mapped_column(String(64))
    task: Mapped[str] = mapped_column(String(64))
    model: Mapped[str] = mapped_column(String(64))
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    success: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
