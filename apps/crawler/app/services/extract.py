"""抽取：正文清洗 + 岗位结构化。

结构化优先走 LLM；LLM 不可用时自动降级到正则规则抽取，保证链路不断。
"""

from __future__ import annotations

import json
import re
from typing import Any

from ..llm.client import LLMUnavailable, default_client
from ..utils import get_logger, truncate
from . import normalize as nz

log = get_logger(__name__)

_JOB_SYSTEM = """你是实习招聘信息抽取助手。从给定的公众号文章正文中抽取实习岗位信息。
只输出 JSON，不要解释。字段：
company(公司), title(岗位名), city(城市), salary(薪资原文), duration(实习时长),
education_req(学历要求), major_req(专业要求), deadline(截止日期 YYYY-MM-DD),
retain_chance(留用机会), apply_method(投递方式原文), confidence(0-1 置信度)。
若某字段不存在填 null。一篇文章可能包含多个岗位，输出 {"jobs": [...]}。"""


def extract_content(html: str | None) -> str:
    """从 HTML 抽取正文纯文本。"""
    if not html:
        return ""
    try:
        from trafilatura import extract

        text = extract(html)
        if text:
            return text.strip()
    except Exception:  # noqa: BLE001 - 无依赖或抽取失败则降级
        log.debug("trafilatura 不可用，降级为标签剥离")
    return strip_tags(html)


