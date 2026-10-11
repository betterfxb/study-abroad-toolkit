# 留学网申助手 · Chrome MV3 插件

模块一（海外研究生留学网申自动填写）的**执行端**。职责边界非常清楚：

> 采集网页表单字段 → 上报 intelligence-service 做语义匹配 → 把返回的填充指令**写进表单** → 校验 → 上报结果。
> **只填充，绝不提交；不绕过验证码；敏感字段本地优先。**

## 核心红线（硬性）

| 红线 | 落地方式 |
|---|---|
| **不自动提交** | 代码不点击任何「提交 / 下一步」按钮；`findAdvanceButtons()` 仅用于**提示**用户 |
| **不绕过验证码** | `detectBlockers()` 命中验证码/风控 → 进入 `BLOCKED`，暂停并提示人工 |
| **敏感字段不上云** | 护照姓名/号、成绩单等（`LOCAL_ONLY_FIELDS`）即便服务端返回自动填，插件侧也降级为「待复核」 |
| **不静默出错** | 状态机非法转移直接抛错；填充失败逐字段记录并上报 |

## 零构建设计

插件用**纯 ESM JavaScript**编写，**无需任何构建步骤**：

- 直接把 `apps/extension` 作为「已解压的扩展程序」加载进 Chrome 即可运行；
- 核心逻辑模块不访问全局 `document`，因此可用**最小 DOM 桩**在 Node 中零依赖测试；
- MV3 内容脚本不支持静态 ESM import，故内容脚本用 `chrome.runtime.getURL` + 动态 `import()` 引入核心模块（已在 `web_accessible_resources` 声明）。

> 后续若引入 TypeScript + Vite(CRXJS)，核心模块可原地迁移，无需改写逻辑。

## 安装与运行

```bash
# 1) 启动字段匹配服务
cd apps/intelligence
uvicorn app.main:app --port 8090

# 2) 加载插件
#   Chrome → chrome://extensions → 打开「开发者模式」
#   → 「加载已解压的扩展程序」→ 选择 apps/extension 目录

# 3) 打开任意网申页面，页面右下角出现浮窗 → 「扫描字段」→「一键填充」
```

点击插件图标打开 popup，可查看服务状态、修改服务地址。

## 测试

### 冒烟测试（零依赖，166 项）

```bash
cd apps/extension
node tests/smoke_test.js
```

覆盖：选择器生成 / 标签定位 / 选项采集 / 可填判定 / 字段提取（含 `maxlength` 缺省归一） / 填充计划（含文书超限降级） / 填充执行 / 校验 / 阻断检测 / 状态机 / API 客户端 / 平台识别 / **多步向导（步骤指纹·稳定窗口·文案识别）** / **源码契约与合规红线** / **本地断点续填**。
当前 **188 项全通过**（联调 31 项）。

### 端到端联调（需服务运行，31 项）

```bash
cd apps/intelligence && uvicorn app.main:app --port 8090   # 终端 A
cd apps/extension && node tests/integration_e2e.js          # 终端 B
```

伪造一个 ApplyWeb 风格表单页，走**真实**服务完成「提取 → 匹配 → 填充 → 校验」，并打印逐字段结果；末尾再验证**两步向导**的换步识别与第 2 步自动填充。

**实测结果**（15 字段）：

| 指标 | 值 |
|---|---|
| 字段提取 | 15 |
| 识别 | 14 / 15（93.3%） |
| 自动填充 | 13 |
| 填充失败 | 0 |
| 档案缺失 | 1（Postal Code，必填缺口已正确识别） |

值转换抽查全部正确：邮箱转小写、电话去分隔符、日期按 placeholder 格式化为 `01/15/2003`、性别/国籍/居住国下拉选中、GPA `88` → `3.7`、自定义题干 textarea **保持为空**。

**多步向导实测**：构造「第 1 步 · 个人信息（2 字段）→ 第 2 步 · 教育背景（3 字段）」两步页，URL 带易变参数 `_t` 也不误判；第 2 步被自动识别后重新走真实匹配，写入 3 个字段、0 失败（`Peking University` / `Computer Science` / `3.7`）。

## 目录

```
manifest.json                      MV3 清单
src/
├── shared/
│   ├── constants.js               状态机 / 消息类型 / 阈值 / 高亮类（与后端对齐）
│   └── config.js                  服务地址 + 平台识别
├── core/                          ★ 纯逻辑，Node 可测
│   ├── dom-utils.js               选择器生成 / 标签定位 / 可填判定
│   ├── field-extractor.js         DOM → FieldSpec[]
│   ├── planner.js                 指令分组 / 分级 / 统计
│   ├── filler.js                  指令 → DOM（含下拉选项匹配）
│   ├── validator.js               填充校验 / 必填缺口 / 阻断检测
│   ├── step-controller.js         状态机 IDLE→…→DONE
│   ├── step-watcher.js            ★ 多步向导：步骤指纹 + 稳定窗口判定换步
│   ├── session-store.js           ★ 本地断点续填：站点键 + TTL/上限 + 存取适配
│   └── api-client.js              调用 intelligence-service（fetch 可注入）
├── background/
│   └── service-worker.js          跨域请求转发 + 会话状态 + 步骤角标 + popup 消息路由
├── content/
│   ├── content-script.js          页面编排 + 浮窗 UI + 换步监听
│   └── panel.css                  浮窗样式（Shadow DOM 隔离）
└── popup/
    ├── popup.html / popup.css / popup.js   健康检查 / 扫描 / 填充 / 自动填充开关
tests/
├── fake-dom.js                    最小 DOM 桩
├── smoke_test.js                  冒烟测试（166 项）
└── integration_e2e.js             端到端联调（31 项）
```

