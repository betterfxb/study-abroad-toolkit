# intelligence-service · 留学网申字段语义匹配服务

模块一（海外研究生留学网申自动填写）的**语义理解核心**。职责单一且明确：

> 插件在网页上采集到一堆表单字段（label / name / id / placeholder / aria / 邻近文本 / type / options），
> 本服务判断「每个字段对应档案里的哪个语义槽位」，把用户档案的值按目标表单要求的格式转换好，
> 产出**填充指令**交给插件执行。**只出指令，不提交。**

对应契约：[`docs/02-详细设计/03-接口契约.md`](../../docs/02-详细设计/03-接口契约.md) §4.1 `/ext/v1/match-fields`。

## 快速开始

```bash
cd apps/intelligence
uvicorn app.main:app --reload --port 8090
# API 文档 http://localhost:8090/docs
# 健康检查 http://localhost:8090/health
```

零外部依赖即可跑通冒烟测试（不需要装 FastAPI）：

```bash
python tests/smoke_test.py     # 89 项，全通过
```

## 三级匹配（对齐架构详设 §3）

| 级别 | 手段 | 置信度区间 | 状态 |
|---|---|---|---|
| L1 | **词典精确匹配** —— label/name/id/aria 归一化后与关键词**完全一致** | 0.92 ~ 1.00 | ✅ 已实现 |
| L2 | **词典模糊匹配** —— 关键词作为**词级子串**出现在任一信号中 | 0.50 ~ 0.88 | ✅ 已实现 |
| L3 | **LLM 语义匹配** —— 前两级都够不到时兜底 | 动态 | ⏳ 代码路径就绪，**缺 API Key** |

前两级 + 冲突消解在 `app/matcher.py`，第三级由 pipeline 调用（不可用时自动跳过，链路不断）。

### 匹配的四个关键设计

1. **词边界**：`state` 不能命中 `statement`，`name` 不能命中 `username`。
   ASCII 关键词按词边界匹配，中文按子串匹配（见 `app/normalize.py::contains_word`）。
2. **反例降权**：词典 `negative` 字段。例：`Recommender Email` 不应被 `basic_info.email` 抢走 —— 命中反例词直接封顶 0.40。
3. **题干降权**：自定义问题（`State your purpose for graduate study`）不能当字段填。
   检测依据是**第二人称 / 物主代词**（`your / you / we / us`）——真实字段标签几乎不含这些词。
   例外：若 `name`/`id` 与关键词**完全一致**（开发者显式命名的语义字段，如 `name="sop"`），仍按字段处理。
4. **贪心分配**：按分数降序分配，非重复槽位只占一个字段；重复槽位（教育/考试/经历/推荐人）按出现顺序编下标。

### 置信度分级（架构详设 §3）

| 置信度 | 动作 | 插件侧行为 |
|---|---|---|
| ≥ 0.90 | `fill` | 自动填入 |
| 0.60 ~ 0.90 | `review` | 填入并**高亮**，提示人工复核 |
| < 0.60 | `skip` | 不填，留给用户 |

阈值可通过 `MATCH_AUTO_THRESHOLD` / `MATCH_REVIEW_THRESHOLD` 配置。

## 值转换处理器（填成什么格式）

匹配解决「填到哪个字段」，处理器解决「填成什么格式」。档案存规范化值，表单要地区化格式：

| handler | 输入 → 输出 | 说明 |
|---|---|---|
| `text` / `richtext` | 原样 | |
| `email` | `A@B.COM` → `a@b.com` | 小写去空格 |
| `phone` | `+86 138-0000-0000` → `+8613800000000` | 保留前导 `+` |
| `number` | `"3.50"` → `3.5` | 提取数值、去尾零 |
| `date` | `2003-01-01` → `01/01/2003` | **按 placeholder 推断** mm/dd/yyyy 等 |
| `month_date` | `2022-09` → `09/2022` | 入学/毕业月 |
| `gpa` | `88` → `3.7` | **百分制 / 5 分制 → 4.0 制** |
| `gender` | `M` → `Male` | |
| `country` | `CN` → `China`（有 options 时再匹配选项） | 含 HK/Macao/Taiwan 的中国称谓 |
| `degree` | `本科` → `Bachelor's Degree` | |
| `state` | `北京` → `Beijing`（美国表单可用州缩写） | 中国省级行政区映射 |
| `select_by_text` | 档案值 → 最接近的下拉选项 | token 重叠度打分 |

处理器自身置信度会**修正最终置信度**：下拉字段没找到匹配选项时自动降级为 `review`/`skip`。

## 字段词典（跨端共享资产）

[`packages/field-dictionary/fields.json`](../../packages/field-dictionary/fields.json) —— **54 个语义槽位**，插件 TS 端与服务端读**同一份**，避免两端字段定义漂移。

| 分组 | 槽位数 | 示例 |
|---|---|---|
| 基本信息 / 地址 / 文书 | 27 | `basic_info.last_name`、`address.city`、`documents.sop` |
| `education`（可重复） | 7 | `education[0].institution`、`education[0].gpa` |
| `tests`（可重复） | 11 | `tests[0].test_type`、`tests[0].total`、`tests[0].verbal` |
| `experiences`（可重复） | 5 | `experiences[0].org`、`experiences[0].description` |
| `recommender`（可重复） | 4 | `recommender[0].name`、`recommender[0].email` |

槽位字段：`key`（点分路径）、`label`、`value_type`、`handler`、`priority`、`keywords`、`negative`、可选 `group` / `repeatable`。

新增字段**只改这一份 JSON**，两端同时生效。

## 档案取值（三级回退）

