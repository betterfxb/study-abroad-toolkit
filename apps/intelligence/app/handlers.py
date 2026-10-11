"""值转换处理器。

字段匹配解决「填到哪个字段」，处理器解决「填成什么格式」——
网申页面要求的是地区化格式（MM/DD/YYYY、Male、China、Bachelor's Degree），
档案里存的是规范化值（2003-01-01、M、CN、Bachelor）。
"""

from __future__ import annotations

import re
from typing import Any, Callable

from .normalize import contains_word, normalize_signal, token_set
from .schema import FieldSpec

# ------------------------------------------------------------------ 基础映射表
_GENDER = {
    "m": "Male", "male": "Male", "男": "Male",
    "f": "Female", "female": "Female", "女": "Female",
    "o": "Other", "other": "Other", "其他": "Other",
    "u": "Prefer not to say", "prefer not to say": "Prefer not to say",
}

_COUNTRY = {
    "cn": "China", "chn": "China", "china": "China", "中国": "China",
    "hk": "Hong Kong, China", "hkg": "Hong Kong, China", "hong kong": "Hong Kong, China",
    "mo": "Macao, China", "macao": "Macao, China", "macau": "Macao, China",
    "tw": "Taiwan, China", "twn": "Taiwan, China",
    "us": "United States", "usa": "United States", "united states": "United States",
    "united states of america": "United States", "美国": "United States",
    "uk": "United Kingdom", "gbr": "United Kingdom", "united kingdom": "United Kingdom",
    "英国": "United Kingdom", "ca": "Canada", "can": "Canada", "canada": "Canada",
    "加拿大": "Canada", "au": "Australia", "aus": "Australia", "australia": "Australia",
    "澳大利亚": "Australia", "sg": "Singapore", "sgp": "Singapore", "singapore": "Singapore",
    "新加坡": "Singapore", "jp": "Japan", "jpn": "Japan", "japan": "Japan", "日本": "Japan",
    "kr": "Korea, Republic of", "kor": "Korea, Republic of", "south korea": "Korea, Republic of",
    "de": "Germany", "deu": "Germany", "germany": "Germany", "德国": "Germany",
    "fr": "France", "fra": "France", "france": "France", "法国": "France",
    "nl": "Netherlands", "nld": "Netherlands", "netherlands": "Netherlands",
    "ch": "Switzerland", "che": "Switzerland", "switzerland": "Switzerland",
    "ie": "Ireland", "irl": "Ireland", "ireland": "Ireland",
    "nz": "New Zealand", "nzl": "New Zealand", "new zealand": "New Zealand",
    "my": "Malaysia", "mys": "Malaysia", "malaysia": "Malaysia",
    "in": "India", "ind": "India", "india": "India", "印度": "India",
}

_DEGREE = {
    "bachelor": "Bachelor's Degree", "bachelors": "Bachelor's Degree",
    "bachelor's": "Bachelor's Degree", "bachelor's degree": "Bachelor's Degree",
    "bs": "Bachelor's Degree", "ba": "Bachelor's Degree", "bsc": "Bachelor's Degree",
    "本科": "Bachelor's Degree", "学士": "Bachelor's Degree",
    "master": "Master's Degree", "masters": "Master's Degree",
    "master's": "Master's Degree", "master's degree": "Master's Degree",
    "ms": "Master's Degree", "msc": "Master's Degree", "ma": "Master's Degree",
    "硕士": "Master's Degree", "研究生": "Master's Degree",
    "doctor": "Doctoral Degree", "doctoral": "Doctoral Degree", "phd": "Doctoral Degree",
    "doctorate": "Doctoral Degree", "博士": "Doctoral Degree",
    "associate": "Associate's Degree", "associate's": "Associate's Degree",
    "大专": "Associate's Degree", "专科": "Associate's Degree",
    "high school": "High School Diploma", "高中": "High School Diploma",
    "diploma": "Diploma", "certificate": "Certificate",
}