## 状态机（架构详设 §3 关键设计点 1）

```
IDLE → SCANNING → FILLING → SAVING → NEXT_STEP → DONE
         │           │
         └───────────┴──→ BLOCKED（验证码/风控） / ERROR
```

`StepController` 严格校验转移合法性，非法转移抛错。`BLOCKED` / `ERROR` 可回到 `IDLE` 重试。

## 多步向导（`step-watcher.js`）

真实网申普遍 5~7 步。插件必须做到：**用户点「下一步」→ 自动识别新步骤 → 自动重新扫描填充**，而不是让用户每步手点一次「一键填充」。

| 机制 | 说明 |
|---|---|
| **步骤指纹** | `归一化 URL :: 字段签名哈希`。URL 捕捉路由式分步，字段签名捕捉同 URL 的 JS 分步，两者任一变化即视为换步 |
| **URL 归一化** | 剔除 `_` / `_t` / `ts` / `nonce` 等易变参数并排序，避免时间戳抖动误判换步 |
| **字段签名** | 优先 `label`（语义稳定），缺失回退 `name`/`id`，再回退 `type`；全部小写归一、排序后取前 40 项 |
| **稳定窗口** | 指纹需连续稳定 `STEP_STABLE_MS`（800ms）才确认换步，防止页面加载中的 DOM 抖动误触发 |
| **防重复** | `committed` 记录已确认指纹，相同指纹不再触发 |
| **步骤文案** | 识别 `Step 2 of 5` / `Page 3/7` / `2 of 5 steps` / `第 3 步` / `第 4 步，共 6 步`，用于 UI 显示「第 2 / 5 步」 |
| **触发源** | `MutationObserver`（防抖 300ms）+ URL 轮询（1s，兜底 SPA `pushState`）+ `popstate` / `hashchange` |

**安全门禁（重要）**：

1. 首次进入页面**只提示、不写数据**——必须由用户主动点一次「一键填充」（`session.armed`）。
2. 之后本会话内的新步骤才自动填充；`session.busy` 期间跳过，避免并发写表单。
3. 用户可在浮窗或 popup 关闭「进入新步骤自动填充」（偏好存 `chrome.storage.local`，两处开关同步）。
4. **绝不点击「下一步」或「提交」**——插件只观察、只填充；换步动作始终由用户完成。

`StepWatcher` 为纯逻辑（不访问 `document`、时钟通过 `now` 注入），因此稳定窗口、抖动抑制、防重复等行为可在 Node 中精确断言。

## 填充分级（与后端阈值一致）

| 置信度 | 动作 | 插件行为 |
|---|---|---|
| ≥ 0.90 | `fill` | 自动填入 + 加绿色标记 |
| 0.60 ~ 0.90 | `review` | 填入 + 加高亮，提示复核 |
| < 0.60 | `skip` | 不填 |

> 文书超限（指令带 `word_check.ok === false`）同样降级为 `review`（与敏感字段同理，
> 只降级、不截断，`word_check` 随指令透传）。`maxlength` 缺省（DOM `-1`）归一为 `null`。

> 插件会**按置信度重算动作**，不盲信服务端 `action`——避免两端版本不一致时越权自动填充。

## 平台识别

`detectSystemCode(url)` 按域名识别网申平台：`applyweb` / `liaison` / `slate` / `commonapp` / `gradcas`，未识别回退 `generic`。

## 接口依赖

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/ext/v1/match-fields` | 字段语义匹配（已实现） |
| GET | `/ext/v1/dictionary` | 词典版本核对（已实现） |
| POST | `/ext/v1/fill-logs` | 上报字段级结果 ✅ 已实现（网关本地；内容脚本 SAVING 态经 SW 自动上报，失败不阻断） |
| GET | `/health` | 服务健康检查 |

## 下一步

| 事项 | 说明 |
|---|---|
| 真实页面回归 | 用真实 ApplyWeb / Liaison / Slate 页面扩充样本，校准稳定窗口与指纹策略 |
| 断点续填（服务端同步） | 本地进度已闭环（`core/session-store.js`：站点键＋7 天 TTL＋20 条上限，恢复只提示不自动写）；服务端会话（网关 `/ext/v1/sessions`）待插件具备鉴权 Token 后同步 |
| 档案管理 UI | 目前档案通过 `chrome.storage.local` 注入，需接入 `/profile` 接口（同样待插件鉴权 Token UX） |
| TypeScript 迁移 | 视需要引入 Vite(CRXJS) 构建链 |
