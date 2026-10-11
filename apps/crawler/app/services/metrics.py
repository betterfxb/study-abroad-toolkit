"""PoC 指标计算：字段完整率、去重率、覆盖率、结构化质量。

零第三方依赖，纯函数。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Sequence

# 岗位关键字段（用于完整率评估）
JOB_FIELDS: tuple[str, ...] = (
    "company",
    "title",
    "city",
    "salary",
    "duration",
    "education_req",
    "major_req",
    "apply_method",
    "deadline",
    "retain_chance",
)

# 核心字段（缺失即视为该岗位基本不可用）
CORE_FIELDS: tuple[str, ...] = ("company", "title", "city", "apply_method")


def _is_present(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    return True


def field_completeness(
    jobs: Sequence[dict[str, Any]],
    fields: Iterable[str] = JOB_FIELDS,
) -> dict[str, float]:
    """逐字段完整率（非空占比）。"""
    fields = tuple(fields)
    if not jobs:
        return {f: 0.0 for f in fields}
    result: dict[str, float] = {}
    for f in fields:
        hit = sum(1 for j in jobs if _is_present(j.get(f)))
        result[f] = round(hit / len(jobs), 4)
    return result


def overall_completeness(
    jobs: Sequence[dict[str, Any]],
    fields: Iterable[str] = JOB_FIELDS,
) -> float:
    """整体字段完整率（所有字段的平均值）。"""
    per_field = field_completeness(jobs, fields)
    if not per_field:
        return 0.0
    return round(sum(per_field.values()) / len(per_field), 4)


def core_completeness(jobs: Sequence[dict[str, Any]]) -> float:
    """核心字段完整率。"""
    return overall_completeness(jobs, CORE_FIELDS)


def usable_job_rate(jobs: Sequence[dict[str, Any]]) -> float:
    """可用岗位率：核心字段全非空的岗位占比。"""
    if not jobs:
        return 0.0
    usable = sum(1 for j in jobs if all(_is_present(j.get(f)) for f in CORE_FIELDS))
    return round(usable / len(jobs), 4)


def duplicate_rate(fetched: int, new_articles: int, duplicate_articles: int) -> float:
    """文章重复率 = 判重数 / 抓取数。"""
    if fetched <= 0:
        return 0.0
    return round(duplicate_articles / fetched, 4)


def coverage(enabled_sources: int, succeeded_sources: int) -> float:
    """源覆盖率 = 成功源数 / 启用源数。"""
    if enabled_sources <= 0:
        return 0.0
    return round(succeeded_sources / enabled_sources, 4)


def low_confidence_rate(jobs: Sequence[dict[str, Any]], threshold: float = 0.6) -> float:
    """低置信度岗位占比（需要人工复核）。"""
    if not jobs:
        return 0.0
    low = sum(1 for j in jobs if float(j.get("confidence") or 0) < threshold)
    return round(low / len(jobs), 4)


@dataclass
class PoCMetrics:
    fetched_articles: int
    new_articles: int
    duplicate_articles: int
    new_jobs: int
    duplicate_jobs: int
    errors: int
    duration_ms: int
    field_completeness: dict[str, float]
    overall_completeness: float
    core_completeness: float
    usable_job_rate: float
    duplicate_rate: float
    low_confidence_rate: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "fetched_articles": self.fetched_articles,
            "new_articles": self.new_articles,
            "duplicate_articles": self.duplicate_articles,
            "new_jobs": self.new_jobs,
            "duplicate_jobs": self.duplicate_jobs,
            "errors": self.errors,
            "duration_ms": self.duration_ms,
            "overall_completeness": self.overall_completeness,
            "core_completeness": self.core_completeness,
            "usable_job_rate": self.usable_job_rate,
            "duplicate_rate": self.duplicate_rate,
            "low_confidence_rate": self.low_confidence_rate,
            "field_completeness": self.field_completeness,
        }


def build_metrics(
    pipeline_result: Any,
    jobs: Sequence[dict[str, Any]],
    duration_ms: int = 0,
) -> PoCMetrics:
    """由流水线结果 + 岗位列表构建 PoC 指标。"""
    fetched = getattr(pipeline_result, "fetched", 0)
    dup_articles = getattr(pipeline_result, "duplicate_articles", 0)
    errors = getattr(pipeline_result, "errors", []) or []

    return PoCMetrics(
        fetched_articles=fetched,
        new_articles=getattr(pipeline_result, "new_articles", 0),
        duplicate_articles=dup_articles,
        new_jobs=getattr(pipeline_result, "new_jobs", 0),
        duplicate_jobs=getattr(pipeline_result, "duplicate_jobs", 0),
        errors=len(errors),
        duration_ms=duration_ms,
        field_completeness=field_completeness(jobs),
        overall_completeness=overall_completeness(jobs),
        core_completeness=core_completeness(jobs),
        usable_job_rate=usable_job_rate(jobs),
        duplicate_rate=duplicate_rate(fetched, getattr(pipeline_result, "new_articles", 0), dup_articles),
        low_confidence_rate=low_confidence_rate(jobs),
    )


# ---------------------------------------------------------------- 报告渲染
FIELD_LABELS: dict[str, str] = {
    "company": "公司",
    "title": "岗位",
    "city": "城市",
    "salary": "薪资",
    "duration": "实习时长",
    "education_req": "学历要求",
    "major_req": "专业要求",
    "apply_method": "投递方式",
    "deadline": "截止日期",
    "retain_chance": "留用机会",
}


def render_markdown(metrics: PoCMetrics, meta: dict[str, Any] | None = None) -> str:
    """把指标渲染为 Markdown 报告片段。"""
    meta = meta or {}
    lines: list[str] = []
    lines.append("## 采集结果")
    lines.append("")
    lines.append("| 指标 | 数值 |")
    lines.append("| --- | --- |")
    lines.append(f"| 抓取文章 | {metrics.fetched_articles} |")
    lines.append(f"| 新增文章 | {metrics.new_articles} |")
    lines.append(f"| 文章判重 | {metrics.duplicate_articles} |")
    lines.append(f"| 新增岗位 | {metrics.new_jobs} |")
    lines.append(f"| 岗位判重 | {metrics.duplicate_jobs} |")
    lines.append(f"| 错误数 | {metrics.errors} |")
    lines.append(f"| 耗时 | {metrics.duration_ms} ms |")
    lines.append("")
    lines.append("## 质量指标")
    lines.append("")
    lines.append("| 指标 | 数值 | 目标 |")
    lines.append("| --- | --- | --- |")
    lines.append(f"| 整体字段完整率 | {metrics.overall_completeness:.1%} | ≥ 85% |")
    lines.append(f"| 核心字段完整率 | {metrics.core_completeness:.1%} | ≥ 95% |")
    lines.append(f"| 可用岗位率 | {metrics.usable_job_rate:.1%} | ≥ 90% |")
    lines.append(f"| 文章重复率 | {metrics.duplicate_rate:.1%} | 视源而定 |")
    lines.append(f"| 低置信度占比 | {metrics.low_confidence_rate:.1%} | ≤ 20% |")
    lines.append("")
    lines.append("## 字段完整率明细")
    lines.append("")
    lines.append("| 字段 | 完整率 |")
    lines.append("| --- | --- |")
    for key, rate in metrics.field_completeness.items():
        label = FIELD_LABELS.get(key, key)
        bar = "█" * int(rate * 10) + "░" * (10 - int(rate * 10))
        lines.append(f"| {label} | {rate:.1%} `{bar}` |")
    lines.append("")
    if meta:
        lines.append("## 运行参数")
        lines.append("")
        for k, v in meta.items():
            lines.append(f"- **{k}**：{v}")
        lines.append("")
    return "\n".join(lines)
