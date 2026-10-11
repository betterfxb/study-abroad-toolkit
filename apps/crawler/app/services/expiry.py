"""岗位过期下架（纯逻辑 + 编排各半，零第三方依赖）。

对应规划「记录截止时间，过期自动下架」：`deadline` 早于今天且仍为
`active` 的岗位，批量置为 `expired`。默认读侧（`GET /jobs`）只返回
`active`，下架后不再打扰订阅匹配；历史数据仍可按 `status=expired` 查询。
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Iterable


def to_day(value: Any) -> date | None:
    """把 DATE / datetime / ISO 字符串归一化为 date；非法返回 None。"""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        s = value.strip()[:10]
        try:
            return date.fromisoformat(s)
        except ValueError:
            return None
    return None


def select_expired(
    rows: Iterable[tuple[Any, Any, Any]],
    today: date | None = None,
) -> list[Any]:
    """纯函数：从 `(id, deadline, status)` 行中挑出应下架的 id。

    规则：status == 'active' 且 deadline 可解析且 deadline < today。
    """
    day = today or date.today()
    out: list[Any] = []
    for job_id, deadline, status in rows:
        if status != "active":
            continue
        d = to_day(deadline)
        if d is not None and d < day:
            out.append(job_id)
    return out


def expire_jobs(session, today: date | None = None) -> dict[str, Any]:
    """编排：把过期 active 岗位批量置 expired，返回计数（供任务与管理接口共用）。"""
    from ..models import Job

    day = today or date.today()
    rows = (
        session.query(Job.id, Job.deadline, Job.status)
        .filter(Job.status == "active", Job.deadline.is_not(None))
        .all()
    )
    ids = select_expired(rows, day)
    if ids:
        session.query(Job).filter(Job.id.in_(ids)).update(
            {Job.status: "expired"}, synchronize_session=False
        )
        session.commit()
    return {"ok": True, "expired": len(ids), "checked_at": day.isoformat()}
