"""字段匹配评测：词典匹配 vs 人工标注。

基准集分两套（`--set` 选择）：
  * basic —— 平台常见命名风格，词典匹配可解（用于回归匹配能力）
  * hard  —— 缩写 / 题干撞车 / 行业黑话 / 非英文标签 / 无 label（用于暴露词典天花板）

指标口径：
  * 识别率   = 正确识别 / 可匹配字段（可匹配字段 = 标注了 expect_key 的字段）
  * 精确率   = 正确识别 / (正确识别 + 误匹配 + 误报)
  * 填充率   = 有非空填充值的字段 / 全部字段
  * 自动填充 = action=fill 的字段 / 全部字段（对应契约「≥0.9 自动填」）

用法：
    python scripts/eval_matcher.py                  # 基础集
    python scripts/eval_matcher.py --set hard       # 难例集
    python scripts/eval_matcher.py --set all        # 合并
    python scripts/eval_matcher.py --pages samples/benchmark/pages.json --out ../../docs/03-PoC
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

from app.pipeline import build_instructions  # noqa: E402
from app.schema import FieldSpec  # noqa: E402

BASIC_PAGES = ROOT / "samples" / "benchmark" / "pages.json"
HARD_PAGES = ROOT / "samples" / "benchmark" / "pages.hard.json"
DEFAULT_OUT = ROOT.parents[1] / "docs" / "03-PoC"


def load_pages(set_name: str, explicit: Path | None) -> tuple[dict[str, Any], list[dict[str, Any]], str]:
    """返回 (profile, pages, 来源说明)。多套集合并时以第一套的 profile 为准。"""
    if explicit is not None:
        data = json.loads(explicit.read_text(encoding="utf-8"))
        return data.get("profile", {}), data["pages"], str(explicit)

    paths: list[Path] = []
    if set_name in ("basic", "all"):
        paths.append(BASIC_PAGES)
    if set_name in ("hard", "all"):
        paths.append(HARD_PAGES)

    profile: dict[str, Any] = {}
    pages: list[dict[str, Any]] = []
    for p in paths:
        if not p.exists():
            continue
        data = json.loads(p.read_text(encoding="utf-8"))
        if not profile:
            profile = data.get("profile", {})
        pages.extend(data["pages"])
    return profile, pages, " + ".join(str(p) for p in paths)


def evaluate_page(page: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    fields = [FieldSpec.from_dict(f) for f in page["fields"]]
    payload = build_instructions(fields, profile)
    by_selector = {i["selector"]: i for i in payload["instructions"]}

    rows: list[dict[str, Any]] = []
    for f in page["fields"]:
        selector = f["selector"]
        expected = f.get("expect_key")
        instr = by_selector.get(selector)
        predicted = instr["field_key"] if instr else None
        rows.append(
            {
                "selector": selector,
                "label": f.get("label", ""),
                "expected": expected,
                "predicted": predicted,
                "value": instr.get("value", "") if instr else "",
                "confidence": instr.get("confidence", 0.0) if instr else 0.0,
                "action": instr.get("action", "fill") if instr else "unmatched",
            }
        )

    matchable = [r for r in rows if r["expected"]]
    correct = [r for r in matchable if r["predicted"] == r["expected"]]
    missed = [r for r in matchable if r["predicted"] is None]
    wrong = [r for r in matchable if r["predicted"] and r["predicted"] != r["expected"]]
    false_pos = [r for r in rows if not r["expected"] and r["predicted"]]
    filled = [r for r in rows if r["value"]]
    auto = [r for r in rows if r["action"] == "fill"]

    precision_denom = len(correct) + len(wrong) + len(false_pos)
    return {
        "id": page["id"],
        "name": page["name"],
        "system_code": page.get("system_code", ""),
        "total": len(rows),
        "matchable": len(matchable),
        "correct": len(correct),
        "missed": len(missed),
        "wrong": len(wrong),
        "false_positive": len(false_pos),
        "filled": len(filled),
        "auto": len(auto),
        "recognition_rate": round(len(correct) / len(matchable), 4) if matchable else None,
        "precision": round(len(correct) / precision_denom, 4) if precision_denom else None,
        "fill_rate": round(len(filled) / len(rows), 4) if rows else 0.0,
        "auto_fill_rate": round(len(auto) / len(rows), 4) if rows else 0.0,
        "rows": rows,
    }


def aggregate(results: list[dict[str, Any]]) -> dict[str, Any]:
    def total(key: str) -> int:
        return sum(r[key] for r in results)

    matchable = total("matchable")
    correct = total("correct")
    wrong = total("wrong")
    false_pos = total("false_positive")
    rows = total("total")
    filled = total("filled")
    auto = total("auto")
    denom = correct + wrong + false_pos
    return {
        "pages": len(results),
        "total_fields": rows,
        "matchable": matchable,
        "correct": correct,
        "missed": total("missed"),
        "wrong": wrong,
        "false_positive": false_pos,
        "recognition_rate": round(correct / matchable, 4) if matchable else None,
        "precision": round(correct / denom, 4) if denom else None,
        "fill_rate": round(filled / rows, 4) if rows else 0.0,
        "auto_fill_rate": round(auto / rows, 4) if rows else 0.0,
    }


def render_markdown(results: list[dict[str, Any]], agg: dict[str, Any], meta: dict[str, Any]) -> str:
    lines = ["## 总体指标", ""]
    lines.append("| 指标 | 值 |")
    lines.append("| --- | --- |")
    lines.append(f"| 页面数 | {agg['pages']} |")
    lines.append(f"| 字段总数 | {agg['total_fields']} |")
    lines.append(f"| 可匹配字段（有标注） | {agg['matchable']} |")
    lines.append(f"| 正确识别 | {agg['correct']} |")
    lines.append(f"| 漏识别 | {agg['missed']} |")
    lines.append(f"| 误匹配 | {agg['wrong']} |")
    lines.append(f"| 误报（不应匹配却匹配） | {agg['false_positive']} |")
    lines.append(f"| **识别率** | **{_pct(agg['recognition_rate'])}** |")
    lines.append(f"| **精确率** | **{_pct(agg['precision'])}** |")
    lines.append(f"| **填充率** | **{_pct(agg['fill_rate'])}** |")
    lines.append(f"| 自动填充率 | {_pct(agg['auto_fill_rate'])} |")
    lines.append("")

    lines.append("## 逐页面")
    lines.append("")
    lines.append("| 页面 | 平台 | 字段 | 可匹配 | 识别率 | 精确率 | 填充率 |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- |")
    for r in results:
        lines.append(
            f"| {r['id']} | {r['system_code']} | {r['total']} | {r['matchable']} | "
            f"{_pct(r['recognition_rate'])} | {_pct(r['precision'])} | {_pct(r['fill_rate'])} |"
        )
    lines.append("")

    fails: list[str] = []
    for r in results:
        for row in r["rows"]:
            if row["expected"] and row["predicted"] != row["expected"]:
                kind = "漏识别" if row["predicted"] is None else "误匹配"
                fails.append(
                    f"| {r['id']} | {row['label']} | {kind} | `{row['expected']}` | "
                    f"`{row['predicted'] or '-'}` | {row['confidence']} |"
                )
            elif not row["expected"] and row["predicted"]:
                fails.append(
                    f"| {r['id']} | {row['label']} | 误报 | - | `{row['predicted']}` | {row['confidence']} |"
                )
    lines.append("## 失败明细")
    lines.append("")
    if fails:
        lines.append("| 页面 | 字段 | 类型 | 期望 | 实际 | 置信度 |")
        lines.append("| --- | --- | --- | --- | --- | --- |")
        lines.extend(fails)
    else:
        lines.append("无失败项。")
    lines.append("")

    lines.append("## 运行参数")
    lines.append("")
    for k, v in meta.items():
        lines.append(f"- **{k}**：{v}")
    lines.append("")
    return "\n".join(lines)


def _pct(v: float | None) -> str:
    return "—" if v is None else f"{v:.1%}"


def main() -> int:
    parser = argparse.ArgumentParser(description="字段匹配评测")
    parser.add_argument("--pages", type=Path, default=None, help="自定义基准集（覆盖 --set）")
    parser.add_argument("--set", dest="page_set", choices=["basic", "hard", "all"], default="basic")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    profile, pages, source = load_pages(args.page_set, args.pages)
    if not pages:
        print(f"基准集为空: {source}")
        return 1

    print("=" * 68)
    print(f"字段匹配评测 · {args.page_set} 集 · {len(pages)} 个页面")
    print("=" * 68)

    results = [evaluate_page(p, profile) for p in pages]
    agg = aggregate(results)

    for r in results:
        print(
            f"\n[{r['id']}] {r['name']}\n"
            f"    字段 {r['total']} | 可匹配 {r['matchable']} | 正确 {r['correct']} | "
            f"漏 {r['missed']} | 误匹配 {r['wrong']} | 误报 {r['false_positive']}\n"
            f"    识别率 {_pct(r['recognition_rate'])} | 精确率 {_pct(r['precision'])} | 填充率 {_pct(r['fill_rate'])}"
        )

    print("\n" + "=" * 68)
    print(
        f"总体：识别率 {_pct(agg['recognition_rate'])} | 精确率 {_pct(agg['precision'])} | "
        f"填充率 {_pct(agg['fill_rate'])} | 自动填充率 {_pct(agg['auto_fill_rate'])}"
    )
    print("=" * 68)

    args.out.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    meta = {
        "运行时间": datetime.now(timezone.utc).isoformat(),
        "基准集": f"{args.page_set}（{len(pages)} 页）",
        "来源": source,
    }
    md = [f"# 模块一字段匹配评测报告 · {ts}", "", render_markdown(results, agg, meta)]
    md_path = args.out / f"field-matcher-eval-{args.page_set}-{ts}.md"
    json_path = args.out / f"field-matcher-eval-{args.page_set}-{ts}.json"
    md_path.write_text("\n".join(md), encoding="utf-8")
    json_path.write_text(
        json.dumps({"aggregate": agg, "results": results, "meta": meta}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"\n报告已生成：\n  {md_path}\n  {json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
