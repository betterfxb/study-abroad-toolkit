"""字段匹配器。

匹配分三级（对应架构详设 §3）：
  1. **词典精确匹配** —— label / name / id / aria 归一化后与关键词完全一致（置信度 0.92~1.00）
  2. **词典模糊匹配** —— 关键词作为词级子串出现在任一信号中（0.50~0.88）
  3. **LLM 语义匹配** —— 前两级都够不到时兜底（由 pipeline 调用，不可用则跳过）

本模块负责前两级 + 冲突消解。关键设计：

* **词边界**：`state` 不应命中 `statement`、`name` 不应命中 `username`（见 normalize.contains_word）
* **反例降权**：`Recommender Email` 不应被 `basic_info.email` 抢走（词典 negative 字段）
* **类型加成**：`type=date` 的字段更可能是日期槽位，`type=select` 更可能是枚举槽位
* **贪心分配**：按分数降序分配，非重复槽位只占一个字段；重复槽位（教育/考试/经历）按出现顺序编下标
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field as dc_field

from .dictionary import Slot
from .normalize import contains_word, normalize_signal
from .schema import FieldSpec

# 参与打分的信号及其权重
_EXACT_WEIGHT = {"name": 1.00, "label": 0.98, "id": 0.97, "aria": 0.95, "placeholder": 0.92, "near": 0.70}
_SUB_WEIGHT = {"name": 0.88, "id": 0.86, "label": 0.84, "aria": 0.78, "placeholder": 0.72, "near": 0.50}

# 低于该分数不认为构成匹配
MIN_SCORE = 0.45

# 题干识别：自定义问题通常是「对申请人发问」的句子。
# 最可靠的信号是第二人称/物主代词（your / you / we / us）——真实字段标签几乎不含这些词；
# 祈使动词开头作为辅助信号，但要求 ≥4 个词，避免误伤 `State/Province` 这类短名词短语标签。
_PROMPT_PRONOUN = re.compile(r"\b(?:your|you|yours|yourself|we|us)\b")
_PROMPT_LEAD = re.compile(r"^(?:state|describe|explain|discuss|list|tell|elaborate)\s+\w+")
_PROMPT_CAP = 0.40

_INDEX_RE = re.compile(r"\[(\d+)\]")


def is_prompt_like(label: str) -> bool:
    """判断标签是否更像「题目」而不是「字段名」。"""
    if not label:
        return False
    text = normalize_signal(label)
    if _PROMPT_PRONOUN.search(text):
        return True
    return bool(_PROMPT_LEAD.match(text)) and len(text.split()) >= 4


@dataclass
class FieldMatch:
    """一个字段的匹配结果。"""

    field: FieldSpec
    slot: Slot | None
    field_key: str
    confidence: float
    reason: str = ""
    signals: dict[str, str] = dc_field(default_factory=dict)

    @property
    def matched(self) -> bool:
        return self.slot is not None


def _signals(field: FieldSpec) -> dict[str, str]:
    return {
        "name": normalize_signal(field.name),
        "label": normalize_signal(field.label),
        "id": normalize_signal(field.field_id),
        "aria": normalize_signal(field.aria_label),
        "placeholder": normalize_signal(field.placeholder),
        "near": normalize_signal(field.near_text),
    }


def _type_bonus(slot: Slot, field: FieldSpec) -> float:
    """字段类型与槽位值类型的相容性调整。"""
    t = field.type
    bonus = 0.0
    if t == "email":
        bonus += 0.06 if slot.value_type == "email" else -0.12
    elif t in ("tel", "phone"):
        bonus += 0.06 if slot.value_type == "phone" else -0.10
    elif t == "date":
        bonus += 0.06 if slot.value_type == "date" else -0.10
    elif t == "number":
        bonus += 0.04 if slot.value_type == "number" else -0.06
    elif t == "select":
        bonus += 0.03 if slot.value_type == "select" else -0.06
    elif t == "textarea":
        bonus += 0.04 if slot.value_type == "richtext" else -0.04
    return bonus


def score_slot(slot: Slot, field: FieldSpec, signals: dict[str, str] | None = None) -> tuple[float, str]:
    """给「字段 → 槽位」打分，返回 (分数, 命中说明)。"""
    sig = signals if signals is not None else _signals(field)
    best, best_reason = 0.0, ""

    for kw in slot.keywords:
        for name, text in sig.items():
            if not text:
                continue
            if text == kw:
                s, why = _EXACT_WEIGHT[name], f"{name}=={kw}"
            elif contains_word(text, kw):
                s, why = _SUB_WEIGHT[name], f"{name}~{kw}"
            else:
                continue
            if s > best:
                best, best_reason = s, why

    if best <= 0.0:
        return 0.0, ""

    # 反例降权：命中任一反例词则封顶
    for neg in slot.negative:
        if any(contains_word(text, neg) for text in sig.values() if text):
            return min(best, 0.40), f"{best_reason}|neg:{neg}"

    # 题干降权：label 像一道题（对申请人发问）→ 判为自定义问题。
    # 例外：若 name/id 与关键词**完全一致**（开发者显式命名的语义字段，如 name="sop"），
    # 则仍按字段处理，避免把标准字段误判成题干。
    if is_prompt_like(field.label):
        exact_named = any(kw in (sig["name"], sig["id"]) for kw in slot.keywords)
        if not exact_named:
            return min(best, _PROMPT_CAP), f"{best_reason}|prompt-like"

    score = max(0.0, min(1.0, best + _type_bonus(slot, field)))
    return round(score, 4), best_reason


def _materialize(key: str, index: int) -> str:
    """把词典里的模板下标替换为实际下标：`education[0].major` + 1 → `education[1].major`。"""
    if "[" not in key:
        return key
    return _INDEX_RE.sub(f"[{index}]", key)


def match_fields(fields: list[FieldSpec], slots: list[Slot] | tuple[Slot, ...]) -> list[FieldMatch]:
    """批量匹配，返回与输入等长的结果列表（未匹配项 slot 为 None）。"""
    slot_list = list(slots)
    signals_cache = [_signals(f) for f in fields]

    # 1) 收集所有候选 (分数, 优先级, 字段序, 槽位序)
    candidates: list[tuple[float, int, int, int]] = []
    for fi, fld in enumerate(fields):
        for si, slot in enumerate(slot_list):
            score, _ = score_slot(slot, fld, signals_cache[fi])
            if score >= MIN_SCORE:
                candidates.append((score, slot.priority, fi, si))

    # 2) 贪心分配：高分优先；同分则槽位优先级高者先占
    candidates.sort(key=lambda x: (-x[0], -x[1], x[2], x[3]))
    chosen: dict[int, tuple[int, float]] = {}
    used_base: dict[str, int] = {}
    for score, _prio, fi, si in candidates:
        if fi in chosen:
            continue
        slot = slot_list[si]
        if not slot.repeatable and used_base.get(slot.base_key, 0) >= 1:
            continue
        chosen[fi] = (si, score)
        used_base[slot.base_key] = used_base.get(slot.base_key, 0) + 1

    # 3) 物化下标（重复槽位按出现顺序编号）
    base_counter: dict[str, int] = {}
    results: list[FieldMatch] = []
    for fi, fld in enumerate(fields):
        if fi not in chosen:
            results.append(FieldMatch(field=fld, slot=None, field_key="", confidence=0.0,
                                      reason="no_match", signals=signals_cache[fi]))
            continue
        si, score = chosen[fi]
        slot = slot_list[si]
        if slot.repeatable:
            idx = base_counter.get(slot.base_key, 0)
            base_counter[slot.base_key] = idx + 1
        else:
            idx = 0
        _, reason = score_slot(slot, fld, signals_cache[fi])
        results.append(
            FieldMatch(
                field=fld,
                slot=slot,
                field_key=_materialize(slot.key, idx),
                confidence=score,
                reason=reason,
                signals=signals_cache[fi],
            )
        )
    return results
