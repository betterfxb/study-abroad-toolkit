"""端到端测试：采集 → 入库 → 岗位库查询。

用真实 SQLite 落地（无需 Docker / PostgreSQL），验证：
  1. Pipeline 经 SqlRepository 正确写入 articles / jobs / dedup_index
  2. 重复采集幂等（文章级 + 岗位级去重）
  3. 岗位库查询：筛选 / 分页 / 排序 / 聚合 / 详情 / CSV 导出
  4. FastAPI /jobs 系列接口（依赖注入覆盖到 SQLite 会话）

运行：python apps/crawler/tests/e2e_jobs_test.py
"""

from __future__ import annotations

import sys
import tempfile
import warnings
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# starlette 对 httpx 的弃用提示与本次验证无关，屏蔽以保持输出干净
warnings.filterwarnings("ignore", message="Using `httpx` with `starlette.testclient` is deprecated")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from app.adapters.base import FetchResult, RawItem, SourceAdapter  # noqa: E402
from app.adapters.registry import register  # noqa: E402
from app.models import Base, CrawlSource, JobTag  # noqa: E402
from app.services import jobs_query  # noqa: E402
from app.services.jobs_query import JobFilter  # noqa: E402
from app.services.pipeline import Pipeline, SqlRepository  # noqa: E402

PASSED: list[str] = []
FAILED: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        PASSED.append(name)
        print(f"  [PASS] {name}")
    else:
        FAILED.append(f"{name} {detail}")
        print(f"  [FAIL] {name} {detail}")


def article(company: str, title: str, city: str, salary: str, deadline: str, email: str) -> str:
    return (
        f"【公司】{company}\n【岗位】{title}\n工作地点：{city}\n薪资：{salary}\n"
        f"学历要求：本科\n截止日期：{deadline}\n投递方式：{email}"
    )


_SEED = [
    ("理想汽车", "数据分析实习生", "北京市", "200-250元/天", "2026-11-30", "hr@lixiang.com"),
    ("字节跳动", "产品运营实习生", "上海市", "180元/天", "2026-11-15", "hr@bytedance.com"),
    ("腾讯", "交互设计实习生", "深圳市", "200元/天", "2026-11-25", "design@tencent.com"),
    ("腾讯", "视觉设计实习生", "深圳市", "220元/天", "2026-12-05", "design2@tencent.com"),
]


