"""采集流水线：fetch → 去重 → 抽取 → 入库。

仓储（Repository）抽象让同一套流水线既能跑真实 PostgreSQL，
也能跑内存实现（PoC / 单测零依赖）。
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Iterator, Protocol

from ..adapters.base import RawItem, SourceAdapter
from ..utils import get_logger
from . import dedup, extract

log = get_logger(__name__)

# jobs 表允许写入的列（防止源给出额外字段导致落库失败）
JOB_COLUMNS: frozenset[str] = frozenset({
    "company", "title", "city", "salary", "duration", "education_req",
    "major_req", "apply_method", "apply_url", "deadline", "retain_chance",
    "confidence", "fingerprint", "status",
})


@dataclass
class PipelineResult:
    source_code: str
    fetched: int = 0
    new_articles: int = 0
    new_jobs: int = 0
    duplicate_articles: int = 0
    duplicate_jobs: int = 0
    errors: list[str] = field(default_factory=list)
    rate_limited: bool = False
    http_status: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_code": self.source_code,
            "fetched": self.fetched,
            "new_articles": self.new_articles,
            "new_jobs": self.new_jobs,
            "duplicate_articles": self.duplicate_articles,
            "duplicate_jobs": self.duplicate_jobs,
            "errors": self.errors,
            "rate_limited": self.rate_limited,
            "http_status": self.http_status,
        }


class Repository(Protocol):
    """采集结果落库接口。"""

    def article_exists(self, url: str) -> bool: ...
    def fingerprint_exists(self, fingerprint: str, entity_type: str) -> bool: ...
    def save_article(self, source_id: int, data: dict[str, Any]) -> int: ...
    def save_job(self, article_id: int, data: dict[str, Any]) -> int: ...
    def register_fingerprint(self, fingerprint: str, entity_type: str, entity_id: int) -> None: ...


class Pipeline:
    def __init__(self, use_llm: bool = True) -> None:
        self.use_llm = use_llm

    def run(
        self,
        adapter: SourceAdapter,
        source_id: int,
        repo: Repository,
        limit: int = 50,
    ) -> PipelineResult:
        result = PipelineResult(source_code=adapter.code)

        try:
            fetched = adapter.fetch(limit=limit)
        except NotImplementedError as exc:
            result.errors.append(f"适配器未实现: {exc}")
            log.warning("适配器未实现 code=%s: %s", adapter.code, exc)
            return result
        except Exception as exc:  # noqa: BLE001
            result.errors.append(f"采集失败: {exc}")
            log.exception("采集失败 code=%s", adapter.code)
            return result

        result.rate_limited = fetched.rate_limited
        result.http_status = fetched.http_status
        result.fetched = fetched.count

        for item in fetched.items:
            try:
                self._process_one(item, source_id, repo, result)
            except Exception as exc:  # noqa: BLE001 - 单条失败不影响整批
                msg = f"处理失败 url={item.url}: {exc}"
                result.errors.append(msg)
                log.warning(msg)

        log.info("流水线完成 %s", result.to_dict())
        return result

    def _process_one(
        self,
        item: RawItem,
        source_id: int,
        repo: Repository,
        result: PipelineResult,
    ) -> None:
        """处理单条记录。

        仓储若提供 `item_scope()`（SAVEPOINT），则整条记录包在其中：
        单条写入失败只回滚该条，不会把整个批次的事务拖成待回滚状态。
        """
        scope = getattr(repo, "item_scope", None)
        if scope is None:
            self._process_item(item, source_id, repo, result)
            return
        with scope():
            self._process_item(item, source_id, repo, result)

    def _process_item(
        self,
        item: RawItem,
        source_id: int,
        repo: Repository,
        result: PipelineResult,
    ) -> None:
        if not item.url:
            return
        if repo.article_exists(item.url):
            result.duplicate_articles += 1
            return

        published = item.published_at or datetime.now(timezone.utc)
        art_fp = dedup.article_fingerprint(
            item.title, item.account_name, published.strftime("%Y-%m-%d")
        )
        if repo.fingerprint_exists(art_fp, "article"):
            result.duplicate_articles += 1
            return

        article_data = {
            "url": item.url,
            "title": item.title,
            "account_name": item.account_name,
            "published_at": published,
            "cover_url": item.cover_url,
            "summary": item.summary[:1000] if item.summary else "",
            "content_hash": dedup.content_hash(item.content),
            "fingerprint": art_fp,
            "raw_meta": item.extra,
        }
        article_id = repo.save_article(source_id, article_data)
        repo.register_fingerprint(art_fp, "article", article_id)
        result.new_articles += 1

        if item.job is not None:
            # 已结构化的源（JSON 招聘 API）：跳过抽取，直接标准化
            jobs = [extract.normalize_job(item.job)]
        else:
            jobs = extract.structure_jobs(item.content, use_llm=self.use_llm)

        for job in jobs:
            job_fp = dedup.job_fingerprint(
                job.get("company", ""), job.get("title", ""),
                job.get("city", ""), job.get("salary", ""),
            )
            if repo.fingerprint_exists(job_fp, "job"):
                result.duplicate_jobs += 1
                continue
            job_data = {
                k: v for k, v in job.items()
                if not k.startswith("_") and k in JOB_COLUMNS
            }
            job_data["fingerprint"] = job_fp
            job_id = repo.save_job(article_id, job_data)
            repo.register_fingerprint(job_fp, "job", job_id)
            result.new_jobs += 1


# --------------------------------------------------------------------------
# 内存仓储（PoC / 测试用，零依赖）
# --------------------------------------------------------------------------
class InMemoryRepository:
    def __init__(self) -> None:
        self.articles: dict[int, dict[str, Any]] = {}
        self.jobs: dict[int, dict[str, Any]] = {}
        self._urls: set[str] = set()
        self._fingerprints: dict[str, tuple[str, int]] = {}
        self._article_seq = 0
        self._job_seq = 0

    def article_exists(self, url: str) -> bool:
        return url in self._urls

    def fingerprint_exists(self, fingerprint: str, entity_type: str) -> bool:
        return fingerprint in self._fingerprints

    def save_article(self, source_id: int, data: dict[str, Any]) -> int:
        self._article_seq += 1
        aid = self._article_seq
        self.articles[aid] = {"id": aid, "source_id": source_id, **data}
        self._urls.add(data["url"])
        return aid

    def save_job(self, article_id: int, data: dict[str, Any]) -> int:
        self._job_seq += 1
        jid = self._job_seq
        self.jobs[jid] = {"id": jid, "article_id": article_id, **data}
        return jid

    def register_fingerprint(self, fingerprint: str, entity_type: str, entity_id: int) -> None:
        self._fingerprints[fingerprint] = (entity_type, entity_id)


# --------------------------------------------------------------------------
# SQLAlchemy 仓储（真实入库）
# --------------------------------------------------------------------------
def _to_date(value: Any) -> date | None:
    """把抽取产出的 ISO 日期字符串转成 date 对象。

    抽取层对外统一输出 ISO 字符串（便于 JSON / API 消费），
    但 jobs.deadline 是 DATE 列——PostgreSQL 会隐式转换，SQLite 不会，
    因此必须在落库边界显式转换。
    """
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _to_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


class SqlRepository:
    def __init__(self, session: Any) -> None:
        self.session = session

    @contextmanager
    def item_scope(self) -> Iterator[None]:
        """单条记录的 SAVEPOINT 作用域。

        没有它时，一条记录的 flush 失败会让整个 Session 进入「待回滚」状态，
        后续所有记录连带失败（一个脏字段 = 整批丢失）。有了它，失败只回滚该条。
        """
        nested = self.session.begin_nested()
        try:
            yield
            nested.commit()
        except Exception:
            nested.rollback()
            raise

    def article_exists(self, url: str) -> bool:
        from sqlalchemy import select

        from ..models import Article

        stmt = select(Article.id).where(Article.url == url).limit(1)
        return self.session.execute(stmt).first() is not None

    def fingerprint_exists(self, fingerprint: str, entity_type: str) -> bool:
        from sqlalchemy import select

        from ..models import DedupIndex

        stmt = (
            select(DedupIndex.id)
            .where(DedupIndex.fingerprint == fingerprint)
            .limit(1)
        )
        return self.session.execute(stmt).first() is not None

    def save_article(self, source_id: int, data: dict[str, Any]) -> int:
        from ..models import Article

        article = Article(source_id=source_id, **data)
        self.session.add(article)
        self.session.flush()
        return int(article.id)

    def save_job(self, article_id: int, data: dict[str, Any]) -> int:
        from ..models import Job

        payload = dict(data)
        payload["deadline"] = _to_date(payload.get("deadline"))
        payload["confidence"] = _to_float(payload.get("confidence"))
        job = Job(article_id=article_id, **payload)
        self.session.add(job)
        self.session.flush()
        return int(job.id)

    def register_fingerprint(self, fingerprint: str, entity_type: str, entity_id: int) -> None:
        from ..models import DedupIndex

        self.session.add(
            DedupIndex(fingerprint=fingerprint, entity_type=entity_type, entity_id=entity_id)
        )
        self.session.flush()
