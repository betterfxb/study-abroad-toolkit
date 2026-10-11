"""字段标准化：城市 / 薪资 / 学历 / 截止时间 / 投递方式。零第三方依赖。"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta

CITY_ALIASES: dict[str, str] = {
    "北京市": "北京", "京": "北京",
    "上海市": "上海", "沪": "上海",
    "深圳市": "深圳", "深": "深圳",
    "广州市": "广州", "穗": "广州",
    "杭州市": "杭州", "南京市": "南京", "成都市": "成都",
    "武汉市": "武汉", "西安市": "西安", "苏州市": "苏州",
    "天津市": "天津", "重庆市": "重庆", "长沙市": "长沙",
    "青岛市": "青岛", "宁波市": "宁波", "厦门市": "厦门",
    "合肥市": "合肥", "郑州市": "郑州", "济南市": "济南",
    "远程": "远程", "remote": "远程", "线上": "远程",
    # 自治区（避免通用后缀剥离后留下「新疆维吾尔」这类残词）
    "内蒙古自治区": "内蒙古", "广西壮族自治区": "广西", "宁夏回族自治区": "宁夏",
    "新疆维吾尔自治区": "新疆", "西藏自治区": "西藏",
}

# 常见城市名（不含「市」后缀）。用于自由文本里的城市识别：
# 只有当片段精确命中该集合时才认定为城市，避免把任意词误判为城市。
CITY_NAMES: set[str] = {
    "北京", "上海", "广州", "深圳", "杭州", "南京", "成都", "武汉", "西安", "苏州",
    "天津", "重庆", "长沙", "青岛", "宁波", "厦门", "合肥", "郑州", "济南", "福州",
    "东莞", "佛山", "无锡", "大连", "沈阳", "昆明", "南昌", "贵阳", "南宁", "哈尔滨",
    "长春", "石家庄", "太原", "兰州", "乌鲁木齐", "宁德", "珠海", "中山", "惠州",
    "温州", "嘉兴", "常州", "徐州", "烟台", "潍坊", "泉州", "绍兴", "台州", "金华",
    "香港", "澳门", "台北",
    # 省级行政区（招聘城市字段常直接写省/区）
    "内蒙古", "广西", "宁夏", "新疆", "西藏", "海南", "云南", "贵州", "四川", "湖南",
    "湖北", "河南", "河北", "山东", "山西", "陕西", "甘肃", "青海", "辽宁", "吉林",
    "黑龙江", "江苏", "浙江", "安徽", "福建", "江西", "广东", "台湾",
}


def detect_city(raw: str | None) -> str:
    """自由文本城市识别：命中已知城市集合才返回，否则返回空串。"""
    if not raw:
        return ""
    text = raw.strip()
    if text in CITY_NAMES:
        return text
    stripped = re.sub(r"(特别行政区|自治区|自治州|地区|市|省)$", "", text).strip()
    if stripped in CITY_NAMES:
        return stripped
    for name in CITY_NAMES:
        if name in text:
            return name
    return ""

_EDU_MAP: list[tuple[str, str]] = [
    ("博士", "博士"), ("phd", "博士"), ("doctor", "博士"),
    ("硕士", "硕士"), ("研究生", "硕士"), ("master", "硕士"), ("msc", "硕士"),
    ("本科", "本科"), ("学士", "本科"), ("bachelor", "本科"), ("undergraduate", "本科"),
    ("大专", "大专"), ("专科", "大专"),
    ("不限", "不限"), ("any", "不限"),
]

_SALARY_RANGE = re.compile(
    r"(\d+(?:\.\d+)?)\s*(元|块|k|K|千)?\s*[-~到至]\s*(\d+(?:\.\d+)?)\s*(元|块|k|K|千)?"
    r"\s*(?:/|每)?\s*(天|日|月|小时|时|year|month|day)?"
)
_SALARY_SINGLE = re.compile(r"(\d+(?:\.\d+)?)\s*(元|块|k|K|千)\s*(?:/|每)?\s*(天|日|月|小时|时)?")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_URL = re.compile(r"https?://[^\s，。；、）)】\]]+")
_QR_HINT = re.compile(r"(二维码|扫码|扫码投递|扫码报名)")

_DATE_PATTERNS = [
    (re.compile(r"(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})"), "ymd"),
    (re.compile(r"(\d{1,2})\s*月\s*(\d{1,2})\s*日"), "md"),
    (re.compile(r"(\d{1,2})[-/](\d{1,2})"), "md"),
]


def normalize_city(raw: str | None) -> str:
    if not raw:
        return ""
    text = raw.strip()
    if text in CITY_ALIASES:
        return CITY_ALIASES[text]
    for alias, std in CITY_ALIASES.items():
        if alias and alias in text:
            return std
    # 通用后缀剥离：宁德市 → 宁德、广东省 → 广东
    # （自治区已在别名表中显式映射，不走此处，避免剥离成「新疆维吾尔」这类残词）
    stripped = re.sub(r"(特别行政区|自治区|自治州|地区|市|省)$", "", text).strip()
    if stripped and stripped != text:
        return stripped
    return text


def normalize_salary(raw: str | None) -> str:
    """把各种薪资写法归一化为 `数值-数值 单位/周期`。"""
    if not raw:
        return ""
    text = raw.strip().replace(" ", "")
    m = _SALARY_RANGE.search(text)
    if m:
        low, unit1, high, unit2, period = m.groups()
        unit = _norm_unit(unit2 or unit1)
        period = _norm_period(period)
        return f"{low}-{high}{unit}/{period}"
    m = _SALARY_SINGLE.search(text)
    if m:
        value, unit, period = m.groups()
        unit = _norm_unit(unit)
        period = _norm_period(period)
        return f"{value}{unit}/{period}"
    return text


def _norm_unit(unit: str | None) -> str:
    if not unit:
        return "元"
    u = unit.strip()
    if u.lower() == "k" or u == "千":
        return "k"
    return "元"


def _norm_period(period: str | None) -> str:
    if not period:
        return "天"
    p = period.strip().lower()
    mapping = {"日": "天", "天": "天", "月": "月", "小时": "小时", "时": "小时", "day": "天", "month": "月"}
    return mapping.get(p, "天")


def normalize_education(raw: str | None) -> str:
    if not raw:
        return ""
    text = raw.strip().lower()
    for key, std in _EDU_MAP:
        if key in text:
            return std
    return raw.strip()


def parse_deadline(raw: str | None, base: date | None = None) -> date | None:
    """解析截止时间，支持 `2026-11-30` / `11月30日` / `11/30` 等写法。"""
    if not raw:
        return None
    text = raw.strip()
    base = base or date.today()
    for pattern, kind in _DATE_PATTERNS:
        m = pattern.search(text)
        if not m:
            continue
        try:
            if kind == "ymd":
                y, mo, d = (int(x) for x in m.groups())
                return date(y, mo, d)
            mo, d = (int(x) for x in m.groups())
            year = base.year
            candidate = date(year, mo, d)
            if candidate < base - timedelta(days=180):
                candidate = date(year + 1, mo, d)
            return candidate
        except ValueError:
            continue
    return None


def extract_apply_method(text: str | None) -> dict[str, str]:
    """从正文中抽取投递方式。"""
    result: dict[str, str] = {}
    if not text:
        return result
    email = _EMAIL.search(text)
    if email:
        result["email"] = email.group(0)
    url = _URL.search(text)
    if url:
        result["url"] = url.group(0)
    if _QR_HINT.search(text):
        result["qr"] = "1"
    if not result:
        result["method"] = "未知"
    return result


def format_apply_method(method: dict[str, str]) -> str:
    parts: list[str] = []
    if "email" in method:
        parts.append(f"邮箱: {method['email']}")
    if "url" in method:
        parts.append(f"链接: {method['url']}")
    if method.get("qr"):
        parts.append("扫码投递")
    return " | ".join(parts) or method.get("method", "未知")


def parse_datetime(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None
