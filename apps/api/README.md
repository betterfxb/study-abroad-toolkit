# api-gateway · 主网关

模块一与模块二的**统一业务入口**。架构定位（见 [系统架构详设](../../docs/02-详细设计/01-系统架构详设.md) §服务划分）：

> 鉴权、Profile、材料、申请管理、订阅、对外 API —— 并把 crawler-service 与 intelligence-service 收敛到同一 Base URL 之下。

技术栈：**NestJS 11 + TypeScript + Express 5**，持久层用 Node 内置 `node:sqlite`（**零原生依赖**）。

## 快速开始

```bash
cd apps/api
npm install
npm run build
npm start          # http://localhost:8080
```

> `npm start` 已内置 `--experimental-sqlite` 标志。`node:sqlite` 是 Node 22 的实验特性，启动时会打印一条 ExperimentalWarning，属正常现象。

指定文件库（默认内存库，重启即清空）：

```bash
DB_PATH=./data/gateway.db npm start
```

## 测试

### 契约与降级（313 项，无需任何外部依赖）

```bash
npm test
```

在内存库上独立启动网关，覆盖：响应封装 / trace_id / 鉴权全流程 / Profile(JSON Merge Patch) /
院校 / 申请 / 推荐人 / 订阅 / 订阅匹配与推送 / 订阅定时调度 / 分布式调度抢占 /
日志模式解析与只读故障识别 / 材料 / 简历解析 / 幂等 / 错误码 / 上游降级 / 跨用户隔离 /
GPA 换算代理降级 / 过期下架管理鉴权 / 填写会话与日志。当前 **332 项**；三服务联调 **80 项**（含 GPA 服务端换算与会话上报）。

### 三服务联调（75 项，需三个服务都在跑）

```bash
# 终端 1 · crawler（指向已入库的 SQLite）
cd apps/crawler
DATABASE_URL="sqlite+aiosqlite:////tmp/gw_jobs.db" uvicorn app.main:app --port 8100
# 终端 2 · intelligence
cd apps/intelligence && uvicorn app.main:app --port 8090
# 终端 3 · gateway
cd apps/api && npm start
# 终端 4
cd apps/api && node test/integration_live.js
```

验证真实跨服务代理：岗位库查询/筛选/聚合/CSV 导出、字段语义匹配与值转换、完整用户旅程。

### 多实例调度互斥（16 项，真实双进程 + 共享 SQLite）

```bash
cd apps/api && npm run build
node --experimental-sqlite test/multi_instance_live.js
```

拉起两个 `dist/main.js` 子进程（各自独立端口、共用同一 SQLite 文件、各自 `SCHEDULER_INSTANCE_ID`），
用本地 HTTP 接收器统计 webhook 推送次数，断言：

* 两个实例**都**扫描到了同一到期订阅（排除「只有一个实例在工作」的假象）；
* 两个实例的**累计执行次数合计恰好为 1**（互斥核心，用累计计数器而非逐轮采样）；
* webhook **只被推送 1 次**，且落库的推送记录数等于岗位条目数（端到端无重复）。

> 「实例崩溃后锁自动过期」由 `e2e.js` 的 `[16] 分布式调度` 段覆盖（把 `locked_at` 置为陈旧，
> 断言另一实例可接管；并断言 `releaseInstanceLocks` 在实例退出时清空自己持有的锁）。

## 已实现接口（对齐 [接口契约](../../docs/02-详细设计/03-接口契约.md)）

### §1 认证 Auth

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/auth/register` | 邮箱注册（bcrypt 哈希，自动初始化空档案） |
| POST | `/api/v1/auth/login` | 登录，返回 access + refresh token |
| POST | `/api/v1/auth/refresh` | 刷新（**轮换策略**：旧 token 立即吊销，防重放） |
| POST | `/api/v1/auth/logout` | 登出，吊销 refresh token |

凭证支持两种来源：控制台 `Authorization: Bearer <JWT>`；插件 `X-Ext-Token: <JWT>`。
access_token 有效期 2h（7200s），refresh_token 30d。

### §2 用户资料 Profile

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/profile` | 获取结构化资料 |
| PUT | `/api/v1/profile` | 全量替换 |
| PATCH | `/api/v1/profile` | 局部更新（**JSON Merge Patch / RFC 7396**） |

PATCH 语义：对象递归合并、`null` 删除键、数组整体替换。
顶层字段白名单：`basic_info / education / tests / experiences / addresses / documents / preferences`，越界返回 1001。