# 中国省级行政区 → 英文（美国表单常要求 State，中国表单要求 Province）
_PROVINCE = {
    "北京": "Beijing", "上海": "Shanghai", "天津": "Tianjin", "重庆": "Chongqing",
    "河北": "Hebei", "山西": "Shanxi", "辽宁": "Liaoning", "吉林": "Jilin",
    "黑龙江": "Heilongjiang", "江苏": "Jiangsu", "浙江": "Zhejiang", "安徽": "Anhui",
    "福建": "Fujian", "江西": "Jiangxi", "山东": "Shandong", "河南": "Henan",
    "湖北": "Hubei", "湖南": "Hunan", "广东": "Guangdong", "海南": "Hainan",
    "四川": "Sichuan", "贵州": "Guizhou", "云南": "Yunnan", "陕西": "Shaanxi",
    "甘肃": "Gansu", "青海": "Qinghai", "台湾": "Taiwan, China",
    "内蒙古": "Inner Mongolia", "广西": "Guangxi", "西藏": "Tibet",
    "宁夏": "Ningxia", "新疆": "Xinjiang",
    "香港": "Hong Kong, China", "澳门": "Macao, China",
}

_US_STATES = {
    "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in",
    "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv",
    "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri", "sc", "sd", "tn",
    "tx", "ut", "vt", "va", "wa", "wv", "wi", "wy", "dc",
}

_MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


# ------------------------------------------------------------------ 工具
def _pick_option(value: str, options: list[str]) -> tuple[str, float]:
    """在给定下拉选项里找最匹配的文本，返回 (选项, 置信度)。"""
    v = normalize_signal(value)
    if not v or not options:
        return value, 0.0
    best, best_score = "", 0.0
    v_tokens = token_set(value)
    for opt in options:
        o = normalize_signal(opt)
        if not o:
            continue
        if o == v:
            return opt, 1.0
        if contains_word(o, v) or contains_word(v, o):
            score = 0.88
        else:
            o_tokens = token_set(opt)
            if not v_tokens:
                continue
            overlap = len(o_tokens & v_tokens) / len(v_tokens)
            score = round(overlap * 0.75, 4)
        if score > best_score:
            best, best_score = opt, score
    return (best, best_score) if best_score > 0 else (value, 0.0)


def _date_parts(value: str) -> tuple[str, str, str] | None:
    """解析 2003-01-01 / 2003/1/1 / 2003-01 形式的日期，返回 (年, 月, 日)。"""
    m = re.search(r"(\d{4})\s*[-/年.]\s*(\d{1,2})(?:\s*[-/月.]\s*(\d{1,2}))?", str(value))
    if not m:
        return None
    return m.group(1), m.group(2).zfill(2), (m.group(3) or "").zfill(2)


def _detect_date_format(field: FieldSpec) -> str:
    """从 placeholder / label 推断目标日期格式。"""
    hint = normalize_signal(f"{field.placeholder} {field.label} {field.near_text}")
    if "mm dd yyyy" in hint or "mm/dd/yyyy" in hint:
        return "mm/dd/yyyy"
    if "dd mm yyyy" in hint or "dd/mm/yyyy" in hint:
        return "dd/mm/yyyy"
    if "yyyy mm dd" in hint:
        return "yyyy-mm-dd"
    if "month year" in hint or "mm yyyy" in hint or "mm/yyyy" in hint:
        return "mm/yyyy"
    return "yyyy-mm-dd"


# ------------------------------------------------------------------ 处理器
def h_text(value: Any, field: FieldSpec, slot: Any = None) -> str:
    return "" if value is None else str(value).strip()


def _scalar(value: Any) -> Any:
    """解包 `{"value": x}` 形式的包装对象。"""
    if isinstance(value, dict):
        return value.get("value", "")
    return value


def h_email(value: Any, field: FieldSpec, slot: Any = None) -> str:
    return str(value or "").strip().lower()


def h_phone(value: Any, field: FieldSpec, slot: Any = None) -> str:
    """保留前导 + 与数字，去掉空格/横线/括号。"""
    s = str(value or "").strip()
    plus = s.startswith("+")
    digits = re.sub(r"\D", "", s)
    return ("+" + digits) if plus else digits


def h_number(value: Any, field: FieldSpec, slot: Any = None) -> str:
    m = re.search(r"-?\d+(?:\.\d+)?", str(_scalar(value) or ""))
    if not m:
        return ""
    num = m.group(0)
    return num.rstrip("0").rstrip(".") if "." in num else num


def h_date(value: Any, field: FieldSpec, slot: Any = None) -> str:
    parts = _date_parts(str(value or ""))
    if not parts:
        return h_text(value, field)
    y, mo, d = parts
    fmt = _detect_date_format(field)
    if fmt == "mm/dd/yyyy":
        return f"{mo}/{d or '01'}/{y}"
    if fmt == "dd/mm/yyyy":
        return f"{d or '01'}/{mo}/{y}"
    if fmt == "mm/yyyy":
        return f"{mo}/{y}"
    return f"{y}-{mo}-{d or '01'}"


