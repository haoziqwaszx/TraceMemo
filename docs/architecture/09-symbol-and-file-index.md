# 09 · 全仓文件、符号、通道与配置总索引

> **源码基线**：Git commit `8f47dca`（`package.json` `v2.7.0`，`pnpm@7.33.7`，Node `22`）  
> **相关文档**：[知识库总览](./README.md) · [系统架构总览](./01-system-overview.md) · [主进程与数据访问](./02-main-process-and-data.md) · [知识库与 AI 检索](./03-knowledge-and-ai-pipeline.md) · [报告、自动化与 Hub](./04-reports-automation-hub.md) · [Local HTTP 与扩展](./05-http-api-and-extensions.md) · [渲染层与 IPC 契约](./06-renderer-and-ipc.md) · [构建脚本与打包](./07-build-scripts-and-packaging.md) · [测试体系与门禁](./08-testing-and-quality-gates.md)

本索引汇总 TraceMemo 全仓一级/二级目录文件分布、核心导出符号定义位置、主进程 `ipcMain` 与推送通道、Local HTTP API / Share Card Worker / `tm-wechat-host` 端点、55+ 个关键环境变量，以及本次源码梳理实证的细节偏差与基线同步/修复状态，供维护者与外部 AI 按图索骥直达源码。

---

## 一、架构总览：全仓一级 / 二级目录地图与实证文件数

> **计数口径**：排除 `.git/` 与 `node_modules/`（本地纯净工作区不含 `out/`）；同时区分磁盘实际文件数与 `git ls-files` 跟踪数（含知识库文档及本地生成产物）。

| 一级 / 二级目录 | 磁盘文件数 | Git 跟踪数 | 三级子目录与核心内容构成 |
|---|---:|---:|---|
| **根目录配置文件** | **30** | **29** | `package.json`、`electron.vite.config.ts`、`electron-builder{,.win,.send-runtime}.yml`、`tsconfig*.json`（4）、`vitest.*.config.ts`（4）、`playwright.config.ts`、`eslint.config.mjs`、`.gitignore`、`create_tag.sh`、`index.js`（遗留）、`index.html`（遗留）、`AGENTS.md`（已解除 `.gitignore` 忽略）等 |
| `src/` | **524** | **524** | 含根文件 `src/env.d.ts`（1）及以下 4 大子目录 |
| ├─ `src/main/` | **174** | **174** | 根级 `45` + `src/main/db/`（`1`）+ `src/main/extensions/`（`21`）+ `src/main/knowledge/`（`9`）+ `src/main/services/`（`81`，含 `src/main/services/wechat-ilink/` `13` + 服务根级 `68`）+ `src/main/voice-pipeline/`（`17`） |
| ├─ `src/preload/` | **2** | **2** | `src/preload/index.ts`（827 行）与 `src/preload/index.d.ts`（904 行） |
| ├─ `src/shared/` | **75** | **75** | 根级 `61` + `src/shared/agent-api/`（`4`）+ `src/shared/extensions/`（`10`） |
| └─ `src/renderer/` | **272** | **272** | `src/renderer/index.html`（1）+ `src/renderer/src/`（`271`：根级 `3` + `assets/` `3` + `components/` `119` + `features/` `105` + `hooks/` `2` + `lib/` `1` + `styles/` `26` + `types/` `1` + `utils/` `11`） |
| `packages/` | **3** | **3** | 仅 `packages/extension-sdk/`（`3`：`package.json`、`index.d.ts`、`README.md`） |
| `scripts/` | **21** | **20** | 20 个已跟踪脚本 + 新增 `scripts/check-knowledge-base.mjs`（完整清单见 [07-build-scripts-and-packaging.md](./07-build-scripts-and-packaging.md)） |
| `services/` | **6** | **6** | 仅 `services/share-card-worker/`（`6`：`package.json`、`README.md`、`wrangler.jsonc`、`wrangler.verify.jsonc`、`services/share-card-worker/src/index.js`、`services/share-card-worker/test/index.test.js`） |
| `examples/` | **29** | **29** | 根级 `1`（`report-template-basic.zip`）+ `examples/extensions/`（`25`：3 套扩展示例 + `template-lock.json`）+ `examples/report-template-basic/`（`3`） |
| `tests/` | **300** | **300** | `tests/typecheck-baseline.json`（`1`）+ `tests/unit/`（`162`）+ `tests/component/`（`76`，含 `support/` 2）+ `tests/integration/`（`36`）+ `tests/e2e/`（`12`，含 8 spec + 2 support + 2 截图）+ `tests/benchmark/`（`3`）+ `tests/smoke/`（`1`）+ `tests/fixtures/`（`8`）+ `tests/setup/`（`1`） |
| `resources/` | **28** | **28** | 根级 `13` + `resources/key/`（`1`）+ `resources/macos/`（`2`）+ `resources/macos-key-tool/`（`1`）+ `resources/runtime/`（`4` Win DLL；`resources/runtime/darwin-arm64/` 被 `.gitignore:13` 忽略）+ `resources/wcdb/`（`7`） |
| `build/` | **9** | **5** | 根级 `5`（`app-update.yml`、`entitlements.mac.plist`、`icon.icns`、`icon.ico`、`icon.png`）+ `build/extension-templates/`（`4` 个 `.gitignore:42` 忽略的本地构建产物：`index.json` + 3 ZIP） |
| `docs/` | **56** | **46** | 根级 `2` + `docs/agent/`（`7`）+ `docs/architecture/`（`10`：`README.md` + `01`~`09`）+ `docs/concepts/`（`2`）+ `docs/deployment/`（`1`）+ `docs/development/`（`7`）+ `docs/extensions/`（`5`）+ `docs/platform/`（`1`）+ `docs/skill/`（`5`）+ `docs/user-guide/`（`16`） |
| `public/` | **15** | **15** | 15 张文档展示配图（全部受 Git 跟踪） |

---

## 二、模块职责与边界：IPC 通道、推送事件与 HTTP 端点总表

### 2.1 `ipcMain` 通道分布（主应用 241 条 = 240 `handle` + 1 `on`）

主应用进程共有 **241 条 `ipcMain` 注册入口**，与 `src/preload/index.ts` 中 `240` 个 `ipcRenderer.invoke` **双向 100% 对齐**（仅 `ipcMain.on('ping')` 为模板遗留单向监听）：

1. **按源文件注册分布**：
   - `src/main/index.ts`：**203 条**（`202` 个 `ipcMain.handle` + `1` 个 `ipcMain.on('ping')` 位于 `src/main/index.ts:1509`）。
   - `src/main/report-template-ipc.ts`：**6 条** `ipcMain.handle`（`report-template:list`:12、`report-template:install`:13、`report-template:uninstall`:24、`report-template-market:list`:36、`report-template-market:install`:37、`report:export`:40）。
   - `src/main/extensions/extension-ipc.ts`：**32 条** `ipcMain.handle`（通过 `EXTENSION_IPC.*` 常量注册，见 `src/main/extensions/extension-ipc.ts:60-370`）。
2. **独立测试入口（不计入主应用 241）**：
   - `src/main/report-template-test-entry.ts:22-29` 注册了 **6 个** `ipcMain.handle`（`report:listGenerated`、`report:saveGenerated`、`report:updateGeneratedTemplate`、`report:prepareTemplateSwitch`、`report:deleteGenerated`、`report:exportSnapshot`）。这 6 个通道在主应用 `src/main/index.ts` 中同样有注册，该文件仅作日报模板隔离测试专用 Electron 入口。