### §3 材料与简历

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/documents/presign` | 获取预签名上传 URL（校验 doc_type / 20MB 上限） |
| POST | `/api/v1/documents` | 登记已上传材料 |
| GET | `/api/v1/documents?doc_type=` | 列出材料 |
| DELETE | `/api/v1/documents/{id}` | 删除材料 |
| POST | `/api/v1/resumes/parse` | 简历文本 → 结构化 JSON（启发式） |
| GET | `/api/v1/resumes` | 简历版本列表 |
| PUT | `/api/v1/resumes/{id}` | 更新简历内容 |

> 存储说明：预签名默认走**本地驱动**（`STORAGE_DRIVER=local`），上传/下载真实可用；
> 配置 `STORAGE_DRIVER=s3` 走对象存储（当前为显式占位，见下文「对象存储」）。
> 简历解析用启发式规则（抽邮箱/手机/学历/技能），结果标注 `method: "heuristic"` 提示人工确认，
> 生产环境应改走 intelligence-service 的 LLM 解析。

### §5 申请管理

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/institutions` | 院校项目列表（按 country / platform / keyword 筛选，含 8 条种子数据） |
| POST | `/api/v1/applications` | 新建申请（支持按 `institution_id` 自动带出院校信息） |
| GET | `/api/v1/applications` | 申请列表（按 status / keyword 筛选） |
| PATCH | `/api/v1/applications/{id}` | 更新进度（status 白名单 + progress 0~100 校验） |
| GET | `/api/v1/applications/{id}/recommenders` | 推荐人列表 |
| POST | `/api/v1/applications/{id}/recommenders` | 添加推荐人 |
| POST | `/api/v1/applications/{id}/recommenders/{rid}/invite` | 记录「已邀请」状态 |

> 合规：推荐人邀请由用户在院校系统内自行完成，本服务只做**登记与状态跟踪**，**不代发邀请邮件**。

### §6 实习信息订阅

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/subscriptions` | 我的订阅 |
| POST | `/api/v1/subscriptions` | 新建订阅（keywords / cities 支持数组或逗号分隔字符串） |
| PATCH | `/api/v1/subscriptions/{id}` | 修改 |
| DELETE | `/api/v1/subscriptions/{id}` | 删除（级联清理推送记录） |
| GET | `/api/v1/subscriptions/{id}/preview` | 预览匹配结果（不写记录） |
| POST | `/api/v1/subscriptions/{id}/run` | 立即匹配并推送 |
| POST | `/api/v1/subscriptions/run-all` | 批量执行全部启用订阅（管理员） |
| GET | `/api/v1/scheduler/status` | 调度器状态（管理员） |
| POST | `/api/v1/scheduler/tick` | 立即执行一轮调度扫描（管理员） |
| GET | `/api/v1/notifications` | 我的推送记录 |
| GET | `/api/v1/notifications/stats` | 推送状态统计 |

> 匹配与推送实现在 `notifications/`：匹配引擎是**纯函数**（关键词 OR/AND + 城市 + 学历，
> 按 0.55×关键词命中率 + 0.25×城市权重 + 0.20×置信度评分）；
> 推送记录表对 `(subscription_id, job_id)` 建唯一约束保证**幂等**。
> 渠道语义：`email` 渲染后排队（`pending`，由发信器消费）；`wechat` / `webhook` 直接 POST 到
> `webhook_url`（`sent` / `failed`）。`channel` 为后两者时必须提供合法 http(s) 地址。

**定时执行（`scheduler/`）**

订阅可配 `schedule` 表达式，由调度器按周期自动跑匹配与推送：

| 表达式 | 语义 |
|---|---|
| `''` | 不自动执行（默认，仅手动） |
| `hourly` | 每小时整点 |
| `daily@HH:MM` | 每天 HH:MM（东八区，`SCHEDULER_TZ_OFFSET` 可调） |
| `weekly@MO,WE,FR@HH:MM` | 每周指定星期几（`SU MO TU WE TH FR SA`） |
| `every:Nm` / `every:Nh` | 每 N 分钟（1..1440）/ 每 N 小时（1..168） |

> 表达式解析与下次执行时间计算是**纯函数**（`common/schedule.ts`，零第三方依赖、不读时钟）。
> 调度器每 `SCHEDULER_INTERVAL_MS`（默认 60s）tick 一次，用 SQL 直查「启用中 + 有表达式 +
> `next_run_at` 到点」的订阅（走 `idx_subscriptions_due` 索引）。
> **失败也会推进 `next_run_at`**，避免上游不可用时形成热循环；单条失败不影响同轮其它订阅；
> 上一轮未结束时本轮直接跳过（单飞）。订阅对象新增 `schedule` / `schedule_text` / `next_run_at` 三个字段。

**分布式调度（多实例部署）**

调度器是**进程内定时器**，但多实例共享同一数据库时不会重复推送：候选查询与执行之间由
`subscriptions.claimDue()` 用**单条条件 `UPDATE` 原子抢占**，只有抢到的实例才执行。

```sql
UPDATE subscriptions SET locked_at = ?, locked_by = ?
 WHERE id = ? AND enabled = 1 AND schedule <> ''
   AND (next_run_at = '' OR next_run_at <= ?)      -- 仍到期
   AND (locked_at = '' OR locked_at <= ?)          -- 无锁 或 锁已陈旧
