"""字段信号归一化。

网申页面的字段信号来源多样（label / name / id / placeholder / aria-label / 邻近文本），
写法混杂：`lastName`、`last_name`、`Last Name *`、`姓（必填）`。
归一化统一为「小写 + 空格分词 + 去噪音」，供词典匹配使用。
"""

from __future__ import annotations

import re

# 驼峰边界：lastName → last Name；XMLHttp → XML Http
_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")
# 分隔符
_SEPARATORS = re.compile(r"[_\-.\\/]+")
# 噪音词：必填标记、占位提示、括号说明
_NOISE = re.compile(
    r"(?:\(?\s*(?:required|optional|if any|please\s+(?:enter|select|specify|provide))\s*\)?"
    r"|必填|选填|请填写|请输入|请选择|如有|若适用)",
    re.IGNORECASE,
)
# 非字母数字（保留中日韩）
_NON_WORD = re.compile(r"[^\w\s\u4e00-\u9fff]")
_WS = re.compile(r"\s+")

_ASCII_ALNUM = re.compile(r"[a-z0-9]")


def normalize_signal(text: str | None) -> str:
    """把任意字段信号归一化为「小写 + 单空格分词」形式。"""
    if not text:
        return ""
    s = str(text)
    s = _CAMEL_BOUNDARY.sub(" ", s)
    s = _SEPARATORS.sub(" ", s)
    s = _NOISE.sub(" ", s)
    s = _NON_WORD.sub(" ", s)
    s = _WS.sub(" ", s)
    return s.strip().lower()


def contains_word(haystack: str, needle: str) -> bool:
    """归一化文本中的「词级」包含判断。

    纯子串匹配会把 `state` 命中 `statement`、`name` 命中 `username`，
    因此含 ASCII 的 needle 必须满足词边界；中文按子串判断（无词边界概念）。
    """
    if not haystack or not needle:
        return False
    if not _ASCII_ALNUM.search(needle):
        return needle in haystack
    return re.search(rf"(?<![a-z0-9]){re.escape(needle)}(?![a-z0-9])", haystack) is not None


def token_set(text: str) -> set[str]:
    return {t for t in normalize_signal(text).split(" ") if t}