3. **241 条通道按前缀分组计数**：
   - `extension:*` (32) · `automation:*` (20) · `db:*` (19) · `wechat-personal:*` (18) · `voice:*` (15) · `api:*` (15) · `image:*` (14) · `agent-hub:*` (11) · `ai:*` (10) · `key:*` (9) · `image-text-index:*` (9) · `report:*` (8) · `app-update:*` (7) · `group-exit-monitor:*` (7) · `tts:*` (6) · `settings:*` (5) · `knowledge:*` (4) · `ai-search:*` (4) · `export:*` (4) · `app-log:*` (3) · `cache:*` (3) · `ask-wechat:*` (3) · `wechat-share:*` (3) · `report-template:*` (3) · `report-template-market:*` (2) · `system-ocr:*` (2) · 无冒号通道 (2：`ping` `L1509`、`copy-image`) · `accounts:*` (1) · `group-stats:*` (1) · `wechat-action-log:*` (1)。**合计 = 241**（全量 `window.api` 方法签名对照表见 [06-renderer-and-ipc.md](./06-renderer-and-ipc.md)）。

### 2.2 17 条主动推送事件索引（20 处发送点 ↔ 17 个 Preload 监听）

| # | 推送通道名 | 投递方式 | 主进程发送文件与行号 | Preload 监听方法（`src/preload/index.ts`） |
|---:|---|---|---|---|
| 1 | `app-update:state` | `window.webContents.send`（广播） | `src/main/services/app-update-service.ts:280` | `onAppUpdateState` |
| 2 | `extension:changed` | `window.webContents.send`（广播） | `src/main/index.ts:1482`（`EXTENSION_IPC.changed`） | `onExtensionChanged` |
| 3 | `group-exit-monitor:state` | `window.webContents.send`（广播） | `src/main/services/group-exit-monitor-service.ts:909` | `onGroupExitMonitorState` |
| 4 | `ai-search:progress` | `event.sender.send`（定向发起窗口） | `src/main/index.ts:2749` | `onAiSearchProgress` |
| 5 | `ask-wechat:progress` | `event.sender.send`（定向发起窗口） | `src/main/index.ts:2776` | `onAskWechatProgress` |
| 6 | `knowledge:status` | `window.webContents.send`（广播） | `src/main/index.ts:1363` | `onKnowledgeStatus` |
| 7 | `voice:batchProgress` | `window.webContents.send`（广播） | `src/main/index.ts:2759` | `onVoiceBatchProgress` |
| 8 | `voice:modelProgress` | `window.webContents.send`（广播） | `src/main/index.ts:1373` | `onVoiceModelProgress` |
| 9 | `export:progress` | `win.webContents.send`（广播） | `src/main/export-service.ts:785,1645`（2 处） | `onExportProgress` |
| 10 | `wcdb-change` | `window.webContents.send`（广播） | `src/main/index.ts:1781,3433`（2 处） | `onWcdbChange` |
| 11 | `key:dbKeyStatus` | `event.sender.send`（定向发起窗口） | `src/main/index.ts:1884,1906`（2 处） | `onDbKeyStatus` |
| 12 | `key:imageKeyStatus` | `event.sender.send`（定向发起窗口） | `src/main/index.ts:2031` | `onImageKeyStatus` |
| 13 | `image-text-index:status` | `window.webContents.send`（广播） | `src/main/index.ts:1368` | `onImageTextIndexStatus` |
| 14 | `agent-hub:conversation` | `window.webContents.send`（广播） | `src/main/services/agent-hub-service.ts:1216` | `onAgentHubConversation` |
| 15 | `agent-hub:conversationsCleared` | `window.webContents.send`（广播） | `src/main/services/agent-hub-service.ts:1222` | `onAgentHubConversationsCleared` |
| 16 | `agent-hub:status` | `window.webContents.send`（广播） | `src/main/services/agent-hub-service.ts:1229` | `onAgentHubStatus` |
| 17 | `agent-hub:log` | `window.webContents.send`（广播） | `src/main/services/agent-hub-service.ts:1255` | `onAgentHubLog` |

> **小结**：共 **17 条**推送通道（**13 条** `webContents.send` 广播 + **4 条** `event.sender.send` 定向），与 `src/preload/index.ts` 的 `17` 个 `ipcRenderer.on` 及 `src/preload/index.d.ts` 的 `257` 个 `Window.api` 方法（`240 invoke + 17 on`）完全对应。

### 2.3 全仓 HTTP 端点索引

#### 1. Local HTTP API（`src/main/http-server.ts`，默认 `127.0.0.1:6131`，共 39 条路径模式 / 47 组方法+路径）

> **安全边界**：`src/main/http-server.ts:1407-1469` 依次执行 Loopback Origin CORS 校验、全局 `OPTIONS`（`204`）、`withMethods` 方法校验（405 附 `Allow` 头）、Bearer Token（SHA-256 + `crypto.timingSafeEqual`，仅 `GET /api/v1/health` 免鉴权）及 `MAX_JSON_BODY_BYTES = 1 MiB`（超限排空 socket 后返回 `413` + `Connection: close`）。详细参数与安全策略见 [05-http-api-and-extensions.md](./05-http-api-and-extensions.md)。