`app/pipeline.py::resolve_value` 按点分路径从用户档案取值，兼容契约路径与档案实际结构：

1. **原路径** —— 含别名（`address.*` → `addresses[0].*`）
2. **叶子同义词** —— `province`→`state`、`school`→`institution`、`major`→`field_of_study` 等
3. **空** —— 标记 `skip`（原因「档案缺少该字段」）

另对 `{"value": x, "scale": y}` 形式的包装对象自动解包为标量。

## 合规：敏感字段本地优先

`settings.local_only_fields` 默认包含护照姓名 / 护照号 / 成绩单 —— 这些字段**默认不上云**（架构详设 §3 关键设计点 5），由插件端本地填充。

## 评测（词典匹配 vs 人工标注）

```bash
cd apps/intelligence

python scripts/eval_matcher.py --set basic    # 平台常见命名（词典可解，回归基线）
python scripts/eval_matcher.py --set hard     # 缩写 / 题干撞车 / 行业黑话 / 非英文 / 无 label
python scripts/eval_matcher.py --set all      # 合并
```

产出 `docs/03-PoC/field-matcher-eval-<set>-<时间戳>.md/.json`。

**当前基线**（6 个页面 / 59 字段）：

| 基准集 | 识别率 | 精确率 | 填充率 | 自动填充率 |
|---|---|---|---|---|
| basic（3 页 / 39 字段） | **100.0%** | **100.0%** | **79.5%** | 79.5% |
| hard（3 页 / 20 字段） | **80.0%** | **92.3%** | **55.0%** | 35.0% |
| **all** | **94.2%** | **98.0%** | **66.1%** | 62.7% |

指标口径：识别率 = 正确识别 / 有标注的可匹配字段；精确率 = 正确 /（正确+误匹配+误报）；填充率 = 有非空值的字段 / 全部字段。

> 双集设计同模块二：basic 集用于回归词典能力，hard 集**独立构造、未针对规则调优**，用于暴露词典天花板。详见 [模块一 · 字段匹配引擎结论](../../docs/03-PoC/模块一-字段匹配引擎结论.md)。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查（含词典槽位数、阈值） |
| POST | `/ext/v1/match-fields` | 批量字段匹配，返回填充指令（含文书 `word_check`） |
| GET | `/ext/v1/dictionary` | 字段词典（供插件端核对版本） |
| POST | `/internal/gpa/convert` | GPA 制式换算（百分制阶梯 / 5 分制线性 → 4.0，`{value, method, note}`） |

## 文书字数校验（规划：PS/SOP 硬性字数限制）

`app/wordcount.py`（纯函数）：英文按词、中文字逐字计数；限制来自词典
`word_limit`（SOP 默认 1000 词）或页面 `maxlength`（字符），未配置只计数。
`pipeline` 对 `essays` 组或声明 `maxlength` 的字段附加 `word_check`，
超限时动作降为 `review`（只降级、不截断）。

> 坑：DOM 缺省 `maxlength` 为 `-1`（= 无限制），插件提取端归一为 `null`、
> 服务端非正限制一律视为未配置——否则全员误判超限（实测曾把自动填充打到 0）。

响应遵循契约「通用响应」封装：`{ code, message, data, trace_id }`。

```bash
curl -X POST http://localhost:8090/ext/v1/match-fields -H "Content-Type: application/json" -d '{
  "session_id": 1001,
  "system_code": "applyweb",
  "profile": {
    "basic_info": {"last_name": "Chen", "email": "chen@example.com", "gender": "M"},
    "addresses": [{"city": "Beijing"}],
    "education": [{"institution": "Peking University", "gpa": 88}]
  },
  "fields": [
    {"selector": "#lastName", "label": "Family Name", "type": "text"},
    {"selector": "#gender", "label": "Gender", "type": "select", "options": ["Male","Female"]},
    {"selector": "#gpa", "label": "GPA", "type": "number"}
  ]
}'
```

返回 `data.instructions[]` 每项含 `selector / field_key / value / confidence / handler`（非 `fill` 动作附 `action` 与 `reason`），
`data.unmatched[]` 列出未识别字段，`data.summary` 折算识别率 / 填充率。

## 目录

```
app/
├── config.py       运行配置（零依赖）
├── utils.py        日志（零依赖）
├── normalize.py    信号归一化 + 词边界匹配 + token 集合
├── dictionary.py   字段词典加载与 Slot 解析
├── schema.py       FieldSpec / Instruction 数据类
├── matcher.py      三级匹配前两级 + 冲突消解 + 题干识别
├── handlers.py     13 个值转换处理器 + 下拉选项匹配
├── pipeline.py     匹配 → 取值 → 转换 → 分级 → 指令
├── main.py         FastAPI 入口
└── api/
    └── ext.py      /ext/v1 接口

scripts/eval_matcher.py              字段匹配评测（basic / hard / all）
samples/benchmark/pages.json         评测基础集（3 页 / 39 字段）
samples/benchmark/pages.hard.json    评测难例集（3 页 / 20 字段）
tests/smoke_test.py                  冒烟测试（61 项，零第三方依赖）
```

## 下一步

| 事项 | 依赖 | 说明 |
|---|---|---|
| LLM 语义匹配（第三级） | **LLM_API_KEY** | 覆盖非英文标签、语义泛化字段 |
| `apps/extension`（MV3 插件） | — | 真正消费填充指令的执行器（FieldExtractor / Filler / StepController） |
| `/profile` 等档案接口 | — | 契约已定义，由 api-gateway 承载 |
| 真实网申页面样本扩充 | 用户提供 | 提升评测外部效度 |
