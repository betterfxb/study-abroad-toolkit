# apps/console · 官网控制台

留学申请与实习求职工作站的**可见门面**：工具集首页、实习信息汇总、岗位订阅、申请进度、资料库。
视觉与交互对齐 `docs/02-详细设计/04-UI原型.html`，接口全部经由 `apps/api` 网关。

## 技术栈

| 项 | 选型 |
|---|---|
| 框架 | React 18.3 |
| 构建 | Vite 5.4 |
| 语言 | TypeScript 5.6（`strict`） |
| 样式 | UnoCSS 原子层（presetUno + 令牌 theme）+ 原生 CSS + 设计令牌（`src/styles/tokens.css`） |
| 端口 | 5173 |

> 说明：架构详设中控制台标注了 UnoCSS。**已接入 UnoCSS 作为共存原子层**——
> `uno.config.ts` 将 `tokens.css` 的设计令牌映射进 `theme`（`text-red-fg` / `rounded-lg` / `shadow-md` …），
> 关闭 preflight 以避免与 `global.css` 冲突；既有语义类（`.topbar` / `.card` / `.panel` / `.badge` / `.filters` …）保持不变。
> 新增样式优先用原子类；静态内联 `style={{}}` 改写为任意值语法（如 `mt-[14px]`），动态宽度（如进度条）保留内联。

## 快速开始

```bash
cd apps/console
npm install
npm run dev          # http://localhost:5173
```

开发期由 Vite 把 `/api` 与 `/ext` 代理到网关（默认 `http://localhost:8080`）：

```bash
GATEWAY_BASE=http://192.168.1.10:8080 npm run dev   # 覆盖网关地址
```

### 前置依赖

控制台本身不依赖数据库，但页面数据来自网关及其上游：

| 服务 | 端口 | 作用 |
|---|---|---|
| `apps/api`（网关） | 8080 | 鉴权、资料、申请、订阅、岗位代理 |
| `apps/crawler`（采集） | 8100 | 岗位库（Tab 2 数据源） |
| `apps/intelligence`（匹配） | 8090 | 简历解析、字段匹配 |

本机没有 Docker / PostgreSQL 时，可用 SQLite 起采集服务并灌入演示数据：

```bash
cd apps/crawler
DATABASE_URL="sqlite+aiosqlite:///./dev.db" python scripts/seed_dev.py
DATABASE_URL="sqlite+aiosqlite:///./dev.db" python -m uvicorn app.main:app --port 8100
```

网关只需构建后启动：

```bash
cd apps/api && npm install && npm run build && npm start
```

## 脚本

```bash
npm run dev         # 开发服务器
npm run build       # tsc --noEmit && vite build
npm run preview     # 预览生产构建
npm run typecheck   # 仅类型检查
npm test            # 冒烟 65 项 + 渲染 10 项（零依赖）
npm run test:live   # 真实联调 23 项（需先启动网关）
```

## 目录结构

```
src/
├── main.tsx                  # 挂载入口
├── App.tsx                   # 外壳：hash 路由 + 全局 Provider
├── lib/
│   ├── api.ts                # 网关客户端（通用响应 / 错误码 / 全部接口）
│   ├── auth.tsx              # 鉴权上下文：token 持久化 + 401 自动刷新（单飞）
│   ├── format.ts             # 状态映射 / 日期 / 薪资 / 查询串（纯函数）
│   └── tools.ts              # 工具集卡片与导航数据
├── components/
│   ├── Topbar.tsx            # 顶栏 + 上游服务健康指示灯
│   ├── HomeTab.tsx           # Tab 1 工具集首页（8 张卡片）
│   ├── JobsTab.tsx           # Tab 2 实习信息汇总（筛选 / 表格 / 详情 / CSV）
│   ├── SubscriptionsTab.tsx  # Tab 3 岗位订阅（规则 / 自动执行频率 / 预览 / 推送 / 记录）
│   ├── ApplyTab.tsx          # Tab 4 申请进度（申请 / 推荐信 / 院校库）
│   ├── ProfileTab.tsx        # Tab 5 资料库（资料 / 材料 / 简历解析）
│   ├── GpaTab.tsx            # Tab 6 成绩换算（GPA 4.0 / 英制等级换算器，纯本地）
│   ├── AuthModal.tsx         # 登录注册
│   └── Toasts.tsx            # 轻量提示
└── styles/
    ├── tokens.css            # 设计令牌（唯一视觉来源）
    └── global.css            # 全局样式与组件类
```

## 设计约定

- **改视觉先改 `tokens.css`**，组件里不写死颜色与圆角。
- 主色 `#2563EB`、辅色金 `#D4AF37`、卡片圆角 `16px`、布局宽度 `1120px`。
- 状态语义色：`gray` 草稿 / `blue` 进行中 / `orange` 临近 / `green` 通过 / `red` 异常。
- 插件（`apps/extension`）浮窗主色已统一为 `#2563EB`，与控制台保持一致。

## 鉴权与错误处理

- 登录后 token 存 `localStorage`（key `qz.auth`），刷新页面不丢登录态。
- 需要鉴权的请求统一走 `useAuth().authed(fn)`：命中 `code 1002` 时自动用
  `refresh_token` 换新 `access_token` 并重放原请求；并发 401 只触发一次刷新（单飞）。