| 路由归属 / 构造器 | 路径模式 | 允许方法 | `http-server.ts` 行号 | 核心业务处理 |
|---|---|---|---|---|
| 静态 `routes` (`13`) | `/api/v1/health` | `GET`（**免鉴权**） | `L352` | 服务健康、`ready`、应用版本与 `skill.version` |
| 静态 `routes` | `/api/v1/skill/tracememo-reader` | `GET` | `L369` | 返回内置 `SKILL.md` Markdown 与 SHA-256 |
| 静态 `routes` | `/api/v1/current_time` | `GET` | `L386` | 本机 ISO 时间、时区、Unix 秒与 `localDate` |
| 静态 `routes` | `/api/v1/contact` | `GET` | `L398` | 异步水合联系人查询（`filter` / `type`） |
| 静态 `routes` | `/api/v1/chatroom` | `GET` | `L412` | 异步水合群聊检索（`keyword`） |
| 静态 `routes` | `/api/v1/recent_chat` | `GET` | `L429` | 最近会话列表（`limit`） |
| 静态 `routes` | `/api/v1/chatlog` | `GET` | `L436` | 异步时间分片聊天记录查询（含语音转写文本） |
| 静态 `routes` | `/api/v1/group_snapshot` | `GET` | `L486` | 群成员快照（`md5`） |
| 静态 `routes` | `/api/v1/resolve` | `GET` | `L495` | 联系人/群模糊解析为 `md5`（`q`） |
| 静态 `routes` | `/api/v1/report` | `POST` | `L504` | 导出现成群日报 JSON 为 HTML/PNG（禁用外部 `templateRef`） |
| 静态 `routes` | `/api/v1/agent/group-report` | `POST` | `L533` | 端到端 AI 生成群日报并导出 PNG（`src/main/services/agent-group-report-service.ts`） |
| 静态 `routes` | `/api/v1/agent/status` | `GET` | `L549` | Agent Hub 连接器与数据 API 状态 |
| 静态 `routes` | `/api/v1/agent/send` | `POST` | `L561` | 经 Agent Hub（iLink）测试发送消息/媒体 |
| `createWechatSendRoute` (`1`) | `/api/v1/wechat/send` | `POST` | `L798` | 经 `WechatActionGateway` 个人微信发送（`text`/`image`/`voice`/`file`、群聊 `at` ≤ 50 人） |
| `createScheduledReportRoute` (`8`) | `/api/v1/wechat-personal/send-capability` | `GET` | `L957` | 个人微信发送能力探测 |
| `createScheduledReportRoute` | `/api/v1/scheduled-reports` | `GET`, `POST` | `L968` | 列出 / 创建定时日报任务 |
| `createScheduledReportRoute` | `/api/v1/scheduled-reports/executions/:executionId/retry-send` | `POST` | `L988` | 重试发送失败的执行记录（当前返回 `501 not_supported`） |
| `createScheduledReportRoute` | `/api/v1/scheduled-reports/:taskId` | `GET`, `PATCH`, `DELETE` | `L1009-1045` | 查询 / 更新 / 删除单个定时日报任务 |
| `createScheduledReportRoute` | `/api/v1/scheduled-reports/:taskId/enable` | `POST` | `L1046` | 启用定时日报任务 |
| `createScheduledReportRoute` | `/api/v1/scheduled-reports/:taskId/disable` | `POST` | `L1050` | 禁用定时日报任务 |
| `createScheduledReportRoute` | `/api/v1/scheduled-reports/:taskId/run` | `POST` | `L1054` | 立即执行一次定时日报任务 |
| `createScheduledReportRoute` | `/api/v1/scheduled-reports/:taskId/executions` | `GET` | `L1059` | 获取定时日报执行历史 |
| `createQueryRoute` (`6`) | `/api/v1/query/capabilities` | `GET` | `L1086` | `LocalQueryApiService` 检索能力探测 |
| `createQueryRoute` | `/api/v1/query/messages` | `POST` | `L1098` | 结构化会话消息读取 |
| `createQueryRoute` | `/api/v1/query/search` | `POST` | `L1100` | FTS5 + OCR + 语音联合检索（支持 `206 retrieval_incomplete`） |
| `createQueryRoute` | `/api/v1/query/message-context` | `POST` | `L1102` | 按 `messageRef` 读取上下文窗口 |
| `createQueryRoute` | `/api/v1/query/conversation-overview` | `POST` | `L1104` | 会话统计概览 |
| `createQueryRoute` | `/api/v1/query/voice-transcribe` | `POST` | `L1106` | 按 `messageRef` 触发语音转写（队列忙返回 `429` + `Retry-After`） |
| `createMediaRoute` (`1`) | `/api/v1/media/:messageId` | `GET`, `HEAD` | `L1130` | 解密并返回单条图片二进制媒体或头部元信息 |
| `createAgentApiRoute` (`10`) | `/api/v1/capabilities` | `GET` | `L1237` | `LocalAgentApiService` 应用总能力矩阵 |
| `createAgentApiRoute` | `/api/v1/monitors/group-exits` | `GET`, `PATCH` | `L1245` | 获取 / 更新退群监控开关与监控群列表 |
| `createAgentApiRoute` | `/api/v1/monitors/group-exits/events` | `GET` | `L1260` | 分页/条件查询退群事件记录 |
| `createAgentApiRoute` | `/api/v1/groups/:conversationId/member-stats` | `GET` | `L1268` | 查询群成员发言统计 |
| `createAgentApiRoute` | `/api/v1/automations` | `GET`, `POST` | `L1288` | 列出 / 创建自动化规则 |
| `createAgentApiRoute` | `/api/v1/automations/validate` | `POST` | `L1308` | 校验自动化规则草稿结构 |
| `createAgentApiRoute` | `/api/v1/automations/executions` | `GET` | `L1316` | 查询自动化执行日志 |
| `createAgentApiRoute` | `/api/v1/automations/:id` | `GET`, `PATCH`, `DELETE` | `L1324-1364` | 获取 / 更新 / 删除单条自动化规则 |
| `createAgentApiRoute` | `/api/v1/automations/:id/enable` | `POST` | `L1338` | 启用自动化规则 |
| `createAgentApiRoute` | `/api/v1/automations/:id/disable` | `POST` | `L1338` | 禁用自动化规则 |

#### 2. Cloudflare Share Card Worker（`services/share-card-worker/src/index.js:253-296`，8 路由）

| 路由 | 方法 | 行号 | 作用说明 |
|---|---|---|---|
| `/<微信域名校验TXT文件名>` | `GET` | `L255` | 返回微信公众平台域名校验文本（`WECHAT_DOMAIN_VERIFICATION`） |
| `/health` | `GET` | `L265` | 服务健康与 R2 `REPORTS` 绑定就绪探测 |
| `/api/cards` | `POST` | `L275` | Bearer `UPLOAD_TOKEN` 鉴权，写入日报卡片 JSON 与图片至 R2 |
| `/api/wx-signature` | `GET` | `L276` | 生成微信 JS-SDK `appId` / `timestamp` / `nonceStr` / `signature` |
| `/s/:id` | `GET` | `L295` | 分享引导页 HTML（`sharePage`） |
| `/v/:id` | `GET` | `L295` | 完整日报查看页 HTML（`viewPage`，已修复为复用 `publicOrigin`） |
| `/l/:id` | `GET` | `L292` | `302` 重定向至 `${publicOrigin(request, env)}/v/${card.id}` |
| `/a/:id/(report\|thumbnail)` | `GET` | `L289` | 从 R2 输出高清日报 PNG 或缩略图（`serveAsset`） |

#### 3. macOS 原生发送宿主 `tm-wechat-host` 端点（`127.0.0.1:4290-4293`）

由 `src/main/services/mac-wechat-runtime-manager.ts:56-58` 托管端口（默认 `4290`，备用顺延 `PORT_FALLBACK_SPAN = 3` 至 `4293`），供主进程调用的本地 HTTP 接口如下：

| 端点 | 调用入口（精确行号） | 用途说明 |
|---|---|---|
| `GET /healthz` | `src/main/services/mac-wechat-runtime-manager.ts:755` | 探测发送守护进程存活状态 |
| `GET /license/status` | `src/main/services/mac-wechat-runtime-manager.ts:856`、`src/main/services/msg-insert-capability-service.ts:143` | 读取本地授权缓存状态（`8s` 超时） |
| `POST /license/refresh` | `src/main/services/mac-wechat-runtime-manager.ts:905` | 触发在线 challenge→sign→check 授权刷新（`20s` 超时） |
| `POST /bindWeChat` | `src/main/services/mac-wechat-runtime-manager.ts:1137` | 绑定当前微信账号上下文 |
| `POST /shutdown` | `src/main/services/mac-wechat-runtime-manager.ts:1214` | 优雅关闭 `tm-wechat-host`（`5s` 超时） |
| `POST /sendText` | `src/main/services/personal-wechat-send-service.ts:934` | macOS 原生通道发送文本消息 |
| `POST /sendImage` | `src/main/services/personal-wechat-send-service.ts:1149` | macOS 原生通道发送图片消息（`50s` 超时） |
| `POST /sendVoice` | `src/main/services/personal-wechat-send-service.ts:1247` | macOS 原生通道发送语音消息（`50s` 超时） |
| `POST /sendMsg` | `src/main/services/personal-wechat-send-service.ts:912,1076,1113,1217` | Windows/通用兼容消息发送与媒体分发路由 |

---

## 三、核心数据流与设计思路：已核实源码细节偏差、遗留点与基线修复状态

以下 8 项均在基线 `8f47dca` 源码中逐行核实，明确区分**现状遗留**与**已同步/修复项**：

1. **主进程服务反向引用渲染层（架构分层违例）**
   - **位置**：`src/main/services/agent-group-report-service.ts:14-22`
   - **事实**：主进程模块直接导入 `src/renderer/src/utils/group-report.ts` 的 `buildGroupReportInput`、`getSummaryDateRange`、`GROUP_REPORT_JSON_REPAIR_SYSTEM_PROMPT`、`GROUP_REPORT_SYSTEM_PROMPT`、`isInternalName`、`parseGroupDailyReport` 与 `SummaryDateRange`。
   - **维护边界**：目前 `src/renderer/src/utils/group-report.ts` 保持纯函数无 DOM 依赖才得以运行；长期应将上述纯提示词、输入构造与 JSON 解析器下沉至 `src/shared/`。

