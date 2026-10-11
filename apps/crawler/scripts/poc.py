"""模块二 PoC 运行器。

无需数据库即可运行（内存仓储），用于验证采集链路与评估数据质量。

用法：
    # 用内置样例源跑一遍（离线，零外部依赖）
    python scripts/poc.py --sources config/poc_sources.json

    # 跑两遍验证去重
    python scripts/poc.py --sources config/poc_sources.json --repeat 2

    # 临时加一个真实 RSS 源
    python scripts/poc.py --adapter rss --feed-url https://example.com/feed.xml

    # 只跑指定源
    python scripts/poc.py --sources config/poc_sources.json --only manual_samples

输出：
    - 控制台摘要
    - <out>/poc-report-<ts>.md     Markdown 报告
    - <out>/poc-report-<ts>.json   原始指标
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.adapters import create_adapter  # noqa: E402
from app.compliance import ComplianceGuard, DomainPolicy, TakedownRegistry  # noqa: E402
from app.http import HttpClient, build_robots_cache  # noqa: E402
from app.services import metrics as M  # noqa: E402
from app.services.pipeline import InMemoryRepository, Pipeline  # noqa: E402

DEFAULT_OUT = ROOT.parents[1] / "docs" / "03-PoC"


def build_guard() -> ComplianceGuard:
    """构建合规总闸：robots + 域名策略 + 下架登记。"""
    robots_client = HttpClient(guard=ComplianceGuard(enabled=False))
    robots = build_robots_cache(robots_client)
    return ComplianceGuard(robots=robots, policy=DomainPolicy(), takedown=TakedownRegistry(), enabled=True)


def load_sources(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict):
        return data.get("sources", [])
    return data


def run_source(
    entry: dict[str, Any],
    repo: InMemoryRepository,
    limit: int,
    use_llm: bool,
    guard: ComplianceGuard | None = None,
) -> tuple[Any, list[dict[str, Any]], int]:
    config = dict(entry.get("config", {}))
    if guard is not None:
        config.setdefault("guard", guard)
    adapter = create_adapter(entry["adapter"], config)
    started = time.monotonic()
    result = Pipeline(use_llm=use_llm).run(adapter, source_id=entry.get("source_id", 0), repo=repo, limit=limit)
    duration_ms = int((time.monotonic() - started) * 1000)
    jobs = [j for j in repo.jobs.values()]
    return result, jobs, duration_ms


def main() -> int:
    parser = argparse.ArgumentParser(description="模块二 PoC 运行器")
    parser.add_argument("--sources", type=Path, help="源清单 JSON")
    parser.add_argument("--only", help="只跑指定 code（逗号分隔）")
    parser.add_argument("--adapter", help="临时指定单个适配器")
    parser.add_argument("--feed-url", help="配合 --adapter rss 使用")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--repeat", type=int, default=1, help="重复轮次，用于验证去重")
    parser.add_argument("--use-llm", action="store_true", help="启用 LLM 结构化（需配置 API Key）")
    parser.add_argument("--no-compliance", action="store_true", help="关闭 robots 合规检查（仅调试用）")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    if args.adapter:
        config: dict[str, Any] = {}
        if args.feed_url:
            config["feed_url"] = args.feed_url
        entries = [{"code": "adhoc", "adapter": args.adapter, "config": config, "enabled": True}]
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

    print("=" * 68)
    print(f"模块二 PoC · {len(entries)} 个源 · {args.repeat} 轮 · LLM={'开' if args.use_llm else '关（规则兜底）'}")
    print(f"合规检查：{'关闭（调试模式）' if args.no_compliance else '开启（robots + 域名策略 + 下架）'}")
    print("=" * 68)

    guard = None if args.no_compliance else build_guard()
    repo = InMemoryRepository()
    rounds: list[dict[str, Any]] = []

    for rnd in range(1, args.repeat + 1):
        print(f"\n--- 第 {rnd} 轮 ---")
        for entry in entries:
            code = entry["code"]
            try:
                result, jobs, duration = run_source(entry, repo, args.limit, args.use_llm, guard)
            except Exception as exc:  # noqa: BLE001
                print(f"  [{code}] 失败: {exc}")
                rounds.append({"round": rnd, "code": code, "error": str(exc)})
                continue
            print(
                f"  [{code}] 抓取 {result.fetched} | 新增文章 {result.new_articles} | "
                f"判重 {result.duplicate_articles} | 新增岗位 {result.new_jobs} | {duration}ms"
            )
            if result.errors:
                for err in result.errors[:3]:
                    print(f"         ! {err}")
            rounds.append(
                {
                    "round": rnd,
                    "code": code,
                    "fetched": result.fetched,
                    "new_articles": result.new_articles,
                    "duplicate_articles": result.duplicate_articles,
                    "new_jobs": result.new_jobs,
                    "duplicate_jobs": result.duplicate_jobs,
                    "errors": result.errors,
                    "duration_ms": duration,
                }
            )

    all_jobs = list(repo.jobs.values())
    total_fetched = sum(r.get("fetched", 0) for r in rounds)
    total_new_articles = sum(r.get("new_articles", 0) for r in rounds)
    total_dup_articles = sum(r.get("duplicate_articles", 0) for r in rounds)
    total_new_jobs = sum(r.get("new_jobs", 0) for r in rounds)
    total_dup_jobs = sum(r.get("duplicate_jobs", 0) for r in rounds)
    total_errors = sum(len(r.get("errors", [])) for r in rounds)
    total_ms = sum(r.get("duration_ms", 0) for r in rounds)

    class _Agg:
        pass

    agg = _Agg()
    agg.fetched = total_fetched
    agg.new_articles = total_new_articles
    agg.duplicate_articles = total_dup_articles
    agg.new_jobs = total_new_jobs
    agg.duplicate_jobs = total_dup_jobs
    agg.errors = list(range(total_errors))

    m = M.build_metrics(agg, all_jobs, duration_ms=total_ms)

    print("\n" + "=" * 68)
    print("质量指标")
    print("=" * 68)
    print(f"  文章：抓取 {m.fetched_articles} / 新增 {m.new_articles} / 判重 {m.duplicate_articles}")
    print(f"  岗位：新增 {m.new_jobs} / 判重 {m.duplicate_jobs}（库内共 {len(all_jobs)} 条）")
    print(f"  整体字段完整率 {m.overall_completeness:.1%} | 核心字段 {m.core_completeness:.1%} | 可用岗位率 {m.usable_job_rate:.1%}")
    print(f"  低置信度占比 {m.low_confidence_rate:.1%} | 耗时 {m.duration_ms}ms")

    args.out.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    meta = {
        "运行时间": datetime.now(timezone.utc).isoformat(),
        "源数量": len(entries),
        "轮次": args.repeat,
        "LLM 结构化": "启用" if args.use_llm else "关闭（规则兜底）",
        "limit": args.limit,
    }

    md_path = args.out / f"poc-report-{ts}.md"
    json_path = args.out / f"poc-report-{ts}.json"

    md = [
        f"# 模块二 PoC 报告 · {ts}",
        "",
        M.render_markdown(m, meta),
        "## 逐源明细",
        "",
        "| 轮次 | 源 | 抓取 | 新增文章 | 判重 | 新增岗位 | 岗位判重 | 耗时(ms) | 错误 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in rounds:
        if "error" in r:
            md.append(f"| {r['round']} | {r['code']} | - | - | - | - | - | - | {r['error'][:60]} |")
        else:
            md.append(
                f"| {r['round']} | {r['code']} | {r['fetched']} | {r['new_articles']} | "
                f"{r['duplicate_articles']} | {r['new_jobs']} | {r['duplicate_jobs']} | "
                f"{r['duration_ms']} | {len(r['errors'])} |"
            )

    md.append("")
    md.append("## 采集样例（前 10 条岗位）")
    md.append("")
    md.append("| 公司 | 岗位 | 城市 | 薪资 | 学历 | 截止 | 投递方式 | 置信度 |")
    md.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for j in all_jobs[:10]:
        md.append(
            f"| {j.get('company') or '-'} | {j.get('title') or '-'} | {j.get('city') or '-'} | "
            f"{j.get('salary') or '-'} | {j.get('education_req') or '-'} | {j.get('deadline') or '-'} | "
            f"{(j.get('apply_method') or '-')[:28]} | {float(j.get('confidence') or 0):.2f} |"
        )
    md.append("")

    md_path.write_text("\n".join(md), encoding="utf-8")
    json_path.write_text(
        json.dumps({"metrics": m.to_dict(), "rounds": rounds, "meta": meta}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"\n报告已生成：\n  {md_path}\n  {json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