```

一条语句同时完成三重判断，靠 SQLite 的写锁天然互斥，**不引入 Redis 等外部依赖**。
`locked_at` 早于 `SCHEDULER_LOCK_TTL_MS`（默认 5min）即视为陈旧——持有者崩溃后锁自动可被接管。
实例正常退出时（`onModuleDestroy`）会 `releaseInstanceLocks()` 清掉自己持有的锁，避免其它实例空等 TTL。

> `GET /api/v1/scheduler/status` 除逐轮快照 `last_result` 外，还暴露**累计计数器**
> `scanned_total / ran_total / failed_total / skipped_total` 与 `busy_ticks`。
> 多实例互斥的判定必须看累计值——`last_result` 只保留最近一轮，逐轮采样会漏掉「真正执行的那一轮」。

### 代理（统一入口）

| 方法 | 路径 | 转发目标 |
|---|---|---|
| GET | `/api/v1/jobs` | crawler-service `/jobs` |
| GET | `/api/v1/jobs/facets` | crawler-service `/jobs/facets` |
| GET | `/api/v1/jobs/export.csv` | crawler-service `/jobs/export.csv`（保留 UTF-8 BOM） |
| GET | `/api/v1/jobs/{id}` | crawler-service `/jobs/{id}` |
| POST | `/ext/v1/match-fields` | intelligence-service 字段匹配 |
| GET | `/ext/v1/dictionary` | intelligence-service 字段词典 |
| GET | `/api/v1/meta/services` | 上游服务健康聚合 |

> 上游不可用时返回 **503 + code 4002**，不影响网关自身可用性；`trace_id` 全链路透传。

### §4.2/§4.3 填写会话与日志（`ext/`，网关本地实现）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/ext/v1/fill-logs` | 批量上报字段级结果（只存哈希不存原文；无会话时自动建） |
| POST | `/ext/v1/sessions` | 创建填写会话 |
| PATCH | `/ext/v1/sessions/{id}` | 更新步骤/统计/状态（转移白名单） |
| GET | `/ext/v1/sessions/{id}` | 查询会话状态 + 最近日志（断点续填） |
| POST | `/ext/v1/sessions/{id}/block` | 标记验证码/风控阻断 |

> intelligence 是无状态匹配引擎，会话归属用户故落在网关（`JwtAuthGuard` 双凭证：
> 控制台 Bearer 与插件 `X-Ext-Token` 均可）；此前 proxy 的 fill-logs 转发因上游无此路由
> 而恒 404，现由本模块接管。会话按 `user_id` 隔离，越权一律 2001。

## 契约落地要点

| 契约约定（§9） | 落地方式 |
|---|---|
| 通用响应 | 全局拦截器统一封装 `{code, message, data, trace_id}`，异常过滤器兜底 |
| trace_id | 中间件分配；复用上游 `X-Trace-Id`；响应头回写 |
| 分页 | `page`（从 1 起）+ `size`（默认 20，上限 200） |
| 排序 | `sort=field:asc\|desc`，白名单校验防注入 |
| 幂等 | `Idempotency-Key` 头，24h 内同键返回首次结果 |
| 错误码 | 1001 参数 / 1002 未认证 / 1003 无权限 / 2001 不存在 / 4002 源失效 / 9001 合规 |
| 时间 | 一律 ISO 8601 |

## 目录