2. **`src/preload/index.d.ts` 两处类型漂移及 `06` 记录的其余 3 处偏差**
   - **偏差 A（`ParsedContent` 分叉缺分支）**：权威定义 `src/shared/types.ts:183-198` 包含 **15 种**联合分支（含 `ForwardBundleContent` 及 `ShareContent.articles`、`QuoteContent.quotedImageMd5`/`quotedImageDatName`、`SystemContent.raw`/`pat`/`recall`、`UnknownContent.messageType`）；而 `src/preload/index.d.ts:190-244` 独立手写了仅 **14 种**分支的旧版 `ParsedContent`，遗漏 `forwardBundle` 与上述扩展字段。
   - **偏差 B（`AppSettings` 内联手写漏字段）**：权威定义 `src/main/services/settings-store.ts:25-70` 包含 **23 个字段**；而 `src/preload/index.d.ts` 中 `autoGetImageKey` 返回体（`L580-601`）、`getSettings` 返回体（`L622-643`）与 `setSettings` 入参 `patch`（`L647-668`）均手写 **20 字段**，遗漏 `imageKeyFallbackDisabled`（`L33`）、`queryAgentEnabled`（`L51`）、`skippedUpdateVersion`（`L69`）；`setSettings` 返回体（`L670-688`）仅手写 **17 字段**，额外漏掉 `ttsSelectedVoiceId`、`ttsModel`、`reportImagePostfixText`。
   - **其余 3 处偏差**（详见 [06-renderer-and-ipc.md](./06-renderer-and-ipc.md)）：
     - `src/main/index.ts:1509` 遗留 `ipcMain.on('ping', () => console.log('pong'))`，未包装进 `window.api`。
     - `src/preload/index.ts:282-367` 仍手写 `'extension:*'` 字符串字面量（未引用 `src/shared/extensions/ipc.ts` 的 `EXTENSION_IPC`），且部分方法参数未显式标注类型。
     - `src/env.d.ts`（声明 `VITE_DEEPSEEK_API_KEY` 与 `VITE_SCHEDULED_REPORT_DEBUG`）仅被 `tsconfig.node.json` 包含而未被 `tsconfig.web.json` 包含；渲染层读取 `VITE_DB_KEY` / `VITE_FILTER_MSG_TYPES` 依赖 `src/renderer/src/env.d.ts`（`vite/client`）的宽索引。

3. **`listeningDegraded: true` 降级标志尚未接入前端 UI 消费**
   - **位置**：`src/shared/automation.ts:723` 定义 `AutomationStatusSummary.listeningDegraded: boolean`；`src/main/services/automation-service.ts:310`（注释明确要求“UI 必须如实告知，不允许把它包装成‘全局监听’”）与 `src/main/index.ts:2679`（数据库未就绪兜底）均返回 `listeningDegraded: true`。
   - **现状**：`src/renderer/src/features/automation/model/api.ts:37` 仅在离线默认对象 `UNAVAILABLE_STATUS` 中保留该字段，全 `src/renderer/` 无任何 UI 组件实际读取或展示该降级提示。

4. **`App.tsx` 未使用函数（死代码）**
   - **位置**：`src/renderer/src/App.tsx:191-234` 定义 `buildSyntheticGroupMessages`，并在 `src/renderer/src/App.tsx:236` 以 `void buildSyntheticGroupMessages` 显式抑制 TS/ESLint 未使用告警。
   - **核实**：同文件 `formatGroupMemberName`（`L188-189`）在 `L1057` 正常调用，`areMessagesEquivalent`（`L155`）在 `L1484` 正常调用，仅 `buildSyntheticGroupMessages` 为死代码。

5. **仓库根目录历史遗留 `index.js` 与 `index.html`**
   - **位置**：根目录 `index.js`（140 行，早期 CommonJS preload 快照）与 `index.html`（19 行，引用已不存在的静态哈希资源）。
   - **现状**：`package.json`（`"main": "./out/main/index.js"`）与 `electron.vite.config.ts` 均不引用它们，完全不参与现行编译或运行。

6. **扩展运行时与 `packages/extension-sdk/` 差异（部分已同步）**
   - **运行时保留行为**：
     - `src/main/extensions/host-runtime.ts:274-286` 在 `tm.automation.registerAction` 发送 `register-action` 消息时，仅传 `hasInputSchema: Boolean(definition.inputSchema)` 而未向主进程传递 `inputSchema` 对象本体。
     - `src/main/extensions/host-runtime.ts:123-126` 中 `tm.secrets.delete(key)` 执行 `await callHost('secrets.delete', { key })` 无 `return` 语句，运行期返回 `Promise<void>`（主进程 `src/main/extensions/extension-host.ts:760` 侧仍返布尔值）。
   - **已同步对齐**：`packages/extension-sdk/index.d.ts` 与 `packages/extension-sdk/README.md` 已补齐 `'secrets'` 权限、`TraceMemoActionFieldSchema`（含 `'integer'` 与约束字段）、`tm.page.onRequest`、`tm.secrets`（`delete` 类型与运行时对齐为 `Promise<void>`）、`contacts.listGroups` 与 `extension.request` 文档说明。

7. **`KnowledgeStore` 短词检索耗时累加归属偏差**
   - **位置**：`src/main/knowledge/knowledge-store.ts:501,648,662`
   - **事实**：`searchMeasured()` 声明了 `let shortTermSearchMs = 0`（`L501`）并在返回对象中返回 `shortTermSearchMs`（`L662`），但第 `648` 行将短词回退查询耗时累加进了 `ftsMs`（`ftsMs += Date.now() - shortTermStartedAt`），导致统计结果中 `shortTermSearchMs` 恒为 `0`。

8. **Share Card Worker `viewPage` Origin 回退缺陷（已修复）**
   - **位置**：`services/share-card-worker/src/index.js:179-180,295`
   - **修复状态**：原实现直接使用 `String(env.PUBLIC_ORIGIN).replace(/\/+$/, '')`，在未配置 `PUBLIC_ORIGIN` 时会渲染 `src="undefined/a/${card.id}/report"`。**现已修复**为 `viewPage(request, env, card)` 并复用 `publicOrigin(request, env)`，同步在 `services/share-card-worker/test/index.test.js` 增补单测覆盖。

---

## 四、关键文件与符号索引

### 4.1 主进程核心与基础设施（`src/main/` 根级及 `src/main/db/`）

