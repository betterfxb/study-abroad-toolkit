#!/usr/bin/env python
"""同步设计令牌 tokens.css：控制台源 → 官网副本（防漂移，零第三方依赖）。

冒烟测试校验两份文件内容一致；本脚本用于源变更后一键同步。
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]  # apps/site/scripts → 项目根
SRC = ROOT / "apps" / "console" / "src" / "styles" / "tokens.css"
DST = ROOT / "apps" / "site" / "assets" / "tokens.css"


def main() -> int:
    if not SRC.exists():
        print(f"sync-tokens: 源不存在 {SRC}", file=sys.stderr)
        return 1
    if not DST.parent.exists():
        DST.parent.mkdir(parents=True, exist_ok=True)
    same = SRC.read_bytes() == DST.read_bytes() if DST.exists() else False
    if same:
        print("sync-tokens: 已是最新，无需同步")
        return 0
    shutil.copyfile(SRC, DST)
    print(f"sync-tokens: 已同步 {SRC} → {DST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
