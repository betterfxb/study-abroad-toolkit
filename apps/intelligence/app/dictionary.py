"""字段词典加载。

词典是跨端共享资产（`packages/field-dictionary/fields.json`），
插件 TS 端与服务端读同一份，避免两端字段定义漂移。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from .config import settings
from .normalize import normalize_signal

_INDEX_RE = re.compile(r"\[(\d+)\]")


@dataclass(frozen=True)
class Slot:
    """一个语义槽位。"""

    key: str
    label: str
    value_type: str
    handler: str
    priority: int
    keywords: tuple[str, ...]
    negative: tuple[str, ...]
    group: str | None = None
    repeatable: bool = False
    word_limit: int | None = None

    @property
    def base_key(self) -> str:
        """去掉数组下标：`education[0].institution` → `education.institution`。"""
        return _INDEX_RE.sub("", self.key)

    @property
    def index(self) -> int:
        m = _INDEX_RE.search(self.key)
        return int(m.group(1)) if m else 0


def _normalized_list(values: list[str] | None) -> tuple[str, ...]:
    if not values:
        return ()
    out: list[str] = []
    for v in values:
        n = normalize_signal(v)
        if n and n not in out:
            out.append(n)
    return tuple(out)


def parse_dictionary(data: dict) -> list[Slot]:
    slots: list[Slot] = []
    for raw in data.get("slots", []):
        slots.append(
            Slot(
                key=raw["key"],
                label=raw.get("label", raw["key"]),
                value_type=raw.get("value_type", "text"),
                handler=raw.get("handler", "text"),
                priority=int(raw.get("priority", 50)),
                keywords=_normalized_list(raw.get("keywords")),
                negative=_normalized_list(raw.get("negative")),
                group=raw.get("group"),
                repeatable=bool(raw.get("repeatable", False)),
                word_limit=raw.get("word_limit"),
            )
        )
    return slots


@lru_cache(maxsize=4)
def load_dictionary(path: str | None = None) -> tuple[Slot, ...]:
    """加载并缓存字段词典。"""
    p = Path(path or settings.dictionary_path)
    if not p.exists():
        raise FileNotFoundError(f"字段词典不存在: {p}")
    data = json.loads(p.read_text(encoding="utf-8"))
    return tuple(parse_dictionary(data))


def slot_map(slots: tuple[Slot, ...] | list[Slot]) -> dict[str, Slot]:
    return {s.key: s for s in slots}
