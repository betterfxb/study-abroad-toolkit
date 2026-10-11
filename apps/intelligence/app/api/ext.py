"""插件侧接口：字段语义匹配。

对应 docs/02-详细设计/03-接口契约.md §4.1 `/ext/v1/match-fields`。
响应遵循契约「通用响应」封装：`{ code, message, data, trace_id }`。
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..dictionary import load_dictionary
from ..pipeline import build_instructions, summarize_stats
from ..schema import FieldSpec
from ..utils import get_logger

log = get_logger(__name__)
router = APIRouter(prefix="/ext/v1", tags=["ext"])


def envelope(data: Any, trace_id: str | None = None, message: str = "ok", code: int = 0) -> dict[str, Any]:
    return {"code": code, "message": message, "data": data, "trace_id": trace_id or uuid4().hex}


# ------------------------------------------------------------------ 请求模型
class FieldIn(BaseModel):
    selector: str
    label: str = ""
    name: str = ""
    id: str = ""
    placeholder: str = ""
    aria_label: str = Field("", alias="aria-label")
    near_text: str = ""
    type: str = "text"
    options: list[str] = Field(default_factory=list)
    required: bool = False
    maxlength: int | None = None

    model_config = {"populate_by_name": True}


class MatchRequest(BaseModel):
    session_id: int | None = None
    page_url: str = ""
    system_code: str = ""
    profile: dict[str, Any] | None = Field(
        default=None,
        description="用户档案。生产环境由 api-gateway 按 session 注入；PoC 可直接传入。",
    )
    fields: list[FieldIn] = Field(default_factory=list)


class MatchResponse(BaseModel):
    instructions: list[dict[str, Any]]
    unmatched: list[str]
    blocked: bool = False
    stats: dict[str, Any] = Field(default_factory=dict)
    summary: dict[str, Any] = Field(default_factory=dict)


# ------------------------------------------------------------------ 接口
@router.post("/match-fields", summary="批量字段语义匹配，返回填充指令")
def match_fields(req: MatchRequest) -> dict[str, Any]:
    if not req.fields:
        raise HTTPException(status_code=400, detail="fields 不能为空")

    fields = [
        FieldSpec.from_dict(
            {
                "selector": f.selector,
                "label": f.label,
                "name": f.name,
                "id": f.id,
                "placeholder": f.placeholder,
                "aria_label": f.aria_label,
                "near_text": f.near_text,
                "type": f.type,
                "options": f.options,
                "required": f.required,
                "maxlength": f.maxlength,
            }
        )
        for f in req.fields
    ]

    payload = build_instructions(fields, req.profile or {})
    payload["summary"] = summarize_stats(payload)
    log.info(
        "match-fields session=%s system=%s fields=%s 识别率=%s",
        req.session_id, req.system_code, len(fields), payload["summary"]["识别率"],
    )
    return envelope(payload)


@router.get("/dictionary", summary="字段词典（供插件端核对版本）")
def dictionary() -> dict[str, Any]:
    slots = load_dictionary()
    return envelope(
        {
            "count": len(slots),
            "slots": [
                {
                    "key": s.key,
                    "label": s.label,
                    "value_type": s.value_type,
                    "handler": s.handler,
                    "group": s.group,
                    "repeatable": s.repeatable,
                }
                for s in slots
            ],
        }
    )
