"""字段填充流水线：匹配 → 取值 → 格式转换 → 置信度分级 → 填充指令。

对应 docs/02-详细设计/03-接口契约.md §4.1 `/ext/v1/match-fields`。
置信度分级遵循架构详设 §3：
  ≥0.90 自动填（fill）｜0.60~0.90 填 + 高亮复核（review）｜<0.60 不填（skip）
"""

from __future__ import annotations

import re
from typing import Any

from .config import settings
from .dictionary import Slot, load_dictionary
from .handlers import apply_handler
from .matcher import FieldMatch, match_fields
from .schema import FieldSpec, Instruction
from .utils import get_logger
from .wordcount import check_words, describe_check

log = get_logger(__name__)

# 档案结构与字段路径不一致时的别名（契约里字段用 address.*，档案里是 addresses[0].*）
_PROFILE_ALIASES: list[tuple[str, str]] = [
    ("address.", "addresses[0]."),
]

# 叶子名同义词：档案字段命名与契约路径不完全一致时回退（province/state、school/institution…）
_LEAF_SYNONYMS: dict[str, tuple[str, ...]] = {
    "state": ("state", "province"),
    "postal": ("postal", "postal_code", "zip", "zipcode"),
    "street": ("street", "address", "address_line1", "address_line_1"),
    "street2": ("street2", "address_line2", "address_line_2"),
    "city": ("city", "city_name"),
    "country": ("country", "country_code"),
    "institution": ("institution", "school", "university", "college"),
    "major": ("major", "field_of_study", "program", "concentration"),
    "degree": ("degree", "degree_type"),
    "start_date": ("start_date", "start"),
    "end_date": ("end_date", "end", "graduation_date"),
    "gpa_scale": ("gpa_scale", "scale"),
    "test_type": ("test_type", "type"),
    "total": ("total", "total_score"),
    "test_date": ("test_date", "date"),
    "registration_id": ("registration_id", "registration_number"),
    "org": ("org", "organization", "organisation", "employer", "company"),
    "role": ("role", "position", "title"),
    "name": ("name", "full_name"),
}

_PATH_PART = re.compile(r"^(\w+)\[(\d+)\]$")


def _navigate(profile: dict[str, Any] | None, path: str) -> Any:
    """按点分路径取值，支持 `education[0].major`。"""
    if not profile or not path:
        return None
    current: Any = profile
    for part in path.split("."):
        m = _PATH_PART.match(part)
        if m:
            name, idx = m.group(1), int(m.group(2))
            if not isinstance(current, dict):
                return None
            current = current.get(name)
            if not isinstance(current, list) or idx >= len(current):
                return None
            current = current[idx]
        else:
            if not isinstance(current, dict):
                return None
            current = current.get(part)
        if current is None:
            return None
    return current


def resolve_value(profile: dict[str, Any] | None, field_key: str) -> Any:
    """按点分路径从档案取值。

    三级回退：① 原路径（含 address→addresses[0] 别名）→ ② 叶子同义词 → ③ 空。
    另外对 `{"value": x, "scale": y}` 这类包装对象自动解包为标量。
    """
    if not profile or not field_key:
        return None
    path = field_key
    for prefix, replacement in _PROFILE_ALIASES:
        if path.startswith(prefix):
            path = replacement + path[len(prefix):]
            break

    value = _navigate(profile, path)
    if value is None:
        head, _, leaf = path.rpartition(".")
        for alt in _LEAF_SYNONYMS.get(leaf, ()):
            if alt == leaf:
                continue
            value = _navigate(profile, f"{head}.{alt}" if head else alt)
            if value is not None:
                break

    if isinstance(value, dict) and "value" in value:
        return value["value"]
    return value


def classify(confidence: float) -> tuple[str, str]:
    """置信度 → (动作, 原因)。"""
    if confidence >= settings.auto_fill_threshold:
        return "fill", ""
    if confidence >= settings.review_threshold:
        return "review", "需人工复核"
    return "skip", "置信度不足"


def build_instructions(
    fields: list[FieldSpec],
    profile: dict[str, Any] | None,
    slots: list[Slot] | tuple[Slot, ...] | None = None,
) -> dict[str, Any]:
    """生成填充指令。"""
    slot_list = list(slots) if slots is not None else list(load_dictionary())
    matches: list[FieldMatch] = match_fields(fields, slot_list)

    instructions: list[Instruction] = []
    unmatched: list[str] = []
    stats = {"total": len(fields), "matched": 0, "fill": 0, "review": 0, "skip": 0,
             "no_value": 0, "unmatched": 0, "local_only": 0}

    for m in matches:
        if not m.matched or m.slot is None:
            unmatched.append(m.field.selector)
            stats["unmatched"] += 1
            continue

        stats["matched"] += 1
        slot = m.slot
        raw = resolve_value(profile, m.field_key)

        if raw is None or (isinstance(raw, str) and not raw.strip()):
            instructions.append(
                Instruction(
                    selector=m.field.selector,
                    field_key=m.field_key,
                    value="",
                    confidence=round(m.confidence, 3),
                    handler=slot.handler,
                    action="skip",
                    reason="档案缺少该字段",
                )
            )
            stats["no_value"] += 1
            continue

        value, handler_conf = apply_handler(slot.handler, raw, m.field, slot)
        final = min(m.confidence, handler_conf) if handler_conf < 1.0 else m.confidence
        action, reason = classify(final)

        if final < settings.review_threshold and handler_conf < 1.0:
            reason = "下拉选项未匹配"

        # 文书字数校验（规划：PS/SOP 硬性字数限制，超限只降级、不静默截断）：
        # essays 组或页面声明 maxlength 的字段附字数检查；超限时 fill→review。
        word_check = None
        if slot.group == "essays" or m.field.maxlength is not None:
            word_check = check_words(
                str(value),
                limit_words=slot.word_limit,
                limit_chars=m.field.maxlength,
            )
            if not word_check["ok"]:
                hint = describe_check(word_check)
                reason = f"{reason}；{hint}" if reason else hint
                if action == "fill":
                    action = "review"
                stats["word_over"] = stats.get("word_over", 0) + 1

        if slot.key in settings.local_only_fields:
            stats["local_only"] += 1

        instructions.append(
            Instruction(
                selector=m.field.selector,
                field_key=m.field_key,
                value=str(value),
                confidence=round(final, 3),
                handler=slot.handler,
                action=action,
                reason=reason,
                word_check=word_check,
            )
        )
        stats[action] = stats.get(action, 0) + 1

    log.info(
        "字段匹配完成 total=%s matched=%s fill=%s review=%s skip=%s unmatched=%s",
        stats["total"], stats["matched"], stats["fill"], stats["review"], stats["skip"], stats["unmatched"],
    )
    return {
        "instructions": [i.to_dict() for i in instructions],
        "unmatched": unmatched,
        "blocked": False,
        "stats": stats,
    }


def summarize_stats(payload: dict[str, Any]) -> dict[str, Any]:
    """把 stats 折算成识别率 / 填充率（对齐可行性报告的「识别 70% / 填充 80%」口径）。"""
    s = payload.get("stats", {})
    total = s.get("total", 0) or 1
    matched = s.get("matched", 0)
    filled = s.get("fill", 0) + s.get("review", 0)
    return {
        "识别率": round(matched / total, 4),
        "填充率": round(filled / total, 4),
        "自动填充率": round(s.get("fill", 0) / total, 4),
        "未识别": s.get("unmatched", 0),
        "档案缺失": s.get("no_value", 0),
    }
