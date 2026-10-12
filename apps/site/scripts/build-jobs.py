#!/usr/bin/env python
"""生成官网 /jobs 每日快照（零第三方依赖，仅 stdlib）。

读取 crawler 数据库 active 岗位 Top N，写入 apps/site/assets/jobs-snapshot.json。
数据库不可用时保留旧快照（沿用昨日），退出码 0，仅打印提示——快照页永不因缺数据而 500。

用法：
  python scripts/build-jobs.py                 # 默认读 apps/crawler/dev.db，Top 50
  python scripts/build-jobs.py --db ./dev.db --top 20
  DATABASE_URL=sqlite:///./dev.db python scripts/build-jobs.py
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

SITE_DIR = Path(__file__).resolve().parents[1]
OUT_JSON = SITE_DIR / "assets" / "jobs-snapshot.json"
DEFAULT_DB = SITE_DIR.parent / "crawler" / "dev.db"

# 与 jobs 页 Top5 同口径的展示字段
SELECT_JOBS = """
SELECT j.id, j.company, j.title, j.city, j.salary, j.education_req,
       j.deadline, j.status, j.created_at,
       (SELECT group_concat(tag, ' / ') FROM job_tags t WHERE t.job_id = j.id) AS tags
FROM jobs j
WHERE j.status = 'active' AND j.deleted_at IS NULL
ORDER BY (j.deadline IS NULL), j.deadline ASC, j.created_at DESC
LIMIT ?
"""


def resolve_db(cli_db: str | None) -> Path | None:
    """优先 CLI 参数，其次 DATABASE_URL，最后默认 dev.db。"""
    if cli_db:
        p = Path(cli_db)
        return p if p.exists() else None
    url = os.environ.get("DATABASE_URL", "")
    if url.startswith("sqlite"):
        # sqlite:///./dev.db 或 sqlite+aiosqlite:///./dev.db
        raw = url.split(":///", 1)[-1] if ":///" in url else ""
        if raw:
            p = Path(raw)
            if p.exists():
                return p
    return DEFAULT_DB if DEFAULT_DB.exists() else None


def load_jobs(db: Path, top: int) -> list[dict]:
    con = sqlite3.connect(str(db))
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(SELECT_JOBS, (top,)).fetchall()
    finally:
        con.close()
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "company": r["company"] or "",
                "title": r["title"] or "",
                "city": r["city"] or "",
                "salary": r["salary"] or "",
                "education": r["education_req"] or "",
                "deadline": r["deadline"] or "",
                "tags": (r["tags"] or "").split(" / ") if r["tags"] else [],
            }
        )
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="生成官网 /jobs 快照")
    ap.add_argument("--db", help="SQLite 路径（默认 apps/crawler/dev.db 或 DATABASE_URL）")
    ap.add_argument("--top", type=int, default=50, help="快照岗位条数上限（默认 50）")
    args = ap.parse_args()

    db = resolve_db(args.db)
    if db is None:
        print("build-jobs: 数据库不可用，沿用已有快照（如无则页面走静态演示数据）")
        return 0

    try:
        jobs = load_jobs(db, args.top)
    except sqlite3.Error as e:
        print(f"build-jobs: 读库失败（{e}），沿用已有快照")
        return 0

    snapshot = {
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "total": len(jobs),
        "jobs": jobs,
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(snapshot, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"build-jobs: 已写入 {OUT_JSON}（{len(jobs)} 条，来自 {db.name}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