- 业务错误码文案见 `api.ts` 的 `ERROR_TEXT`（1001 参数 / 1002 未认证 / 1003 无权限 /
  2001 不存在 / 3001 人机验证 / 4002 源失效 / 5001 AI 失败 / 9001 合规）。

## 合规红线

- 首页明示「**不自动提交 · 人工复核**」，系统不会代替用户提交任何申请。
- 推荐信仅做**登记与状态跟踪**，不代发邀请邮件，实际邀请由用户在院校系统内完成。
- 岗位数据保留来源（公众号名称 + 原文链接），支持一键跳转原文。

## 交互与易用性约定

这一节是本轮体验改造沉淀下来的**硬性约定**，新增列表页/表单时请照此办理：

| 维度 | 约定 |
|---|---|
| 列表请求 | 统一走 `lib/useRequest`：自增 seq 只认最后一次结果（防竞态）；失败保留上一次数据（防闪空）；区分「首屏加载」与「静默刷新」（静默刷新只降透明度，不整块消失） |
| 输入类筛选 | 统一 `useDebounced(value, 350)`，不允许把原始输入直接拼进 query（申请页曾每敲一个字发一次请求） |
| 翻页与筛选联动 | 筛选变化即回到第 1 页，用**渲染期同步修正**（`if (filterKey !== lastFilterKey) setPage(1)`），避免「旧 page + 新筛选」多打一轮无效请求 |
| 危险操作 | 删除等不可逆操作必须走 `ConfirmDialog` 二次确认 |
| 忙碌态 | 用「行 ID + 动作」复合键（`busyKey = ${id}:${action}`），**不要**只存行 ID——那会让一条记录在跑时锁住整张表 |
| 多值输入 | 关键词 / 城市按 `, ， 、 空格` 拆分（`format.ts` 的 `splitList`），并以**数组**提交；界面实时渲染 chips 让用户确认拆分结果 |
| 关键词高亮 | 同一份分隔符切词（`highlightParts`），命中词套 `mark.hl`（底色走 `--gold-bg` 令牌）；空关键词不断链 |
| 新手引导 | 首页一次性横幅（`GUIDE_KEY` 存 localStorage，关闭不再展示），三个动作落点明确 |
| 窄屏 | 弹窗锁高内部滚动、`.modal-f` / `.panel-title` / `.panel-actions` 换行；复制用 clipboard＋textarea 双方案 |
| 宽表格 | 面板开启 `overflow-x: auto`，窄屏横向滚动而非撑破页面 |
| 反馈 | 成功/失败都要有落点：toast 之外，错误态还要内联在面板里并给「重试」按钮 |

> **历史坑位**：网关 `toJsonArray` 原先用 `/[,，\s]+/` 拆分，**不含顿号**；
> 而界面提示与占位符示例写的正是顿号（"数据分析、SQL"），导致按提示输入会被整体当成
> **一个关键词**，订阅永远匹配不到岗位。现在网关与前端两侧都已覆盖顿号，并有回归测试守住。

## 测试

`npm test` 为**零依赖**测试，共 75 项：

**冒烟测试（71 项，`test/smoke_test.js`）** 分十层：

1. 设计令牌与样式契约（含「不得残留旧酒红主色」回归）
2. 纯逻辑行为（`format.ts` / `tools.ts`，借助 Node ≥22.18 原生类型擦除直接 `import`）
3. 源码结构契约（API 方法齐全、路由装配、鉴权包装、字段白名单）
4. 产品红线与跨应用视觉一致性
5. 订阅定时调度（预设频率全部符合网关调度语法、自定义表达式不被静默改写、下次执行时间展示）
6. 交互易用性改造（多值拆分支持顿号、删除二次确认、busy 按行隔离、防抖与竞态保护、响应式样式）
7. 成绩换算逻辑（`gpa.ts` 纯函数：阶梯映射 / 英制等级 / 加权计算 / 参照表单调性）
8. 在线表格能力（岗位表头点击排序 / 列显隐 / 就地筛选；进度表行内编辑进度与状态）
9. 从岗位一键建订阅（`jobSubscribe.ts` 纯函数预填规则 + 岗位详情按钮与鉴权拦截的源码契约）
10. 体验升级（`highlightParts` 纯函数 + 复制投递降级 + 新手引导 + 窄屏换行滚动的源码契约）

**渲染测试（11 项，`test/render_test.js`）**：用 esbuild 打包 `App.tsx` 后 `renderToString`，
验证六个 Tab 的组件树**真实渲染不抛错**，并断言 Hero / 8 张卡片 / 新手引导横幅 / 筛选器 / 未登录拦截 / 成绩换算页等关键文案。
比「编译通过」更进一步，能抓出运行时解引用与初始状态崩溃。

`npm run test:live` 为**真实 HTTP 联调**（23 项），覆盖岗位列表 / 聚合项 /
CSV BOM / 注册登录刷新 / 资料读写 / 申请创建 / 推荐人流转 / **订阅匹配与推送** / 未认证拦截。
订阅支持配置**自动执行频率**（`hourly` / `daily@09:00` / `weekly@MO,WE@FR@09:00` / `every:30m`），
列表展示「下次执行」时间；表达式由网关调度器解析，控制台只做选择与展示。
网关未启动时自动跳过，不会误报失败。