| 文件路径 | 核心导出符号（含定义行号） | 职责说明 |
|---|---|---|
| `src/main/app-data-bootstrap.ts` | `LEGACY_MIGRATION_HELPER_ENV:5`, `LEGACY_MIGRATION_SOURCE_ENV:6`, `LEGACY_MIGRATION_USER_DATA_ENV:7`, `LEGACY_MIGRATION_RESULT_FD_ENV:8` | 主进程首条静态导入，锁定 `userData` 路径与迁移 Helper 环境变量 |
| `src/main/app-data-paths.ts` | `CURRENT_USER_DATA_NAME:6`, `TRACE_MEMO_RUNTIME_NAME:7`, `UserDataRoots:9`, `UserDataSelection:30` | `WechatExplorer` → `TraceMemo` 运行目录选择与隔离判定 |
| `src/main/app-data-migration.ts` | `assessMigration:129`, `migrateLegacyVoiceTranscripts:294`, `getAgentCredentialRoots:358` | 跨应用身份安全存储、设置与语音库迁移 |
| `src/main/legacy-safe-storage-helper.ts` | `decryptLegacySecrets:38`, `writeLegacySecretHelperResult:114`, `runLegacySafeStorageHelper:120` | 独立子进程解密旧版 `safeStorage` 凭据 |
| `src/main/preload-env.ts` | 环境变量注入副作用（`WCDB_RESOURCES_PATH:32`, `TRACEMEMO_PROJECT_NAME:33`） | 在 Electron 早期加载阶段注入 Windows DLL 搜索路径 |
| `src/main/app-logger.ts` | `class AppLogger:31`, `appLogger:85` | 主日志写入、5MB 轮转 `.1` 与目录打开 |
| `src/main/safe-log.ts` | `safeLog:17`, `safeWarn:18`, `safeError:19`, `installSafeConsole:21` | 全局 console 脱敏包装（`sk-*`、`Bearer`、64 位 hex Key） |
| `src/main/database-key-store.ts` | `isValidDatabaseKey:9`, `class DatabaseKeyStore:12` | `safeStorage` 加密存储分账号 DB 密钥 |
| `src/main/image-key-store.ts` | `StoredImageKeyEntry:5`, `class ImageKeyStore:23` | `safeStorage` 加密存储图片 XOR/AES 密钥 |
| `src/main/ai-provider-key-store.ts` | `class AIProviderKeyStore:10` | `safeStorage` 加密存储 AI 模型 API Key |
| `src/main/api-token-store.ts` | `class ApiTokenStore:21`, `apiTokenStore:148` | 本地 HTTP API 32B `base64url` Bearer Token 生成与存储 |
| `src/main/wcdb4-client.ts` | `Wcdb4Session:14`, `Wcdb4Message:29`, `WindowsNativePathBridgeOptions:51` | Koffi FFI 封装 `WCDB.dll` / `libWCDB.dylib`、Win NTFS Junction 桥（`L421`）与命名管道监听 |
| `src/main/wechat-db.ts` | `UserContact:4`, `WechatMessage:18`, `Contact:28`, `class WechatDb:60` | 面向业务的微信数据库查询封装 |
| `src/main/key-service-win.ts` | `class KeyService:29` | Windows 通过 `wx_key.dll` 提取微信 DB 与图片密钥 |
| `src/main/key-service-mac.ts` | `resolveXkeyHelperMode:32`, `buildAppleSiliconXkeyInvocation:40`, `parseXkeyHelperOutput:121`, `parseSipEnabled:142` | macOS ARM64/Intel 密钥提取与 SIP 检查 |
| `src/main/macos-arch.ts` | `getMacArchSnapshot:45`, `resetMacArchSnapshotCache:58` | macOS 硬件架构与 Rosetta 检测 |
| `src/main/native-runtime-paths.ts` | `hasMacNativeBundle:36`, `resolveWcdbLibrary:44`, `resolveWcdbConfigHelper:56`, `resolveWechatHost:63` | 统一解析 WCDB、Helper、发送运行时及 `tracememo-build.json` |
| `src/main/resource-paths.ts` | `getResourceRoots:9`, `getResourceCandidates:34`, `findResource:38` | 开发态 / 打包态 `resources/` 资源路径定位 |
| `src/main/image-decrypt-service.ts` | `resolveFfmpegExecutable:119`, `inspectImageDecoderStatus:173`, `class ImageDecryptService:474` | `worker_threads` 图片 AES-128-ECB/XOR 解密、WXGF 转码与磁盘缓存 |
| `src/main/message-parser.ts` | `ParsedContent:108`, `parseMessageContent:125`, `parseStickerMessageFromRow:388`, `parseImageDatNameFromRow:982`, `parseImageBufferDataUrlFromRow:1006` | 微信消息 XML/Protobuf/引用/合并转发（15 分支）解析 |
| `src/main/export-service.ts` | `HtmlExportArchive:84`, `mergeHtmlArchiveMessages:284`, `readHtmlArchive:337`, `writeHtmlArchive:468`, `runExport:1861` | 聊天记录增量 HTML/ZIP/TXT/JSON 导出 |
| `src/main/group-report-service.ts` | `detectImageMime:124`, `embedAvatar:215`, `extractGroupReportRenderSnapshot:799`, `exportGroupReport:1111`, `exportGroupReportSnapshot:1168` | 群日报 HTML 渲染、隐藏 `BrowserWindow` 截图 PNG 与安全过滤 |
| `src/main/report-template-service.ts` | `validateReportTemplateHtml:143`, `class ReportTemplateService:232`, `reportTemplateService:408` | 本地日报模板校验与安装 / 卸载 |
| `src/main/report-template-market-service.ts` | `class ReportTemplateMarketService:207`, `reportTemplateMarketService:243` | 社区日报模板目录拉取与安装 |
| `src/main/report-history-service.ts` | `listGeneratedReports:114`, `saveGeneratedReport:136`, `updateGeneratedReportTemplate:213`, `prepareGeneratedReportTemplateSwitch:283`, `deleteGeneratedReport:331` | 已生成日报历史持久化与切换模板 |
| `src/main/report-template-ipc.ts` | `registerReportTemplateIpc:9` | 注册 6 个日报/模板相关 `ipcMain.handle` |
| `src/main/http-server.ts` | `DEFAULT_HTTP_HOST:51`, `DEFAULT_HTTP_PORT:52`, `startHttpServer:1383`, `apiServer:1522` | `127.0.0.1:6131` 受 Bearer 鉴权与 CORS 校验的本地 HTTP API 服务 |
| `src/main/http-media-service.ts` | `HttpImageResult:6`, `class HttpMediaError:11`, `readImageMedia:48` | `/api/v1/media/:messageId` 图片读取与解码服务 |
| `src/main/db/image-insights-store.ts` | `imageInsightsStore:101` | 图片 AI 理解缓存表存储（7 天 TTL） |
| `src/main/wechat-share-card-service.ts` & `src/main/wechat-share-config-store.ts` | `class WechatShareCardService:12`、`class WechatShareConfigStore:24` | 实验性微信日报分享卡片上传与 Worker 配置存储 |

### 4.2 知识库、语音、AI 搜索与核心业务服务（`src/main/knowledge/`、`src/main/voice-pipeline/`、`src/main/services/`）

