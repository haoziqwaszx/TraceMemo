# 04. 聊天导出、群日报沙箱、自动化防回环与双通道微信网关

> **源码基线**：`8f47dca`｜**适用范围**：聊天多格式导出与增量 HTML 归档、群日报与模板安全沙箱、退群监控与进程外写入隔离、四道防回环自动化引擎、双通道微信网关（iLink + 个人微信）与 `AgentHubService`

本专题覆盖 TraceMemo 在核心数据底座之上的业务出口与主动触达闭环，上承 [02. 主进程生命周期与核心数据访问](./02-main-process-and-data.md) 的只读 WCDB4 数据与解密能力，并与 [03. 本地知识库与 AI 检索流水线](./03-knowledge-and-ai-pipeline.md)（共享 `AskWechatService` / `QueryAgentService`）以及 [05. 本地 HTTP API 与扩展中心](./05-http-api-and-extensions.md)（共享扩展桥接与 HTTP 投影契约）协同工作。

---

## 1. 架构总览

五大子系统全部运行在 Electron 主进程（`src/main/`）及其受控隔离边界内，遵循**「只读主库、进程外写库、渲染沙箱隔离、入站先落盘后推进、出站统一策略审计」**原则：

```text
┌───────────────────────────────────────────────────────────────────────────────────────┐
│                                 数据与事件来源层                                        │
│  WCDB4 只读库 & 解密服务          Wcdb4Monitor (v2/v1)        iLink 长轮询 / 定时器     │
└───────────┬─────────────────────────────┬───────────────────────────┬─────────────────┘
            │                             │                           │
            ▼                             ▼                           ▼
┌───────────────────────┐   ┌───────────────────────────┐   ┌───────────────────────────┐
│ 1. 聊天导出子系统       │   │ 3. 实时监听与退群监控      │   │ 5. AgentHub 与 iLink 网关 │
│ export-service.ts     │   │ MessageListenerService    │   │ WechatConnectorService    │
│ export-html-template  │   │  (120ms coalesce + dedup) │   │  (长轮询 → WechatInbound  │
│ (增量归档/视觉指纹/XSS) │   │ GroupExitMonitorService   │   │   Inbox 落盘 → 推进游标)   │
└───────────────────────┘   │  (LastGoodSnapshot diff)  │   │ AgentHubService           │
                            └──────┬──────────┬─────────┘   │  (纯规则路由/QueryAgent)  │
┌───────────────────────┐          │          │             └─────────────┬─────────────┘
│ 2. 群日报与模板沙箱     │          │          ▼                           │
│ agent-group-report    │          │   ┌──────────────────────────┐       │
│ group-report-service  │          │   │ 微信内本地插入隔离通道     │       │
│ report-template-*     │          │   │ WechatLocalExitNotice    │       │
│ (5层安全沙箱+全页截图)  │          │   │ MsgInsertSwitchService   │       │
└───────────┬───────────┘          │   │ → spawn 一次性子进程     │       │
            │                      │   │   tm-wcdb-config-helper  │       │
            │                      │   │   (stdin传密钥,避开-3004)│       │
            │                      │   └──────────────────────────┘       │
            │                      ▼                                      │
            │           ┌─────────────────────────────────────┐           │
            │           │ 4. 自动化防回环引擎                  │           │
            │           │ AutomationService (4道消息闸门/      │           │
            │           │   退群4闸门/定时3闸门)               │           │
            │           │ ScheduledReportService (15s tick)   │           │
            │           │ AutomationActionRunner (步骤截断)    │           │
            │           └──────────────────┬──────────────────┘           │
            └──────────────────────────────┼──────────────────────────────┘
                                           ▼
┌───────────────────────────────────────────────────────────────────────────────────────┐
│                              双通道统一发送出口层                                        │
│  WechatActionGateway (策略白名单 + 幂等键 + 3s 自动化串行冷却 + 500条持久化审计)          │
│            │                                                                          │
│            ▼                                                                          │
│  WechatSendGateway (resolveSendTransport 路由 + 脱敏 Send Log)                         │
│    ├── transport === 'ilink'    → WechatConnectorService (AES-128-ECB CDN + sendmessage)│
│    └── transport === 'personal' → PersonalWechatSendService                            │
│          ├── win32  → 本地 Hook HTTP (127.0.0.1:<port>/SendMsg)                         │
│          └── darwin → MacWechatRuntimeManager (tm-wechat-host, 127.0.0.1:4290..4293)  │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### 子系统规模与文件分布

| 子系统 | 核心源码目录 / 文件 | 职责聚焦 |
|---|---|---|
| 聊天导出 | `src/main/export-service.ts`、`src/main/export-html-template.ts` | 单/多会话与全量导出、HTML 增量归档、资源去重与 XSS 防护 |
| 群日报与模板安全 | `src/main/group-report-service.ts`、`src/main/report-template-service.ts`、`src/main/report-template-market-service.ts`、`src/main/report-template-ipc.ts`、`src/main/report-history-service.ts`、`src/main/services/agent-group-report-service.ts`、`src/shared/report-templates.ts`、`src/shared/report-template-package.ts`、`src/shared/report-template-market.ts`、`src/shared/report-template-fragment-contract.ts` | AI 日报生成、社区模板校验/安装、5 层安全沙箱、无头截图与历史管理 |
| 退群监控与本地插入 | `src/main/services/group-exit-monitor-service.ts`、`src/main/services/msg-insert-switch-service.ts`、`src/main/services/wechat-local-exit-notice-service.ts`、`src/main/services/msg-insert-capability-service.ts`、`src/shared/msg-insert-switch.ts`、`src/shared/group-exit-monitor.ts`、`src/shared/group-exit-event.ts` | 唯一退群事实源、JSONL 永久事件、进程外写入隔离 |
| 自动化防回环引擎 | `src/main/services/message-listener-service.ts`、`src/main/services/automation-service.ts`、`src/main/services/automation-rule-store.ts`、`src/main/services/automation-action-runner.ts`、`src/main/services/scheduled-report-service.ts`、`src/shared/automation-matcher.ts`、`src/shared/automation.ts` | 实时消息聚合回读、4 道防回环闸门、退群/定时规则执行与步骤截断 |
| 双通道发送与 AgentHub | `src/main/services/wechat-action-gateway.ts`、`src/main/services/wechat-send-gateway.ts`、`src/main/services/personal-wechat-send-service.ts`、`src/main/services/mac-wechat-runtime-manager.ts`、`src/main/services/wechat-ilink/`（13 文件）、`src/main/services/agent-hub-service.ts`、`src/main/services/agent-hub-routing.ts`、`src/main/services/wechat-inbound-inbox.ts`、`src/shared/wechat-send.ts` | 发送策略审计、个人微信双端适配、iLink 协议实现、Bot 入站落盘与路由分流 |

---

## 2. 模块职责与边界

| 模块 | 做什么（职责范围） | 明确不做什么（边界红线） |
|---|---|---|
| **聊天导出** (`export-service.ts` / `export-html-template.ts`) | 执行 `html`/`json`/`csv`/`markdown` 导出；合并历史 `HtmlExportArchive`、计算资源 hash 与视觉指纹去重、生成独立离线可浏览的 HTML 单页壳与 ZIP 包 | 不修改 WCDB 源库；多会话合并除 `html` 外拒绝导出；非 HTML 格式不复制媒体二进制文件 |
| **群日报与模板服务** (`group-report-service.ts` / `report-template-*` / `agent-group-report-service.ts`) | 通过 `AIProviderService` 生成结构化日报 JSON（含自动修复）、校验本地/市场模板 ZIP 并通过 AST 白名单、Data URL 内联、CSP 与受限 `BrowserWindow` 截图为 PNG | 不允许外部模板执行 JS、发网络请求或读取宿主本地文件；外置模板禁止 `file:` 图片；定时日报配置不接 `external:*` 模板 |
| **退群监控与插入开关** (`group-exit-monitor-service.ts` / `msg-insert-switch-service.ts` / `wechat-local-exit-notice-service.ts`) | `GroupExitMonitorService` 作为唯一退群事实源维护快照与事件 JSONL；主进程只读检查分片/规则状态；通过 `tm-wcdb-config-helper` 写入 `_tm_config`、规则或一次性退群本地提示 | **绝不在主进程向 WCDB 发起写入**（防 `-3004`）；`WechatLocalExitNoticeService` 不自行判断退群、不持有群列表、失败绝不抛异常或回滚退群记录；helper 密钥绝不进 `argv`/`env` |
| **自动化引擎** (`message-listener-service.ts` / `automation-*` / `scheduled-report-service.ts`) | `MessageListenerService` 聚合 native 事件并有界回读去重；`AutomationService` 执行匹配、防回环闸门与能力预检；`AutomationActionRunner` 顺序执行步骤并在失败时截断后续 | `MessageListenerService` 不做业务匹配或 AI 调用；`ScheduledReportService` 不直接生成/发送日报也不再落盘新任务，只做 15s 调度扫描与异常通知；自动化日志严禁出现群名/昵称/`wxid`/消息正文 |
| **双通道微信网关** (`wechat-action-gateway.ts` / `wechat-send-gateway.ts` / `wechat-ilink/` / `personal-wechat-send-service.ts` / `mac-wechat-runtime-manager.ts`) | `WechatActionGateway` 负责用途白名单、幂等、3s 自动化间隔与审计；`WechatSendGateway` 负责通道路由与脱敏 Send Log；`wechat-ilink/` 负责扫码登录、长轮询与 CDN 加解密；`MacWechatRuntimeManager` 管理 `tm-wechat-host` 进程与授权探测 | Electron **绝不直接 `dlopen` 原生发送 dylib**；个人微信通道明确不支持 `file` 以外未授权类型或无 `context_token` 跨通道假装成功；Mac `tm-wechat-host` 发生绑定态崩溃后禁止自动重绑死循环 |
| **AgentHub** (`agent-hub-service.ts` / `agent-hub-routing.ts`) | 接收 iLink 入站消息先落盘 `WechatInboundInbox` 再消费；按纯规则路由分发群日报、成员发言总结、最近会话列表或共享 `AskWechatService`；维护 5s typing 心跳 | 不做“先调一次 LLM 分类、再调一次 LLM 查询”的双重模型语义；不注入 Legacy 搜索回退器；不向微信输出 `[E#]` 引用编号或内部错误栈 |

---

## 3. 核心数据流与设计思路

### 3.1 聊天导出与增量 HTML 归档

`src/main/export-service.ts` 通过 `runExport`（`L1861-1870`）分流 `runSingleExport`（单/多会话合并，1~5 个会话，且多会话仅支持 `html`）与 `runAllExport`（`scope === 'all'`）。

1. **多格式渲染与全量归档**：
   - 支持 `'html' | 'json' | 'csv' | 'markdown'`（`render`, `L649-670`），`csv` 注入 UTF-8 BOM `\uFEFF` 并做双引号转义。
   - `runAllExport`（`L1637-1859`）按 `群聊/` 与 `联系人/` 分类目录输出，实时更新 `导出清单.json`（原子临时文件 rename），并在开启 `zip` 时使用 `archiver`（`ZipArchive` zlib `level: 6`，`L429`）压缩并支持 `cancelExport` 中止（`L1871-1874`）。
2. **HTML 增量归档与双层资源去重（`L955-1605`）**：
   - 读取已有 `data/messages.js`（兼容 `HtmlExportArchiveV1` 与 `v2`，`L337-414`），计算每条消息的稳定主键 `exportMessageKey`（`L235-256`：优先 `localId:createTime` → `serverId` → `id:createTime` → 内容摘要 hash）与源签名 `htmlArchiveSourceSignature`（`L191-204`）。
   - **媒体与语音复用**：若 `previous` 消息的源签名一致且对应磁盘文件真实存在（对表情包还会用 `detectAssetExtension` 校验魔数，`L588-600`），直接复用 `voices/voice_<sha1>.wav`、`media/{image,video,sticker}_<sha1>.*` 与 `files/file_<sha1>_<name>`，跳过重复解密与文件拷贝。语音时长优先保留消息 XML 解析得到的 `<voicemsg voicelength>` 权威小数，仅在缺失时用 WAV PCM 字节数估算（`L1249-1257`）。
   - **头像视觉指纹去重（`L127-189, L1035-1077`）**：使用 `electron.nativeImage` 缩放到 `9×8` 灰度图计算 `64-bit` 差分哈希 + 平均 RGB 十六进制串（`avatarVisualHash`）。当 `avatarHashDistance <= 5` 且 RGB 各通道差 `<= 12`（`avatarsLookTheSame`）时复用旧头像；否则生成带版本号的新文件 `avatar_<sourceHash>_<bufHash>.<ext>`。
   - **收尾原子写与孤儿清理**：合并并排序消息后，经 `pruneHtmlArchiveResources`（`L509-555`）清理不再被引用的孤儿资源，最后通过 `writeHtmlArchive`（`L468-507`）备份 `.bak` 并原子写 `data/messages.js` 与 `data/conversations.json`。
3. **HTML 导出壳 XSS 与 URL 注入防护（`src/main/export-html-template.ts`）**：
   - **服务端页面壳**：标题等文本经 `safe()`（`L854-860`）转义 `&<>"'` 后写入 HTML；
   - **客户端渲染脚本（`L940-974`）**：`esc()` 对文本转义；`decodeEntities` 借助离屏 `textarea` 还原实体后再转义（`displayText`）；`externalUrl()` 严格解析 `URL` 并仅放行 `http:` / `https:`；`imageUrl()` 仅放行 `data:image/`；搜索高亮采用原生 `document.createElement('mark')` + `textContent` 构建 DOM，彻底避免 `innerHTML` 拼接注入。

---

### 3.2 群日报生成与五层模板安全沙箱

群日报系统由 AI 归纳（`agent-group-report-service.ts`）、模板管理（`report-template-service.ts`、`report-template-market-service.ts`）与沙箱渲染截图（`group-report-service.ts`）三部分构成：

1. **AI 日报生成与反向导入事实（`src/main/services/agent-group-report-service.ts`）**：
   - `generateAgentGroupReport`（`L97-231`）先解析群聊与消息范围，调用 `hydrateGroupMemberIdentity`（`L40-63`）基于 `getGroupSnapshot` 补全群成员头像与显示名——刻意取消早期 `isInternalName` 早退门禁，**只要 `senderId` 命中群成员即可补头像**，名称仅在解析为非内部标识时替换。
   - 注意一个重要的源码事实：`src/main/services/agent-group-report-service.ts:14-22` 直接**反向导入**了渲染层工具 `src/renderer/src/utils/group-report.ts` 的 `buildGroupReportInput`、`GROUP_REPORT_SYSTEM_PROMPT`、`GROUP_REPORT_JSON_REPAIR_SYSTEM_PROMPT` 与 `parseGroupDailyReport`。若主进程返回 JSON 解析失败，会自动携带 `GROUP_REPORT_JSON_REPAIR_SYSTEM_PROMPT` 调 `AIProviderService.chat` 做一次语法修复并累加 `tokenUsage`（`L180-210`）。
2. **内置与社区模板体系**：
   - `src/shared/report-templates.ts:32-117` 定义经典模板 `v1`（`resources/mobile_daily_report_v1.html`）以及 5 款新版内置模板（`mobile-feed`、`mobile-magazine`、`mobile-dashboard`、`desktop-workspace`、`desktop-editorial`，统一共用 `resources/daily_report_templates.html` 并以 `TEMPLATE_CLASS` 区分样式；同时兼容 `v2` → `resources/mobile_daily_report_v2.html`，而 `resources/mobile_daily_report.html` 为历史遗留模板）。
   - 社区模板包格式见 `examples/report-template-basic/`（`manifest.json` + `template.html`），遵循 `REPORT_TEMPLATE_PACKAGE_PROTOCOL_VERSION = '1.0'` 与 `REPORT_TEMPLATE_INTERFACE_VERSION = '1'`（`src/shared/report-template-package.ts:3-4`），占位符分为 `'text' | 'html' | 'class'` 三类（`L54-80`）。
3. **五层模板安全边界**：
   - **第 1 层 · 远端市场固定 commit 与完整性校验（`src/main/report-template-market-service.ts:20-241`）**：Catalog 地址硬编码为 `REPORT_TEMPLATE_CATALOG_URL`；`assertAllowedRemoteUrl` / `assertAllowedPackageUrl` 强制 `https://raw.githubusercontent.com/Wxw-Gu/TraceMemo-Templates/<40位hex commit>/...`，禁止查询串/认证/端口，且 `fetchBytes` 设 `redirect: 'error'`、15s 超时与 2MB/20MB 字节上限；下载 ZIP 后强制校验 `sizeBytes` 与 `sha256`。
   - **第 2 层 · 安装期 ZIP 越界与 AST 白名单清洗（`src/main/report-template-service.ts:55-359`）**：
     - 体积与路径防线：压缩包 ≤20MB、解压后 ≤50MB、最多 100 个文件、单 HTML/CSS ≤2MB（`REPORT_TEMPLATE_LIMITS`）；禁止重复条目、符号链接及 `..` 目录穿越；校验 `SAFE_ID`（`community.github.<owner>.<name>`）。
     - HTML/CSS AST 校验：`validateReportTemplateHtml`（`L143-184`）使用 `parse5.parseFragment` 遍历全部节点，只允许 `REPORT_TEMPLATE_ALLOWED_TAGS`（无 `<script>`、`<iframe>`、`<object>`、`<link>`、`<svg>`）与 `REPORT_TEMPLATE_ALLOWED_ATTRS`（禁用所有 `on*` 事件属性与 `href`/`action`/`poster`），`<img>` 的 `src` 只允许 `assets/` 下的 `.png`/`.jpg`/`.jpeg`/`.webp`；`class` 类占位符以外的占位符禁止进入属性或 `<style>`。`validateCss`（`L120-141`）使用 `css-tree` 遍历样式 AST，拦截 `@import` 与 `https:`/`http:`/`file:`/`data:`/`javascript:` URL。
   - **第 3 层 · 运行时内联、片段契约与强制 CSP（`src/main/group-report-service.ts:293-320, L767-796`）**：
     - 每次渲染外置模板都会重新执行 `validateReportTemplateHtml` 并将 `assets/*` 内联为 Base64 Data URL（`inlineTemplateAssets`）。
     - `injectReportTemplateFragmentContract` 注入 `src/shared/report-template-fragment-contract.ts` 的几何约束 CSS（锁定头像尺寸与文本换行，防止外置样式把片段挤塌）。
     - `addReportCsp` 向 `<head>` 注入 `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:[ file:]; style-src 'unsafe-inline'; font-src 'none'; base-uri 'none'; form-action 'none'">`（外置模板连 `file:` 图片都禁用）。
   - **第 4 层 · 沙箱 `BrowserWindow` 与网络全拦截（`src/main/group-report-service.ts:1005-1109`）**：
     - `captureFullPage` 使用随机独立会话分区 `partition: report-template-${crypto.randomUUID()}`，并配置 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`。
     - 注册 `session.webRequest.onBeforeRequest` 拦截全部 `http/https/ws/wss/file` 请求，仅放行与当前 `allowedDocumentPath` 严格相等的 `file://` 主文档请求（拦截记录可通过 `TRACEMEMO_TEMPLATE_SECURITY_LOG` 落盘供 E2E 审计），并禁用 `setWindowOpenHandler` 与 `will-navigate`。
   - **第 5 层 · 有界头像富化与容错截图**：
     - `enrichAvatarsFromGroup`（`L254-282`）利用 `buildReportAvatarAliasIndex` 按多昵称别名索引群快照头像；`embedAvatar`（`L215-239`）通过 `AVATAR_FETCH_CONCURRENCY = 6`、2 次重试与 `detectImageMime` 字节魔数验证防止微信 CDN 限流返回 HTML 导致空白头像，失败时降级为 SVG 首字头像并记录 `warnings`。
     - 渲染完成的 HTML/PNG 可经 `src/main/report-history-service.ts` 存入 `{userData}/reports/<YYYY>/<MM>/`，并支持通过 `extractGroupReportRenderSnapshot`（`group-report-service.ts:799-1003`）在沙箱窗口中提取渲染快照以供历史报告无损换模板重渲染（`exportGroupReportSnapshot`）。

---

### 3.3 退群监控与 `tm-wcdb-config-helper` 写入隔离

退群监控与微信内消息插入围绕「**单一事实源**」与「**WCDB 只读池锁隔离**」两条硬架构约束设计：

1. **唯一退群事实源（`src/main/services/group-exit-monitor-service.ts`）**：
   - `GroupExitMonitorService` 监听原生联系人/库变更事件（`DB_CHANGE_DEBOUNCE_MS = 350ms` 防抖，`L61, L295-308`）。
   - 检查阶段优先走 `chat.getGroupMemberIdsBatchAsync` 批量拉取成员 ID，与内存中的 `Last Good Snapshot` 比对；若查询失败或异常空结果，保留旧快照（`membersValid` 保护），防止瞬时失败制造假退群风暴。
   - 发现成员减少（`findRemovedGroupMembers`）即按「一人一条」生成事件，经 `DUPLICATE_WINDOW_MS = 2 分钟` 窗口去重（`L717-725`）后立即追加写入 `{userData}/group-exit-monitor-events.jsonl`（append-only 永久保留；`MAX_EVENTS = 500` 仅限制 IPC `getState()` 回传条数，状态文件 `group-exit-monitor.json` 不存事件避免重写膨胀）。
   - 随后在后台异步队列 `hydrationQueue`（`L605-677`）中补齐退群成员昵称与头像，并经 `setGroupExitHandler` 回调非阻塞分发事件（`src/main/index.ts:1687-1719`）：
     - 若 `isNoticeRoom(conversationId)`（全量群聊且微信内退群提示开着），触发 `wechatLocalExitNoticeService.handleExitEvent(event)`；
     - 若 `isMonitoredRoom(conversationId)`（用户勾选的监控群），触发 `automationService.handleGroupExit(event)`。
2. **为什么微信库写入必须隔离到 `tm-wcdb-config-helper`（`src/main/services/msg-insert-switch-service.ts:4-25`）**：
   - WCDB CommonCore 在进程内按文件路径池化数据库对象（`getOrCreateDatabase`），且只读标志一旦设置即不可逆。主进程 `Wcdb4Client` 以只读方式打开微信消息分片，同进程再以可写打开必报 `-3004 attempt to write a readonly database`。
   - 因此架构上**严格分离读写进程**：主进程仅只读核查分片 `_tm_config` 与触发器目录；所有写操作均由主进程 `spawn` 一次性短生命周期子进程 `tm-wcdb-config-helper`（Windows 可优先定位 `%LOCALAPPDATA%\TraceMemo\Pro\...` 外置组件并校验 SHA-256，macOS 仅在 `native` 构建可用），数据库密钥 `key` 与 `myWxid` **仅通过 `stdin` JSON 行传入**（`L196-205`），绝不进入命令行参数或环境变量。
3. **两类开关的不同实现形态（`src/shared/msg-insert-switch.ts:17-105`, `msg-insert-switch-service.ts:98-126, 613-777`, `wechat-local-exit-notice-service.ts:1-25, 137-322`）**：
   - **`recall_notice`（`mode: 'rules'`, `scope: 'all_sessions'`）**：调用 `--action apply --switch recall` 或启动自愈 `--action ensure-rules`（`reconcileMsgInsertRules`），在每个目标会话的 `Msg_<md5(roomId)>` 表安装带会话后缀的库级唯一规则 `_tm_msg_insert_capture_<md5(roomId)>` 并写 `_tm_config`。只有该会话命中的全部分片规则都就绪（排除无 `Msg_` 表的公众号/未发消息空会话作为中性 `roomsWithoutTable`），才算 `effectiveEnabled`。
   - **`group_exit_notice`（`mode: 'event'`, `scope: 'all_group_chats'`）**：**不安装任何持久化 SQLite trigger**（避免在微信分片上铺成百上千条规则并与监控循环形成两套退群事实源）。而是由 `WechatLocalExitNoticeService` 消费 `GroupMemberExitedEvent`，校验 `msgInsertCapabilityService.getCapability` 后，调用 `--action insert-notice` 传入 `dedupeKey: event.eventId`，由 helper 按 `MAX(sort_seq)` 选中最新活跃分片写入并落盘跨重启幂等键。方法 `handleExitEvent` 永不抛异常，插入失败只记录 `recent` 诊断历史，绝不影响退群监控与自动化通知。

---

### 3.4 自动化防回环引擎与定时日报

自动化体系（`src/main/services/message-listener-service.ts`、`automation-service.ts`、`automation-rule-store.ts`、`automation-action-runner.ts`、`scheduled-report-service.ts`、`src/shared/automation-matcher.ts`）将三类规则（`daily_report`、`leave_notification`、`scheduled_report`）统一收口到 `{userData}/automation/rules.json`（版本号 `CURRENT_VERSION = 4`）。

1. **实时监听聚合与 `listeningDegraded: true` 现状（`message-listener-service.ts:190-469`, `automation-service.ts:307-310`）**：
   - `MessageListenerService` 接收 WCDB Monitor 事件并开启 `DEFAULT_COALESCE_MS = 120ms` 合并窗口（防止单次写库产生十余个连续事件触发雪崩回读）：
     - 若原生事件为 `protocol === 2`（含 `sessionId`），将 `sessionId` 收进 `pendingSessions` Set，窗口结束后逐个有界回读（`lookbackSec = 30s`、`lookaheadSec = 2s`、`readLimit = 50`）；
     - 若为 `protocol === 1`（legacy 事件无 `sessionId`），退化为只回读最近活跃会话 `client.getSessions()[0]`。因此 `AutomationService.getStatus()` 仍保守返回 `listeningDegraded: true`，如实向 UI 提示底层监听边界。
   - 回读后的消息解压缩 `zstd` 编码的 `source` 列（魔数 `28 b5 2f fd`），提取 `<atuserlist>`（剥离 CDATA）作为真 `@` 目标 `mentionTargets`，以 `Number(mesDes) === 0` 判断 `isSelf`，并经 `seen` Map（TTL 5 分钟、上限 5000）去重后投递给 `AutomationService` 与扩展事件总线。
2. **消息型规则四道防回环 / 防刷屏闸门（`automation-service.ts:52-60, 215-292, 836-960`, `automation-matcher.ts:50-102`）**：
   - **第 1 道 · Rule Type 与 `isSelf` 闸门（`matchAutomationRule`）**：共享纯函数（执行与 UI 效果预览共用）。首位硬分派 `rule.ruleType === 'daily_report'`（避免空关键词的定时/退群规则匹配每条群消息）；默认 `ignoreSelf !== false && input.isSelf` 直接拦截自身回复（如「收到，正在生成今日日报」），从源头切断死循环；真 `@` 只精确匹配 `selfUsernames`。
   - **第 2 道 · Listener 级 `seen` 去重**：`sessionId:localId` 级拦截重复 native 事件。
   - **第 3 道 · Conversation Rule Gate（`ruleId:conversationId`）**：`blocked = inFlight || now < triggeredAt + cooldown`。检查放在 `matchAutomationRule` **之前**（纯读无副作用），且从 `isGated()` 到 `claimGate()` 之间**无任何 `await`** 保证并发原子性；`triggeredAt` 锁定首次触发时间而非结束时间；容量淘汰（`GATE_MAX_ENTRIES = 5000`）硬性跳过 `inFlight === true` 的条目；`try/finally` 必调 `leaveGate` 防止规则永久锁死。
   - **第 4 道 · 同消息幂等 `claims`**：`ruleId:sessionId:localId`（`CLAIM_TTL_MS = 10 分钟`、`CLAIM_MAX_ENTRIES = 5000`）。
3. **退群通知 & 定时日报的独立闸门与跨重启幂等**：
   - **退群通知（`handleGroupExit`, `L342-417`）**：四闸门严格依次为 `enabled` → `!targetNeedsReview` → `leaveNotificationCoversRoom`（先判二次勾选范围，再占幂等位，避免排除群占用事件幂等键）→ `exitClaims`（`ruleId:eventId`，上限 1000）；生成确定性 `leaveNotificationExecutionId(ruleId, eventId)`（SHA-1）与 `leaveNotificationIdempotencyKey(eventId)`，重启后由 `WechatActionGateway` 持久化审计直接短路。
   - **定时日报（`ScheduledReportService.tick`, `L203-256`；`AutomationService.executeScheduledRule`, `L473-579`）**：每 `15_000ms` 扫描所有 `ruleType === 'scheduled_report'` 规则，通过 `resolveDueScheduledSlot` 计算最近已到点槽位，过双时间闸门（`slotMs >= rule.createdAt` 防新建规则立即补发昨天报告；`slotMs > lastScheduledSlot` 防同日重跑）后交由 `AutomationService.executeScheduledRule`。定时日报**不套 conversation gate**，仅使用 `scheduledInFlight` Set 防止同规则并发，以确定性 `scheduledReportExecutionId(ruleId, slot)` 实现跨重启幂等；手动「立即执行」使用随机 UUID 且不写入 `lastScheduledSlot`、失败不发微信异常通知。
4. **步骤状态机、失败截断与扩展安全代发（`automation-action-runner.ts:330-945`）**：
   - 消息规则按 `received → matched → [extension_action] → reply → report → send` 顺序执行；定时日报按 `schedule_triggered → report_generating → report_generated → send_resolved → report_sent` 执行；退群通知按 `exit_received → exit_matched → exit_target → exit_send` 执行。
   - **前序失败严格短路**：一旦 `extension_action`/`reply`/`report` 失败，后续步骤全部置 `skipped`（`markRemainingSkipped`），绝不发空图或上一张旧图。
   - **扩展动作安全边界**：扩展不能直接调微信发送；扩展仅返回 `{ reply }` 文本，由宿主校验 `canExtensionSendText(extensionId)`（`wechat.send.text` 权限）后，由宿主填好 `origin: 'extension'`、`purpose: 'extension_action'` 与 `idempotencyKey` 代调 `wechatActionGateway.execute` 发送。

---

### 3.5 双通道微信发送与 `AgentHubService`

TraceMemo 将所有对外微信消息统一抽象为「策略审计层 → 路由日志层 → 双协议传输层」，并在此之上承载进程内 `AgentHubService`：

1. **三层出站网关架构**：
   - **策略审计层 `WechatActionGateway`（`src/main/services/wechat-action-gateway.ts`）**：
     - `normalizeActionRequest` 校验收件人与内容（文本 `<= 2000` 字符）。
     - `evaluateWechatActionPolicy`（`L493-537`）对 `triggerType === 'automation'` 强制校验 `AUTOMATION_PURPOSE_ALLOWLIST`（10 个合法 `purpose`）；对所有 `extension_*` 用途强制校验 `origin === 'extension'`。
     - 预检 `personalWechatCapabilityService`，检查持久化审计 `{userData}/actions/wechat-actions.json`（保留最近 `MAX_AUDIT_RECORDS = 500` 条）及内存 `inFlight` 幂等；对 `triggerType === 'automation'` 请求挂载到串行 Promise 链 `automationSendTail`，强制 **`AUTOMATION_SEND_INTERVAL_MS = 3_000ms` 间隔节流**，然后调 `wechatSendGateway.sendPersonal`。
   - **统一路由层 `WechatSendGateway`（`src/main/services/wechat-send-gateway.ts` & `src/shared/wechat-send.ts`）**：
     - `resolveSendTransport`（`src/shared/wechat-send.ts:156-162`）：显式 `transport` 优先；否则携带 `context_token` 走 `'ilink'`，无则走 `'personal'`。
     - 每次发送无论成功失败均写入 Send Log（`buildSendPreview` 对媒体仅保留文件名防泄露目录结构，同时记录原文 SHA-256）；个人微信通道若传入 `file` 类型在 `unifiedToPersonalRequest`（`wechat-send-gateway.ts:303-327`）需经网关或平台支持，注意 `unifiedToPersonalRequest` 对 `file` 会显式抛出 `UnsupportedSendTypeError`（而 `PersonalWechatSendService` 自身支持 `file` 供直接调用方使用）。
2. **iLink 通道全协议栈（`src/main/services/wechat-ilink/` 全 13 文件）**：
   - **协议与防重放头（`types.ts`, `headers.ts`, `client.ts`, `errors.ts`）**：基线 `ILINK_CHANNEL_VERSION = '2.4.6'`、`ILINK_APP_ID = 'bot'`、`ILINK_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'`、`ILINK_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'`。`buildAuthorizedHeaders` 每次请求现算随机 uint32 十进制字符串 Base64 作为 `X-WECHAT-UIN`；`ILinkClient` 自动注入 `base_info` 并区分网络/超时/HTTP/协议/凭证失效（`-14` `stale_token`）错误链。
   - **扫码登录与原子持久化（`auth.ts`, `account-store.ts`）**：`runQrLogin` 实现完整 8 态状态机（`wait` / `scaned` / `need_verifycode` / `verify_code_blocked` / `scaned_but_redirect` / `binded_redirect` / `expired` / `confirmed`），支持数字配对码等待与 IDC 重定向；**先写入新凭据再清理旧账号文件**。所有状态以 `0o600` 权限原子落盘于 `~/.tracememo/wechat-connector/accounts/<id>.{json,sync.json,context.json}`（`context.json` 上限 500 条），并只读兼容历史目录 `~/.wechatexplorer/wechat-connector/accounts/`。
   - **可靠长轮询（`poller.ts`）**：默认超时 `35s`（采纳服务端 `longpolling_timeout_ms` 上限 `120s`）；客户端超时不计失败退避；`ret/errcode = -14` 立即停轮询并触发 `stale_token`（刻意保留游标以备重登续传）；**必须等待 `onMessages`（`WechatInboundInbox` 落盘）成功 resolve 后才保存 `get_updates_buf`**，确保 at-least-once 语义。
   - **端到端媒体加密与输入心跳（`media.ts`, `sender.ts`, `markdown.ts`, `typing.ts`, `messages.ts`）**：上传媒体时生成随机 16 字节 `AES-128-ECB` 密钥，调 `getuploadurl`（显式 `no_need_thumb: true`），加密后 POST 至 CDN 取得 `X-Encrypted-Param`，再通过 `sendmessage` 下发 `encrypt_type: 1` 与 `base64(hexKey)`；文本经 `markdownToPlainText` 降级。`TypingCoordinator` 通过 `getconfig` 缓存 `typing_ticket`（24h TTL）并按引用计数每 `ILINK_TYPING_KEEPALIVE_MS = 5_000ms` 维持 `status=1`，结束发 `status=2`，任何失败退化为 `NOOP_LEASE` 绝不阻断业务。
3. **Personal 通道平台差异（`personal-wechat-send-service.ts`, `mac-wechat-runtime-manager.ts`）**：
   - **Windows 路径（`personal-wechat-send-service.ts:831-887, 1265-1443`）**：连接用户配置的本地 Hook HTTP 服务 `127.0.0.1:<port>`（`GET /getLoginInfo`、`POST /SendMsg`）。对非 ASCII 路径或超长路径媒体（图片/视频/文件/SILK 语音）自动拷贝到纯 ASCII 临时目录并在发送后延迟清理，解决 Hook 中文路径失败与复制截断诊断。
   - **macOS 进程隔离与生命周期管理（`mac-wechat-runtime-manager.ts:265-1253`）**：
     - Electron 绝不 `dlopen` 原生 dylib，而是先 `codesign --verify` 并尝试 adopt 已存活的 `tm-wechat-host`（允许 Host 跨 TraceMemo 重启保持绑定会话），否则 spawn `tm-wechat-host` 监听 `127.0.0.1:4290..4293`（`PORT_FALLBACK_SPAN = 3`，支持 `TM_WECHAT_HOST_PORT` 覆盖）。
     - **孤儿 Agent 保护（`wechatRestartRequired`）**：Host 在绑定微信期间崩溃或退出会在微信进程内遗留无法从外部卸载的 Frida agent，Manager 立即置 `wechatRestartRequired = true` 并记录 `orphanWechatPid`（禁止自动重启绑定死循环），仅当检测到微信进程重启（`currentWechatPid !== orphanWechatPid`）或后续观测到同一 PID 重新健康就绪时自动清除（`L807-819, L1055-1070`）。
     - **协议机制分流与授权接口**：根据 `runtime-manifest.json` 能力按微信版本选择 `tm-message-source-send`（走 `POST /sendMsg`，支持原生群 `@`、`file` 与微信沙盒目录图片暂存）或传统接口（`/sendText`、`/uploadImage`+`/sendImage`、`/uploadVoice`+`/sendVoice`、`/SendMsg`）；并通过 `/license/status`（8s 超时）与 `/license/refresh`（20s 超时）管理 Mac 授权，网络错误映射到 `server_unavailable` 而非误报撤销。
4. **`AgentHubService` 与纯规则入站路由（`agent-hub-service.ts`, `agent-hub-routing.ts`, `wechat-inbound-inbox.ts`）**：
   - **收件箱落盘**：`handleInboundMessages` 经 `recentlyHandled`（10 分钟 TTL）去重后写入 `WechatInboundInbox`（`0o600` 权限、上限 200 条、单条最多重试 3 次），驱动单协程 `pump()` 串行消费；应用启动时 `resumePendingInbound()` 自动补处理残留消息。
   - **四路纯规则路由（`resolveInboundRoute`, `agent-hub-routing.ts:138-146`）**：无前置 LLM 分类——`report_action`（需同时含「群」+ 明确产物词）→ `generateAndSendReport`；`group_member_action` → `summarizeGroupMemberChat`；`recent_list`（必须命中名单形态且排除 `RECENT_CONTENT_PROBE` 内容探针词）→ `listRecentChat`；其余全部直达共享 `AskWechatService`（Query Agent），经 `queryAgentReplyText` 剥离 `[E#]` 引用编号并由 `formatWechatReplyText` 用空行 `\n\n` 分隔列表项后发出；`deliver()` 若检测到正文含 Markdown 图片 URL 会自动补发独立图片消息。

---

## 4. 关键文件与符号索引

### 4.1 导出与群日报核心文件

| 仓库路径 | 核心导出符号 / 关键常量 | 行号定位 |
|---|---|---|
| `src/main/export-service.ts` | `runExport`, `cancelExport`, `revealExport`, `readHtmlArchive`, `writeHtmlArchive`, `pruneHtmlArchiveResources`, `exportMessageKey`, `mergeHtmlArchiveMessages` | `L235-306`, `L337-414`, `L468-555`, `L1861-1877` |
| `src/main/export-html-template.ts` | `EXPORT_PAGE_SIZE` (240), `renderExportPage`, `safe`, `esc` | `L1-3`, `L854-860`, `L940-974`, `L1887-1950` |
| `src/shared/report-templates.ts` | `DEFAULT_REPORT_TEMPLATE`, `REPORT_TEMPLATES` (5 款), `SELECTABLE_REPORT_TEMPLATES`, `getReportTemplate`, `encodeExternalReportTemplateId` | `L32-145` |
| `src/shared/report-template-package.ts` | `REPORT_TEMPLATE_PACKAGE_PROTOCOL_VERSION` ('1.0'), `REPORT_TEMPLATE_INTERFACE_VERSION` ('1'), `REPORT_TEMPLATE_LIMITS`, `REPORT_TEMPLATE_PLACEHOLDERS`, `REPORT_TEMPLATE_ALLOWED_TAGS`, `REPORT_TEMPLATE_ALLOWED_ATTRS`, `ReportTemplateError` | `L3-98` |
| `src/shared/report-template-market.ts` | `REPORT_TEMPLATE_CATALOG_URL` | `L3-4` |
| `src/shared/report-template-fragment-contract.ts` | `REPORT_TEMPLATE_FRAGMENT_CONTRACT_VERSION`, `REPORT_TEMPLATE_FRAGMENT_CONTRACT_CSS` | `L1-130` |
| `src/main/group-report-service.ts` | `detectImageMime`, `embedAvatar`, `extractGroupReportRenderSnapshot`, `exportGroupReport`, `exportGroupReportSnapshot`, `addReportCsp`, `captureFullPage` | `L124-144`, `L215-239`, `L293-320`, `L799-1212` |
| `src/main/report-template-service.ts` | `ReportTemplateService`, `reportTemplateService`, `validateReportTemplateHtml` | `L143-184`, `L232-408` |
| `src/main/report-template-market-service.ts` | `ReportTemplateMarketService`, `reportTemplateMarketService`, `CATALOG_MAX_BYTES` (2MB) | `L20-21`, `L207-243` |
| `src/main/report-template-ipc.ts` | `registerReportTemplateIpc` (注册 6 条模板与日报导出 IPC) | `L9-41` |
| `src/main/report-history-service.ts` | `listGeneratedReports`, `saveGeneratedReport` | `L114-200` |
| `src/main/services/agent-group-report-service.ts` | `generateAgentGroupReport`, `hydrateGroupMemberIdentity`（注：反向导入 `src/renderer/src/utils/group-report.ts`） | `L14-22`, `L40-63`, `L97-231` |
| `resources/daily_report_templates.html` | 新版 5 套内置模板共用宿主 HTML | 全文 |
| `resources/mobile_daily_report_v1.html`、`resources/mobile_daily_report_v2.html`、`resources/mobile_daily_report.html` | 经典 `v1`、`v2` 兼容模板及历史遗留模板 | 全文 |
| `examples/report-template-basic/` | 最小外置模板参考包（`manifest.json`、`template.html`、`README.md`） | 全文 |

### 4.2 退群监控与自动化核心文件

| 仓库路径 | 核心导出符号 / 关键常量 | 行号定位 |
|---|---|---|
| `src/main/services/group-exit-monitor-service.ts` | `GroupExitMonitorService`, `DB_CHANGE_DEBOUNCE_MS` (350ms), `DUPLICATE_WINDOW_MS` (2min), `MAX_EVENTS` (500) | `L61-71`, `L85-912` |
| `src/shared/group-exit-event.ts` | `GroupMemberExitedEvent`, `toGroupMemberExitedEvent`, `renderLeaveNotificationText` | `L19-87` |
| `src/shared/msg-insert-switch.ts` | `MSG_INSERT_SWITCHES`, `MSG_INSERT_SCOPES`, `MsgInsertSwitchStatus`, `CapabilityView` | `L17-142` |
| `src/main/services/msg-insert-switch-service.ts` | `SWITCH_MODE`, `resolveHelperPath`, `readMsgInsertSwitches`, `applyMsgInsertSwitch`, `reconcileMsgInsertRules` | `L98-103`, `L160-187`, `L613-777` |
| `src/main/services/wechat-local-exit-notice-service.ts` | `WechatLocalExitNoticeService`, `wechatLocalExitNoticeService`, `configureWechatLocalExitNotice` | `L82-239` |
| `src/main/services/msg-insert-capability-service.ts` | `mapLicenseStatus`, `probeLicenseStatus` | `L69-160` |
| `src/main/services/message-listener-service.ts` | `MessageListenerService`, `extractMentionTargets`, `decodeSourcePayload`, `DEFAULT_COALESCE_MS` (120ms), `DEFAULT_DEDUP_TTL_MS` (5min) | `L40-52`, `L133-185`, `L204-469` |
| `src/shared/automation-matcher.ts` | `matchAutomationRule` | `L50-102` |
| `src/shared/automation.ts` | `AUTOMATION_RULE_TYPE_LABELS`, `AutomationRuleType` (`daily_report`/`scheduled_report`/`leave_notification`) | `L41-48` |
| `src/main/services/automation-service.ts` | `AutomationService`, `leaveNotificationExecutionId`, `leaveNotificationIdempotencyKey`, `scheduledReportExecutionId`, `GATE_MAX_ENTRIES` (5000), `CLAIM_TTL_MS` (10min) | `L66-96`, `L105-134`, `L155-1001` |
| `src/main/services/automation-rule-store.ts` | `AutomationRuleStore`, `AutomationRulePersistenceError` | `L53-58`, `L216-670` |
| `src/main/services/automation-action-runner.ts` | `AutomationActionRunner` (`run`/`runScheduledReport`/`runLeaveNotification`) | `L295-945` |
| `src/main/services/scheduled-report-service.ts` | `ScheduledReportService`, `resolveDueScheduledSlot`, `TICK_MS` (15s), `NON_NOTIFYING_ERROR_CODES` | `L74-86`, `L137-1003` |

### 4.3 双通道微信网关与 AgentHub 核心文件

| 仓库路径 | 核心导出符号 / 关键常量 | 行号定位 |
|---|---|---|
| `src/main/services/wechat-action-gateway.ts` | `WechatActionGateway`, `wechatActionGateway`, `evaluateWechatActionPolicy`, `AUTOMATION_SEND_INTERVAL_MS` (3s), `AUTOMATION_PURPOSE_ALLOWLIST`, `MAX_AUDIT_RECORDS` (500) | `L22-51`, `L95-543` |
| `src/shared/wechat-send.ts` | `normalizeWechatSendRequest`, `resolveSendTransport`, `buildSendPreview`, `MAX_SEND_PREVIEW_LENGTH` (200) | `L71-162` |
| `src/main/services/wechat-send-gateway.ts` | `WechatSendGateway`, `wechatSendGateway`, `unifiedToPersonalRequest` | `L58-357` |
| `src/main/services/personal-wechat-capability-service.ts` | `PersonalWechatCapabilityService`, `personalWechatCapabilityService`, `getPersonalWechatSendCapability` | `L20-116` |
| `src/main/services/personal-wechat-send-service.ts` | `PersonalWechatSendService`, `personalWechatSendService`, `buildWindowsWechatRequest`, `normalizeWindowsWechatPort` | `L55-61`, `L606-653`, `L782-1446` |
| `src/main/services/mac-wechat-runtime-manager.ts` | `MacWechatRuntimeManager`, `macWechatRuntimeManager`, `deriveMacWechatSenderStatus`, `shouldClearWechatRestartRequired`, `resolveLicenseRefreshFailure`, `DEFAULT_PORT` (4290), `PORT_FALLBACK_SPAN` (3) | `L56-57`, `L104-263`, `L265-1253` |
| `src/main/services/wechat-ilink/types.ts` | `ILINK_DEFAULT_BASE_URL`, `ILINK_CDN_BASE_URL`, `ILINK_CHANNEL_VERSION` ('2.4.6'), `ILINK_STALE_TOKEN_CODE` (-14), `ILINK_TYPING_KEEPALIVE_MS` (5s) | `L9-72` |
| `src/main/services/wechat-ilink/headers.ts` | `generateWechatUin`, `buildAuthorizedHeaders`, `buildQrStatusHeaders`, `buildBaseInfo` | `L42-84` |
| `src/main/services/wechat-ilink/client.ts`、`src/main/services/wechat-ilink/errors.ts` | `ILinkClient`, `ILinkError`, `assertBusinessOk`, `classifyNetworkError` | 全文 |
| `src/main/services/wechat-ilink/auth.ts`、`src/main/services/wechat-ilink/account-store.ts` | `runQrLogin`, `saveCredentials`, `loadCursor`, `saveCursor`, `saveContextToken`, `loadContextToken` | 全文 |
| `src/main/services/wechat-ilink/poller.ts`、`src/main/services/wechat-ilink/messages.ts` | `ILinkPoller`, `normalizeInboundMessage`, `extractInboundText` | 全文 |
| `src/main/services/wechat-ilink/media.ts`、`src/main/services/wechat-ilink/sender.ts`、`src/main/services/wechat-ilink/markdown.ts` | `uploadMediaToCdn`, `sendMedia*`, `sendText`, `markdownToPlainText`, `extractMarkdownImageUrls` | 全文 |
| `src/main/services/wechat-ilink/typing.ts`、`src/main/services/wechat-ilink/index.ts` | `TypingCoordinator`, `WechatConnectorService` | 全文 |
| `src/main/services/wechat-inbound-inbox.ts` | `WechatInboundInbox`, `inboxKeyFor`, `DEFAULT_MAX_ATTEMPTS` (3), `DEFAULT_MAX_ENTRIES` (200) | `L40-189` |
| `src/main/services/agent-hub-routing.ts` | `resolveInboundRoute`, `matchGroupReportIntent`, `matchGroupMemberChatIntent`, `matchRecentChatIntent`, `formatWechatReplyText`, `queryAgentReplyText` | `L35-196` |
| `src/main/services/agent-hub-service.ts` | `AgentHubService`, `HEALTH_INTERVAL_MS` (5s), `HANDLED_MESSAGE_TTL_MS` (10min) | `L55-58`, `L182-1285` |

---

## 5. 后续维护与开发指南

### 5.1 常见陷阱与防踩坑清单

1. **禁止将 `renderer` 侧工具误认为纯前端代码**：`src/main/services/agent-group-report-service.ts:14-22` 直接导入了 `src/renderer/src/utils/group-report.ts` 中的 Prompt、输入构造与 JSON 解析器。修改该渲染层文件时**必须严禁引入 DOM / React / `window` 依赖**，否则会直接破坏主进程日报生成与自动化任务。
2. **模板沙箱任何放宽需同步审查五层防线**：新增外部模板占位符必须同步修改 `src/shared/report-template-package.ts` 与 `src/main/group-report-service.ts`；若新增 `'class'` 以外的占位符，不可允许其进入 HTML 属性或 `<style>`；`BrowserWindow` 截图的随机 `partition` 与 `webRequest.onBeforeRequest` 白名单拦截不可移除。
3. **绝对不要在主进程打开可写 WCDB 句柄**：任何向微信分片写配置/规则/提示消息的需求，必须交由 `tm-wcdb-config-helper` 一次性子进程通过 `stdin` JSON 执行，并在事后用只读路径复核状态。
4. **维护自动化闸门顺序与原子性**：
   - `AutomationService.handleMessage` 中 `isGated()` 到 `claimGate()` 之间绝不能插入 `await`；
   - `handleGroupExit` 中 `leaveNotificationCoversRoom` 必须位于 `claimGroupExit` 之前，否则未勾选群会抢占事件幂等位；
   - 新增自动化发送 `purpose` 必须同时登记 `src/shared/automation.ts` 与 `src/main/services/wechat-action-gateway.ts` 的 `AUTOMATION_PURPOSE_ALLOWLIST`，否则会被策略层以 `ACTION_NOT_ALLOWED` 拦截。
5. **AgentHub 与 iLink 游标/令牌红线**：`ILinkPoller` 的游标推进必须在 `WechatInboundInbox.accept` 成功落盘之后；`context_token` 与 `bot_token` 绝不写入普通日志；微信回复文本中的列表项必须保留空行 `\n\n`（`formatWechatReplyText`），否则微信客户端会把单换行 `\n` 压缩成空格。
6. **macOS `tm-wechat-host` 重启门禁**：`MacWechatRuntimeManager` 标记 `wechatRestartRequired` 是为了规避绑定态崩溃留下的孤儿 Frida agent 造成 `20s` 附加超时死锁；切勿将其改成「后台自动重启微信并自动重绑」。

### 5.2 常见扩展方式

- **新增内置群日报模板**：在 `src/shared/report-templates.ts` 的 `REPORT_TEMPLATES` 注册定义与 `captureWidth`，并在 `resources/daily_report_templates.html` 中添加对应的 `.template-*` 样式规则与渲染适配。
- **新增导出消息类型或 HTML 归档字段**：在 `src/main/export-service.ts` 更新 `kindOf` 与 `htmlArchiveSourceSignature`（确保新增字段变更能触发增量刷新），同步在 `src/main/export-html-template.ts` 使用 `esc()`/`displayText()` 安全渲染。
- **新增 AgentHub 入站确定性命令**：在 `src/main/services/agent-hub-routing.ts` 编写无副作用、可单测的纯匹配函数并接入 `resolveInboundRoute`，同时保持查询类问题直达 `AskWechatService` 而无需前置 LLM 意图分类。

### 5.3 验证命令

关于全仓测试分层与平台门禁详见 [08. 测试体系与质量门禁](./08-testing-and-quality-gates.md)；修改本专题覆盖模块后建议执行以下定向验证：

```bash
# 1. 类型检查与知识库引用校验
pnpm typecheck
node scripts/check-knowledge-base.mjs

# 2. 导出、群日报与模板安全单测
npx vitest run tests/unit/export-media.test.ts tests/unit/group-report.test.ts tests/unit/group-report-avatar-download.test.ts tests/unit/group-report-avatar-enrichment.test.ts tests/unit/group-report-member-hydration.test.ts tests/unit/report-template-service.test.ts tests/unit/report-template-market.test.ts tests/unit/report-history-service.test.ts tests/integration/export-media-flow.test.ts

# 3. 退群监控与自动化防回环引擎单测/集成测试
npx vitest run tests/unit/group-exit-monitor-service.test.ts tests/unit/automation-matcher.test.ts tests/unit/automation-service.test.ts tests/unit/automation-service-group-exit.test.ts tests/unit/automation-action-runner.test.ts tests/unit/automation-rule-store.test.ts tests/unit/scheduled-report-service.test.ts tests/integration/automation-chain.test.ts tests/integration/scheduled-report-automation.test.ts

# 4. 双通道网关、iLink 协议与 AgentHub 测试
npx vitest run tests/unit/wechat-action-gateway.test.ts tests/unit/wechat-send-gateway.test.ts tests/unit/personal-wechat-send-service.test.ts tests/unit/personal-wechat-capability-service.test.ts tests/unit/mac-wechat-runtime-manager.test.ts tests/unit/wechat-ilink-protocol.test.ts tests/unit/wechat-ilink-poller.test.ts tests/unit/wechat-ilink-auth.test.ts tests/unit/wechat-ilink-account-store.test.ts tests/unit/wechat-ilink-typing.test.ts tests/unit/wechat-inbound-inbox.test.ts tests/unit/agent-hub-routing.test.ts tests/integration/agent-hub-inbound-flow.test.ts tests/integration/wechat-send-api.test.ts
```
