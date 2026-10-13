# CLAUDE.md

> 项目记忆文件。本文件是**开发约定与注意事项的唯一速查入口**，详细设计另见 `docs/`。
> 开发产生结构、约定、命令或坑的变化时，**必须同步更新本文件**。

## 一、项目目标

AI 驱动的留学申请 + 实习求职工具集（产品形态参考 [求职方舟AI](https://www.qiuzhifangzhou.com/)）。

| 模块 | 一句话 | 状态 |
|---|---|---|
| 模块一 · 留学网申自动填写 | 浏览器插件识别海外院校表单、多步向导一键填充 | 引擎 + 插件已可用 |
| 模块二 · 实习信息自动爬取 | 多源聚合公众号/平台/官网，结构化去重后入库与订阅推送 | 全链路已闭环 |
| 官网 | 营销展示站（零构建静态，P0 首页 + P1 三产品页 + P1.5 内容丰富化 + P2 信任层 + P3 自动化） | 冒烟 48 项全绿 |

**合规红线（不可绕过）**：不破解验证码、**不自动提交**；采集仅公开信息、控制频次、署名来源、不整篇转载。

## 二、整体结构

```
apps/
  console/       React 控制台（产品门面）：首页 / 岗位 / 订阅 / 申请进度 / 成绩换算 / 资料库
  api/           NestJS 主网关：鉴权、Profile、材料、申请、订阅、调度、上游代理
  crawler/       FastAPI 采集服务（模块二）
  intelligence/  FastAPI 字段匹配引擎（模块一）
  extension/     Chrome MV3 插件（模块一执行端，零构建）
  twin/          储能充电站数字孪生独立站（React + three 程序化建模，5174 端口）
packages/field-dictionary/  跨端共享字段词典（54 语义槽位）
dashboard-prototype/  跨境电商数据大屏 HTML 原型（`index.html` + `server.js` 静态预览 8899）+ `ozon/` Seller API 接入框架（零依赖，凭据走 `.env`，已在根 gitignore）
db/             schema.sql + migrate.py + migrations/（0001_init.sql 建基表、0002_gateway_pg.sql 网关 PG 化）+ tests/pg_migration_check.js
deploy/         docker-compose.yml
docs/           规划 → 详设 → PoC 结论
```

## 三、技术栈与依赖

| 层 | 选型 | 备注 |
|---|---|---|
| 控制台 | React 18.3 + Vite 5.4 + TS 5.6 | UnoCSS 0.58 原子层 + 原生语义类共存；Ant Design 5 表单控件与弹层 |
| 孪生站 | React 18.3 + Vite 5.4 + `three` 0.186 | 独立应用 `apps/twin`（独立端口可独立部署，静态引入 three，主包约 +600KB） |
| 插件 | Chrome MV3 + 原生 ESM JS | **零构建**，直接加载目录即可运行 |
| 网关 | NestJS 11 + `node:sqlite` | 生产切换 PostgreSQL 时替换 `DatabaseService` |
| AI / 采集 | Python + FastAPI + Celery | 隔离环境见下 |
| 数据库 | PostgreSQL 16（生产）/ SQLite（本地与测试） | 本机**无 Docker、无 PG** |
| 对象存储 | S3 兼容（MinIO / 云 OSS） | 预签名目前为登记式，未接真实对象存储 |

**端口（固定，勿改）**：网关 8080 · intelligence 8090 · crawler 8100 · 控制台 5173 · 孪生站 5174（strictPort，防漂移）。

**运行时（隔离环境，勿污染全局）**
- Python：`C:/Users/19560/.workbuddy-ai/binaries/python/envs/default`（已装 fastapi / sqlalchemy / celery / pydantic / httpx / psycopg）
- Node：**v22.22.2**（受管版本；`node:sqlite` 与 TS 类型擦除都依赖它）

## 四、目录约定与编码规范

**通用**
- 纯逻辑与 IO 分离：规则/匹配/格式化/调度表达式一律写成**纯函数**，可被零依赖测试直接断言；IO 与落库集中在编排层。
- 时间一律 UTC `timestamptz`；写接口带 `Idempotency-Key`（网关 24h 幂等）。
- 表单/规则类功能，**界面提示文案必须与后端解析规则一致**（见「顿号」教训）。

**控制台（apps/console）**
- 设计令牌唯一来源 `src/styles/tokens.css`（主色 `#2563EB`、金 `#D4AF37`、圆角 16/10/8、内容宽 **1280**）。组件内**不写死颜色**。
- 样式两条腿：既有语义类（`.panel` `.btn` `.badge`…）不动；**新增样式优先用 UnoCSS 原子类**。像素值必须用任意值语法 `mt-[14px]`（≠ Tailwind 的 `mt-14`）；动态宽度（进度条 / 骨架屏百分比）保留内联。
- **表单控件与弹层统一用 Ant Design 5**（`ConfigProvider` 在 `App.tsx`：`locale=zhCN`、`colorPrimary:'#2563EB'`、`borderRadius:10`）。新表单一律 `Input/Select/DatePicker/Slider/Switch/Input.TextArea`，弹层用 `Modal`（footer 自带 `.btn` 按钮）；**禁止再写裸 `<input>/<select>/<textarea>` 与手写 `.modal-mask`**。Select 空值语义：保留显式 `value:''` 选项（如「全部城市」），不改查询行为。
- `global.css` **不得**写 `.filters input / .field input` 之类元素级规则——会命中 antd 内部节点；`.filters` 只保留 flex 布局。
- `virtual:uno.css` **只在 `main.tsx` 引入**（测试不打包 main，故零回归）。
- 需要鉴权的请求统一走 `useAuth().authed(fn)`（自动带 token、401 自动刷新并重放、单飞）。
- 列表页三件套：**防抖**（`useDebounced`）+ **竞态保护**（`useRequest`，seq 只认最后一次）+ **筛选变化渲染期回第 1 页**。
- 危险操作走 `ConfirmDialog`；忙碌态用**复合键** `${id}:${action}`，禁止「只存行 ID」（会锁整表）。
- Toast API 只有 `info / ok / err` 三个方法（**无** `success` / `error`）。
- 多值输入用 `splitList`（`,` `，` `、` 空格），提交**数组**而非字符串。

**孪生站（apps/twin，独立 Vite 应用）**
- `src/twin/layout.ts` / `twinStore.ts` 为纯逻辑（零依赖、`npm test` 单测），`ChargeScene.tsx` 为 IO 层（一切 DOM/WebGL 只在 `useEffect` 内）；`ChargeTwinTab.tsx` 为 HUD 层（样式见 `src/twin/twin.css` + UnoCSS 原子类）。
- 自带薄顶栏，无路由无鉴权；以后如需搬回控制台，只需把 `src/twin/` + `Toasts` 拷回并加一条导航。

**插件（apps/extension）**
- 核心模块不访问全局 `document`，以便 Node 中用最小 DOM 桩测试；MV3 内容脚本用 `chrome.runtime.getURL` + 动态 `import()`。
- 源码契约禁止出现 `.click(` / `.submit(` / `requestSubmit`——**绝不点击「下一步」或「提交」**。

**网关（apps/api）**
- 需鉴权路由统一 `@UseGuards(JwtAuthGuard)`；管理类接口额外校验 `user.role === 'admin'`（与 scheduler 一致，非管理员 1003 且不泄露上游是否存在）。
- 上游调用一律走 `ProxyService`（复用归一化、trace_id、超时与降级），不要自己 `fetch`。
- 限流规则集中在 `common/rate-limit.ts` 的 `defaultRateLimitRules()`；新增高成本端点（LLM、导出、批量）时补一条规则。
- 存储只依赖 `StorageDriver` 接口，新增驱动实现接口并在 `resolveStorageDriver` 注册。
- 环境变量：`ADMIN_EMAILS`（管理员白名单）、`RATE_LIMIT_ENABLED` / `RATE_LIMIT_DEFAULT_LIMIT`、`STORAGE_DRIVER`（local|s3）/ `STORAGE_DIR` / `STORAGE_PUBLIC_BASE`、`PROXY_TIMEOUT_MS`、`SCHEDULER_INTERVAL_MS`、`SQLITE_JOURNAL_MODE`。

**测试约定**
- 零第三方依赖，能 `node xxx.js` / `python xxx.py` 直接跑。
- 测 TS 纯逻辑：Node ≥22.6 类型擦除，直接 `await import('./x.ts')`，无需构建。
- 渲染冒烟：esbuild 打包 `App.tsx`（`external: react`、`.css` → `empty` loader）+ DOM 桩 + `renderToString`。**只打包 `App.tsx`，从不打包 `main.tsx`**。

## 五、常用命令

```bash
# 控制台
cd apps/console && npm install
npm run dev           # 5173
npm run build         # tsc --noEmit + vite build
npm test              # 冒烟 + 渲染

# 孪生站（独立）
cd apps/twin && npm install
npm run dev           # 5174（strictPort）
npm run build         # tsc --noEmit + vite build
npm test              # 7 项：孪生纯逻辑 + 外壳装配

# 网关
cd apps/api && npm install
npm run build && npm start
npm test                        # 382 项：契约/降级/调度/分布式抢占/限流/管理后台/对象存储/岗位匹配评分
node test/integration_live.js   # 80 项（需先起 crawler/intelligence）
node test/multi_instance_live.js# 16 项（真实双进程调度互斥）

# 采集（无 Docker 时）
cd apps/crawler
DATABASE_URL="sqlite+aiosqlite:///./dev.db" python scripts/seed_dev.py
DATABASE_URL="sqlite+aiosqlite:///./dev.db" python -m uvicorn app.main:app --port 8100

# 回归测试（零第三方依赖）
python apps/crawler/tests/smoke_test.py        # 95
python apps/crawler/tests/e2e_jobs_test.py     # 44
python apps/intelligence/tests/smoke_test.py   # 89
node   apps/extension/tests/smoke_test.js      # 254
node   apps/console/test/smoke_test.js         # 80
node   apps/console/test/render_test.js        # 11
node   apps/site/test/smoke.mjs                # 48（官网 11 页 + 动效 + 内容构件 + SEO/红线/断链 + P3 自动化）
node   apps/twin/test/smoke_twin.js            # 7（孪生纯逻辑 + 外壳装配）
node   dashboard-prototype/ozon/test.js        # 17（Ozon 接入：config/client/adapter 纯逻辑 + mock fetch）
node   dashboard-prototype/ozon/probe.js       # 凭据连通自检（`.env` 缺 Client-Id 时 exit 2 并打印补齐步骤）
```

## 六、关键决策

1. **网关持久层用 `node:sqlite`**（`--experimental-sqlite`）：零原生依赖，避免 better-sqlite3 在 Windows 需编译工具链；生产切 PG 只换 `DatabaseService`。
2. **插件零构建原生 ESM**：直接加载目录即可运行，核心模块可在 Node 中零依赖测试；后续需 TS 可原地迁移。
3. **样式先落地原生 CSS + 令牌，再接 UnoCSS 共存**：类名与原型逐一同名，接原子层时组件不动。UnoCSS 锁 **0.58.9**（最新 66.x 需 Vite 6/7，本项目 Vite 5.4）。
4. **匹配/抽取混合策略**：规则全量初筛（零成本），低置信度触发 LLM，LLM 不可用自动降级。
5. **订阅推送去重落在数据库唯一约束** `(subscription_id, job_id)`，不能只靠应用层查询（并发会漏）。
6. **调度器失败也必须推进 `next_run_at`**，否则坏数据造成无限重试热循环；多实例靠 DB 行级原子抢占 + 锁 TTL。
7. **合规硬约束**写进 `system_configs.compliance.no_autosubmit`（不可关闭）；插件敏感字段本地优先不上云。
8. **限流为滑动窗口且被拒绝的命中不写入窗口**，否则持续请求会把窗口不断后推，客户端永远等不到恢复。单实例内存态，多实例需换 Redis 集中计数。
9. **管理员来自部署期白名单 `ADMIN_EMAILS`**（注册时赋 `role=admin`），**不提供注册后自助升级**——那等于把权限交给任意注册者。
10. **对象存储 S3 驱动做成显式占位并快速失败**，不做静默降级：否则会出现「登记了但文件不存在」的坏数据。

## 七、已知注意事项（踩过的坑，勿重犯）

**Windows / 环境**
- `node:sqlite` + WAL 在 Windows 多进程打开会让一方连接**永久只读**，重试无效、必须重开连接。故 Windows 默认 `journal_mode=delete`，非 Windows 用 `wal`（`SQLITE_JOURNAL_MODE` 可覆盖），并内置只读自愈。
- 本机 **8080 常被环境代理拦截**：curl 需 `--noproxy '*'`。
- **联调前先确认端口上的进程是本轮构建**（曾因旧进程残留导致「字段不存在」的假象）。
- **会话默认 `node` 是 nvm v20.5.0**：跑 TS 类型擦除 / `node:sqlite` 必须用受管 Node22 绝对路径（`C:\Users\19560\.workbuddy-ai\binaries\node\versions\22.22.2-3\node.exe`）；`npm test` 会取 PATH 的 node 而失败，直接调 node22。Python 同理用 `binaries\python\envs\default\Scripts\python.exe`。
- Windows 时钟粒度约 15ms：用时间戳做 Map 键需带上实例标识。
- **PowerShell 5.1 给 curl.exe 传 JSON body 引号会被吃**（单引号包裹也丢引号），Ozon 报 `code 3 invalid character`；必须写临时文件后 `--data @file`。
- **Ozon Seller API 要求双头 `Client-Id`（正整数）+ `Api-Key`（UUID）**：缺 Client-Id 时服务端在校验 Api-Key 之前就 400，无法单独验证密钥有效性；两件凭据缺一不可。

**框架**
- NestJS 11 默认 Express 5：中间件路由 `'*'` 失效，必须写 `'{*splat}'`。
- Nest DI：`DatabaseService` 构造函数不能带「有默认值的普通参数」，否则报 `UnknownDependenciesException`。
- FastAPI 0.143 的 `app.routes` 不再平铺子路由：核对路由请用 `app.openapi()['paths']`。
- `urllib.robotparser` 未调 `modified()`/`parse()` 时 `can_fetch` 恒 False。
- Vite：`tsconfig.node.json` 不能同时 `composite: true` 与 `noEmit: true`（TS6310）。
- **Express 5 / path-to-regexp v8 的裸 `*` 通配符已失效**，不只是中间件（`'{*splat}'`），**路由参数同样**：`@Put('x/upload/*')` 匹配不到多段路径，必须写 `@Put('x/upload/{*splat}')`，再取 `req.params.splat`（可能是数组，需 `join('/')`）。
- **JS 默认参数对显式 `undefined` 也生效**：`f(x, undefined)` 会用默认值而非 undefined。测试「未配置」分支要用 `''` 或 `null`，不能用 `undefined`。
- **TS 参数属性（`constructor(private x: T)`）不被 Node strip-only 支持**：纯逻辑文件一律显式字段赋值（控制台 `ApiError` 已改）。
- **岗位专业维度不能整串包含**：`major_req` 先 `splitList` 拆顿号/逗号多值，再剥「优先」与「相关专业」类后缀（真实数据出现过 `金融、数学、计算机`）；「专业优先」按 neutral 处理。
- **DOM 缺省 `maxlength` 为 `-1`（= 无限制）**：提取端必须归一为 `null`，服务端非正限制一律视为未配置——否则全员误判超限（曾把插件自动填充从 13 打到 0）。
- **handlers 回退路径必须传全参**：`h_date` 脏输入回退曾漏传 `field` 致 TypeError（整条匹配 500），脏数据分支要有回归用例。
- **限流的窗口边界容易算错**：窗口是 `[at-windowMs, at]`，判断「是否已滑过」要用**最后一次写入的命中时刻** + windowMs，不是第一次。
- **Nest 全局拦截器在 Guards 之后执行**：未认证请求会先被 401 拦下、不会计入限流；想保护登录接口（无守卫）是有效的，想限制未登录访问需改用中间件。
- **three ≥0.17x 废弃了 `THREE.Clock` 与 `PCFSoftShadowMap`**：计时用 `performance.now()` 手算，阴影用 `PCFShadowMap`——否则控制台刷 deprecation 警告。

**数据与算法**
- **中文 SimHash 阈值取 8**（英文常用 3 不适用）；短文不用 SimHash，用精确指纹。中文按字符 4-gram。
- `job_fingerprint` 入参城市须先 `normalize_city`（北京 vs 北京市否则指纹不同）。
- 单条坏数据会污染整批入库：用 SAVEPOINT 逐条隔离。
- 抽取标签匹配必须**行首锚定 + 紧跟分隔符**，否则「岗位职责：xxx」被误判成岗位字段。

**验证类**
- 验证 BOM 必须看**字节**（`arrayBuffer`），`fetch().text()` 会按规范剥离 BOM，测试端也会被剥。
- 验证「是否轮换」用随机值，**不要**用 JWT（秒级精度，同秒生成完全相同，测试随机失败）。
- 多实例互斥断言看**累计计数器**，`last_result` 这类快照有采样竞态。

**安全**
- 任何来自请求体的**路径**（对象 key、文件名）都必须做穿越防护：拒绝 `..`、绝对路径、空值、超长，解析后再校验仍在根目录之内。
- 资源归属校验放在**服务层**而非控制器：`file_key` 这类标识要校验它属于当前用户，否则登录用户可互相写文件。

**产品一致性**
- 插件浮窗主色曾为酒红 `#8b254a`，已统一为 `#2563eb`；控制台源码禁止出现该酒红。
- 合规红线测试会扫描「自动提交 / 一键提交 / 代提交」，但**否定语境**（前 4 字含「不/无/禁/杜/绝/免」）视为合规声明放行。新增文案需注意。

## 八、当前进度与阻塞

- 进度清单见 `README.md`「当前进度」，详细轮次记录见 `.workbuddy-ai/memory/`。
- **功能 B 岗位匹配度评分**已交付（`apps/api/src/match/` 五维加权纯函数 + `POST /api/v1/match/jobs`；控制台匹配度列 / 详情五因子 / 档案「期望工作城市」→ `preferences.preferred_cities`；订阅城市兜底、未登录 fail-open；e2e 332→382、控制台冒烟 71→77）。
- **长期阻塞项**：`LLM_API_KEY`（模块一第三级匹配 + 模块二 LLM 抽取对比）；公众号清单 / 三方数据服务凭据（模块二真实源基线）。
- PG 迁移 SQL（`db/migrations/0002_gateway_pg.sql`）已先行落地（环境无关），核查 `node db/tests/pg_migration_check.js`（32 项）；切库时改动面仅 `DatabaseService` 驱动 + `claimDue` 改 `SELECT … FOR UPDATE SKIP LOCKED`（空串时刻改 IS NULL），DDL 无需再动。
