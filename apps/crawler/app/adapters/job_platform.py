"""招聘平台 / 招聘 API 适配器（主源 C）。

支持两类接入：
  1. **内置预设**（开箱即用，用于验证真实链路）：
     - `remotive`：https://remotive.com/api/remote-jobs
     - `remoteok`：https://remoteok.com/api
  2. **自定义 JSON API**：通过 `fields` 配置把任意 JSON 接口的字段映射到统一结构。

配置示例::

    {"platform": "remotive", "limit": 50}

    {"api_url": "https://api.example.com/jobs", "list_path": "data",
     "required": "title",
     "fields": {"url": "link", "title": "name", "company": "org",
                "city": "location", "content": "description"}}

返回的条目为**已结构化**岗位（RawItem.job），流水线会跳过抽取直接标准化。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from ..utils import get_logger
from .base import FetchResult, RawItem, SourceAdapter
from .registry import register

log = get_logger(__name__)

# 预设：真实公开招聘 API
PRESETS: dict[str, dict[str, Any]] = {
    "remotive": {
        "api_url": "https://remotive.com/api/remote-jobs",
        "list_path": "jobs",
        "query": {"limit": "{limit}"},
        "required": "title",
        "fields": {
            "url": "url",
            "title": "title",
            "company": "company_name",
            "city": "candidate_required_location",
            "salary": "salary",
            "content": "description",
            "published_at": "publication_date",
            "account_name": "category",
        },
    },
    "remoteok": {
        "api_url": "https://remoteok.com/api",
        "list_path": "",
        "query": {},
        "required": "position",
        "fields": {
            "url": "url",
            "title": "position",
            "company": "company",
            "city": "location",
            "salary_min": "salary_min",
            "salary_max": "salary_max",
            "content": "description",
            "published_at": "date",
            "apply_url": "apply_url",
        },
    },
}


@register
class JobPlatformAdapter(SourceAdapter):
    code = "job_platform"
    source_type = "job_platform"

    def _preset(self) -> dict[str, Any]:
        platform = self.cfg("platform")
        if platform:
            if platform not in PRESETS:
                raise ValueError(
                    f"未知平台预设: {platform}；可用: {sorted(PRESETS)}；"
                    "或改用 api_url + fields 自定义配置"
                )
            return PRESETS[platform]
        if not self.cfg("api_url"):
            raise NotImplementedError(
                "job_platform 适配器需配置 platform（预设名）或 api_url（自定义接口）"
            )
        return {
            "api_url": self.cfg("api_url"),
            "list_path": self.cfg("list_path", ""),
            "query": self.cfg("query", {}),
            "required": self.cfg("required", "title"),
            "fields": self.cfg("fields", {}),
        }

    def fetch(self, limit: int = 50) -> FetchResult:
        preset = self._preset()
        client = self.http_client()

        api_url = preset["api_url"]
        query = {
            k: str(v).format(limit=limit) for k, v in (preset.get("query") or {}).items()
        }
        url = api_url
        if query:
            from urllib.parse import urlencode

            url = f"{api_url}?{urlencode(query)}"

        try:
            resp = client.get(url, headers={"Accept": "application/json"})
        except Exception as exc:  # noqa: BLE001 - 合规拦截或网络异常
            log.warning("招聘 API 抓取失败 url=%s err=%s", url, exc)
            return FetchResult(items=[], message=str(exc))

        if not resp.ok:
            return FetchResult(
                items=[], rate_limited=resp.rate_limited, http_status=resp.status,
                message=f"HTTP {resp.status}",
            )

        try:
            import json

            payload = json.loads(resp.text)
        except Exception as exc:  # noqa: BLE001
            return FetchResult(
                items=[], http_status=resp.status,
                message=f"JSON 解析失败: {exc}",
            )

        rows = _dig(payload, preset.get("list_path", ""))
        if not isinstance(rows, list):
            return FetchResult(
                items=[], http_status=resp.status,
                message=f"list_path={preset.get('list_path')!r} 未指向数组",
            )

        required = preset.get("required")
        fields = preset.get("fields", {})
        items: list[RawItem] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            if required and not row.get(required):
                continue  # 跳过公告类条目（如 RemoteOK 的首条 legal 声明）
            item = self._map_row(row, fields, query)
            if item:
                items.append(item)
            if len(items) >= limit:
                break

        log.info("招聘 API 采集完成 platform=%s items=%d status=%s",
                 self.cfg("platform") or url, len(items), resp.status)
        return FetchResult(items=items, http_status=resp.status)

    # ------------------------------------------------------------------
    def _map_row(
        self,
        row: dict[str, Any],
        fields: dict[str, str],
        query: dict[str, str],
    ) -> RawItem | None:
        def pick(key: str) -> Any:
            path = fields.get(key)
            return _dig(row, path) if path else None

        url = str(pick("url") or "").strip()
        title = str(pick("title") or "").strip()
        if not url or not title:
            return None

        content = str(pick("content") or "")
        published = _parse_dt(pick("published_at"))
        account = str(pick("account_name") or self.cfg("account_name") or "招聘平台")
        apply_url = str(pick("apply_url") or url)

        salary = self._salary(row, fields, pick)

        job: dict[str, Any] = {
            "company": str(pick("company") or "").strip(),
            "title": title,
            "city": str(pick("city") or "").strip(),
            "salary": salary,
            "duration": str(pick("duration") or "").strip(),
            "education_req": str(pick("education_req") or "").strip(),
            "major_req": str(pick("major_req") or "").strip(),
            "apply_method": f"链接: {apply_url}",
            "apply_url": apply_url,
            "deadline": str(pick("deadline") or "").strip() or None,
            "retain_chance": str(pick("retain_chance") or "").strip(),
        }

        return RawItem(
            url=url,
            title=title,
            account_name=account,
            published_at=published,
            summary=_strip_html(content)[:300],
            content=_strip_html(content),
            job=job,
            extra={"adapter": self.code, "platform": self.cfg("platform"), "query": query},
        )

    @staticmethod
    def _salary(row: dict[str, Any], fields: dict[str, str], pick) -> str:
        direct = pick("salary")
        if direct:
            return str(direct).strip()
        low = row.get(fields.get("salary_min", "")) if fields.get("salary_min") else None
        high = row.get(fields.get("salary_max", "")) if fields.get("salary_max") else None
        if low or high:
            unit = "USD/年"
            if low and high:
                return f"{int(low)}-{int(high)} {unit}"
            return f"{int(low or high)} {unit}"
        return ""

    def health_check(self) -> dict[str, Any]:
        try:
            preset = self._preset()
            return {"ok": True, "adapter": self.code, "api_url": preset["api_url"]}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "adapter": self.code, "message": str(exc)}


# ----------------------------------------------------------------------
def _dig(data: Any, path: str | None) -> Any:
    """按点号路径取值，空路径返回自身。"""
    if not path:
        return data
    cur = data
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list) and part.isdigit():
            cur = cur[int(part)] if int(part) < len(cur) else None
        else:
            return None
        if cur is None:
            return None
    return cur


def _parse_dt(raw: Any) -> datetime | None:
    if not raw:
        return None
    text = str(raw).strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _strip_html(html: str) -> str:
    from ..services.extract import strip_tags

    return strip_tags(html) if html else ""
