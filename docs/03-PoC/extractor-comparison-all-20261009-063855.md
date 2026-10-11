# 抽取器对比评测报告 · 20261009-063855

## 总体准确率

| 字段 | 规则抽取 |
| --- | --- |
| 公司 | 75.0% |
| 岗位 | 85.7% |
| 城市 | 61.5% |
| 薪资 | 84.6% |
| 截止日期 | 66.7% |
| 投递方式 | 92.9% |
| **整体** | **78.2%** |

## 逐用例明细

| 用例 | 格式 | 岗位数 | 规则抽取 |
| --- | --- | --- | --- |
| c01_bracket | 标准【】标签 | 1/1 | 6/6 |
| c02_colon | 冒号标签 | 1/1 | 6/6 |
| c03_freeform | 无标签自然段（公众号软文） | 1/1 | 6/6 |
| c04_oneline | 一行式（招聘平台风格） | 1/1 | 6/6 |
| c05_multi | 多岗位混排 | 2/2 | 6/6 |
| c06_mixed_lang | 中英混排 | 1/1 | 6/6 |
| c07_distractor | 含干扰词（岗位职责/任职要求） | 1/1 | 6/6 |
| c08_minimal | 极简（仅公司+岗位+邮箱） | 1/1 | 3/3 |
| h01_table | TSV 表格（表头+数据行） | 1/1 | 3/6 |
| h02_multi_bullet | 编号列表多岗位（无标签） | 1/3 | 3/4 |
| h03_english | 英文自由文本 | 0/1 | 0/6 |
| h04_verbose_prose | 长软文（信息散落多句） | 1/1 | 3/5 |
| h05_hourly | 时薪结算（无标准薪资标签） | 1/1 | 4/6 |
| h06_brand_team | 母公司+事业群 + 后缀式截止 | 1/1 | 3/6 |

## 失败明细

### 规则抽取

| 抽取器 | 用例 | 字段 | 期望 | 实际 |
| --- | --- | --- | --- | --- |
| 规则抽取 | h01_table | 公司 | `快手` | `岗位	地点	薪资	截止` |
| 规则抽取 | h01_table | 城市 | `北京` | `薪资	截止` |
| 规则抽取 | h01_table | 截止日期 | `2026-11-18` | `None` |
| 规则抽取 | h02_multi_bullet | 城市 | `北京` | `` |
| 规则抽取 | h03_english | 公司 | `NVIDIA` | `None` |
| 规则抽取 | h03_english | 岗位 | `Machine Learning Intern` | `None` |
| 规则抽取 | h03_english | 城市 | `上海` | `None` |
| 规则抽取 | h03_english | 薪资 | `300元/天` | `None` |
| 规则抽取 | h03_english | 截止日期 | `2026-12-10` | `None` |
| 规则抽取 | h03_english | 投递方式 | `ml-intern@nvidia.com` | `None` |
| 规则抽取 | h04_verbose_prose | 岗位 | `数据科学实习生` | `届同学开放数据科学实习生` |
| 规则抽取 | h04_verbose_prose | 城市 | `深圳` | `` |
| 规则抽取 | h05_hourly | 薪资 | `25元/小时` | `25元/天` |
| 规则抽取 | h05_hourly | 截止日期 | `2026-12-05` | `None` |
| 规则抽取 | h06_brand_team | 公司 | `腾讯` | `事业群面向在校生` |
| 规则抽取 | h06_brand_team | 城市 | `深圳` | `` |
| 规则抽取 | h06_brand_team | 截止日期 | `2026-11-28` | `None` |

## 运行参数

- **运行时间**：2026-10-09T06:38:55.975488+00:00
- **基准集**：all（14 例）
- **来源**：C:\Users\19560\WorkBuddy AI\new_job_project\apps\crawler\samples\benchmark\cases.json + C:\Users\19560\WorkBuddy AI\new_job_project\apps\crawler\samples\benchmark\cases.hard.json
- **LLM**：未配置 API Key，已跳过