| 文件路径 | 核心导出符号（含定义行号） | 职责说明 |
|---|---|---|
| `src/main/knowledge/knowledge-service.ts` | `class KnowledgeService:18` | 派生 SQLite FTS5 知识库索引编排与增量更新 |
| `src/main/knowledge/knowledge-store.ts` | `knowledgeAccountKey:91`, `getKnowledgeDatabasePath:95`, `class KnowledgeStore:141`, `estimateKnowledgeCapacityPreflight:1578` | `node:sqlite` FTS5 存储与百万级容量预检 |
| `src/main/knowledge/knowledge-search-service.ts` | `class KnowledgeSearchService:259` | 面向检索与状态查询的统一门面 |
| `src/main/knowledge/knowledge-worker-host.ts` | `class KnowledgeWorkerHost:39` | `ELECTRON_RUN_AS_NODE=1` fork 宿主（支持取消） |
| `src/main/knowledge/chunker.ts`、`src/main/knowledge/normalizer.ts`、`src/main/knowledge/message-identity.ts` | `chunkConversation:51`、`normalizeKnowledgeMessage:17`、`sourceMessageId:20` | 会话分块、消息归一化与稳定消息身份 |
| `src/main/voice-pipeline/voice-pipeline.ts` | `class VoiceSourceResolver:13`, `class VoicePipeline:28` | 语音解码 → 重采样 → 识别全链路编排 |
| `src/main/voice-pipeline/recognition-host.ts` | `class RecognitionHost:23`, `class WorkerSpeechRecognizer:148` | SenseVoice 独立子进程宿主（空闲 60s 退出） |
| `src/main/voice-pipeline/sensevoice-recognizer.ts` | `class SenseVoiceRecognizer:24` | `sherpa-onnx-node` SenseVoice ONNX 推理封装 |
| `src/main/voice-pipeline/voice-batch-service.ts` | `class VoiceBatchService:65` | 批量语音转写任务调度与进度推送 |
| `src/main/voice-pipeline/voice-transcription-gateway.ts` | `VOICE_TRANSCRIBE_MAX_IN_FLIGHT:11`, `class VoiceTranscriptionGateway:34` | 并发限流保护的统一语音转写网关 |
| `src/main/services/image-text-index-service.ts` | `isImageMessage:290`, `class ImageTextIndexService:294`, `imageTextIndexService:2146` | `@napi-rs/system-ocr` 图片文字索引服务与 SQLite 存储 |
| `src/main/services/image-insight-service.ts` | `ImageCandidateInput:37`, `imageInsightService:348` | Vision 模型图片理解与 7 天缓存复用 |
| `src/main/services/ai-provider-service.ts` | `class AIProviderRequestError:85`, `class AIProviderService:121` | 多 AI Provider 管理、对话与 Vision/模型探测 |
| `src/main/services/ai-search-pipeline-service.ts` | `isSuspiciousLocalPlan:68`, `class AiSearchPipelineService:206` | Legacy AI Search 检索管线与引用校验 |
| `src/main/services/query-agent-service.ts` | `QueryAgentProvider:65`, `QueryAgentToolResult:92`, `QueryAgentTraceItem:97` | Query Agent 主检索与问答引擎 |
| `src/main/services/ask-wechat-service.ts` | `class AskWechatService:55` | 桌面「问问微信」统一入口，支持 Query Agent 与 Legacy 自动回退 |
| `src/main/services/local-query-api-service.ts` | `buildImageOcrCoverage:164`, `class LocalQueryApiService:371`, `selectTemporalCoverageEvidence:1036` | `/api/v1/query/*` 6 个底层结构化查询端点实现 |
| `src/main/services/local-agent-api-service.ts` | `class LocalAgentApiError:63`, `class LocalAgentApiService:178` | `/api/v1/capabilities`、自动化与退群监控 Agent API 实现 |
| `src/main/services/scheduled-report-api-service.ts` | `class ScheduledReportApiError:37`, `class ScheduledReportApiService:67` | `/api/v1/scheduled-reports*` REST API 实现 |
| `src/main/services/scheduled-report-service.ts` | `validateScheduleTime:127`, `resolveDueScheduledSlot:137`, `class ScheduledReportService:146` | 定时日报调度器与执行链路 |
| `src/main/services/agent-group-report-service.ts` | `hydrateGroupMemberIdentity:40`, `generateAgentGroupReport:97` | Agent 触发一键群日报生成 |
| `src/main/services/group-exit-monitor-service.ts` | `GroupExitEventHandler:79`, `groupExitMonitorService:1128` | 退群监控快照对比、事件持久化与状态广播 |
| `src/main/services/group-stats-service.ts` | `class GroupStatsService:41` | 群成员活跃度与发言统计（7 天/30 天窗口） |
| `src/main/services/automation-service.ts` | `leaveNotificationExecutionId:105`, `scheduledReportExecutionId:132`, `class AutomationService:155` | 自动化引擎（4 层闸门、防回环、退群通知与触发分发） |
| `src/main/services/automation-rule-store.ts` & `src/main/services/automation-action-runner.ts` | `class AutomationRuleStore:216`, `automationRuleStore:676`, `class AutomationActionRunner:295` | 自动化规则持久化与动作链执行器 |
| `src/main/services/wechat-action-gateway.ts` | `AUTOMATION_SEND_INTERVAL_MS:24`, `WechatActionGatewayDependencies:64` | 所有个人微信发送动作的统一安全网关（限流/授权/幂等/审计） |
| `src/main/services/wechat-send-gateway.ts` | `class WechatSendGateway:58`, `unifiedToPersonalRequest:303` | 双通道（iLink + 个人微信）发送网关 |
| `src/main/services/agent-hub-service.ts` | `AgentHubWechatConnectorPort:62`, `class AgentHubService:182` | Agent Hub 连接器托管、入站路由与状态日志广播 |
| `src/main/services/wechat-ilink/index.ts` | `WechatConnectorHost:35`, `WechatConnectorServiceOptions:43`, `ConnectorSendTextInput:64` | 微信 iLink 协议连接器（QR 登录、`ILinkClient`、`ILinkPoller`、AES Media、Typing） |
| `src/main/services/settings-store.ts` | `CloseAction:23`, `interface AppSettings:25`, `loadSettings:178`, `saveSettings:235`, `updateSettings:252` | 应用配置读写（23 字段权威定义） |
| `src/main/services/skill-resource-service.ts` | `READER_SKILL_NAME:13`, `parseSkillFrontmatter:86` | 内置 `tracememo-reader` Skill 加载与版本哈希解析 |

### 4.3 扩展中心、SDK 与独立服务（`src/main/extensions/`、`packages/`、`services/`）

| 文件路径 | 核心导出符号（含定义行号） | 职责说明 |
|---|---|---|
| `src/main/extensions/extension-service.ts` | `initExtensionSystem:40`, `getExtensionManager:138`, `disposeExtensionSystem:147` | 扩展系统总初始化与生命周期托管 |
| `src/main/extensions/extension-manager.ts` | `ExtensionManagerDependencies:75`, `class ExtensionManager:125` | 扩展安装、启停、权限、开发模式、`pageRequest`（`L1085`）与发送网关调度 |
| `src/main/extensions/extension-host.ts` | `class ExtensionHost:158`, `killProcessTree:887`, `forkExtensionHost:953` | 扩展子进程托管与 IPC/RPC 通道 |
| `src/main/extensions/host-runtime.ts` | `tm` 全局 API（`L90-305`，含 `page.onRequest:104`、`secrets:114` 等 11 命名空间）、`activate:339` | 扩展子进程独立入口，注入 `tm` 全局对象 |
| `src/main/extensions/extension-ipc.ts` | `interface ExtensionIpcOptions:19`, `registerExtensionIpc:33` | 注册 32 个 `extension:*` 主进程 IPC 通道 |
| `src/main/extensions/extension-protocol.ts` | `EXTENSION_SCHEME:7`, `registerExtensionScheme:29`, `installExtensionProtocolHandler:50` | `tm-extension://` 自定义协议与 realpath 防越界校验 |
| `src/main/extensions/extension-send-gateway.ts` | `class ExtensionSendGateway:58`, `extensionIdempotencyKey:438` | 扩展调用微信发送的权限/路径/授权二次校验网关 |
| `src/main/extensions/extension-secret-store.ts` & `src/main/extensions/extension-storage.ts` | `class ExtensionSecretStore:41`、`class ExtensionStorage:79` | 扩展私有凭据加密存储与 JSON 私有存储 |
| `packages/extension-sdk/index.d.ts` | `ExtensionPermission:3`, `TraceMemoMessageEvent:27`, `TraceMemoSendRequest:96`, `TraceMemoActionFieldSchema:104`, `TraceMemoCapabilities:136`, `TraceMemoApi:170`, `TraceMemoActivate:235` | `@tracememo/extension-sdk` 类型包（已同步 `secrets` 与 `page.onRequest`） |
| `services/share-card-worker/src/index.js` | `default { fetch:314, scheduled:315 }`, `escapeHtml:318`, `sha1:318` | Cloudflare Worker + R2 分享卡片服务与 JS-SDK 签名 |

### 4.4 Preload、Shared 与 Renderer 核心符号（`src/preload/`、`src/shared/`、`src/renderer/src/`）