```
src/
├── main.ts                      入口（CORS、端口 8080）
├── app.module.ts                模块装配 + 全局中间件/拦截器/过滤器
├── health.controller.ts         健康检查（含上游状态）
├── common/
│   ├── biz-error.ts             业务错误码 + BizError
│   ├── envelope.interceptor.ts  响应统一封装
│   ├── all-exceptions.filter.ts 异常 → 契约响应
│   ├── trace.middleware.ts      trace_id 分配与透传
│   ├── idempotency.ts           幂等存储 + 拦截器
│   ├── pagination.ts            分页 / 排序解析
│   └── schedule.ts              ★ 调度表达式解析 / 下次执行时间 / 到期判定（纯函数）
├── db/
│   ├── database.service.ts      node:sqlite 封装 + 建表 + 院校种子数据 + 日志模式解析 + 只读自愈
│   └── database.module.ts       全局模块
├── auth/                        注册 / 登录 / 刷新 / 登出 + JWT 守卫
├── profile/                     用户资料（JSON Merge Patch）
├── documents/                   材料预签名 / 登记 / 简历解析
├── applications/                院校 / 申请 / 推荐人
├── subscriptions/               实习订阅（规则 CRUD）
├── notifications/               订阅匹配与推送（引擎 / 编排 / 接口）
├── scheduler/                   订阅定时调度（tick 编排 / 原子抢占 / 运维接口）
├── ext/                         填写会话与日志（契约 §4.2/§4.3，网关本地）
└── proxy/                       上游服务代理与归一化

test/
├── e2e.js                       契约与降级（313 项，零外部依赖）
├── integration_live.js          三服务联调（75 项，需服务在跑）
└── multi_instance_live.js       多实例调度互斥（16 项，真实双进程 + 共享 SQLite）
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8080` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `JWT_SECRET` | `dev-secret-change-me` | JWT 密钥（**生产必须替换**） |
| `DB_PATH` | `:memory:` | SQLite 文件路径；留空为内存库 |
| `CRAWLER_BASE` | `http://localhost:8100` | crawler-service 地址 |
| `INTELLIGENCE_BASE` | `http://localhost:8090` | intelligence-service 地址 |
| `PROXY_TIMEOUT_MS` | `15000` | 上游请求超时 |
| `SCHEDULER_ENABLED` | `1` | 设为 `0` 关闭订阅定时调度 |
| `SCHEDULER_INTERVAL_MS` | `60000` | 调度扫描间隔（夹在 5s ~ 1h） |
| `SCHEDULER_TZ_OFFSET` | `480` | 调度时区偏移（分钟），默认东八区 |
| `SCHEDULER_INSTANCE_ID` | `hostname:pid:随机` | 实例标识；多实例部署**建议显式指定**，便于定位锁归属 |
| `SCHEDULER_LOCK_TTL_MS` | `300000` | 抢占锁 TTL（夹在 30s ~ 1h），超时视为持有者已崩溃 |
| `SQLITE_JOURNAL_MODE` | Windows `delete` / 其他 `wal` | SQLite 日志模式，可选 `wal/delete/truncate/persist/memory/off`（见下方「多实例部署注意」） |

### 多实例部署注意：Windows 下不要用 WAL

`node:sqlite` + `PRAGMA journal_mode = WAL` 在 **Windows** 上存在一个可复现的缺陷：
两个进程**同时**打开同一库文件时，可能有一方的连接被永久置为只读
（`SQLITE_READONLY`，`errcode 8`），此后该连接执行**任何**写语句都失败，
且**重试无效**（实测 0/5），必须关闭重开才能恢复。

实测（双进程各写 100 次、同时冷启动，各 6 轮）：

| 日志模式 | 结果 |
|---|---|
| `wal` | 6 轮中 3~4 轮出现一方 100/100 全失败；重试同语句 0/5 无效，**关闭重开 5/5 恢复** |
| `delete` | **6 轮 6 次零失败** |

因此本服务默认 **Windows → `delete`、其他平台 → `wal`**（`journal_mode` 是库文件的持久属性，
同一文件跨平台使用不会冲突）。同时 `DatabaseService` 内置了**只读自愈**：
`run()` 与初始化重试路径捕获到该故障时会自动关闭并重开连接再试一次，
事务进行中（`txDepth > 0`）则不做重开以免丢失未提交更改。

若确需在 Windows 上启用 WAL，设 `SQLITE_JOURNAL_MODE=wal` 即可——自愈会兜住冷启动竞争，
但会比 `delete` 多付出一次重连与语句重试的代价。