def strip_tags(html: str) -> str:
    """极简 HTML 标签剥离，作为零依赖兜底。"""
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", html)
    text = re.sub(r"(?s)<br\s*/?>", "\n", text)
    text = re.sub(r"(?s)</p>", "\n", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = re.sub(r"&nbsp;?", " ", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&lt;", "<", text)
    text = re.sub(r"&gt;", ">", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def structure_jobs(content: str, use_llm: bool = True) -> list[dict[str, Any]]:
    """把正文结构化为岗位列表。"""
    if not content:
        return []

    if use_llm:
        try:
            result = default_client.complete(
                task="extract_job",
                prompt=truncate(content, 6000),
                system=_JOB_SYSTEM,
                temperature=0.0,
                max_tokens=2048,
            )
            jobs = _parse_llm_json(result.text)
            if jobs:
                return [_post_process(j) for j in jobs]
        except LLMUnavailable as exc:
            log.info("LLM 不可用，降级到规则抽取: %s", exc)
        except Exception as exc:  # noqa: BLE001
            log.warning("LLM 抽取异常，降级到规则抽取: %s", exc)

    return [_post_process(j) for j in rule_based_extract(content)]


def _parse_llm_json(text: str) -> list[dict[str, Any]]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.MULTILINE).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        log.warning("LLM 返回非法 JSON，降级到规则抽取")
        return []
    if isinstance(data, dict):
        return data.get("jobs", []) if isinstance(data.get("jobs"), list) else []
    return data if isinstance(data, list) else []


def _label(keys: str, inline: bool = False) -> re.Pattern[str]:
    """构造容错标签匹配：支持 `公司：x` / `【公司】x` / `Company: x` 等写法。

    四个关键约束（避免误匹配）：
      1. 标签默认必须在**行首**（允许前置括号与空白）；`inline=True` 时放开行首锚点，
         用于兜底「一行式 / 自由文本」里出现在句子中间的标签（如 `…，base 上海，…`）。
      2. 标签后必须紧跟分隔符（右括号 / 冒号 / 空白 / 行尾）。
         否则 "岗位职责：xxx" 会被误判为 "岗位" 字段，导致一篇被拆成多条；
      3. 标签后若紧跟「职责/要求/描述…」类词，直接判为非标签（行内模式下的第二道闸）；
      4. 大小写不敏感，兼容英文标签（Company / Position / Location ...）。
    """
    head = r"[【\[（(]?[ \t]*" if inline else r"^[ \t]*[【\[（(]?[ \t]*"
    return re.compile(
        head + r"(?:" + keys + r")"
        r"(?![职责要求描述说明内容介绍详情])"
        r"[ \t]*(?=[】\]）)]|[:：]|[ \t]|$)"
        r"[】\]）)]?[ \t]*[:：]?[ \t]*"
        r"([^\n，,。；;【】\[\]]{1,60})",
        re.MULTILINE | re.IGNORECASE,
    )


_COMPANY = _label("公司名称|公司|单位|企业|Company|Employer|Organization|Org")
_COMPANY_IN = _label("公司名称|公司|单位|企业|Company|Employer|Organization|Org", inline=True)
_TITLE = _label("招聘岗位|岗位名称|岗位|职位|Position|Job Title|Role|Opening")
_TITLE_SUFFIX = re.compile(r"([\u4e00-\u9fffA-Za-z]{2,12}?(?:实习生|实习|管培生|暑期实习))")
# 无标签场景下，标题常被整句吞掉（如"字节跳动最近在招产品运营实习生"），
# 取最后一个动词之后的部分作为标题
_TITLE_VERB = re.compile(r"^.*?(?:正在招|在招|急招|诚招|招募|招聘|招)")
# 无标签场景下的公司识别：「X在招/招 Y」句式（公众号/平台常见写法）
_COMPANY_ACTION = re.compile(
    r"(?!我们|各位|大家|同学|本公司|该公司|贵公司)"
    r"([\u4e00-\u9fffA-Za-z0-9]{2,16}?)"
    r"(?:最近|目前|现在|近期)?(?:正在|在)?(?:招聘|招募|诚招|急招|招)"
)
# 无标签场景下的公司识别：首个非标签用语的【…】括号块
_LABEL_KEYWORDS = {
    "公司", "公司名称", "单位", "企业", "岗位", "岗位名称", "招聘岗位", "职位",
    "工作地点", "城市", "地点", "薪资", "待遇", "日薪", "月薪", "实习薪资",
    "学历", "学历要求", "专业", "专业要求", "截止", "截止日期", "截止时间",
    "投递", "投递方式", "投递截止", "实习时长", "实习时间", "时长", "备注",
}
_BRACKET_TOKEN = re.compile(r"【([^】\n]{1,20})】")
_CITY = _label("工作地点|城市|地点|base|Base|Location|City")
_CITY_IN = _label("工作地点|城市|地点|base|Base|Location|City", inline=True)
_PIPE_SPLIT = re.compile(r"[｜|]")
_SALARY = _label("实习薪资|薪资|待遇|日薪|月薪|Salary|Compensation|Pay")
# 无标签裸薪资：`200元/天` / `180-220元/天` / `180 块`
_SALARY_BARE = re.compile(
    r"(\d+(?:\.\d+)?\s*[-~至]?\s*\d*\s*(?:元|块|k|K|千)\s*(?:/|每)?\s*(?:天|日|月|小时|时)?)"
)
_DURATION = _label("实习时长|实习时间|时长|Duration")
_EDU = _label("学历要求|学历|Education")
_MAJOR = _label("专业要求|专业|Major")
_DEADLINE = _label("截止日期|截止时间|投递截止|截止到|截至|截止|Deadline|Apply by|Close Date|Closing")
_DEADLINE_IN = _label(
    "截止日期|截止时间|投递截止|截止到|截至|截止|Deadline|Apply by|Close Date|Closing",
    inline=True,
)
_RETAIN = re.compile(r"(可转正|有留用|留用机会|转正机会|无留用)")


def _bracket_company(block: str) -> str:
    """取首个非标签用语的【…】块作为公司名（如 `【腾讯】交互设计实习生`）。"""
    for m in _BRACKET_TOKEN.finditer(block):
        token = m.group(1).strip()
        if token and token not in _LABEL_KEYWORDS:
            return token
    return ""


def _pipe_city(block: str) -> str:
    """从管道分隔片段里识别城市（如 `…｜深圳｜200元/天…`）。"""
    for seg in _PIPE_SPLIT.split(block):
        seg = seg.strip()
        if seg in nz.CITY_NAMES:
            return seg
    return ""


def rule_based_extract(content: str) -> list[dict[str, Any]]:
    """零依赖的正则规则抽取（降级兜底）。

    分块策略：先按空行分段；段内以「公司行 / 岗位行」为边界，
    且仅当当前块已出现过同类标签时才切分，避免把同一岗位的公司行与岗位行拆开。
    """
    blocks: list[str] = []
    for para in re.split(r"\n\s*\n", content):
        lines = [ln.strip() for ln in para.splitlines() if ln.strip()]
        current: list[str] = []
        for line in lines:
            has_company = bool(_COMPANY.search(line))
            has_title = bool(_TITLE.search(line))
            split = (has_company and any(_COMPANY.search(x) for x in current)) or (
                has_title and any(_TITLE.search(x) for x in current)
            )
            if split:
                blocks.append("\n".join(current))
                current = []
            current.append(line)
        if current:
            blocks.append("\n".join(current))

    if not blocks:
        blocks = [content]

    jobs: list[dict[str, Any]] = []
    for block in blocks[:20]:
        job = _extract_block(block)
        if job:
            jobs.append(job)
    return jobs


def _extract_block(block: str) -> dict[str, Any] | None:
    # 公司：行首标签 → 【…】括号块 → 「X在招/招」句式
    company = _first(_COMPANY, block) or _bracket_company(block) or _first(_COMPANY_ACTION, block)
    title = _first(_TITLE, block)
    if not title:
        # 无显式标签：退化为后缀匹配，并剥掉句子里的动词前缀
        m = _TITLE_SUFFIX.search(block)
        if m:
            title = _TITLE_VERB.sub("", m.group(1)).strip() or m.group(1)
    if not company and not title:
        return None

    # 城市：行首标签 → 行内标签 → 管道片段
    city_raw = _first(_CITY, block) or _first(_CITY_IN, block) or _pipe_city(block)
    # 薪资：行首标签 → 裸薪资（自由文本无标签时）
    salary_raw = _first(_SALARY, block) or _first(_SALARY_BARE, block)
    # 截止：行首标签 → 行内标签（一行式 / 自由文本）
    deadline_raw = _first(_DEADLINE, block) or _first(_DEADLINE_IN, block)
    retain = _first(_RETAIN, block)

    return {
        "company": company or "",
        "title": title or "",
        "city": nz.normalize_city(city_raw) if city_raw else "",
        "salary": salary_raw or "",
        "duration": _first(_DURATION, block) or "",
        "education_req": nz.normalize_education(_first(_EDU, block)) if _first(_EDU, block) else "",
        "major_req": _first(_MAJOR, block) or "",
        "deadline": deadline_raw or "",
        "retain_chance": retain or "",
        "apply_method": nz.format_apply_method(nz.extract_apply_method(block)),
        "confidence": None,
        "_source": "rule",
    }


def _first(pattern: re.Pattern[str], text: str) -> str:
    m = pattern.search(text)
    return m.group(1).strip() if m else ""


def _post_process(job: dict[str, Any]) -> dict[str, Any]:
    """标准化岗位字段，并按字段完整度推导置信度。"""
    method_raw = job.get("apply_method") or ""
    method = nz.extract_apply_method(method_raw) if method_raw else {}
    deadline = nz.parse_deadline(job.get("deadline"))

    normalized = {
        "company": (job.get("company") or "").strip(),
        "title": (job.get("title") or "").strip(),
        "city": nz.normalize_city(job.get("city")),
        "salary": nz.normalize_salary(job.get("salary")),
        "duration": (job.get("duration") or "").strip(),
        "education_req": nz.normalize_education(job.get("education_req")),
        "major_req": (job.get("major_req") or "").strip(),
        "apply_method": nz.format_apply_method(method) if method else method_raw,
        "apply_url": method.get("url", ""),
        "deadline": deadline.isoformat() if deadline else None,
        "retain_chance": (job.get("retain_chance") or "").strip(),
    }
    normalized["confidence"] = _derive_confidence(normalized, job.get("confidence"))
    return normalized


# 参与置信度计算的字段（核心 + 高价值）
_CONFIDENCE_FIELDS = (
    "company", "title", "city", "salary",
    "education_req", "apply_method", "deadline",
)


def _derive_confidence(job: dict[str, Any], explicit: Any = None) -> float:
    """按关键字段填充度推导置信度。

    规则抽取没有模型打分，若写死一个常数会让「低置信度占比」这类指标失去意义；
    改为按实际抽取到的字段数推导，更能反映数据可用性。
    LLM 返回了显式置信度时以其为准。
    """
    if explicit is not None:
        try:
            value = float(explicit)
            if value > 0:
                return round(value, 3)
        except (TypeError, ValueError):
            pass
    filled = sum(1 for f in _CONFIDENCE_FIELDS if (job.get(f) or "").strip())
    return round(min(0.90, 0.35 + 0.08 * filled), 2)


def normalize_job(job: dict[str, Any]) -> dict[str, Any]:
    """对外暴露的岗位标准化入口。

    已结构化的源（JSON 招聘 API）拿到字段后直接调用，跳过 LLM / 规则抽取，
    但仍走同一套标准化（城市、薪资、学历、日期、投递方式）。
    """
    return _post_process(job)