| 文件路径 | 核心导出符号（含定义行号） | 职责说明 |
|---|---|---|
| `src/preload/index.ts` | 封装 `api` 对象（257 个方法，`contextBridge.exposeInMainWorld('api', api)`） | 安全桥接渲染层与主进程 IPC |
| `src/preload/index.d.ts` | `ParsedContent:190`（14 分支漂移）、`Window.api:249`（257 方法声明） | 渲染层全局 `window.api` 类型契约 |
| `src/shared/types.ts` | `ParsedContent:183`（15 分支权威版）、`Contact`、`Message` 等 | 核心业务类型真源 |
| `src/shared/extensions/ipc.ts` | `EXTENSION_IPC:4`, `ExtensionPageBridgeRequest:56`, `isExtensionPageBridgeRequest:72` | 扩展 32 invoke + 1 event 常量与 iframe bridge 校验 |
| `src/shared/extensions/permissions.ts` | `EXTENSION_PERMISSIONS:3`（11 权限，含 `secrets`）、`EXTENSION_PERMISSION_INFO:27` | 扩展权限目录与风险级别定义 |
| `src/shared/extensions/rpc.ts` | `EXTENSION_HOST_PROTOCOL_VERSION:5`, `ExtensionHostCallMethod:7`（15 方法） | 主进程 ↔ 扩展子进程私有 RPC 协议 |
| `src/shared/local-api-test.ts` | `LOCAL_API_ENDPOINTS:1`, `LocalApiTestRequest:66` | API Center 在线测试预设端点清单（24 项） |
| `src/shared/automation.ts` & `src/shared/automation-matcher.ts` | `AutomationStatusSummary:719`、`matchAutomationRule:50` | 自动化契约与纯函数规则匹配引擎 |
| `src/shared/group-report.ts` & `src/shared/report-templates.ts` & `src/shared/report-template-package.ts` | `selectHeroParticipantNames:7`, `REPORT_AVATAR_ALIAS_FIELDS:18` 等 | 群日报元信息、内置模板与模板包校验 |
| `src/renderer/src/App.tsx` | `default App:238` | React 19 根状态机，托管 10 大一级工作区 |
| `src/renderer/src/components/layout/navigation.ts` | `AppPage:1`, `NavigationItem:13`, `PRIMARY_NAV_ITEMS:18` | 10 大一级工作区路由表定义 |
| `src/renderer/src/components/layout/AppShell.tsx` & `src/renderer/src/components/layout/PrimaryNavigation.tsx` | `AppShell:35`、`PrimaryNavigation:111` | 应用外壳布局与左侧主导航栏 |
| `src/renderer/src/features/api-center/utils/buildSkillInstallInstruction.ts` | `buildSkillInstallInstruction:20`, `buildSkillVerificationPrompt:42` | 4 类外部 Agent 安装指令生成器（受 `test:skill-install` 校验） |
| `src/renderer/src/utils/group-report.ts` | `GROUP_REPORT_SYSTEM_PROMPT:26`, `buildGroupReportInput:182`, `parseGroupDailyReport:787` | 群日报提示词构建与 LLM JSON 解析（被主进程反向引用） |

### 4.5 全仓 55+ 个关键环境变量清单

> 下表覆盖源码、脚本与测试中实际消费的业务/工程环境变量（系统通用环境变量 `PATH`/`APPDATA`/`LOCALAPPDATA`/`HOME`/`ProgramData`/`PROGRAMFILES`/`PUBLIC`/`SystemDrive`/`TEMP`/`TMP` 已省略）。

