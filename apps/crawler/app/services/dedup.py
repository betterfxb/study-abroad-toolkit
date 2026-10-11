"""去重：内容指纹 + SimHash 近似判重。零第三方依赖。

三级去重策略：
  1. 文章级 —— URL 唯一键 + (标题+公众号+日期) 指纹
  2. 岗位级 —— (公司+岗位+城市+薪资) 归一化指纹
  3. 跨源级 —— 正文 SimHash 相似度比对，保留最早/最权威源
"""

from __future__ import annotations

import hashlib
import re
from collections import Counter

_WS = re.compile(r"\s+")
_PUNCT = re.compile(r"[^\w\u4e00-\u9fff]+")


def normalize_text(text: str | None) -> str:
    """归一化文本：去空白、去标点、转小写，用于指纹计算。"""
    if not text:
        return ""
    text = _WS.sub("", text)
    text = _PUNCT.sub("", text)
    return text.lower()


def content_hash(text: str | None) -> str:
    """精确内容哈希（SHA-256 前 32 位）。"""
    return hashlib.sha256(normalize_text(text).encode("utf-8")).hexdigest()[:32]


def _shingles(text: str, size: int = 4) -> list[str]:
    norm = normalize_text(text)
    if len(norm) <= size:
        return [norm] if norm else []
    return [norm[i : i + size] for i in range(len(norm) - size + 1)]


def _token_hash(token: str, bits: int) -> int:
    digest = hashlib.md5(token.encode("utf-8")).hexdigest()
    return int(digest, 16) % (1 << bits)


def simhash(text: str | None, bits: int = 64) -> int:
    """计算 SimHash 值。"""
    tokens = _shingles(text or "")
    if not tokens:
        return 0
    vector = [0] * bits
    for token, weight in Counter(tokens).items():
        h = _token_hash(token, bits)
        for i in range(bits):
            vector[i] += weight if (h >> i) & 1 else -weight
    result = 0
    for i in range(bits):
        if vector[i] > 0:
            result |= 1 << i
    return result


def hamming(a: int, b: int) -> int:
    """汉明距离。"""
    return bin(a ^ b).count("1")


def simhash_hex(value: int, bits: int = 64) -> str:
    return format(value, f"0{bits // 4}x")


def is_similar(text_a: str, text_b: str, bits: int = 64, threshold: int = 8) -> bool:
    """两段文本是否近似（汉明距离 <= threshold 判为重复）。

    阈值说明：中文按**字符 n-gram** 切片（无空格分词），实测同一篇长文经局部替换后
    汉明距离约 5~8，而无关文章约 30+。因此 64 位下推荐阈值取 **8**（而非英文按词
    切分常用的 3），可稳定区分「转载改写」与「无关内容」。

    适用场景：**长文**（公众号正文）的转载判重——同一篇文章被转载时通常只做
    局部替换（改标题、改落款、替换少量词句），SimHash 对此表现良好。

    已知局限：对**中段插入/删除**敏感——按字符 n-gram 切片时，插入一个字符会使其后
    所有 n-gram 整体位移，汉明距离显著变大。因此：
      - 短文（< 100 字）不建议依赖本函数，应使用 job_fingerprint 精确指纹；
      - 若需更强鲁棒性，可接入分词（jieba）后按词 n-gram 计算，或引入向量库。
    """
    if not text_a or not text_b:
        return False
    return hamming(simhash(text_a, bits), simhash(text_b, bits)) <= threshold


def article_fingerprint(title: str, account_name: str, published_date: str = "") -> str:
    """文章级指纹：标题 + 公众号 + 日期。"""
    raw = f"{normalize_text(title)}|{normalize_text(account_name)}|{published_date}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


def job_fingerprint(company: str, title: str, city: str, salary: str = "") -> str:
    """岗位级指纹：公司 + 岗位 + 城市 + 薪资（均归一化）。"""
    raw = "|".join(
        normalize_text(x) for x in (company, title, city, salary)
    )
    return hashlib.md5(raw.encode("utf-8")).hexdigest()
