#!/usr/bin/env python
"""本地开发数据种子：向 SQLite 写入演示用岗位数据。

用途：本机没有 Docker / PostgreSQL 时，也能把采集服务的岗位库跑通，
      供控制台（apps/console）联调与人工验收使用。

用法：
    python apps/crawler/scripts/seed_dev.py
    DATABASE_URL=sqlite+aiosqlite:///./dev.db python apps/crawler/scripts/seed_dev.py

幂等：按文章 URL 去重，重复执行不会产生重复数据。
"""

from __future__ import annotations

import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./dev.db")

from sqlalchemy import create_engine, select  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from app.config import settings  # noqa: E402
from app.db import _sync_url  # noqa: E402
from app.models import Article, Base, CrawlSource, Job, JobTag  # noqa: E402

# (公司, 岗位, 城市, 薪资, 时长, 学历, 专业, 留用, 置信度, 截止偏移天数, 标签)
SEED = [
    ("中金公司", "量化研究实习生", "北京", "300/天", "3个月", "硕士", "金融、数学、计算机",
     "有", 0.92, 25, ["金融", "量化", "券商"]),
    ("字节跳动", "数据分析实习生", "上海", "250/天", "3个月", "本科", "统计学、计算机",
     "有", 0.88, 12, ["互联网", "数据分析", "转正"]),
    ("腾讯", "产品运营实习生", "深圳", "200/天", "6个月", "本科", "不限",
     "有", 0.85, 40, ["互联网", "运营"]),
    ("麦肯锡", "商业分析实习生", "北京", "400/天", "2个月", "硕士", "不限",
     "无", 0.79, 18, ["咨询", "商业分析"]),
    ("阿里巴巴", "算法工程实习生", "杭州", "300/天", "3个月", "硕士", "计算机、人工智能",
     "有", 0.91, 50, ["互联网", "算法", "转正"]),
    ("网易", "游戏策划实习生", "广州", "180/天", "3个月", "本科", "不限",
     "有", 0.62, 30, ["游戏", "策划"]),
]

ACCOUNTS = ["实习信息速递", "校招内推君", "大学生就业情报站", "实习信息速递", "校招内推君", "大学生就业情报站"]


def main() -> int:
    url = settings.database_url
    print(f"目标数据库：{url}")
    if url.startswith("postgresql"):
        print("警告：当前指向 PostgreSQL，请确认这是你想要的开发库。")

    engine = create_engine(_sync_url(url), future=True)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False, future=True)

    session = Session()
    source = session.execute(
        select(CrawlSource).where(CrawlSource.code == "seed_dev")
    ).scalar_one_or_none()
    if source is None:
        source = CrawlSource(
            code="seed_dev", name="本地种子源", source_type="seed", adapter="seed", config={},
        )
        session.add(source)
        session.flush()
        print(f"新建采集源：#{source.id}")

    now = datetime.now(timezone.utc)
    created = 0
    skipped = 0

    for i, row in enumerate(SEED):
        (company, title, city, salary, duration, edu, major,
         retain, conf, deadline_days, tags) = row

        art_url = f"https://example.com/seed/{i + 1}"
        exists = session.execute(select(Article).where(Article.url == art_url)).scalar_one_or_none()
        if exists is not None:
            skipped += 1
            continue

        article = Article(
            source_id=source.id,
            url=art_url,
            title=f"{company}{title}招聘（{city}）",
            account_name=ACCOUNTS[i],
            published_at=now - timedelta(days=i),
            summary=f"{company} 招募{title}，工作地点{city}，薪资{salary}。",
            content_hash=f"seed-hash-{i + 1}",
            fingerprint=f"seed-fp-{i + 1}",
            raw_meta={"seed": True},
        )
        session.add(article)
        session.flush()

        job = Job(
            article_id=article.id,
            company=company,
            title=title,
            city=city,
            salary=salary,
            duration=duration,
            education_req=edu,
            major_req=major,
            apply_method=f"官网投递：https://careers.example.com/{company}/apply",
            apply_url=f"https://careers.example.com/{company}/apply",
            deadline=date.today() + timedelta(days=deadline_days),
            retain_chance=retain,
            confidence=conf,
            fingerprint=f"seed-job-fp-{i + 1}",
            status="active",
        )
        session.add(job)
        session.flush()

        for t in tags:
            session.add(JobTag(job_id=job.id, tag=t))

        created += 1

    session.commit()
    total = session.execute(select(Job)).scalars().all()
    session.close()

    print(f"新增岗位 {created} 条，跳过已存在 {skipped} 条，当前库内共 {len(total)} 条。")
    print("完成。启动采集服务后即可通过 /api/v1/jobs 查询。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
