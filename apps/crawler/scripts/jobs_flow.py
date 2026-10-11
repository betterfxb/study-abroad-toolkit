"""模块二全链路演示：采集 → 入库 → 查询 → 导出汇总表。

与 poc.py 的区别：poc.py 用内存仓储验证链路与指标；本脚本**真实落库**，
并走岗位库查询接口导出「实习信息汇总表」CSV，用于验证读侧闭环。

默认用 SQLite（零依赖、无需 Docker）；也可指向真实 PostgreSQL。

用法：
    # 离线样例 → SQLite → 导出 CSV
    python scripts/jobs_flow.py --sources config/poc_sources.json

    # 真实公开源（RemoteOK 等 JSON 招聘 API）
    python scripts/jobs_flow.py --sources config/poc_sources.real.json --only remoteok

    # 指定数据库（PostgreSQL）
    python scripts/jobs_flow.py --sources config/poc_sources.json \
        --dsn "postgresql+psycopg://user:pass@localhost:5432/qiuzhi"

    # 临时加一个真实 RSS 源
    python scripts/jobs_flow.py --adapter rss --feed-url https://example.com/feed.xml
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.adapters import create_adapter  # noqa: E402
from app.compliance import ComplianceGuard, DomainPolicy, TakedownRegistry  # noqa: E402
from app.http import HttpClient, build_robots_cache  # noqa: E402
from app.services import jobs_query  # noqa: E402
from app.services.jobs_query import JobFilter  # noqa: E402
from app.services.pipeline import Pipeline, SqlRepository  # noqa: E402

DEFAULT_OUT = ROOT.parents[1] / "docs" / "03-PoC"


def build_guard() -> ComplianceGuard:
    """构建合规总闸：robots + 域名策略 + 下架登记。"""
    robots_client = HttpClient(guard=ComplianceGuard(enabled=False))
    robots = build_robots_cache(robots_client)
    return ComplianceGuard(robots=robots, policy=DomainPolicy(), takedown=TakedownRegistry(), enabled=True)


def load_sources(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return data.get("sources", []) if isinstance(data, dict) else data


def main() -> int:
    parser = argparse.ArgumentParser(description="模块二全链路：采集 → 入库 → 查询 → 导出")
    parser.add_argument("--sources", type=Path, help="源清单 JSON")
    parser.add_argument("--only", help="只跑指定 code（逗号分隔）")
    parser.add_argument("--adapter", help="临时指定单个适配器")
    parser.add_argument("--feed-url", help="配合 --adapter rss 使用")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--dsn", default="", help="数据库 DSN；默认 SQLite 临时库")
    parser.add_argument("--use-llm", action="store_true", help="启用 LLM 结构化（需 API Key）")
    parser.add_argument("--no-compliance", action="store_true", help="关闭 robots 合规检查（仅调试）")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--keep-db", action="store_true", help="保留 SQLite 文件（默认写入 --out 目录）")
    args = parser.parse_args()

    if args.adapter:
        config: dict[str, Any] = {}
        if args.feed_url:
            config["feed_url"] = args.feed_url
        entries = [{"code": "adhoc", "name": "临时源", "adapter": args.adapter, "config": config}]
    elif args.sources:
        if not args.sources.exists():
            print(f"源清单不存在: {args.sources}")
            return 1
        entries = [e for e in load_sources(args.sources) if e.get("enabled", True)]
    else:
        print("请提供 --sources 或 --adapter")
        return 1

    if args.only:
        wanted = {c.strip() for c in args.only.split(",")}
        entries = [e for e in entries if e.get("code") in wanted]
    if not entries:
        print("没有可执行的源")
        return 1

    args.out.mkdir(parents=True, exist_ok=True)

    # ---------------------------------------------------------------- 数据库
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    if args.dsn:
        dsn, is_sqlite = args.dsn, args.dsn.startswith("sqlite")
    else:
        db_file = args.out / "jobs.db"
        dsn, is_sqlite = f"sqlite:///{db_file.as_posix()}", True

    from app.models import Base, CrawlSource

    engine = create_engine(dsn, future=True)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    session = Session()

    print("=" * 68)
    print(f"模块二全链路 · {len(entries)} 个源 · LLM={'开' if args.use_llm else '关（规则兜底）'}")
    print(f"数据库：{dsn}")
    print(f"合规检查：{'关闭（调试）' if args.no_compliance else '开启（robots + 域名策略 + 下架）'}")
    print("=" * 68)

    guard = None if args.no_compliance else build_guard()
    pipeline = Pipeline(use_llm=args.use_llm)
    repo = SqlRepository(session)
    rounds: list[dict[str, Any]] = []

    for entry in entries:
        code = entry["code"]
        # 幂等建源（重复运行不报错）
        src = session.query(CrawlSource).filter_by(code=code).one_or_none()
        if src is None:
            src = CrawlSource(
                code=code,
                name=entry.get("name", code),
                source_type=entry.get("source_type", "rss"),
                adapter=entry["adapter"],
                config=entry.get("config", {}),
            )
            session.add(src)
            session.flush()

        config = dict(entry.get("config", {}))
        if guard is not None:
            config.setdefault("guard", guard)
        try:
            adapter = create_adapter(entry["adapter"], config)
            result = pipeline.run(adapter, source_id=int(src.id), repo=repo, limit=args.limit)
            session.commit()
        except Exception as exc:  # noqa: BLE001
            session.rollback()
            print(f"  [{code}] 失败: {exc}")
            rounds.append({"code": code, "error": str(exc)})
            continue

        print(
            f"  [{code}] 抓取 {result.fetched} | 新增文章 {result.new_articles} | "
            f"判重 {result.duplicate_articles} | 新增岗位 {result.new_jobs}"
        )
        for err in result.errors[:2]:
            print(f"         ! {err[:100]}")
        rounds.append(result.to_dict())

    # ---------------------------------------------------------------- 查询
    print("\n" + "=" * 68)
    print("岗位库查询")
    print("=" * 68)

    listing = jobs_query.list_jobs(session, JobFilter(size=10))
    fac = jobs_query.facets(session, JobFilter())
    print(f"  库内岗位总数：{listing['total']}")
    if fac["cities"]:
        print("  城市分布：" + "、".join(f"{c['value']}({c['count']})" for c in fac["cities"][:8]))
    if fac["companies"]:
        print("  公司分布：" + "、".join(f"{c['value']}({c['count']})" for c in fac["companies"][:8]))

    print("\n  前 10 条：")
    for it in listing["items"]:
        print(
            f"    {it['company'] or '-':<12} {it['title'] or '-':<18} "
            f"{it['city'] or '-':<6} {it['salary'] or '-':<14} 截止 {it['deadline'] or '-'}"
        )

    # ---------------------------------------------------------------- 导出
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    csv_text, total = jobs_query.export_jobs(session, JobFilter(), max_rows=5000)
    csv_path = args.out / f"jobs-summary-{ts}.csv"
    csv_path.write_text(csv_text, encoding="utf-8")

    md_lines = [
        f"# 模块二全链路运行报告 · {ts}",
        "",
        "## 采集",
        "",
        "| 源 | 抓取 | 新增文章 | 文章判重 | 新增岗位 | 岗位判重 | 错误 |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in rounds:
        if "error" in r:
            md_lines.append(f"| {r['code']} | - | - | - | - | - | {r['error'][:60]} |")
        else:
            md_lines.append(
                f"| {r['source_code']} | {r['fetched']} | {r['new_articles']} | "
                f"{r['duplicate_articles']} | {r['new_jobs']} | {r['duplicate_jobs']} | {len(r['errors'])} |"
            )
    md_lines += ["", "## 岗位库", "", f"- 岗位总数：**{listing['total']}**", f"- 导出 CSV：`{csv_path.name}`（{total} 行）", ""]
    md_path = args.out / f"jobs-flow-{ts}.md"
    md_path.write_text("\n".join(md_lines), encoding="utf-8")

    print(f"\n汇总表已导出：{csv_path}（{total} 行）")
    print(f"运行报告：{md_path}")

    session.close()
    if is_sqlite and not args.keep_db and not args.dsn:
        print(f"（SQLite 文件保留在 {args.out / 'jobs.db'}，可重复运行验证去重）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
