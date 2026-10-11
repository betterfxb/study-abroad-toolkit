"""降级链路：L0 全自动 → L1 切源 → L2 半自动 → L3 人工。

纯函数实现，输入源健康快照，输出降级决策。便于单测与后台一键切换。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

LEVELS: dict[int, tuple[str, str]] = {
    0: ("L0", "全自动多源"),
    1: ("L1", "切源（自建 RSS + 官网兜底）"),
    2: ("L2", "半自动（运营转发统一入口）"),
    3: ("L3", "人工汇总表"),
}

# 主源：第三方数据 API / 公众号接口 / 招聘平台
PRIMARY_TYPES = {"thirdparty_api", "wechat_mp", "job_platform"}
# 自动兜底源：自建 RSS / 企业官网
AUTO_FALLBACK_TYPES = {"rss", "company_site"}
# 人工源
MANUAL_TYPES = {"manual"}

UNHEALTHY_SUCCESS_RATE = 0.3
UNHEALTHY_CONSECUTIVE_FAILURES = 3


@dataclass
class SourceHealthSnapshot:
    code: str
    source_type: str
    enabled: bool = True
    success_rate: float = 1.0
    consecutive_failures: int = 0
    item_count: int = 0

    @property
    def healthy(self) -> bool:
        if not self.enabled:
            return False
        return (
            self.success_rate >= UNHEALTHY_SUCCESS_RATE
            and self.consecutive_failures < UNHEALTHY_CONSECUTIVE_FAILURES
        )


@dataclass
class DegradeDecision:
    level: int
    changed: bool
    reason: str
    healthy_sources: list[str] = field(default_factory=list)
    unhealthy_sources: list[str] = field(default_factory=list)

    @property
    def level_name(self) -> str:
        return LEVELS.get(self.level, ("?", "未知"))[1]

    def to_dict(self) -> dict[str, object]:
        return {
            "level": self.level,
            "level_name": self.level_name,
            "changed": self.changed,
            "reason": self.reason,
            "healthy_sources": self.healthy_sources,
            "unhealthy_sources": self.unhealthy_sources,
        }


def _group(snapshots: Iterable[SourceHealthSnapshot], types: set[str]) -> list[SourceHealthSnapshot]:
    return [s for s in snapshots if s.source_type in types]


def evaluate(
    snapshots: Iterable[SourceHealthSnapshot],
    current_level: int = 0,
) -> DegradeDecision:
    """根据源健康度计算应有的降级层级。

    升级（降级链路往下走）条件：
      - 主源全部不健康            → 至少 L1
      - 主源 + 自动兜底源都不健康  → L2
      - 人工源也无产出            → L3

    恢复（往回升）条件：
      - 更高层级所需的源重新健康时，逐级回升 1 档。
    """
    snaps = list(snapshots)
    primary = _group(snaps, PRIMARY_TYPES)
    fallback = _group(snaps, AUTO_FALLBACK_TYPES)
    manual = _group(snaps, MANUAL_TYPES)

    healthy = [s.code for s in snaps if s.healthy]
    unhealthy = [s.code for s in snaps if not s.healthy]

    primary_ok = any(s.healthy for s in primary)
    fallback_ok = any(s.healthy for s in fallback)
    manual_ok = any(s.healthy and s.item_count > 0 for s in manual)

    # ---- 计算目标层级 ----
    if primary_ok:
        target = 0
        reason = f"主源健康: {[s.code for s in primary if s.healthy]}"
    elif fallback_ok:
        target = 1
        reason = "主源不可用，已切至自动兜底源（RSS / 官网）"
    elif manual_ok:
        target = 2
        reason = "自动源均不可用，降级至半自动人工投递"
    else:
        target = 3
        reason = "全部自动源与人工入口均无产出，降级至人工汇总"

    # ---- 恢复：每次只回升 1 档，避免抖动 ----
    if target < current_level:
        target = current_level - 1
        reason = f"源健康度回升，逐级恢复中（{LEVELS[current_level][0]} → {LEVELS[target][0]}）"

    # ---- 升级：可直接跳到目标层级（故障不等人） ----
    if target > current_level:
        target = min(target, 3)

    return DegradeDecision(
        level=target,
        changed=target != current_level,
        reason=reason,
        healthy_sources=healthy,
        unhealthy_sources=unhealthy,
    )


def describe(level: int) -> dict[str, object]:
    code, name = LEVELS.get(level, ("?", "未知"))
    return {"level": level, "code": code, "name": name}
