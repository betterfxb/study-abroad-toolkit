"""插件侧上报的字段结构。

对齐 docs/02-详细设计/03-接口契约.md §4.1 `/ext/v1/match-fields` 的 req.fields。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class FieldSpec:
    """网申页面上的一个表单字段。"""

    selector: str
    label: str = ""
    name: str = ""
    field_id: str = ""
    placeholder: str = ""
    aria_label: str = ""
    near_text: str = ""
    type: str = "text"
    options: list[str] = field(default_factory=list)
    required: bool = False
    maxlength: int | None = None

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "FieldSpec":
        return cls(
            selector=str(raw.get("selector") or raw.get("id") or ""),
            label=str(raw.get("label") or ""),
            name=str(raw.get("name") or ""),
            field_id=str(raw.get("id") or ""),
            placeholder=str(raw.get("placeholder") or ""),
            aria_label=str(raw.get("aria_label") or raw.get("aria-label") or ""),
            near_text=str(raw.get("near_text") or ""),
            type=str(raw.get("type") or "text").lower(),
            options=[str(o) for o in (raw.get("options") or [])],
            required=bool(raw.get("required", False)),
            maxlength=raw.get("maxlength"),
        )


@dataclass
class Instruction:
    """一条填充指令（契约 §4.1 res.data.instructions）。"""

    selector: str
    field_key: str
    value: str
    confidence: float
    handler: str
    action: str = "fill"          # fill | review | skip
    reason: str = ""
    word_check: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        out = {
            "selector": self.selector,
            "field_key": self.field_key,
            "value": self.value,
            "confidence": round(self.confidence, 3),
            "handler": self.handler,
        }
        if self.action != "fill":
            out["action"] = self.action
        if self.reason:
            out["reason"] = self.reason
        if self.word_check is not None:
            out["word_check"] = self.word_check
        return out
