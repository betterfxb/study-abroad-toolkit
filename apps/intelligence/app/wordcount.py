"""文书字数校验（纯函数，零依赖）。

对应规划「PS/SOP 硬性字数限制，需字数实时校验」与「提交前硬校验」。
口径：英文按词计（空白分隔的字母数字串，含连字符/缩写），中文按字计
（CJK 统一表意文字逐字），总字符为 len(text)。学校常用词数限制
（如 SOP 500~1000 词）由字段词典 `word_limit` 或页面 `maxlength` 传入，
未配置时只计数、不判定（ok=True）。
"""

from __future__ import annotations

import re
from typing import Any

_WORD_RE = re.compile(r"[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*")
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")


def count_words(text: Any) -> dict[str, int]:
    """计数：words（英文词）/ cjk_chars（中文字）/ chars（总字符）。"""
    s = "" if text is None else str(text)
    return {
        "words": len(_WORD_RE.findall(s)),
        "cjk_chars": len(_CJK_RE.findall(s)),
        "chars": len(s),
    }


def _as_limit(v: Any) -> int | None:
    """归一化限制值：None/非正数（DOM 缺省 -1 表无限制）一律视为未配置。"""
    try:
        n = int(v) if v is not None else None
    except (TypeError, ValueError):
        return None
    return n if n and n > 0 else None


def check_words(
    text: Any,
    limit_words: int | None = None,
    limit_chars: int | None = None,
) -> dict[str, Any]:
    """校验：未配置限制时只计数（ok=True）；任一超限则 ok=False 并给出超量。"""
    limit_words = _as_limit(limit_words)
    limit_chars = _as_limit(limit_chars)
    counts = count_words(text)
    words, chars = counts["words"], counts["chars"]
    exceeds_by_words = max(0, words - limit_words) if limit_words else 0
    exceeds_by_chars = max(0, chars - limit_chars) if limit_chars else 0
    return {
        **counts,
        "limit_words": limit_words,
        "limit_chars": limit_chars,
        "ok": not (exceeds_by_words or exceeds_by_chars),
        "exceeds_by_words": exceeds_by_words,
        "exceeds_by_chars": exceeds_by_chars,
    }


def describe_check(check: dict[str, Any]) -> str:
    """超限提示文案（ok 时返回空串）。"""
    if check.get("ok", True):
        return ""
    parts = []
    if check.get("exceeds_by_words"):
        parts.append(f"约{check['words']}词/限{check['limit_words']}词")
    if check.get("exceeds_by_chars"):
        parts.append(f"{check['chars']}字符/限{check['limit_chars']}字符")
    return "文书超字数：" + "、".join(parts) + "，需删减后复核"
