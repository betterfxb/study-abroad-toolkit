# 模块一字段匹配评测报告 · 20261009-065848

## 总体指标

| 指标 | 值 |
| --- | --- |
| 页面数 | 3 |
| 字段总数 | 20 |
| 可匹配字段（有标注） | 15 |
| 正确识别 | 12 |
| 漏识别 | 3 |
| 误匹配 | 0 |
| 误报（不应匹配却匹配） | 1 |
| **识别率** | **80.0%** |
| **精确率** | **92.3%** |
| **填充率** | **55.0%** |
| 自动填充率 | 35.0% |

## 逐页面

| 页面 | 平台 | 字段 | 可匹配 | 识别率 | 精确率 | 填充率 |
| --- | --- | --- | --- | --- | --- | --- |
| h01_abbrev_and_collision | applyweb | 6 | 3 | 100.0% | 75.0% | 50.0% |
| h02_industry_jargon | liaison | 6 | 6 | 100.0% | 100.0% | 83.3% |
| h03_nonenglish_and_nolabel | slate | 8 | 6 | 50.0% | 100.0% | 37.5% |

## 失败明细

| 页面 | 字段 | 类型 | 期望 | 实际 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| h01_abbrev_and_collision | Country of intended study | 误报 | - | `address.country` | 0.91 |
| h03_nonenglish_and_nolabel | Nom de famille | 漏识别 | `basic_info.last_name` | `-` | 0.0 |
| h03_nonenglish_and_nolabel | Nachname | 漏识别 | `basic_info.last_name` | `-` | 0.0 |
| h03_nonenglish_and_nolabel | Vorname | 漏识别 | `basic_info.first_name` | `-` | 0.0 |

## 运行参数

- **运行时间**：2026-10-09T06:58:48.134621+00:00
- **基准集**：hard（3 页）
- **来源**：C:\Users\19560\WorkBuddy AI\new_job_project\apps\intelligence\samples\benchmark\pages.hard.json
