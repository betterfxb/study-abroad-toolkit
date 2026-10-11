# 留学生助手

AI 驱动的留学申请与实习求职工具集。产品形态与视觉风格参考 [求职方舟AI](https://www.qiuzhifangzhou.com/)。

## 两个核心模块

| 模块 | 说明 | 优先级 |
|---|---|---|
| **模块一 · 留学网申自动填写** | 浏览器插件识别海外院校申请表单，多步向导一键填充 | P2 / P3 |
| **模块二 · 实习信息自动爬取** | 多源聚合公众号 / 招聘平台 / 官网实习信息，结构化去重 | **P1** |

> 合规红线：**不破解验证码、不自动提交**；采集**仅公开信息、控制频次、署名来源、不整篇转载**。

## 文档索引

### 规划阶段
- [`docs/项目规划与可行性分析报告.md`](docs/项目规划与可行性分析报告.md) — 可行性分析、基线对比、风险、资料清单、排期

### 详细设计阶段
- [`docs/02-详细设计/01-系统架构详设.md`](docs/02-详细设计/01-系统架构详设.md) — 服务划分、数据流、部署拓扑、横切设计
- [`docs/02-详细设计/02-数据库设计.md`](docs/02-详细设计/02-数据库设计.md) — 表设计、索引、安全合规、迁移策略
- [`docs/02-详细设计/03-接口契约.md`](docs/02-详细设计/03-接口契约.md) — REST API 契约、错误码、约定
- [`docs/02-详细设计/04-UI原型.html`](docs/02-详细设计/04-UI原型.html) — 首页工具集 / 实习汇总表 / 插件浮窗

### 数据库
- [`db/schema.sql`](db/schema.sql) — psql 一键初始化（建库 + 串迁移）
- [`db/migrations/0001_init.sql`](db/migrations/0001_init.sql) — 初始表结构（唯一 DDL 来源）
- [`db/migrate.py`](db/migrate.py) — 迁移执行器（`--status` / `--dry-run`）

### 工程实现
- [`apps/console/`](apps/console/) — **React 控制台（工具集首页 / 实习汇总 / 申请进度 / 资料库）**，见 [控制台说明](apps/console/README.md)
- [`apps/api/`](apps/api/) — **主网关（鉴权 / Profile / 申请 / 订阅 / 对外 API）**，见 [服务说明](apps/api/README.md)
- [`apps/crawler/`](apps/crawler/) — **模块二采集服务（已可运行）**，见 [服务说明](apps/crawler/README.md)
- [`apps/intelligence/`](apps/intelligence/) — **模块一字段匹配引擎（已可运行）**，见 [服务说明](apps/intelligence/README.md)
- [`apps/extension/`](apps/extension/) — **模块一 Chrome MV3 插件（零构建，已可加载）**，见 [插件说明](apps/extension/README.md)
- [`packages/field-dictionary/`](packages/field-dictionary/) — 跨端共享字段词典（54 语义槽位）
- [`deploy/docker-compose.yml`](deploy/docker-compose.yml) — 本地/单机部署（postgres / redis / minio / api / worker / beat / migrate）

### PoC
- [`docs/03-PoC/模块二-PoC方案与指标.md`](docs/03-PoC/模块二-PoC方案与指标.md) — PoC 目标、能力清单、实测结果、待补资料
- [`docs/03-PoC/模块二-抽取器对比结论.md`](docs/03-PoC/模块二-抽取器对比结论.md) — 规则 vs LLM 抽取对比（双集方法论）
- [`docs/03-PoC/模块二-岗位库与全链路闭环.md`](docs/03-PoC/模块二-岗位库与全链路闭环.md) — 采集 → 入库 → 查询 → 导出全链路
- [`docs/03-PoC/模块一-字段匹配引擎结论.md`](docs/03-PoC/模块一-字段匹配引擎结论.md) — 词典匹配 vs 人工标注（基础集 / 难例集）
- `docs/03-PoC/poc-report-*.md` · `extractor-comparison-*.md` · `field-matcher-eval-*.md` — 脚本自动生成报告

## 目录结构

```
new_job_project/
├── docs/                      # 方案与设计文档
│   ├── 项目规划与可行性分析报告.md
│   └── 02-详细设计/
├── db/                        # 数据库
│   ├── schema.sql
│   ├── migrate.py
│   └── migrations/0001_init.sql
├── apps/
│   ├── console/               # React 控制台（Vite + TS + 设计令牌）✅
│   ├── extension/             # Chrome MV3 插件（零构建）✅
│   ├── api/                   # NestJS 主网关 ✅
│   ├── intelligence/          # FastAPI 字段匹配引擎 ✅
│   └── crawler/               # FastAPI 采集服务 ✅
├── packages/
│   ├── shared-types/          # 跨端 TS 类型
│   └── field-dictionary/      # 字段词典与映射规则 ✅（54 槽位）
├── deploy/
│   └── docker-compose.yml
└── README.md
```

## 快速启动

### 主网关（模块一 + 模块二统一入口）

```bash
cd apps/api
npm install && npm run build && npm start
# http://localhost:8080 · 健康检查 /health
```

### 模块二 · 采集服务

```bash
cp apps/crawler/.env.example apps/crawler/.env
docker compose -f deploy/docker-compose.yml up -d --build
# API 文档: http://localhost:8100/docs
```

### 模块一 · 字段匹配引擎 + 插件

```bash
# 服务端
cd apps/intelligence
uvicorn app.main:app --reload --port 8090
# API 文档: http://localhost:8090/docs

# 插件：Chrome → chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选 apps/extension
```

### 控制台（产品门面）

```bash
cd apps/console
npm install
npm run dev
# http://localhost:5173 · /api 与 /ext 自动代理到网关（GATEWAY_BASE 可覆盖）
```

无 Docker / PostgreSQL 时，用 SQLite 起采集服务并灌入演示岗位数据：

```bash
cd apps/crawler
DATABASE_URL="sqlite+aiosqlite:///./dev.db" python scripts/seed_dev.py
DATABASE_URL="sqlite+aiosqlite:///./dev.db" python -m uvicorn app.main:app --port 8100
```

### 回归测试（零第三方依赖）

```bash
python apps/crawler/tests/smoke_test.py        # 95 项
python apps/crawler/tests/e2e_jobs_test.py     # 44 项（SQLite 落地）
python apps/intelligence/tests/smoke_test.py   # 89 项
node   apps/extension/tests/smoke_test.js      # 188 项
cd apps/api && npm test                        # 332 项（网关契约 / 降级 / 订阅调度 / 分布式抢占 / 限流 / 管理后台 / 对象存储 / GPA 代理 / 过期下架鉴权 / 填写会话与日志）
node   apps/console/test/smoke_test.js         # 71 项（控制台：令牌 / 逻辑 / 结构 / 红线 / 订阅调度 / 易用性 / 在线表格 / 一键建订阅 / 体验升级）
node   apps/console/test/render_test.js        # 11 项（控制台：六 Tab 真实渲染，含新手引导横幅）

# 端到端联调（需先启动对应服务）
node   apps/extension/tests/integration_e2e.js # 31 项（插件 ↔ 字段匹配服务，含两步向导）
node   apps/api/test/integration_live.js       # 80 项（网关 ↔ 采集/匹配服务，含订阅推送与定时、GPA 服务端换算、会话上报）
node   apps/api/test/multi_instance_live.js    # 16 项（多实例调度互斥：真实双进程 + 共享 SQLite）
node   apps/console/test/integration_live.js   # 23 项（控制台 ↔ 网关 ↔ 采集服务）
```

## 技术栈

| 层 | 选型 |
|---|---|
| 控制台 | React 18 + Vite + TypeScript（UnoCSS 原子层 + 原生 CSS + 设计令牌） |
| 插件 | Chrome MV3 + 原生 ESM JavaScript（零构建，Node 可测） |
| 主 API | NestJS + TypeScript |
| AI / 采集服务 | Python + FastAPI + Celery |
| 数据库 | PostgreSQL 16 + Redis 7 |
| 对象存储 | S3 兼容（MinIO / 云 OSS） |
| 部署 | Docker Compose → K8s |

## 当前进度

- [x] 可行性分析报告
- [x] 系统架构详设
- [x] 数据库设计与 DDL
- [x] 接口契约
- [x] UI 原型
- [x] 工程搭建（crawler-service 骨架 + docker-compose + 迁移脚本）
- [x] 模块二 **合规层 / 降级链路 / 管理接口 / PoC 运行器**（冒烟 90 项）
- [x] 模块二 **真实公开源链路 + 抽取器对比（规则 vs LLM）**（基础 100% / 难例 48.5%）
- [x] 模块二 **岗位库读侧 API + 全链路落库（采集→入库→查询→导出）**（e2e 39 项）
- [x] 模块一 **字段匹配引擎（词典三级匹配 + 值转换 + 填充指令）**（冒烟 61 项，识别 94.2% / 精确 98.0%）
- [x] 模块一 **Chrome MV3 插件（字段提取 / 填充执行 / 校验 / 状态机 / 阻断检测）**（冒烟 83 项 + 联调 17 项）
- [x] 模块一 **插件多步向导适配（步骤指纹 / 稳定窗口 / 自动重填 / 步骤角标 / 自动填充开关）**（冒烟 166 项 + 联调 31 项）
- [x] **主网关 api-gateway（鉴权 / Profile / 材料 / 申请 / 订阅 / 上游代理）**（契约 100 项 + 三服务联调 35 项）
- [x] **`apps/console` React 控制台（工具集首页 / 实习汇总表 / 岗位订阅 / 申请进度 / 资料库）**（测试 44 项 + 联调 23 项）
- [x] **订阅匹配与推送（匹配引擎 / 幂等去重 / 邮件排队 + 企微 + Webhook 实发 / 推送记录）**（契约 137 项 + 联调 59 项）
- [x] **订阅定时调度（调度表达式 / 到期索引 / 失败推进防热循环 / 单飞 / 控制台可配频率）**（契约 205 项 + 联调 75 项）
- [x] **分布式调度（DB 行级原子抢占 + 锁 TTL + 只读自愈 + Windows 日志模式规避）**（契约 242 项 + 多实例双进程 16 项）
- [x] **控制台交互易用性改造（竞态保护 / 输入防抖 / 静默刷新不闪空 / 删除二次确认 / 修复顿号拆分导致订阅失效）**（冒烟 53 项 + 渲染 9 项）
- [x] 模块一 **GPA 换算服务端化**（`POST /internal/gpa/convert`＋网关代理，百分制阶梯/5 分制线性→4.0，与 handlers/控制台同口径）
- [x] 模块一 **文书字数校验**（`wordcount` 纯函数＋pipeline `word_check` 附加＋超限降 review＋插件透传；SOP 默认 1000 词）
- [x] 模块二 **岗位过期自动下架**（`deadline` 过期批量置 `expired`，Beat 每日 02:05＋`POST /admin/jobs/expire` 手动触发）
- [x] 模块一 **填写会话与日志服务端闭环**（契约 §4.2/§4.3：网关 `ext/` 本地实现 sessions CRUD＋block＋fill-logs，会话隔离，只存哈希；插件上报链路（SAVING→SW→网关）就此打通）
- [x] 模块一 **插件本地断点续填**（`session-store`：站点键＋7 天 TTL＋20 条上限，恢复只提示不自动写；服务端同步待插件鉴权 Token UX）
- [x] 控制台体验升级（关键词高亮 / 详情复制投递方式 / 首页三步上手横幅 / 窄屏弹窗与操作区换行滚动）
- [ ] 模块一 LLM 语义匹配（第三级）— **待 LLM_API_KEY**
- [ ] 模块一 真实网申页面回归（用真实 ApplyWeb / Liaison / Slate 页面校准稳定窗口与指纹策略）
- [x] 控制台接入 UnoCSS 原子化（共存原子层：presetUno + 关闭 preflight + tokens.css 令牌映射进 theme，静态内联样式改写为原子类，构建/测试零回归）
- [x] 首页卡片落点收口（成绩换算新增独立「GPA 换算」Tab 并落地真实加权换算器；院校项目库 / 推荐信管理仍落 apply，相关功能已在其中）
- [x] 在线表格能力（岗位表：表头点击排序 + 列显隐 + 本页就地筛选；进度表：进度 / 状态行内编辑，复用 updateApplication）
- [x] 从岗位一键建订阅（岗位详情按公司 / 城市 / 标题词 / 标签预填订阅规则，一次点击创建；未登录走鉴权引导）
- [x] 网关接口限流（滑动窗口 / 规则按最长前缀匹配 / 按 IP 与用户分维度计数 / `X-RateLimit-*` 与 `Retry-After` 响应头，契约 §9.6）
- [x] 网关管理后台接口（契约 §6.3：采集源 CRUD / 手动触发 / 健康度 / 降级切换与评估 / 任务列表，全部限管理员，纯代理到 crawler）
- [x] 对象存储本地驱动（预签名从占位变为真实落盘：上传 / 登记 / 下载 / 删除联动清理，路径穿越防护，`STORAGE_DRIVER` 可切 s3）
- [x] 网关 PG 迁移 SQL（`db/migrations/0002_gateway_pg.sql` + `db/tests/pg_migration_check.js` 32 项，环境无关先行；含 `SELECT … FOR UPDATE SKIP LOCKED` 改写参考）
- [ ] 网关切换 PostgreSQL 驱动（本机无 PG；届时替换 `DatabaseService` 并按 0002 §5 改写调度抢占）
- [ ] 对象存储切 S3 / MinIO（S3 驱动为显式占位，需 SDK 与 `STORAGE_S3_*` 凭据）
- [ ] 模块二真实源连续跑 3 天（待公众号清单 / 三方数据服务凭据）
