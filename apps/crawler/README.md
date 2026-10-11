# crawler-service · 实习信息采集服务

模块二（实习信息自动爬取）的服务端实现。多源适配器 + 结构化抽取 + 三级去重 + 分级降级。

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
cd <项目根目录>
cp apps/crawler/.env.example apps/crawler/.env
docker compose -f deploy/docker-compose.yml up -d --build
```

启动后：

| 服务 | 地址 |
|---|---|
| crawler-api | http://localhost:8100 |
| API 文档 | http://localhost:8100/docs |
| MinIO 控制台 | http://localhost:9001 （minioadmin / minioadmin） |

### 方式二：本地直跑

```bash
cd apps/crawler
python -m venv .venv && . .venv/Scripts/activate     # Windows
pip install -r requirements.txt
cp .env.example .env
python ../../db/migrate.py --dsn postgresql://postgres:postgres@localhost:5432/study_abroad
uvicorn app.main:app --reload --port 8100
```

Worker / Beat 另开两个终端：

```bash
celery -A app.worker:celery_app worker -l info
celery -A app.worker:celery_app beat -l info
```

## 冒烟测试（零第三方依赖）

不装任何依赖即可验证核心逻辑：

```bash
python tests/smoke_test.py
```

覆盖：去重与指纹、字段标准化、适配器注册表、正文抽取与规则结构化、
**自由文本兜底**、人工投递适配器、端到端流水线、**合规层、HTTP 客户端、降级链路、PoC 指标、过期下架**。
当前 **95 项全通过**。

## 抽取器对比评测（规则 vs LLM）

在同一基准集上逐字段对比规则抽取与 LLM 抽取，输出准确率与失败明细。

```bash
cd apps/crawler

# 基础集：标签规范 / 常见写法（规则可解，用于回归规则能力）
python scripts/compare_extractors.py --set basic

# 难例集：表格 / 列表 / 英文 / 长软文 / 时薪（用于暴露规则天花板）
python scripts/compare_extractors.py --set hard

# 合并 + LLM 对比（需 LLM_API_KEY，缺失时自动只跑规则）
python scripts/compare_extractors.py --set all --llm
```

产出 `docs/03-PoC/extractor-comparison-<set>-<时间戳>.md/.json`。
当前基线：基础集 **100.0%**、难例集 **48.5%**、合并 **78.2%**（规则抽取）。
详见 [模块二 · 抽取器对比结论](../../docs/03-PoC/模块二-抽取器对比结论.md)。

## PoC 运行器

```bash
cd apps/crawler

# 离线样例（零外部依赖，验证链路正确性）
python scripts/poc.py --sources config/poc_sources.json --repeat 2

# 接入真实 RSS 源
python scripts/poc.py --adapter rss --feed-url https://example.com/feed.xml

# 开启 LLM 结构化
python scripts/poc.py --sources config/poc_sources.json --use-llm
```

产出控制台摘要 + `docs/03-PoC/poc-report-<时间戳>.md/.json`。
详见 [模块二 PoC 方案与指标](../../docs/03-PoC/模块二-PoC方案与指标.md)。

## 全链路运行（采集 → 入库 → 查询 → 导出）

与 PoC 运行器的区别：PoC 用内存仓储验证链路与指标；本脚本**真实落库**并走岗位库接口导出汇总表。

```bash
cd apps/crawler

# 离线样例 → SQLite → 导出 CSV（无需 Docker / PostgreSQL）
python scripts/jobs_flow.py --sources config/poc_sources.json

# 真实公开源（RemoteOK 等 JSON 招聘 API）
python scripts/jobs_flow.py --sources config/poc_sources.real.json --only remoteok

# 指向真实 PostgreSQL
python scripts/jobs_flow.py --sources config/poc_sources.json \
    --dsn "postgresql+psycopg://user:pass@localhost:5432/qiuzhi"