def h_month_date(value: Any, field: FieldSpec, slot: Any = None) -> str:
    """入学/毕业时间：档案存 `2022-09`，表单可能只要 月/年。"""
    parts = _date_parts(str(value or ""))
    if not parts:
        return h_text(value, field)
    y, mo, d = parts
    fmt = _detect_date_format(field)
    if fmt == "mm/yyyy" or (fmt == "yyyy-mm-dd" and not d):
        return f"{mo}/{y}"
    if fmt == "mm/dd/yyyy":
        return f"{mo}/{d or '01'}/{y}"
    return f"{y}-{mo}"


def h_gpa(value: Any, field: FieldSpec, slot: Any = None) -> str:
    """GPA 归一化：百分制（>4.0）按阶梯换算到 4.0 制（表单最常见口径）。

    阶梯唯一事实源见 gpa.ladder_100_to_4，本函数只做路由 + 格式化，
    行为与历史版本一致（4.0 及以下原样回填）。
    """
    from .gpa import extract_number, format_gpa, ladder_100_to_4

    num = extract_number(_scalar(value))
    if num is None:
        return ""
    if num > 4.0:
        return format_gpa(ladder_100_to_4(num))
    return format_gpa(num)


def h_gender(value: Any, field: FieldSpec, slot: Any = None) -> str:
    key = normalize_signal(str(value or ""))
    return _GENDER.get(key, str(value or "").strip())


def h_country(value: Any, field: FieldSpec, slot: Any = None) -> str:
    key = normalize_signal(str(value or ""))
    name = _COUNTRY.get(key) or _COUNTRY.get(key.replace(" ", ""), "")
    if not name:
        # 已是英文国名则原样返回
        name = str(value or "").strip()
    if field.options:
        opt, _ = _pick_option(name, field.options)
        return opt
    return name


def h_degree(value: Any, field: FieldSpec, slot: Any = None) -> str:
    key = normalize_signal(str(value or ""))
    name = _DEGREE.get(key, "")
    if not name:
        for k, v in _DEGREE.items():
            if k in key:
                name = v
                break
    name = name or str(value or "").strip()
    if field.options:
        opt, _ = _pick_option(name, field.options)
        return opt
    return name


def h_state(value: Any, field: FieldSpec, slot: Any = None) -> str:
    raw = str(value or "").strip()
    key = normalize_signal(raw)
    if key in _US_STATES:
        name = raw
    else:
        name = _PROVINCE.get(key, raw)
        if name == raw:
            for k, v in _PROVINCE.items():
                if k in key:
                    name = v
                    break
    if field.options:
        opt, _ = _pick_option(name, field.options)
        return opt
    return name


def h_select_by_text(value: Any, field: FieldSpec, slot: Any = None) -> str:
    raw = str(value or "").strip()
    if field.options:
        opt, _ = _pick_option(raw, field.options)
        return opt
    return raw


def h_richtext(value: Any, field: FieldSpec, slot: Any = None) -> str:
    return str(value or "")


HANDLERS: dict[str, Callable[..., str]] = {
    "text": h_text,
    "email": h_email,
    "phone": h_phone,
    "number": h_number,
    "date": h_date,
    "month_date": h_month_date,
    "gpa": h_gpa,
    "gender": h_gender,
    "country": h_country,
    "degree": h_degree,
    "state": h_state,
    "select_by_text": h_select_by_text,
    "richtext": h_richtext,
}


def apply_handler(name: str, value: Any, field: FieldSpec, slot: Any = None) -> tuple[str, float]:
    """应用处理器，返回 (转换后的值, 处理器自身置信度)。

    处理器置信度用于修正最终置信度：例如 select 字段没找到匹配选项时应降级。
    """
    fn = HANDLERS.get(name or "text", h_text)
    result = fn(value, field, slot)
    conf = 1.0
    if field.options and name in {"select_by_text", "country", "degree", "state", "gender"}:
        _, opt_conf = _pick_option(str(result), field.options)
        conf = 0.95 if opt_conf >= 0.88 else (0.55 if opt_conf > 0 else 0.3)
    return result, conf


def best_option(value: str, options: list[str]) -> tuple[str, float]:
    """对外暴露的下拉选项匹配（评测脚本使用）。"""
    return _pick_option(value, options)