@register
class _E2EAdapter(SourceAdapter):
    code = "e2e_test"
    source_type = "test"

    def fetch(self, limit: int = 50) -> FetchResult:
        base = datetime(2026, 10, 1, 9, 0, tzinfo=timezone.utc)
        items = [
            RawItem(
                url=f"https://example.com/e2e/{i}",
                title=f"{row[0]}实习招聘 {i}",
                account_name="E2E测试源",
                published_at=base + timedelta(days=i),
                content=article(*row),
            )
            for i, row in enumerate(_SEED)
        ]
        return FetchResult(items=items, http_status=200)


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="e2e_jobs_"))
    db_path = tmp / "e2e.db"
    engine = create_engine(f"sqlite:///{db_path.as_posix()}", future=True)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False, future=True)

    print("\n[1] 采集 → 入库")
    session = Session()
    src = CrawlSource(code="e2e_src", name="E2E源", source_type="test", adapter="e2e_test", config={})
    session.add(src)
    session.flush()
    source_id = int(src.id)

    pipeline = Pipeline(use_llm=False)
    repo = SqlRepository(session)
    result = pipeline.run(_E2EAdapter(), source_id, repo, limit=50)
    session.commit()

    check("4 篇文章全部入库", result.new_articles == 4, f"实际 {result.new_articles}")
    check("抽取到 4 个岗位", result.new_jobs == 4, f"实际 {result.new_jobs}")
    check("无错误", not result.errors, str(result.errors))

    print("\n[2] 重复采集幂等（去重生效）")
    again = pipeline.run(_E2EAdapter(), source_id, repo, limit=50)
    session.commit()
    check("第二轮无新增文章", again.new_articles == 0, f"实际 {again.new_articles}")
    check("第二轮无新增岗位", again.new_jobs == 0, f"实际 {again.new_jobs}")
    check("第二轮全部判为重复文章", again.duplicate_articles == 4, f"实际 {again.duplicate_articles}")

    print("\n[3] 岗位库查询：筛选 / 分页 / 排序")
    all_jobs = jobs_query.list_jobs(session, JobFilter())
    check("默认查询返回全部 4 条", all_jobs["total"] == 4, f"实际 {all_jobs['total']}")
    check("返回体含分页字段", all_jobs["page"] == 1 and all_jobs["size"] == jobs_query.DEFAULT_SIZE)

    city_jobs = jobs_query.list_jobs(session, JobFilter(city="深圳"))
    check("按城市筛选（深圳）命中 2 条", city_jobs["total"] == 2, f"实际 {city_jobs['total']}")

    kw = jobs_query.list_jobs(session, JobFilter(keyword="设计"))
    check("关键词筛选（设计）命中 2 条", kw["total"] == 2, f"实际 {kw['total']}")

    comp = jobs_query.list_jobs(session, JobFilter(company="腾讯"))
    check("按公司模糊筛选命中 2 条", comp["total"] == 2, f"实际 {comp['total']}")

    page2 = jobs_query.list_jobs(session, JobFilter(page=2, size=2))
    check("分页 size=2 第 2 页返回 2 条", len(page2["items"]) == 2 and page2["total"] == 4)

    by_deadline = jobs_query.list_jobs(session, JobFilter(sort="deadline:asc"))
    deadlines = [it["deadline"] for it in by_deadline["items"]]
    check("按截止日期升序排序", deadlines == sorted(deadlines), str(deadlines))

    bad_sort = jobs_query.list_jobs(session, JobFilter(sort="not_a_field:asc"))
    check("非法排序字段回退默认", bad_sort["total"] == 4)

    norm = JobFilter(page=0, size=9999).normalized()
    check("非法分页参数被收敛", norm.page == 1 and norm.size == jobs_query.MAX_SIZE, f"{norm.page}/{norm.size}")

    print("\n[4] 聚合筛选项")
    job_id_first = all_jobs["items"][0]["id"]
    session.add(JobTag(job_id=job_id_first, tag="新能源"))
    session.flush()
    fac = jobs_query.facets(session, JobFilter())
    cities = {c["value"]: c["count"] for c in fac["cities"]}
    check("城市聚合含深圳=2", cities.get("深圳") == 2, str(cities))
    companies = {c["value"]: c["count"] for c in fac["companies"]}
    check("公司聚合含腾讯=2", companies.get("腾讯") == 2, str(companies))
    check("标签聚合含新能源=1", any(t["value"] == "新能源" and t["count"] == 1 for t in fac["tags"]), str(fac["tags"]))
    check("聚合维度排除自身条件（city 过滤下仍返回多城市）",
          len(jobs_query.facets(session, JobFilter(city="深圳"))["cities"]) > 1)

    print("\n[5] 详情与 CSV 导出")
    detail = jobs_query.get_job(session, job_id_first)
    check("详情返回岗位字段", detail is not None and detail["company"], str(detail and detail.get("company")))
    check("详情含来源文章信息", bool(detail and detail["article"]["url"]))
    check("详情含标签", detail is not None and detail["tags"] == ["新能源"], str(detail and detail["tags"]))
    check("不存在的岗位返回 None", jobs_query.get_job(session, 999999) is None)

    csv_text, total = jobs_query.export_jobs(session, JobFilter())
    check("CSV 带 UTF-8 BOM", csv_text.startswith("\ufeff"))
    check("CSV 表头含中文列名", "公司" in csv_text.splitlines()[0] and "截止日期" in csv_text.splitlines()[0])
    check("CSV 行数 = 命中数 + 表头", len(csv_text.strip().splitlines()) == total + 1, f"{len(csv_text.splitlines())} vs {total}")
    check("CSV 含实际数据", "理想汽车" in csv_text)

    session.close()

    print("\n[6] FastAPI /jobs 接口（依赖覆盖到 SQLite）")
    try:
        from fastapi.testclient import TestClient

        from app.api.deps import get_db
        from app.main import app

        def _override_db():
            s = Session()
            try:
                yield s
                s.commit()
            finally:
                s.close()

        app.dependency_overrides[get_db] = _override_db
        client = TestClient(app)

        r = client.get("/jobs")
        check("GET /jobs 200", r.status_code == 200, f"{r.status_code} {r.text[:120]}")
        body = r.json()
        check("GET /jobs 返回 total=4", body.get("total") == 4, str(body.get("total")))
        check("GET /jobs items 字段对齐契约", body["items"] and "article" in body["items"][0])

        r = client.get("/jobs", params={"city": "深圳"})
        check("GET /jobs?city=深圳 → 2 条", r.json().get("total") == 2, str(r.json().get("total")))

        r = client.get("/jobs/facets")
        check("GET /jobs/facets 200", r.status_code == 200 and "cities" in r.json(), r.text[:120])

        r = client.get(f"/jobs/{job_id_first}")
        check("GET /jobs/{id} 200", r.status_code == 200 and r.json()["id"] == job_id_first, r.text[:120])

        r = client.get("/jobs/999999")
        check("GET /jobs/不存在 → 404", r.status_code == 404, str(r.status_code))

        r = client.get("/jobs/export.csv")
        check("GET /jobs/export.csv 200", r.status_code == 200, str(r.status_code))
        check("导出响应为 CSV 且带附件名", "text/csv" in r.headers.get("content-type", "")
              and "jobs.csv" in r.headers.get("content-disposition", ""))
        check("导出内容含中文列名", "公司" in r.text)

        r = client.get("/jobs", params={"size": 0})
        check("GET /jobs?size=0 → 422 参数校验", r.status_code == 422, str(r.status_code))

        r = client.get("/jobs", params={"sort": "deadline:asc", "page": 1, "size": 2})
        check("GET /jobs 排序+分页组合可用", r.status_code == 200 and len(r.json()["items"]) == 2)

        app.dependency_overrides.clear()
    except ImportError as exc:  # pragma: no cover
        check(f"FastAPI TestClient 不可用: {exc}", False)

    print("\n[7] 岗位过期下架（管理接口 + Beat 任务共用逻辑）")
    try:
        from fastapi.testclient import TestClient

        from app.api.deps import get_db
        from app.main import app
        from app.models import Article, Job

        s = Session()
        art = s.query(Article).first()
        s.add(Job(article_id=art.id, company="过期公司", title="过期岗位",
                  city="北京", deadline=date(2020, 1, 1), status="active"))
        s.commit()
        s.close()

        def _override_db2():
            s2 = Session()
            try:
                yield s2
                s2.commit()
            finally:
                s2.close()

        app.dependency_overrides[get_db] = _override_db2
        client2 = TestClient(app)

        r = client2.post("/admin/jobs/expire")
        check("POST /admin/jobs/expire 200", r.status_code == 200, f"{r.status_code} {r.text[:120]}")
        check("下架 1 条过期岗位", r.json().get("expired") == 1, str(r.json()))
        check("默认列表不再含过期岗位", client2.get("/jobs").json().get("total") == 4,
              str(client2.get("/jobs").json().get("total")))
        check("status=expired 可查到下架岗位", client2.get("/jobs", params={"status": "expired"}).json().get("total") == 1)
        check("status=all 含全部 5 条", client2.get("/jobs", params={"status": "all"}).json().get("total") == 5)

        app.dependency_overrides.clear()
    except ImportError as exc:  # pragma: no cover
        check(f"FastAPI TestClient 不可用: {exc}", False)

    print("\n" + "=" * 60)
    print(f"通过 {len(PASSED)} 项，失败 {len(FAILED)} 项")
    if FAILED:
        for f in FAILED:
            print(f"  - {f}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
