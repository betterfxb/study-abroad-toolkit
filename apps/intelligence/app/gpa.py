"""GPA 制式换算（纯函数，零依赖）。

对应 docs/02-详细设计/03-接口契约.md §7.2 `POST /internal/gpa/convert`。
百分制阶梯与 handlers.h_gpa 同口径（单一事实源，本模块定义、handlers 引用），
避免两处阶梯漂移。英制等级换算走控制台 `GpaTab` 本地换算器，本服务暂不支持。
"""

from __future__ import annotations

import re
from typing import Any

ESTIMATE_NOTE = "估算值，以官方换算为准"

# 百分制 → 4.0 阶梯（下限，含）：与 h_gpa 历史行为一致
_LADDER_100: tuple[tuple[float, float], ...] = (
    (90, 4.0),
    (85, 3.7),
    (82, 3.3),
    (78, 3.0),
    (75, 2.7),
    (72, 2.3),
    (68, 2.0),
    (64, 1.5),
    (60, 1.0),
)

_NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")


def extract_number(value: Any) -> float | None:
    """从原始值（含 `{"value": x}` 包装）提取首个数字；无数字返回 None。"""
    if isinstance(value, dict):
        value = value.get("value", "")
    m = _NUM_RE.search(str(value if value is not None else ""))
    if not m:
        return None
    try:
        return float(m.group(0))
    except ValueError:
        return None


def ladder_100_to_4(value: float) -> float:
    """百分制 → 4.0 阶梯映射（60 以下记 0.0）。"""
    for bound, gpa in _LADDER_100:
        if value >= bound:
            return gpa
    return 0.0


def format_gpa(value: float) -> str:
    """4.0 制格式化：保留两位、去尾零（3.70 → 3.7）。"""
    return f"{value:.2f}".rstrip("0").rstrip(".")


def _normalize_scale(scale: Any, allowed: tuple[str, ...], what: str) -> str:
    s = str(scale or "").strip().lower().replace("分制", "").replace(" ", "")
    alias = {
        "100": "100", "percent": "100", "percentage": "100", "百分": "100",
        "5": "5", "5.0": "5",
        "4": "4.0", "4.0": "4.0",
    }
    norm = alias.get(s, s)
    if norm not in allowed:
        raise ValueError(f"{what} 不支持：{scale}（可用：{', '.join(allowed)}）")
    return norm


def convert_gpa(
    value: Any,
    from_scale: Any = "100",
    to_scale: Any = "4.0",
    country: Any = "US",
) -> dict[str, str]:
    """制式换算，返回契约形状 `{"value", "method", "note"}`。

    - from 100 → 阶梯法（method standard_ladder）
    - from 5 → 线性 v/5*4（method scale_linear）
    - from 4.0 → 原样（method identity）
    - to 仅支持 4.0；country 保留入参（英制等级请用控制台成绩换算）。
    非法输入抛 ValueError（接口层转 400 + 1001）。
    """
    src = _normalize_scale(from_scale, ("100", "5", "4.0"), "from_scale")
    _normalize_scale(to_scale, ("4.0",), "to_scale")

    num = extract_number(value)
    if num is None:
        raise ValueError(f"value 无法解析为数字：{value!r}")

    if src == "100":
        if num < 0 or num > 100:
            raise ValueError(f"百分制超出范围：{value!r}")
        out = format_gpa(ladder_100_to_4(num))
        method = "standard_ladder"
    elif src == "5":
        if num < 0 or num > 5:
            raise ValueError(f"5 分制超出范围：{value!r}")
        out = format_gpa(round(num / 5 * 4, 2))
        method = "scale_linear"
    else:
        if num < 0 or num > 4.0:
            raise ValueError(f"4.0 制超出范围：{value!r}")
        out = format_gpa(num)
        method = "identity"
    return {"value": out, "method": method, "note": ESTIMATE_NOTE}
