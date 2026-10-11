"""内部服务接口：GPA 换算。

对应 docs/02-详细设计/03-接口契约.md §7.2 `POST /internal/gpa/convert`。
响应遵循契约「通用响应」封装：`{ code, message, data, trace_id }`。
参数非法 → 400（业务码 1001 口径，message 载明原因）。
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..gpa import convert_gpa
from ..utils import get_logger

log = get_logger(__name__)
router = APIRouter(prefix="/internal", tags=["internal"])


def envelope(data: Any, trace_id: str | None = None, message: str = "ok", code: int = 0) -> dict[str, Any]:
    return {"code": code, "message": message, "data": data, "trace_id": trace_id or uuid4().hex}


class GpaConvertRequest(BaseModel):
    value: Any = Field(..., description="原始成绩（88 / 3.7 / 'A' 等，数字优先）")
    from_scale: str = "100"
    to_scale: str = "4.0"
    country: str = "US"


@router.post("/gpa/convert", summary="GPA 制式换算（百分制/5分制 → 4.0）")
def gpa_convert(req: GpaConvertRequest) -> dict[str, Any]:
    try:
        data = convert_gpa(req.value, req.from_scale, req.to_scale, req.country)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    log.info("gpa-convert value=%r from=%s to=%s → %s", req.value, req.from_scale, req.to_scale, data["value"])
    return envelope(data)