```

产出 `docs/03-PoC/jobs-summary-<时间戳>.csv`（实习信息汇总表）+ `jobs-flow-<时间戳>.md`。
重复运行同一 SQLite 库可验证去重幂等（第二轮应全部判重、新增为 0）。

## 端到端测试

覆盖「采集 → 入库 → 岗位库查询 → HTTP 接口」完整闭环，用真实 SQLite 落地：

```bash
python tests/e2e_jobs_test.py
```

验证点：Pipeline 写入 articles/jobs/dedup_index、重复采集幂等、筛选/分页/排序/聚合/详情/CSV 导出、
FastAPI `/jobs` 系列接口（含 404 与 422 参数校验）、**过期下架端到端**（`POST /admin/jobs/expire` 后默认列表剔除、`status=expired/all` 可查）。当前 **44 项全通过**。

## 架构

```
L1 采集层   scheduler(Celery Beat) → 多源适配器 → 代理池/频控令牌桶
L2 解析层   正文抽取(trafilatura) + LLM 结构化（不可用时降级规则抽取）
L3 处理层   三级去重(URL / 指纹 / SimHash) + 字段标准化 + 置信度过滤
L4 存储层   PostgreSQL(articles/jobs/dedup_index) + Redis + 对象存储
L5 服务层   岗位库检索 API(/jobs) · 订阅推送 · 后台管理 · 降级开关
```

## 适配器

| code | 类型 | 状态 | 说明 |
|---|---|---|---|
| `rss` | rss | ✅ 可用 | 自建 wechat2rss / RSSHub 中转源 |
| `manual` | manual | ✅ 可用 | 降级 L2：运营转发至 inbox 目录（JSON） |
| `company_site` | company_site | ✅ 可用 | 兜底源 B：抓企业官网招聘页 |
| `thirdparty_api` | thirdparty_api | ⚠️ 待接入 | 主源 A：新榜/清博等，需填 base_url + api_key |
| `job_platform` | job_platform | ⚠️ 待接入 | 主源 C：实习僧/牛客等，需确认授权 |

新增源只需继承 `SourceAdapter` 并用 `@register` 装饰：

```python
from app.adapters.base import FetchResult, RawItem, SourceAdapter
from app.adapters.registry import register

@register
class MyAdapter(SourceAdapter):
    code = "my_source"
    source_type = "rss"

    def fetch(self, limit: int = 50) -> FetchResult:
        return FetchResult(items=[RawItem(url="...", title="...", content="...")])
```

## 接口

### 采集 / 内部接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/internal/adapters` | 已注册适配器 |
| POST | `/internal/crawl/run` | 执行一次采集（内存仓储，连通性验证） |
| POST | `/internal/extract` | 正文 → 岗位结构化 |
| POST | `/internal/dedup/check` | SimHash 查重 |

真实入库走 Celery 任务 `app.tasks.run_source`。

### 岗位库接口（读侧）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/jobs` | 岗位列表（分页 + 筛选 + 排序） |
| GET | `/jobs/{id}` | 岗位详情（含来源文章） |
| GET | `/jobs/facets` | 聚合筛选项（城市 / 公司 / 学历 / 标签） |
| GET | `/jobs/export.csv` | 导出汇总表 CSV（带 BOM，Excel 直接打开） |

```bash
# 筛选 + 分页 + 排序
GET /jobs?city=北京&keyword=数据分析&status=active&sort=published_at:desc&page=1&size=50

# 聚合筛选项
GET /jobs/facets?keyword=设计

# 导出汇总表
GET /jobs/export.csv?city=深圳&max_rows=5000
```

支持的筛选参数：`keyword`（公司/岗位/专业/文章标题）、`city`、`company`、`education`、
`status`（active/expired/removed/all）、`min_confidence`、`date_from`、`date_to`、`has_deadline`。

排序字段：`published_at` / `created_at` / `deadline` / `confidence` / `company` / `city`，
方向 `asc|desc`，非法取值自动回退默认（`published_at:desc`）。

> 聚合接口按标准分面搜索行为实现：统计某维度时**排除该维度自身的筛选条件**。

