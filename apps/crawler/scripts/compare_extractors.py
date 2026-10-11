"""抽取器对比评测：规则抽取 vs LLM 抽取。

在同一基准集上跑不同抽取器，逐字段对比人工标注，输出准确率与失败明细。

基准集分两套（可用 `--set` 选择）：
  * basic —— 标签规范 / 常见写法，规则抽取可解（用于回归规则能力）
  * hard  —— 表格 / 列表 / 英文 / 长软文 / 时薪 等真实自由形态（用于暴露规则天花板）

用法：
    # 仅规则抽取，跑基础集（零依赖，随时可跑）
    python scripts/compare_extractors.py

    # 跑难例集
    python scripts/compare_extractors.py --set hard

    # 基础集 + 难例集合并
    python scripts/compare_extractors.py --set all

    # 规则 + LLM 对比（需配置 LLM_API_KEY）
    python scripts/compare_extractors.py --set all --llm

    # 指定基准集与输出目录
    python scripts/compare_extractors.py --cases samples/benchmark/cases.json --out ../../docs/03-PoC
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.config import settings  # noqa: E402
from app.services import extract  # noqa: E402
from app.services import normalize as nz  # noqa: E402

BASIC_CASES = ROOT / "samples" / "benchmark" / "cases.json"
HARD_CASES = ROOT / "samples" / "benchmark" / "cases.hard.json"
DEFAULT_CASES = BASIC_CASES
DEFAULT_OUT = ROOT.parents[1] / "docs" / "03-PoC"

CORE_FIELDS = ("company", "title", "city", "salary", "deadline", "apply_method")


def load_cases(set_name: str, explicit: Path | None) -> tuple[list[dict[str, Any]], str]:
    """按 `--set` 载入基准集，返回 (用例列表, 描述)。"""
    if explicit is not None:
        data = json.loads(explicit.read_text(encoding="utf-8"))
        return data["cases"], str(explicit)

    paths: list[Path] = []
    if set_name in ("basic", "all"):
        paths.append(BASIC_CASES)
    if set_name in ("hard", "all"):
        paths.append(HARD_CASES)

    cases: list[dict[str, Any]] = []
    for p in paths:
        if not p.exists():
            continue
        cases.extend(json.loads(p.read_text(encoding="utf-8"))["cases"])
    return cases, " + ".join(str(p) for p in paths)


# ------------------------------------------------------------------ 抽取器
def extract_rule(text: str) -> list[dict[str, Any]]:
    return extract.structure_jobs(text, use_llm=False)


def extract_llm(text: str) -> list[dict[str, Any]]:
    return extract.structure_jobs(text, use_llm=True)


# ------------------------------------------------------------------ 匹配
def _norm(value: Any) -> str:
    return str(value or "").strip().lower()


def match_field(field: str, expected: Any, actual: Any) -> bool | None:
    """返回 True/False；expected 为 None 表示该字段不适用，返回 None。"""
    if expected is None:
        return None
    exp, act = _norm(expected), _norm(actual)
    if not exp:
        return None
    if not act:
        return False  # 未抽到即为不匹配（注意：空串是任何字符串的子串，不能走包含判断）

    if field == "city":
        return nz.normalize_city(str(expected)) == nz.normalize_city(str(actual))
    if field == "salary":
        return nz.normalize_salary(str(expected)) == nz.normalize_salary(str(actual))
    if field == "apply_method":
        return exp in act
    if field == "company":
        return exp == act or exp in act or act in exp
    return exp == act


def evaluate_case(
    case: dict[str, Any],
    extractor: Callable[[str], list[dict[str, Any]]],
) -> dict[str, Any]:
    text = case["text"]
    try:
        jobs = extractor(text)
        error = None
    except Exception as exc:  # noqa: BLE001
        jobs, error = [], f"{type(exc).__name__}: {exc}"

    expect = case.get("expect", {})
    expected_count = case.get("expect_jobs")

    result: dict[str, Any] = {
        "id": case["id"],
        "format": case["format"],
        "jobs_found": len(jobs),
        "expected_jobs": expected_count,
        "count_ok": (len(jobs) == expected_count) if expected_count else None,
        "error": error,
        "fields": {},
    }

    # 取第一个岗位与 ground truth 对比（多岗位用例只看首个）
    job = jobs[0] if jobs else {}
    for f in CORE_FIELDS:
        if f not in expect:
            continue
        ok = match_field(f, expect.get(f), job.get(f))
        if ok is None:
            continue
        result["fields"][f] = {
            "ok": ok,
            "expected": expect.get(f),
            "actual": job.get(f),
        }
    return result


# ------------------------------------------------------------------ 汇总
def summarize(case_results: list[dict[str, Any]]) -> dict[str, Any]:
    per_field: dict[str, dict[str, int]] = {f: {"hit": 0, "total": 0} for f in CORE_FIELDS}
    for r in case_results:
        for f, info in r["fields"].items():
            per_field[f]["total"] += 1
            if info["ok"]:
                per_field[f]["hit"] += 1

    total_hit = sum(v["hit"] for v in per_field.values())
    total_cnt = sum(v["total"] for v in per_field.values())
    count_cases = [r for r in case_results if r["count_ok"] is not None]
    count_ok = sum(1 for r in count_cases if r["count_ok"])

    return {
        "field_accuracy": {
            f: round(v["hit"] / v["total"], 4) if v["total"] else None
            for f, v in per_field.items()
        },
        "overall_accuracy": round(total_hit / total_cnt, 4) if total_cnt else 0.0,
        "total_hit": total_hit,
        "total_count": total_cnt,
        "case_count_accuracy": round(count_ok / len(count_cases), 4) if count_cases else None,
        "errors": [r["id"] for r in case_results if r["error"]],
    }


FIELD_LABELS = {
    "company": "公司",
    "title": "岗位",
    "city": "城市",
    "salary": "薪资",
    "deadline": "截止日期",
    "apply_method": "投递方式",
}


def render_markdown(
    summaries: dict[str, dict[str, Any]],
    details: dict[str, list[dict[str, Any]]],
    meta: dict[str, Any],
) -> str:
    lines: list[str] = []
    lines.append("## 总体准确率")
    lines.append("")
    header = "| 字段 | " + " | ".join(summaries.keys()) + " |"
    lines.append(header)
    lines.append("| --- |" + " --- |" * len(summaries))
    for f in CORE_FIELDS:
        row = [FIELD_LABELS.get(f, f)]
        for name in summaries:
            v = summaries[name]["field_accuracy"].get(f)
            row.append("—" if v is None else f"{v:.1%}")
        lines.append("| " + " | ".join(row) + " |")
    row = ["**整体**"]
    for name in summaries:
        row.append(f"**{summaries[name]['overall_accuracy']:.1%}**")
    lines.append("| " + " | ".join(row) + " |")
    lines.append("")

    lines.append("## 逐用例明细")
    lines.append("")
    names = list(summaries.keys())
    lines.append("| 用例 | 格式 | 岗位数 | " + " | ".join(names) + " |")
    lines.append("| --- | --- | --- |" + " --- |" * len(names))
    for idx, case_id in enumerate([r["id"] for r in details[names[0]]]):
        fmt = details[names[0]][idx]["format"]
        found = details[names[0]][idx]["jobs_found"]
        exp = details[names[0]][idx]["expected_jobs"]
        cells = []
        for name in names:
            r = details[name][idx]
            hits = sum(1 for v in r["fields"].values() if v["ok"])
            tot = len(r["fields"])
            cells.append(f"{hits}/{tot}")
        lines.append(f"| {case_id} | {fmt} | {found}/{exp or found} | " + " | ".join(cells) + " |")
    lines.append("")

    lines.append("## 失败明细")
    lines.append("")
    any_fail = False
    for name in names:
        fails: list[str] = []
        for r in details[name]:
            for f, info in r["fields"].items():
                if not info["ok"]:
                    fails.append(
                        f"| {name} | {r['id']} | {FIELD_LABELS.get(f, f)} | "
                        f"`{info['expected']}` | `{info['actual']}` |"
                    )
            if r["error"]:
                fails.append(f"| {name} | {r['id']} | 异常 | - | {r['error'][:60]} |")
        if fails:
            any_fail = True
            lines.append(f"### {name}")
            lines.append("")
            lines.append("| 抽取器 | 用例 | 字段 | 期望 | 实际 |")
            lines.append("| --- | --- | --- | --- | --- |")
            lines.extend(fails)
            lines.append("")
    if not any_fail:
        lines.append("无失败项。")
        lines.append("")

    lines.append("## 运行参数")
    lines.append("")
    for k, v in meta.items():
        lines.append(f"- **{k}**：{v}")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="抽取器对比评测")
    parser.add_argument("--cases", type=Path, default=None, help="自定义基准集文件（覆盖 --set）")
    parser.add_argument("--set", dest="case_set", choices=["basic", "hard", "all"], default="basic",
                        help="基准集：basic（标签规范）/ hard（真实自由形态）/ all")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--llm", action="store_true", help="加入 LLM 抽取（需 LLM_API_KEY）")
    args = parser.parse_args()

    cases, source = load_cases(args.case_set, args.cases)
    if not cases:
        print(f"基准集为空：{source}")
        return 1

    extractors: dict[str, Callable[[str], list[dict[str, Any]]]] = {"规则抽取": extract_rule}

    llm_note = "未启用"
    if args.llm:
        if not settings.llm_api_key:
            print("=" * 68)
            print("警告：--llm 已指定，但未检测到 LLM_API_KEY。")
            print("      请先设置环境变量后重跑，例如：")
            print("        set LLM_API_KEY=sk-xxx            (Windows CMD)")
            print("        $env:LLM_API_KEY='sk-xxx'         (PowerShell)")
            print("        export LLM_API_KEY=sk-xxx         (bash)")
            print("      本次将只运行规则抽取。")
            print("=" * 68)
            llm_note = "未配置 API Key，已跳过"
        else:
            extractors["LLM 抽取"] = extract_llm
            llm_note = f"启用（{settings.llm_model_fast} / {settings.llm_model_strong}）"

    print("=" * 68)
    print(f"抽取器对比评测 · {args.case_set} 集 · {len(cases)} 个用例 · {len(extractors)} 个抽取器")
    print("=" * 68)

    summaries: dict[str, dict[str, Any]] = {}
    details: dict[str, list[dict[str, Any]]] = {}

    for name, fn in extractors.items():
        results = [evaluate_case(c, fn) for c in cases]
        details[name] = results
        summaries[name] = summarize(results)
        print(f"\n[{name}] 整体准确率 {summaries[name]['overall_accuracy']:.1%}")
        for f, v in summaries[name]["field_accuracy"].items():
            if v is not None:
                print(f"    {FIELD_LABELS.get(f, f):6s} {v:.1%}")

    args.out.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    meta = {
        "运行时间": datetime.now(timezone.utc).isoformat(),
        "基准集": f"{args.case_set}（{len(cases)} 例）",
        "来源": source,
        "LLM": llm_note,
    }

    md = [f"# 抽取器对比评测报告 · {ts}", "", render_markdown(summaries, details, meta)]
    md_path = args.out / f"extractor-comparison-{args.case_set}-{ts}.md"
    json_path = args.out / f"extractor-comparison-{args.case_set}-{ts}.json"
    md_path.write_text("\n".join(md), encoding="utf-8")
    json_path.write_text(
        json.dumps({"summaries": summaries, "details": details, "meta": meta}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"\n报告已生成：\n  {md_path}\n  {json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
