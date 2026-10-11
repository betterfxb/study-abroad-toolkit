# 模块一字段匹配评测报告 · 20261009-065821

## 总体指标

| 指标 | 值 |
| --- | --- |
| 页面数 | 6 |
| 字段总数 | 59 |
| 可匹配字段（有标注） | 52 |
| 正确识别 | 49 |
| 漏识别 | 3 |
| 误匹配 | 0 |
| 误报（不应匹配却匹配） | 1 |
| **识别率** | **94.2%** |
| **精确率** | **98.0%** |
| **填充率** | **66.1%** |
| 自动填充率 | 62.7% |

## 逐页面

| 页面 | 平台 | 字段 | 可匹配 | 识别率 | 精确率 | 填充率 |
| --- | --- | --- | --- | --- | --- | --- |
| p01_applyweb_personal | applyweb | 14 | 12 | 100.0% | 100.0% | 78.6% |
| p02_liaison_academic | liaison | 10 | 10 | 100.0% | 100.0% | 90.0% |
| p03_slate_tests_address | slate | 15 | 15 | 100.0% | 100.0% | 73.3% |
| h01_abbrev_and_collision | applyweb | 6 | 3 | 100.0% | 75.0% | 50.0% |
| h02_industry_jargon | liaison | 6 | 6 | 100.0% | 100.0% | 83.3% |
| h03_nonenglish_and_nolabel | slate | 8 | 6 | 50.0% | 100.0% | 0.0% |

## 失败明细

| 页面 | 字段 | 类型 | 期望 | 实际 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| h01_abbrev_and_collision | Country of intended study | 误报 | - | `address.country` | 0.91 |
| h03_nonenglish_and_nolabel | Nom de famille | 漏识别 | `basic_info.last_name` | `-` | 0.0 |
| h03_nonenglish_and_nolabel | Nachname | 漏识别 | `basic_info.last_name` | `-` | 0.0 |
| h03_nonenglish_and_nolabel | Vorname | 漏识别 | `basic_info.first_name` | `-` | 0.0 |

## 运行参数

- **运行时间**：2026-10-09T06:58:21.396446+00:00
- **基准集**：all（6 页）
- **来源**：C:\Users\19560\WorkBuddy AI\new_job_project\apps\intelligence\samples\benchmark\pages.json + C:\Users\19560\WorkBuddy AI\new_job_project\apps\intelligence\samples\benchmark\pages.hard.json