| 类别 | 变量名 | 使用位置（精确路径与行号） | 作用说明 |
|---|---|---|---|
| **构建与双版隔离** | `TRACEMEMO_EDITION` | `scripts/after-pack.cjs:60,421,436,743,745`、`scripts/build-macos-edition.cjs:122` | 区分 macOS `public` / `native` 构建与 `after-pack` 校验分支 |
| | `TRACEMEMO_EDITION_OUT_DIR` | `electron.vite.config.ts`、`scripts/build-macos-edition.cjs:123` | 重定向 `electron-vite` 编译输出目录到 staging |
| | `TRACEMEMO_RUNTIME_PROFILE` | `src/main/native-runtime-paths.ts:16`、`scripts/build-macos-edition.cjs:122` | 非打包环境下覆写运行配置（`public` / `native`） |
| | `TM_SEND_RUNTIME_BUILD` | `scripts/after-pack.cjs:736` | 显式放行打包 macOS 发送运行时（`tm-wechat-host`） |
| | `TRACEMEMO_WCDB_DIST_ROOT` / `TRACEMEMO_NATIVE_DIST_ROOT` | `scripts/prepare-macos-edition.cjs:70` / `scripts/prepare-macos-edition.cjs:19` | 覆写 macOS 双版 Staging 的 WCDB / Native 产物源目录 |
| | `TRACEMEMO_FFMPEG_ARM64_PATH` / `TRACEMEMO_FFMPEG_LICENSE_DIR` | `scripts/prepare-macos-edition.cjs:386` / `scripts/prepare-macos-edition.cjs:328,433` | 覆写 macOS ARM64 FFmpeg 二进制及许可文件源目录 |
| | `TRACEMEMO_MAC_STAGE_ROOT` / `TRACEMEMO_MAC_OUTPUT_ROOT` | `scripts/prepare-macos-edition.cjs` | 覆写 macOS 双版 staging 与输出根目录 |
| | `TM_NATIVE_RUNTIME_DIR` | `scripts/prepare-wechat-native-runtime.cjs:153` | 指定 `prepare:wechat-native` 的原生发送运行时源目录 |
| | `ELECTRON_MIRROR` | `scripts/ensure-electron-binary.cjs:31` | 覆写 Electron 二进制下载镜像地址 |
| | `EP_PRE_RELEASE` | `package.json`（`release:beta`） | 控制 `electron-builder` 发布 GitHub Draft 为预发布版本 |
| | `SKILL_VERSION_BASE` | `scripts/check-skill-version-drift.cjs` | 覆写 Skill 版本漂移比对的 Git 基准分支 |
| **主/子进程运行时** | `ELECTRON_RENDERER_URL` | `src/main/index.ts:1083-1084` | `electron-vite dev` 注入的渲染层开发服务器 URL |
| | `ELECTRON_RUN_AS_NODE` | `src/main/knowledge/knowledge-worker-host.ts`、`src/main/voice-pipeline/recognition-host.ts`、`src/main/extensions/extension-host.ts`、`scripts/run-query-agent-poc.cjs` | 以纯 Node 模式 fork Worker；POC 运行前显式清除 |
| | `TRACEMEMO_LEGACY_MIGRATION_HELPER` / `SOURCE` / `USER_DATA` / `RESULT_FD`（4 个） | `src/main/app-data-bootstrap.ts:5-8` | 旧身份安全凭据迁移子进程通信与结果 FD 传递 |
| | `WXE_USER_DATA` | `src/main/app-data-bootstrap.ts:20` | 强制指定隔离的 `userData` 目录并跳过旧版迁移 |
| | `WXE_TRAY` | `src/main/index.ts:840` | 设为 `1` 时启动静默隐藏到系统托盘 |
| | `TRACEMEMO_PROJECT_NAME` | `src/main/preload-env.ts:33` | 注入项目名（默认 `'TraceMemo'`） |
| | `TRACEMEMO_RESOURCES_PATH` / `WECHATEXPLORER_RESOURCES_PATH` | `src/main/resource-paths.ts:19-20` | 覆写 `resources/` 资源检索根路径 |
| | `WCDB_RESOURCES_PATH` / `WCDB_DLL_PATH` / `WCDB_DEBUG_LOGS` | `src/main/preload-env.ts:32`、`src/main/wcdb4-client.ts:252,336,3437,3738`、`src/main/wcdb-debug.ts:2` | 覆写 WCDB 库搜索路径、DLL 路径与开启调试日志 |
| | `WX_KEY_DLL_PATH` | `src/main/key-service-win.ts:69-70` | 覆写 Windows `wx_key.dll` 路径 |
| | `FFMPEG_BIN` | `src/main/image-decrypt-service.ts:79`、`src/main/services/system-ocr-service.ts:126` | 覆写 FFmpeg 可执行文件路径 |
| | `TM_WECHAT_HOST_PORT` / `TM_WECHAT_LOG_FILE` | `src/main/services/mac-wechat-runtime-manager.ts:56,528,704`、`src/main/services/mac-wechat-residual-cleanup.ts:28`、`src/main/services/msg-insert-capability-service.ts:143` | 覆写 macOS `tm-wechat-host` 端口（默认 `4290`）与日志路径 |
| | `TM_EXTENSION_ID` / `TM_EXTENSION_DIR` / `TRACEMEMO_EXTENSION_TEMPLATES_DIR` | `src/main/extensions/extension-host.ts:966-967`、`src/main/extensions/host-runtime.ts:49`、`src/main/extensions/extension-service.ts:28` | 扩展宿主子进程标识及模板目录覆写 |
| | `TRACEMEMO_OCR_CONCURRENCY` | `src/main/index.ts:1261-1262` | 覆写系统 OCR 索引并发度 |
| | `TRACEMEMO_DEBUG_IMAGE` / `WECHATEXPLORER_DEBUG_IMAGE` | `src/main/image-decrypt-service.ts:15-16` | 开启图片解密诊断日志 |
| | `TRACEMEMO_REPORT_OUTPUT_DIR` / `TRACEMEMO_TEMPLATE_SECURITY_LOG` | `src/main/group-report-service.ts:327,1119,1173` | 覆写日报导出目录与模板安全拦截日志输出（含 E2E） |
| | `TRACEMEMO_TEMPLATE_TEST_USER_DATA` | `src/main/report-template-test-entry.ts:4` | 日报模板测试入口必需的 `userData` 目录 |
| | `TRACEMEMO_QUERY_API_BASE` / `TRACEMEMO_POC_ELECTRON` | `src/main/query-agent-poc-entry.ts:24`、`scripts/run-query-agent-poc.cjs` | Query Agent POC Local API 基地址与 Electron 执行路径 |
| | `TRACEMEMO_UPDATE_SIMULATION` / `TRACEMEMO_UPDATE_SIMULATION_DURATION_MS` | `src/main/services/app-update-service.ts:51,53` | 模拟应用自动更新调试模式与下载耗时 |
| | `WE_SETTINGS_DIR` | `src/main/services/settings-store.ts:168` | 覆写设置文件存储目录 |
| | `FISH_API_KEY` | `src/main/services/text-to-speech-settings-service.ts:291` | Fish Audio TTS 默认 API Key 回退 |
| | `WXE_VOICE_THREADS` / `WXE_VOICE_RECOGNITION_FAKE_TEXT` | `src/main/voice-pipeline/sensevoice-recognizer.ts:45`、`src/main/voice-pipeline/voice-recognition-worker.ts:25` | SenseVoice 线程数（1–4，默认 2）与测试桩转写文本 |
| | `WECHAT_SHARE_DOMAIN` / `WECHAT_SHARE_APP_ID` / `WECHAT_SHARE_APP_SECRET` / `WECHAT_SHARE_UPLOAD_TOKEN` | `.env.example:35-39` | 实验性 Share Card Worker 域名、微信服务号凭据与上传鉴权 |
| **`VITE_*` 开发变量** | `VITE_DB_KEY` / `VITE_AUTO_LOGIN` | `src/renderer/src/App.tsx:86`、`src/main/services/settings-store.ts:150` | 开发模式（`import.meta.env.DEV`）预填 DB 密钥与默认自动登录开关 |
| | `VITE_FILTER_MSG_TYPES` | `src/renderer/src/components/ChatWindow.tsx:143` | 逗号分隔过滤消息类型 |
| | `VITE_IMAGE_AES_KEY` / `VITE_IMAGE_XOR_KEY` | `src/main/services/image-key-config-service.ts:62,67` | 仅开发模式回退的图片 AES/XOR 密钥（`L61` 为 `const envAesKey` 换行首行） |
| | `VITE_SCHEDULED_REPORT_DEBUG` | `src/main/index.ts:2956` | 控制定时日报调试通知测试入口 |
| | `VITE_DEEPSEEK_API_KEY` / `VITE_AI_BASE_URL` / `VITE_AI_MODEL` | `.env.example:15-17`、`src/env.d.ts:4` | **历史遗留声明**：`.env.example:12` 已注明当前发布版与 `src/` 源码不再自动读取 |
| **测试与评测门控** | `WXE_E2E_USER_DATA` / `HEADLESS` / `NOW_MS` / `UPDATE_SIMULATION` / `UNSIGNED_MAC_UPDATE` / `AI_FAILURE` / `MODE` / `APPEARANCE_THEME` / `LARGE_CONTACTS` / `REALTIME_REORDER` / `SCHEDULED_FIXTURE` / `CORRUPT_CACHE` / `TEMPLATE_MARKET` / `CLOSE_DELAY_MS`（14 项） | `tests/e2e/support/electron-main.cjs:8-1254`、`tests/e2e/support/electron.ts:40`、`.env.example:31` | 控制 E2E 主进程替身场景注入与 CI 关窗延迟 |
| | `WXE_UPDATE_VISUAL_BASELINES` | `tests/e2e/visual.spec.ts:16` | 设为 `1` 时刷新 `@visual` 视觉截图基线 |
| | `KNOWLEDGE_CAPACITY` / `KNOWLEDGE_CAPACITY_REPORT_PATH` | `tests/benchmark/knowledge-capacity.benchmark.test.ts:11,16` | 启用百万级知识库容量压测及报告输出路径 |
| | `WXE_REAL_DATA_SMOKE` / `WXE_SMOKE_DB_ROOT` | `tests/smoke/native-environment.test.mjs:5,9,11` | 启用真机 WCDB 冒烟测试并指定数据根目录 |
| | `REPORT_FIXTURE_IMAGE` | `scripts/render-report-fixtures.mjs:33` | 覆写日报 fixture 渲染配图 |

---

## 五、后续维护与开发指南

1. **自动化维护门禁**：每次新增或调整目录结构、IPC 通道、HTTP 路由、环境变量或导出符号后，必须同步更新本索引及对应专题文档，并执行以下本地校验：
   ```bash
   node scripts/check-knowledge-base.mjs
   node scripts/check-knowledge-base.mjs --json
   pnpm check:skill-version
   node scripts/build-extension-templates.cjs --check
   ```
2. **修复已核实源码偏差的推荐顺序**：
   - 先将 `src/renderer/src/utils/group-report.ts` 的纯逻辑（Prompt 与解析器）迁入 `src/shared/`，解除 `src/main/services/agent-group-report-service.ts:14-22` 的反向引用；
   - 让 `src/preload/index.d.ts` 直接复用 `src/shared/types.ts` 的 `ParsedContent` 及提取自 `src/shared/` 的 `AppSettings` 共享类型，并在 `src/preload/index.ts` 绑定 `EXTENSION_IPC` 常量；
   - 为 `listeningDegraded` 补充前端横幅提示，清理 `App.tsx` 死代码 `buildSyntheticGroupMessages` 与根目录遗留 `index.js` / `index.html`，修正 `knowledge-store.ts:648` 计时赋值。
3. **全套知识库专题快速回链**：
   - [知识库总览与阅读路径](./README.md) · [01. 系统架构总览](./01-system-overview.md) · [02. 主进程与数据访问](./02-main-process-and-data.md) · [03. 知识库与 AI 检索](./03-knowledge-and-ai-pipeline.md) · [04. 报告、自动化与 Hub](./04-reports-automation-hub.md) · [05. Local HTTP 与扩展](./05-http-api-and-extensions.md) · [06. 渲染层与 IPC 契约](./06-renderer-and-ipc.md) · [07. 构建脚本与打包](./07-build-scripts-and-packaging.md) · [08. 测试体系与门禁](./08-testing-and-quality-gates.md)