### 管理接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/adapters` | 适配器清单 |
| GET / POST | `/admin/degrade` | 查看 / 手动切换降级层级 |
| POST | `/admin/degrade/evaluate` | 按源健康度自动评估层级 |
| GET / POST | `/admin/sources` | 源列表 / 新增源 |
| PATCH | `/admin/sources/{id}` | 修改源（启停、频控、配置） |
| POST | `/admin/sources/{id}/run` | 手动触发采集 |
| GET | `/admin/sources/{id}/health` | 源健康度趋势 |
| GET | `/admin/tasks` | 任务列表 |
| POST | `/admin/jobs/expire` | 手动触发过期下架（`deadline` 早于今天的 `active` 岗位批量置 `expired`；定时由 Beat 每日 02:05 执行） |

> 数据库不可用时 `/jobs/*` 与管理接口优雅返回 **503**，不影响 `/health` 与采集链路可用性。

## 合规层（硬性）

`app/compliance.py` + `app/http.py` 构成合规总闸，**所有 HTTP 采集必须经过**：

| 能力 | 说明 |
|---|---|
| robots.txt | `RobotsCache` 抓取 + 缓存 + `can_fetch`；不可达时可配放行/拒绝 |
| 域名策略 | `DomainPolicy` 白名单 / 禁采名单 |
| 权利人下架 | `TakedownRegistry` URL / 域名级永久跳过 |
| 频控 | 按域名独立令牌桶 + 随机抖动，遵守 `Crawl-delay` |
| 不存全文 | 默认仅存摘要 + 原文链接 |

> 本服务不采集任何非公开信息，不绕过登录墙与验证码。

## 降级链路

`app/services/degrade.py`，按源健康度自动判定：

| 层级 | 含义 | 触发条件 |
|---|---|---|
| L0 | 全自动多源 | 主源（第三方 API / 公众号 / 招聘平台）健康 |
| L1 | 切源（自建 RSS + 官网兜底） | 主源不可用 |
| L2 | 半自动（运营转发统一入口） | 自动源均不可用，人工入口有投递 |
| L3 | 人工汇总表 | 全部无产出 |

恢复时**每次只回升 1 档**，避免抖动。

## 去重阈值说明

中文按**字符 n-gram** 切 SimHash（64 位），实测：

- 同一篇长文局部改写 → 汉明距离 **5~8**
- 无关文章 → 汉明距离 **30+**

故默认阈值取 **8**（英文按词切分常用 3，不适用中文）。
短文本（<100 字）不依赖 SimHash，改用 `job_fingerprint` 精确指纹。

## 目录

```
app/
├── config.py            运行配置（零依赖）
├── utils.py             日志 / 令牌桶 / 重试（零依赖）
├── compliance.py        robots / 域名策略 / 下架登记（零依赖）
├── http.py              统一 HTTP 客户端（合规感知 + 频控）
├── db.py                数据库连接（API 异步 / Worker 同步）
├── models.py            ORM 模型（跨方言：PG 用 JSONB/BIGINT，SQLite 自动降级）
├── main.py              FastAPI 入口
├── worker.py            Celery 应用 + Beat 调度
├── tasks.py             采集任务
├── api/
│   ├── deps.py          公共依赖（get_db，无库时 503）
│   ├── internal.py      内部接口
│   ├── admin.py         管理接口
│   └── jobs.py          岗位库接口（读侧）
├── adapters/            多源适配器（插件式）
├── services/            去重 / 标准化 / 抽取 / 流水线 / 降级 / 指标 / 岗位库查询
└── llm/client.py        统一 LLM 客户端（路由 + 降级 + 计量）

scripts/poc.py                PoC 运行器（内存仓储，验证链路与指标）
scripts/jobs_flow.py          全链路运行（真实落库 + 导出汇总表）
scripts/compare_extractors.py 抽取器对比评测（规则 vs LLM）
config/poc_sources.json       PoC 源清单（离线样例）
config/poc_sources.real.json  PoC 源清单（真实公开源）
samples/inbox/                离线样例数据
samples/benchmark/cases.json       抽取评测基础集（8 例）
samples/benchmark/cases.hard.json  抽取评测难例集（6 例）
tests/smoke_test.py           冒烟测试（90 项，零第三方依赖）
tests/e2e_jobs_test.py        端到端测试（39 项，SQLite 落地）
```