## 下一步

| 事项 | 说明 |
|---|---|
| 切换 PostgreSQL | DDL 已就绪：`db/migrations/0002_gateway_pg.sql`（网关运行时表 PG 化：users.role、新表 refresh_tokens/profiles/subscriptions/subscription_deliveries/documents/idempotency、存量四表补列+约束合并+回填，核查 `node db/tests/pg_migration_check.js` 32 项）；剩余把 `DatabaseService` 替换为 TypeORM/Prisma + 按 0002 §5 把 `claimDue` 改为 `SELECT … FOR UPDATE SKIP LOCKED`（空串时刻改 IS NULL）。**本机无 PG/Docker，驱动替换暂不可实测** |
| 对象存储切 S3/MinIO | 本地驱动已落地；S3 驱动为显式占位，需 `@aws-sdk/client-s3` 与 `STORAGE_S3_*` 凭据 |
| 简历解析升级 | 走 intelligence-service 的 LLM 解析替代启发式 |

> ✅ **分布式调度已落地**：多实例下同一订阅只被执行一次（DB 行级原子抢占 + 锁 TTL），
> 证据见 `test/multi_instance_live.js`（真实双进程）。仅当实例数很大、或需要跨地域调度时，
> 才建议换成外置 scheduler（如 Temporal / K8s CronJob + 租约）。

> ✅ **限流 / 管理后台 / 对象存储已落地**（详见下节）。

## 限流

全局拦截器 `common/rate-limit.ts`，注册在**最前**（被限流的请求不再消耗幂等记录或执行业务逻辑）。

- **滑动窗口**：记录窗口内命中时刻；被拒绝的命中**不写入**窗口，避免持续请求把窗口一直往后推（惩罚性延长）
- **规则按最长路径前缀匹配**，默认规则（`RATE_LIMIT_*` / `RATE_LIMIT_DEFAULT_LIMIT` 可覆盖）：

| 规则 | 前缀 | 限额 | 计数维度 |
|---|---|---|---|
| auth | `/api/v1/auth/` | 10 / 分钟 | IP（防暴力破解） |
| admin | `/api/v1/admin/` | 60 / 分钟 | 用户 |
| scheduler | `/api/v1/scheduler/` | 30 / 分钟 | 用户 |
| resume-parse | `/api/v1/resumes/parse` | 20 / 分钟 | 用户 |
| default | `/` | 300 / 分钟 | IP |

- 响应头：`X-RateLimit-Limit / -Remaining / -Reset`，超限追加 `Retry-After`，错误码 **4003**（HTTP 429）
- 豁免：`/health`、`/api/v1/meta/`；`RATE_LIMIT_ENABLED=0` 可整体关闭
- **单实例内存态**，多实例部署需换集中计数（Redis）

## 管理后台

`admin/` 模块，契约 §6.3，路径 `/api/v1/admin/*`，**全部限管理员**（非管理员一律 1003，不泄露上游信息）：

`GET|POST /sources`、`PATCH /sources/{id}`、`POST /sources/{id}/run`、`GET /sources/{id}/health`、
`GET|POST /degrade`、`POST /degrade/evaluate`、`GET /tasks`、`GET /adapters`、`POST /jobs/expire`（手动触发过期下架）。

纯代理到 crawler-service 的 `/admin/*`，上游不可用时按既有约定返回 503 + 4002。

**管理员来源**：部署期白名单 `ADMIN_EMAILS`（逗号/顿号/空格分隔，大小写不敏感），
命中者在**注册时**即赋 `role=admin`。不提供注册后自助升级（那等于把权限交给任意注册者）；
存量用户提升由运维直接改库。

## 对象存储

`documents/storage.ts`，驱动由 `STORAGE_DRIVER` 选择（默认 `local`）：

- **local**：落盘到 `STORAGE_DIR`（默认 `./storage`）。链路 `presign → PUT /api/v1/documents/upload/{key} → 登记 → GET /api/v1/documents/{id}/content → 删除联动清理`，端到端真实可用
- **s3**：显式占位，配置即**快速失败**（不做静默降级，否则会出现「登记了但文件不存在」的坏数据）
- **安全**：`file_key` 来自请求体，属不可信输入——`resolveObjectPath` 拒绝 `..`、绝对路径、空值与超长，解析后仍校验在根目录之内；写入前校验 key 归属当前用户（`u/{userId}/`），防止跨用户写文件
