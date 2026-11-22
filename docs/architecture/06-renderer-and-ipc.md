# 渲染进程、共享契约与 IPC 通信全景

> **源码基线**：Git commit `9efb8ac`（`package.json` `version: 2.7.0`）
> **覆盖范围**：`src/renderer/`（272 个文件）、`src/shared/`（75 个文件）、`src/preload/`（2 个文件）、`src/env.d.ts`，以及主进程侧 `ipcMain` / `webContents.send` / `event.sender.send` 注册点与隔离协议实现。
> **关联文档**：[知识库总览](./README.md) · [系统总览](./01-system-overview.md) · [主进程与数据层](./02-main-process-and-data.md) · [构建、脚本与打包](./07-build-scripts-and-packaging.md) · [测试与质量门禁](./08-testing-and-quality-gates.md)

---

## 一、架构总览

TraceMemo 桌面端 UI 与跨进程契约层由三个紧密解耦的源码目录共同支撑：

| 层级 | 目录 | 文件数 | 核心角色与运行环境 |
|---|---|---:|---|
| 渲染进程层 | `src/renderer/` | 272 | 基于 React 19 + TypeScript 的单窗口 SPA，承载 10 大一级工作区、双轨样式体系与 22 个 Radix UI 原语组件；运行在 Chromium 沙箱关闭但上下文隔离开启的页面环境中，**零直接 `fetch()` 调用** |
| 预加载桥接层 | `src/preload/` | 2 | 由 `src/preload/index.ts` 与 `src/preload/index.d.ts` 组成，通过 `contextBridge.exposeInMainWorld` 向渲染层注入 `window.api`（257 个方法）与 `window.electron` |
| 共享契约层 | `src/shared/` | 75 | 纯 TypeScript 类型、协议常量、校验器与工具函数，按 9 大主题域组织，零 Electron/Node/DOM 运行时依赖，同时被 `tsconfig.node.json` 与 `tsconfig.web.json` 引入 |

### 进程隔离与通信拓扑

```text
+-----------------------------------------------------------------------------------+
| 渲染进程 (src/renderer/)                                                           |
|   App.tsx (React State 枚举路由 / 10 大工作区)                                     |
|     ├─ 主体 UI ──────────────────────► window.api.* (240 invoke + 17 on)          |
|     └─ 扩展页面宿主 (ExtensionPageHost.tsx)                                        |
|          └─ <iframe sandbox="allow-scripts" src="tm-extension://...">             |
|               (无 Node / 无 preload / connect-src 'none')                          |
|               └─ postMessage ──► window.api.extensionPageRequest                  |
+-----------------------------------------------------------------------------------+
                                         │ contextBridge (sandbox: false, contextIsolation: true)
                                         ▼
+-----------------------------------------------------------------------------------+
| 预加载层 (src/preload/index.ts & src/preload/index.d.ts)                           |
|   - 封装 240 条 ipcRenderer.invoke + 17 条 ipcRenderer.on（返回取消订阅闭包）       |
|   - 暴露 @electron-toolkit/preload 的 electronAPI (window.electron)               |
+-----------------------------------------------------------------------------------+
                                         │ Electron IPC
                                         ▼
+-----------------------------------------------------------------------------------+
| 主进程 IPC 注册点                                                                  |
|   - src/main/index.ts (202 handle + 1 遗留 on('ping'))                            |
|   - src/main/extensions/extension-ipc.ts (32 handle, 含 isTrustedSender 校验)      |
|   - src/main/report-template-ipc.ts (6 handle)                                    |
|   - 主动推送：13 条 webContents.send 广播 + 4 条 event.sender.send 定向推送         |
+-----------------------------------------------------------------------------------+
          ▲ 类型、协议常量、输入校验函数单一真相源（部分存在预加载手写漂移）
          │
+-----------------------------------------------------------------------------------+
| 共享契约层 (src/shared/，75 文件，9 大主题域)                                      |
+-----------------------------------------------------------------------------------+
```

与本层衔接的其他专题详见：

- 主进程窗口托管、数据存储与 `Wcdb4Client` 详见 [主进程与数据层](./02-main-process-and-data.md)。
- Knowledge FTS5、图片 OCR、SenseVoice 与 `QueryAgentService` 链路详见 [03. 知识库、语音与 AI 检索管道](./03-knowledge-and-ai-pipeline.md)。
- 日报渲染、退群监控、自动化与 `AgentHubService` 详见 [04. 报告导出、自动化与 Agent Hub](./04-reports-automation-hub.md)。
- 本地 HTTP API（`127.0.0.1:6131`）与扩展中心宿主实现详见 [05. Local HTTP API、扩展中心与外围服务](./05-http-api-and-extensions.md)。

---

## 二、模块职责与边界

### 2.1 渲染进程 `src/renderer/`（272 个文件）

`src/renderer/` 不直接访问文件系统、SQLite、Node 原生模块或本地 HTTP 服务，全部数据与副作用均收敛至 `window.api.*`（外加极少量的 `window.electron.process` 环境探测与 `localStorage` 轻量偏好持久化）。

#### 顶层入口与全局骨架分布

| 目录 / 文件 | 文件数 | 职责说明 |
|---|---:|---|
| `src/renderer/index.html` | 1 | 渲染进程 HTML 宿主，标题 `TraceMemo（迹忆）`，声明严格 CSP：`frame-src tm-extension:; img-src 'self' data: https: wxe-media:; media-src 'self' https: blob: data: wxe-media:` |
| `src/renderer/src/main.tsx` | 1 | React 19 挂载入口（`React.StrictMode`），按序加载 `src/renderer/src/styles/tailwind.css` 与 `src/renderer/src/styles/index.scss`，注册全局 `error` 与 `unhandledrejection` 监听器并经 `window.api.writeAppLog` 落盘，外层包裹 `TooltipProvider` 与 `ToastProvider` |
| `src/renderer/src/App.tsx` | 1 | 2403 行核心根状态机，统筹数据库自动/手动登录状态机、联系人与消息分页缓存、实时数据库变更监听（`onWcdbChange`）、10 大工作区条件挂载及跨工作区深链流转 |
| `src/renderer/src/env.d.ts` | 1 | 仅含 `/// <reference types="vite/client" />` |
| `src/renderer/src/lib/cn.ts` | 1 | 基于 `clsx` + `tailwind-merge` 的 `cn()` 类名合并工具 |
| `src/renderer/src/types/wechat-emojis.d.ts` | 1 | `wechat-emojis` 表情资源类型补充声明 |
| `src/renderer/src/assets/` | 3 | `brand-icon.svg`、`electron.svg`、`wavy-lines.svg` |
| `src/renderer/src/hooks/` | 2 | `useGroupExitEvents.ts`（群聊内联退群推断事件）、`useGroupReportGeneration.ts`（手动群日报生成状态机） |
| `src/renderer/src/utils/` | 11 | 联系人头像与搜索（`contact-avatar.ts`、`contact-search.ts`）、消息分页与监听过滤（`message-pages.ts`、`message-monitor.ts`、`quoted-messages.ts`、`voice-message-reference.ts`、`wechatEmojiText.tsx`）、日报事实与换版（`group-report.ts`、`group-report-facts.ts`、`report-template-switch.ts`）、运行时平台检测（`runtime-environment.ts`） |
| `src/renderer/src/styles/` | 26 | `tailwind.css` + `index.scss` + `_tokens.scss` + `_base.scss` + `theme.scss` + 21 个业务/模块 SCSS |

#### 组件与业务特性目录分布（`src/renderer/src/components/` 与 `src/renderer/src/features/`）

| 目录 | 文件数 | 核心组件与职责边界 |
|---|---:|---|
| `src/renderer/src/components/`（顶层） | 10 | 登录引导与基础气泡：`DatabaseConnectionPage.tsx`、`FirstUseWelcome.tsx`、`ChatWindow.tsx`、`Sidebar.tsx`、`ImageBubble.tsx`、`RichMessageBubble.tsx`、`VideoBubble.tsx`、`VoicePlayer.tsx`、`Versions.tsx`、`image-loader.ts` |
| `src/renderer/src/components/account/` | 1 | `AccountSummary.tsx`（左侧主导航底部与各侧栏账号/连接态徽标） |
| `src/renderer/src/components/layout/` | 3 | `navigation.ts`（`AppPage` 与 `PRIMARY_NAV_ITEMS`）、`AppShell.tsx`（注入 `data-theme` 与 `is-compact`，托管主导航栏）、`PrimaryNavigation.tsx`（退群未读角标与发送能力 `!` 告警角标） |
| `src/renderer/src/components/conversation/` | 5 | 会话侧栏：`ConversationSidebar.tsx`、`ConversationSidebarHeader.tsx`、`ConversationSearch.tsx`、`ConversationSection.tsx`、`ConversationItem.tsx` |
| `src/renderer/src/components/chat/` | 21 | 消息流与聊天辅助：`ChatHeader.tsx`、`MessageList.tsx`、`MessageGroup.tsx`、`MessageBubble.tsx`、`ChatImageViewer.tsx`、`ChatStatusBar.tsx`、`ConversationContentSearch.tsx`、`DataTrustBar.tsx`、`EmptyConversationState.tsx`、`ExportMenu.tsx`、`GroupExitEventBubble.tsx`、`PersonalWechatChatComposer.tsx`、`PersonalWechatSendDialog.tsx`、`PersonalWechatSetupGuide.tsx`、`PersonalWechatVoiceDiagnosticDialog.tsx`、`PersonalWechatWindowsSendDialog.tsx`、`ReportImagePostfixInput.tsx`、`useReportImagePostfixSetting.ts`、`messageGrouping.ts`、`messageJump.ts`、`icons.tsx` |
| `src/renderer/src/components/export/` | 8 | 导出工作区：`ExportWorkspace.tsx`、`ExportContactPanel.tsx`、`ExportConfigurationPanel.tsx`、`ExportPreviewPanel.tsx`、`ExportTaskCenter.tsx`、`exportPreferences.ts`、`exportTypes.ts`、`exportUtils.ts` |
| `src/renderer/src/components/group-stats/` | 1 | `GroupMemberStatsDialog.tsx`（群成员发言统计弹窗） |
| `src/renderer/src/components/reports/` | 23 | 日报生成、历史浏览与模板市场：`AiReportWorkspace.tsx`、`ReportHistorySidebar.tsx`、`ReportSourceSidebar.tsx`、`ReportViewer.tsx`、`ReportInfoPanel.tsx`、`ReportTaskStatusPanel.tsx`、`ReportTemplateMarketWorkspace.tsx`、`ReportTemplateSelector.tsx`、`ReportTemplatePreview.tsx`、`WechatShareCardDialog.tsx` 等 |
| `src/renderer/src/components/search/` | 24 | 问问微信（AI 搜索）：`AISearchWorkspace.tsx`、`AISearchComposer.tsx`、`AISearchEvidencePanel.tsx`、`ExternalProviderConsentDialog.tsx`、`ImageTextIndexCard.tsx`、`ImageTextIndexSummary.tsx`、`KnowledgeIndexCard.tsx`、`queryAgentBridge.ts`、7 个专用 Hooks 与服务桥接 |
| `src/renderer/src/components/ui/` | 23 | `index.ts` + 22 个基于 Radix UI 与 CVA 的基础 UI 原语（清单见 3.4 节） |
| `src/renderer/src/features/agent-hub/` | 2 | `AgentHubWorkspace.tsx`、`AgentHubConversationPanel.tsx` |
| `src/renderer/src/features/api-center/` | 19 | `ApiWorkspace.tsx`、`src/renderer/src/features/api-center/hooks/useApiCenterController.ts`、`src/renderer/src/features/api-center/services/localApiClient.ts`、`src/renderer/src/features/api-center/model/`（5 文件）、`src/renderer/src/features/api-center/utils/`（4 文件）、`src/renderer/src/features/api-center/components/`（8 文件） |
| `src/renderer/src/features/app-update/` | 2 | `AppUpdatePrompt.tsx`、`useAppUpdateState.ts` |
| `src/renderer/src/features/automation/` | 19 | `AutomationWorkspace.tsx`、`RuleListPanel.tsx`、`RuleEditorPanel.tsx`、`ExecutionLogPanel.tsx`、`ExecutionDetailDrawer.tsx`、`ScheduledReportEditor.tsx`、`ScheduledReportNotificationPanel.tsx`、`ScheduledReportRuleList.tsx`、`LeaveNotificationEditor.tsx`、`MessageInsertSwitches.tsx`、`AutomationRuleTypeTabs.tsx`、`ExtensionActionList.tsx`、`EffectPreview.tsx`、`src/renderer/src/features/automation/model/`（3 文件）等 |
| `src/renderer/src/features/extensions/` | 5 | `ExtensionWorkspace.tsx`、`ExtensionPageHost.tsx`、`ExtensionTemplateGallery.tsx`、`CreateProjectDialog.tsx`、`DevelopmentGuide.tsx` |
| `src/renderer/src/features/group-exit-monitor/` | 2 | `GroupExitMonitorWorkspace.tsx`、`LeaveMonitorAutomationEntry.tsx` |
| `src/renderer/src/features/logs/` | 1 | `LogsWorkspace.tsx`（在设置页 `wechat-action-logs` 复用展示发送动作审计日志） |
| `src/renderer/src/features/settings/` | 55 | `SettingsWorkspace.tsx`、`src/renderer/src/features/settings/model/`（`settingsNavigation.ts`、`types.ts`）、`src/renderer/src/features/settings/pages/`（`pages/` 共 13 个设置子页文件，`SETTINGS_NAVIGATION` 公开 13 项菜单，`SettingsWorkspace.tsx` `switch (selectedCategory)` 覆盖 16 个显式分支（含 `personal-wechat-send`、`recall-protection`、`storage-export` 3 个隐藏/保留分支），`SettingsCategoryId` 共 17 个联合成员（含已废弃的 `local-api`））、`src/renderer/src/features/settings/account-database/`（6 文件）、`src/renderer/src/features/settings/ai-model/`（8 文件）、`src/renderer/src/features/settings/database-key/`（10 文件）、`src/renderer/src/features/settings/image-decryption/`（11 文件）、`src/renderer/src/features/settings/components/`（4 文件） |

#### 10 大一级工作区映射表

`AppPage` 联合类型（`src/renderer/src/components/layout/navigation.ts:1-11`）定义了全部 10 个一级工作区，按左侧导航栏从上到下顺序对应如下：

| `AppPage` ID | 导航标签 | 挂载入口组件 | 核心职责与内部子视图 |
|---|---|---|---|
| `archive` | 档案 | `App.tsx` `renderArchiveWorkspace` → `Sidebar` (`ConversationSidebar.tsx`) + `ChatWindow.tsx` | 联系人/群聊分组检索、可拖拽分栏（260–380px）、消息流分页、媒体解密展示、引用补全、群成员统计弹窗、退群推断内联事件与个人微信测试发送弹窗 |
| `search` | 问问微信 | `src/renderer/src/components/search/AISearchWorkspace.tsx` | 双引擎 AI 检索（主路径 `ask-wechat:*` Query Agent，能力缺失或配置关闭时回退 `ai-search:*` Legacy Pipeline）、Knowledge FTS5 与 OCR 索引状态卡片、外部 AI 数据脱敏授权弹窗、可跳回原消息的证据侧栏 |
| `report` | 日报 | `App.tsx` `renderReportWorkspace` → `ReportHistorySidebar.tsx` / `ReportViewer.tsx` / `ReportInfoPanel.tsx` / `ReportSourceSidebar.tsx` / `AiReportWorkspace.tsx` / `ReportTaskStatusPanel.tsx` / `ReportTemplateMarketWorkspace.tsx` | 双 Tab：`今日日报`（`result` 历史列表/多模板重排版/微信分享卡片 vs `configure` 单群配置生成）与 `社区模板市场`；顶部提供“去自动化配置 →”深链按钮（注：定时日报已并入 `automation`，此处不再作为独立 Tab） |
| `exit-monitor` | 退群监控 | `src/renderer/src/features/group-exit-monitor/GroupExitMonitorWorkspace.tsx` | 监控总开关、即时触发检测、退群事件时间线、监控群聊范围管理（`manage` 视图）；通过 `openLeaveNotificationAutomation` 深链直达 `automation` 退群通知规则 |
| `automation` | 自动化 | `src/renderer/src/features/automation/AutomationWorkspace.tsx` | 顶部三块实时状态（监听 / 发送能力 / 今日执行）；双 Tab：`规则`（`@我生成日报`、`定时日报`、`退群通知` 规则与 `MessageInsertSwitches` 微信消息插入开关）与 `执行日志`（含 `ExecutionDetailDrawer`） |
| `extensions` | 扩展 | `src/renderer/src/features/extensions/ExtensionWorkspace.tsx` + `ExtensionPageHost.tsx` | 三视图：`extensions`（已安装/开发联调扩展、启停、高风险权限二次确认、运行日志、数据目录）、`templates`（模板画廊与脚手架创建）、`guide`（开发指南）；打开扩展页面时挂载 `ExtensionPageHost` 沙箱 `iframe` |
| `agent-hub` | Agent | `src/renderer/src/features/agent-hub/AgentHubWorkspace.tsx` + `AgentHubConversationPanel.tsx` | 内嵌微信连接器（iLink）扫码登录/重连/断开、Agent Hub 运行态与本地 API/DB 状态、800 条上限实时日志过滤与复制、本机交互会话回看 |
| `export` | 导出 | `src/renderer/src/components/export/ExportWorkspace.tsx` | 单选/多选（最多 5 个）/全量会话导出（HTML/JSON/TXT/MD/CSV）、媒体与语音转写选项、实时预览面板、进度监控与任务中心（最近 20 条持久化至本地存储） |
| `api` | API | `src/renderer/src/features/api-center/ApiWorkspace.tsx` | Reader Skill 预览与安装指南复制、`LOCAL_API_ENDPOINTS` 全端点目录、在线调试器（通过 `localApiClient.ts` 调用 `window.api.testLocalApiRequest`，不走 `fetch`）、API 服务启停与 Token 查看/轮换 |
| `settings` | 设置 | `src/renderer/src/features/settings/SettingsWorkspace.tsx` | 左侧 4 分组共 13 个公开菜单项（连接：`account-database`/`database-key`/`image-key`；智能能力：`wechat-send`/`wechat-action-logs`/`voice-recognition`/`text-to-speech`/`ai-model`；数据管理：`local-index`/`cache-cleanup`；应用：`appearance`/`advanced`/`about`）；另保留 `storage-export` 与 `recall-protection`（已下线隐藏）以及 `personal-wechat-send` 兼容渲染分支 |

---

### 2.2 共享契约层 `src/shared/`（75 个文件，9 大主题域）

`src/shared/` 是跨进程的契约枢纽：不仅定义请求/响应接口，还承载**主/渲染进程共用的确定性纯逻辑**（如联系人拼音索引、群头像别名合并、自动化规则合法性校验、模板占位符与标签白名单、定时任务时间计算等），从而防止同一业务规则在主进程与 UI 层出现双份实现漂移。

| 主题域 | 文件数 | 文件清单与核心导出符号 / 协议常量 |
|---|---:|---|
| 1. 核心数据、账号与基础工具 | 9 | `src/shared/types.ts`（`Contact`、`Message`、`MessagesAroundResult`、`ParsedContent` 15 联合体、`ChatTable`）<br>`src/shared/contact-name.ts`（`displayContactName`、`filesystemSafeName`）<br>`src/shared/contact-resolution.ts`（`normalizeContactName`、`ContactResolutionResult`）<br>`src/shared/contact-search.ts`（`buildContactSearchIndex`、`filterContactSearchIndex`）<br>`src/shared/member-names.ts`（`resolveMemberName`）<br>`src/shared/wechat-identities.ts`（`WECHAT_FILE_HELPER_USERNAME`、`isFileHelperUsername`）<br>`src/shared/cache.ts`（`CacheSummary`、`CacheClearScope`）<br>`src/shared/database-key.ts`（`DatabaseInitResult`、`AccountDiscoveryResult`、`DatabaseKeyEnvironment`）<br>`src/shared/connection-diagnostics.ts`（`buildSafeDiagnosticSummary`） |
| 2. 群日报、模板协议与分享卡片 | 10 | `src/shared/group-report.ts`（`GroupDailyReport`、`GroupReportMetadata`、`ReportSectionKey`、`REPORT_AVATAR_ALIAS_FIELDS`、`buildReportAvatarAliasIndex`、`mergeReportAvatars`）<br>`src/shared/report-templates.ts`（`ReportTemplateId` 5 套内置新版 + `v1`、`REPORT_TEMPLATES`、`DEFAULT_REPORT_TEMPLATE`）<br>`src/shared/report-template-package.ts`（`REPORT_TEMPLATE_PACKAGE_PROTOCOL_VERSION='1.0'`、`REPORT_TEMPLATE_LIMITS`、`REPORT_TEMPLATE_PLACEHOLDERS`、`REPORT_TEMPLATE_ALLOWED_TAGS` / `ATTRS` / `ASSET_EXTENSIONS`、`ReportTemplateError`）<br>`src/shared/report-template-fragment-contract.ts`（`REPORT_TEMPLATE_FRAGMENT_CONTRACT_VERSION`、`REPORT_TEMPLATE_FRAGMENT_CONTRACT_CSS`）<br>`src/shared/report-template-market.ts`（`REPORT_TEMPLATE_CATALOG_URL`、`ReportTemplateCatalogEntry`）<br>`src/shared/report-history.ts`（`GeneratedReportRecord`、`SaveGeneratedReportRequest`）<br>`src/shared/scheduled-report.ts`（`ScheduledReportTask`、`ScheduledReportExecution`）<br>`src/shared/scheduled-report-api.ts`（`ScheduledReportApiTask`）<br>`src/shared/scheduled-report-error.ts`（`SCHEDULED_REPORT_ERROR_CODES`、`normalizeScheduledReportError`）<br>`src/shared/wechat-share-card.ts`（`WechatShareServiceConfig`、`PublishWechatShareCardRequest`） |
| 3. 知识库、AI 搜索与模型配置 | 5 | `src/shared/ai-provider.ts`（`AIProviderConfig`、`AIModelCapabilities`、`AIRuntimeModelConfig`、`ReportModelChoice`）<br>`src/shared/ai-search.ts`（888 行：`AiSearchPipelineRequest`、`AiSearchPipelineResult`、`AiSearchProgressEvent`、`aiSearchRangeStart`、`buildLocalAiSearchPlan`）<br>`src/shared/knowledge.ts`（628 行：`KNOWLEDGE_SCHEMA_VERSION`、`KnowledgeRuntimeStatus`、`KnowledgeSearchIpcRequest`、`KnowledgeWorkerRequest` / `Response`）<br>`src/shared/query-agent.ts`（`AskWechatConfig`、`AskWechatQueryRequest`、`AskWechatQueryResult`、`QueryAgentProgressEvent`）<br>`src/shared/local-query-api.ts`（506 行：`LOCAL_QUERY_TOOL_DEFINITIONS` 4 工具 Schema、`QueryTemporalBasisKind`、`decodeMessageRef`、`QueryEvidenceItem`） |
| 4. 图片解密、OCR 与表情包 | 9 | `src/shared/image-decryption.ts`（`ImageDecryptionStatus`、`ImageDecoderStatus`、`ImageKeyConfigResult`）<br>`src/shared/image-debug-info.ts`（`IMAGE_DEBUG_KIND`、`ImageDebugInfoRequest` / `Result`）<br>`src/shared/image-insight.ts`（`ImageInsight`、`IMAGE_INSIGHT_CACHE_TTL_MS`、`calculateImageHeatScore`）<br>`src/shared/image-message-xml.ts`（`ImageMessageXmlRequest` / `Result`）<br>`src/shared/image-quality.ts`（`ExportImageQuality`、`imageFileQuality`）<br>`src/shared/image-text-index.ts`（926 行：`IMAGE_TEXT_INDEX_SCHEMA_VERSION`、`ImageTextIndexStatus`、`ImageTextBackfillTier`、`buildImageTextBackfillSegments`）<br>`src/shared/system-ocr.ts`（`SystemOcrCapability`、`SystemOcrRequest` / `Result`、`parseImageDataUrl`）<br>`src/shared/sticker.ts`（`StickerFailureCode`、`classifyStickerHttpFailure`）<br>`src/shared/wechat-image-key-derivation.ts`（`deriveV4ImageKeys`、`normalizeV4AccountId`） |
| 5. 聊天导出域 | 2 | `src/shared/export.ts`（`ExportRequest`、`ExportJobProgress`、`ExportTaskRecord`、`ExportFormat`）<br>`src/shared/export-media.ts`（`getImageExportAttempts`） |
| 6. 语音识别与 TTS | 2 | `src/shared/voice-recognition.ts`（`DEFAULT_VOICE_MODEL_ID`、`VoiceMessageReference`、`VoiceRecognitionResult`、`VoiceBatchRequest` / `Progress`、`VoiceModelStatus`）<br>`src/shared/text-to-speech.ts`（`TextToSpeechModel`、`TextToSpeechVoice`、`SynthesizeTextToSpeechRequest` / `Result`） |
| 7. 自动化与退群监控 | 7 | `src/shared/automation.ts`（1312 行：`AutomationRule`、`AutomationRuleDraft`、`AutomationExecution`、`AutomationStatusSummary`、`AUTOMATION_RULE_TEMPLATES`、`BUILTIN_DAILY_REPORT_RULE_ID`、`BUILTIN_LEAVE_NOTIFICATION_RULE_ID`、`normalizeRuleDraft`）<br>`src/shared/automation-matcher.ts`（`matchAutomationRule`）<br>`src/shared/msg-insert-switch.ts`（`MSG_INSERT_SWITCHES`、`MsgInsertSwitchesSnapshot`、`MsgInsertApplyResult`）<br>`src/shared/group-exit-monitor.ts`（`GroupExitMonitorState`、`GroupExitMonitorEvent`、`GROUP_EXIT_NOTIFICATION_TEMPLATE`）<br>`src/shared/group-exit-event.ts`（`GroupMemberExitedEvent`、`renderLeaveNotificationText`）<br>`src/shared/group-exit-event-message.ts`（`GROUP_EXIT_EVENT_MESSAGE_TYPE`、`mergeGroupExitEvents`）<br>`src/shared/group-stats.ts`（`GroupMemberStatsQuery` / `Result`、`GROUP_STATS_RANGE_OPTIONS`） |
| 8. 微信个人发送、网关与 Agent Hub | 10 | `src/shared/personal-wechat.ts`（`PersonalWechatSenderStatus`、`PersonalWechatSendCapability`、`PersonalWechatSendRequest` / `Result`）<br>`src/shared/personal-wechat-mac-license.ts`（`MacLicenseStatus`）<br>`src/shared/personal-wechat-mac-runtime.ts`（`MacWechatRuntimeSnapshot`、`MacWechatResidualProcess`）<br>`src/shared/personal-wechat-mac-send-action.ts`（`resolveMacSendPrimaryAction`）<br>`src/shared/personal-wechat-voice-runtime.ts`（`PERSONAL_WECHAT_PILK_VERSION`、`PersonalWechatVoiceEncodingEnvironment`）<br>`src/shared/wechat-action.ts`（`WechatActionRequest` / `Result`、`WechatActionAuditRecord`）<br>`src/shared/wechat-send.ts`（`WechatSendRequest` / `Result`、`resolveSendTransport`）<br>`src/shared/action-log.ts`（`ActionLogEntry`）<br>`src/shared/agent-hub.ts`（`AgentHubStatus`、`AgentHubLogEntry`）<br>`src/shared/agent-hub-conversation.ts`（`AgentHubConversation`、`AgentHubConversationSummary`、`AGENT_HUB_KIND_LABELS`） |
| 9. 扩展中心协议与 Agent API / 系统平台 | 21 | **扩展协议（`src/shared/extensions/`，10 文件）**：`ipc.ts`（`EXTENSION_IPC` 33 常量、`EXTENSION_PAGE_MESSAGE_SOURCE` / `HOST_SOURCE`、`isExtensionPageBridgeRequest`）、`manifest.ts`（`EXTENSION_MANIFEST_VERSION`、`EXTENSION_API_VERSION`、`isSafeRelativeEntryPath`）、`permissions.ts`（`EXTENSION_PERMISSIONS`、`EXTENSION_PERMISSION_INFO`）、`rpc.ts`（`EXTENSION_HOST_PROTOCOL_VERSION`、`ExtensionHostCallMethod`）、`events.ts`（`EXTENSION_EVENT_PROTOCOL_VERSION`、`buildExtensionMessageEvent`）、`action-schema.ts`（`validateActionInput`）、`errors.ts`（`EXTENSION_ERROR_CODES`、`ExtensionError`）、`source.ts`（`EXTENSION_SOURCES`）、`templates.ts`（`ExtensionTemplateStatus`）、`types.ts`（`InstalledExtension`、`ExtensionPageMethod`、`ExtensionDeepLink`）<br>**Agent API 契约（`src/shared/agent-api/`，4 文件）**：`contracts.ts`（`ApplicationCapabilities`、`AgentAutomationValidationResult`）、`automation-validation.ts`（`validateAutomationDraftShape`）、`group-exit-monitor.ts`、`group-stats.ts`<br>**本地 API 与系统平台（7 文件）**：`local-api-auth.ts`（`ApiTokenStatus`）、`local-api-test.ts`（`LOCAL_API_ENDPOINTS`、`LocalApiTestRequest` / `Response`）、`app-log.ts`、`app-update.ts`（`AppUpdateState`、`APP_UPDATE_RELEASES_URL`）、`debug-flags.ts`（`isTruthyDebugFlag`）、`macos-arch.ts`（`MacArchSnapshot`、`resolveMacKeyFlow`）、`windows-runtime.ts`（`WINDOWS_VC_RUNTIME_DOWNLOAD_URL`、`isWindowsVcRuntimeMissingError`） |

---

### 2.3 预加载层 `src/preload/`（2 个文件）

- `src/preload/index.ts`（827 行）：构造包含 **257 个成员方法**的 `api` 对象（240 条 `ipcRenderer.invoke` + 17 条 `ipcRenderer.on`），当 `process.contextIsolated` 为 `true` 时通过 `contextBridge.exposeInMainWorld('electron', electronAPI)` 与 `contextBridge.exposeInMainWorld('api', api)` 暴露给渲染层（L815–821）；非隔离场景则降级直接挂载到 `window.electron` / `window.api`（L822–827）。所有 17 个 `on*` 监听方法均严格封装 listener 并返回 `() => ipcRenderer.removeListener(...)` 取消订阅闭包，避免 React `useEffect` 卸载泄漏。
- `src/preload/index.d.ts`（904 行）：定义并导出 `ParsedContent`（L190–244，存在与 `src/shared/types.ts` 的同步漂移，见第五章），并扩展 `declare global { interface Window { electron: ElectronAPI; api: { ... } } }`，其 257 个方法键名与 `src/preload/index.ts` 完全一一对应。

---

## 三、核心数据流与设计思路

### 3.1 启动与数据库连接状态机（`src/renderer/src/App.tsx`）

`App.tsx` 通过 `isAuthenticated`、`isDatabaseConnected`、`isDatabaseConnecting` 与 `bootState: 'loading' | 'connecting' | 'login'` 四个正交状态控制根视图切换，核心思路是**“缓存先行首屏快涂 + 后台原生库异步预热”**：

1. **Splash 加载阶段（`!isAuthenticated && bootState !== 'login'`，L2255–2284）**：渲染 `.boot-splash` 启动页，同时在首次挂载 `useEffect`（L700–842）执行 `attemptAutoConnect()`：
   - 调用 `window.api.getSettings()` 获取 `dbRoot`、`autoLogin` 等配置，再调用 `discoverAccounts(dbRoot)` 识别候选微信账号。
   - 开发模式下优先读取 `import.meta.env.VITE_DB_KEY`（L84–87），生产环境调用 `getSavedDbKey(startupAccountRoot)` 从系统安全存储取回密钥。若无密钥或 `autoLogin === false`，立即切换至 `bootState = 'login'` 展示登录引导页。
2. **缓存快涂与后台建连（L754–828）**：
   - 先请求 `window.api.getStartupCache()`：若缓存命中（联系人列表非空），立即设置 `isAuthenticated = true` 进入主界面渲染缓存联系人与 `selfInfo`，同时保持 `isDatabaseConnected = false`，让 `window.api.initDb(key, startupAccountRoot)` 在后台异步建立 WCDB 原生连接并补刷最新联系人与头像。
   - 若启动缓存未命中，则阻塞等待 `initDb` 完成及 `getBootstrapCache()` / `loadContacts()` 就绪后再放行进入主界面。
3. **连接引导页（`!isAuthenticated && bootState === 'login'`，L2286–2375）**：渲染 `DatabaseConnectionPage`，支持自动模式（6 步向导 `connectionGuideStep: 1 | 2 | 3 | 4 | 5 | 6`）与手动密钥输入、剪切板安全粘贴（`pasteAndSaveDbKey`）、脱敏环境诊断摘要复制（`copyText`）。

### 3.2 React State 枚举路由与跨工作区深链

渲染层未引入 `react-router` 等 URL 路由库，而是采用 **State 驱动的条件切换**：

- **切换与卸载语义**：`App.tsx` 持有 `activePage: AppPage`（默认 `'archive'`），通过 `switch (activePage)`（L2087–2214）只挂载当前激活的工作区组件。切换一级菜单会导致原工作区被卸载并清理局部状态。
- **跨工作区深链“消费即清空”模式**：因为工作区会被卸载，由 `App.tsx` 托管的跨页跳转请求必须作为受控 Props 传递并在目标组件消费后立即清零，否则下次正常切入该菜单时会重放旧深链。典型链路如下：
  - `search` → `archive`（证据精确定位）：点击搜索证据触发 `handleOpenSearchEvidence`（L1331–1366），先通过 `decodeMessageRef(evidence.messageRef)` 解析 `conversationId` 与 `messageId`，切至 `'archive'` 并选中联系人，随后调用 `window.api.getMessagesAround(contact.md5, anchor.messageId, anchorSeconds)` 围绕锚点拉取上下文消息并注入 `archiveJumpMessageId` / `archiveJumpTime` 让 `MessageList` 精准高亮滚动。
  - `report` → `automation`：`openScheduledReportAutomation`（L1667–1670）注入 `automationOpenRuleRequest = { ruleType: 'scheduled_report', requestId }` 并切往 `'automation'`。
  - `exit-monitor` ⇄ `automation`：`openLeaveNotificationAutomation`（L1661–1664）携带 `{ ruleType: 'leave_notification', requestId }` 跳转 `AutomationWorkspace`；反向则通过 `openExitMonitorGroups`（L1673–1676）设置 `exitMonitorOpenViewRequest = { view: 'manage', requestId }` 跳回 `GroupExitMonitorWorkspace`（消费后调用 `onOpenViewRequestHandled` 清空）。
  - `automation` / 其他工作区 → `extensions`：`openExtensionDeepLink`（L1606–1609）传入 `ExtensionDeepLink` 并在 `ExtensionWorkspace` 消费后触发 `onConsumeDeepLink={() => setExtensionDeepLink(null)}`。
  - 任意页 → `settings` 指定二级页：通过 `openModelSettings`、`openTextToSpeechSettings`、`openWechatSendSettings`、`openLocalIndexSettings`、`openUpdateSettings`（L1625–1654）原子更新 `settingsCategory` 与 `activePage = 'settings'`；此外 `App.tsx` 还监听 `window` 自定义事件 `'wxe:open-voice-recognition-settings'`（L369–379）直达语音转文字设置。

### 3.3 零直接 `fetch()`、实时监听与扩展沙箱双层桥接

1. **零直接 `fetch()` 红线**：全仓检索 `src/renderer/` 下 `\bfetch\s*\(` 为 **0 匹配**。即使是 `ApiWorkspace` 的“在线接口调试器”（`src/renderer/src/features/api-center/services/localApiClient.ts:3–24`），也是把 `endpointId`、`query`、`body` 经 `window.api.testLocalApiRequest` 交给主进程代发请求并回传状态、耗时与响应体。
2. **实时数据库增量刷新（`onWcdbChange`）**：`App.tsx`（L1454–1584）在 `isAuthenticated && isNativeMonitorActive` 时注册两个防抖监听（`MESSAGE_MONITOR_DEBOUNCE_MS = 350ms`）：一个针对当前选中会话，用 `isRelevantMessageMonitorEvent(payload, targetIds)` 过滤后拉取最新一页并保留用户已加载的历史长度；另一个同步刷新左侧联系人列表（跳过头像批量水合以降低抖动）。
3. **扩展页面沙箱隔离与 `postMessage` 桥接**（`ExtensionPageHost.tsx:24–122`、`src/shared/extensions/ipc.ts:53–81`、`src/main/extensions/extension-protocol.ts:29–104`）：
   - 主进程注册特权协议 `tm-extension://<extensionId>/<path>`，加载文件前执行 `isSafeRelativeEntryPath` 与双层 `realpath` + `isPathInside` 校验防止路径穿越，单文件上限 20MB，并强制注入 `Content-Security-Policy`（含 `connect-src 'none'`、`object-src 'none'`、`base-uri 'none'`）。
   - `ExtensionPageHost` 使用 `<iframe sandbox="allow-scripts" referrerPolicy="no-referrer">` 托管扩展页面（无 Node、无 preload、无 `window.api`、与主渲染器不同源）。
   - 扩展页面通过 `window.parent.postMessage` 发送 `{ source: 'tracememo-extension-page', extensionId, requestId, method, params }`；宿主校验 `event.source === frame.contentWindow`、`isExtensionPageBridgeRequest(event.data)` 及 `extensionId` 匹配后，转发 `window.api.extensionPageRequest`，经主进程 `isTrustedSender`（仅主窗口）与白名单校验后再回传 `{ source: 'tracememo-extension-host', requestId, ok, result/error }`。

### 3.4 双轨样式体系与组件原语

TraceMemo 正在从早期全手写 SCSS 渐进演进至 Tailwind CSS + Radix UI，为避免破坏存量界面，设计了严密的**双轨共享 Token 体系**：

1. **导入顺序（`src/renderer/src/main.tsx:5–6`）**：先导入 `./styles/tailwind.css`，再导入 `./styles/index.scss`。
2. **Tailwind 关闭 Preflight（`tailwind.config.cjs:6–9`）**：显式配置 `corePlugins: { preflight: false }`，防止 Tailwind CSS reset 破坏既有 SCSS 组件排版；`darkMode` 配置为 `['class', '[data-theme="dark"]']`，颜色工具类统一指向 `hsl(var(--tm-*) / <alpha-value>)` 支持透明度修饰符。
3. **单一 Token 源与向后映射**：
   - `src/renderer/src/styles/tailwind.css`（L5–124）在 `:root`、`[data-theme='dark']` 与 `@media (prefers-color-scheme: dark)` 下的 `[data-theme='system']` 定义了 40+ 个 `--tm-*` HSL 变量（语义色、表面层级、圆角、阴影、动效时长与 `z-index` 层级），并由 `AppShell.tsx:47–52` 动态同步 `document.documentElement.dataset.theme`。
   - `src/renderer/src/styles/_tokens.scss`（L1–27）将整套遗留 `--wxex-*` 变量（如 `--wxex-bg-app`、`--wxex-brand`、`--wxex-text-primary`）直接别名映射至 `hsl(var(--tm-*))`，配合 `src/renderer/src/styles/theme.scss` 的 `@mixin dark-theme` 兜底局部遗留样式，确保切换浅色/暗色/跟随系统时新旧页面零割裂。
4. **Radix UI 原语层（`src/renderer/src/components/ui/`，23 个文件）**：在 `package.json` 中引入 **14 个 `@radix-ui/react-*` 依赖**，封装了 **22 个统一 UI 原语**（`alert-dialog`、`button`、`checkbox`、`dialog`、`dropdown-menu`、`empty-state`、`icon-button`、`input`、`popover`、`progress`、`radio-group`、`scroll-area`、`segmented-control`、`select`、`separator`、`skeleton`、`spinner`、`switch`、`tabs`、`textarea`、`toast`、`tooltip`，其中 `segmented-control.tsx` 复用 `@radix-ui/react-radio-group`），配合 `class-variance-authority`、`tailwindcss-animate` 与 `src/renderer/src/lib/cn.ts` 构建无障碍交互基础。

---

### 3.5 IPC 通道全景（240 条 invoke + 17 条 push）

`src/preload/index.ts` 的 `window.api` 共暴露 **257 个方法**，与主进程实际运行时通道保持精确对齐：

- **请求/响应通道（240 条）**：`src/preload/index.ts` 注册 **240** 条 `ipcRenderer.invoke`，对应主进程运行时注册的 **240** 个唯一 `ipcMain.handle` 通道（`src/main/index.ts` 202 条 + `src/main/extensions/extension-ipc.ts` 32 条 + `src/main/report-template-ipc.ts` 6 条）。另注：独立工具入口 `src/main/report-template-test-entry.ts`（L22–29）在离线测试子进程模式下单独注册了 6 条 `report:*` 句柄。
- **主动推送通道（17 条）**：`src/preload/index.ts` 注册 **17** 条 `ipcRenderer.on`（`on*` 方法），对应主进程 **13 条 `webContents.send` 全局广播通道**与 **4 条 `event.sender.send` 请求方定向推送通道**（`key:dbKeyStatus`、`key:imageKeyStatus`、`ai-search:progress`、`ask-wechat:progress`）。

#### 全量 257 条 `window.api` ↔ IPC 通道分组对照表（按 31 个通道前缀）

| # | 通道域 | 数量（Invoke / Push） | `window.api` 方法 → IPC 通道名（含推送来源说明） |
|---:|---|---|---|
| 1 | `extension` | 32 invoke + 1 push | **Invoke**（`src/main/extensions/extension-ipc.ts`）：`listExtensions`→`extension:list`、`getExtension`→`extension:get`、`pickExtensionDirectory`→`extension:pickDirectory`、`pickExtensionPackage`→`extension:pickPackage`、`installExtensionFromDirectory`→`extension:installDirectory`、`installExtensionFromPackage`→`extension:installPackage`、`setExtensionEnabled`→`extension:setEnabled`、`getExtensionHealth`→`extension:health`、`grantExtensionPermissions`→`extension:grantPermissions`、`revokeExtensionPermission`→`extension:revokePermission`、`resetExtensionStorage`→`extension:resetStorage`、`listExtensionTemplates`→`extension:templates`、`installExtensionTemplate`→`extension:installTemplate`、`acknowledgeExtensionRecovery`→`extension:acknowledgeRecovery`、`acknowledgeExtensionStorage`→`extension:acknowledgeStorage`、`adoptExtensionCode`→`extension:adoptInstalledCode`、`rollbackExtensionUpgrade`→`extension:rollbackUpgrade`、`pickExtensionProjectDirectory`→`extension:pickProjectDirectory`、`linkExtensionDevelopment`→`extension:linkDevelopment`、`reloadExtensionDevelopment`→`extension:reloadDevelopment`、`unlinkExtensionDevelopment`→`extension:unlinkDevelopment`、`convertExtensionDevelopment`→`extension:convertDevelopment`、`createExtensionProject`→`extension:createProjectFromTemplate`、`listExtensionActions`→`extension:actions`、`openExtensionDevelopmentSource`→`extension:openDevelopmentSource`、`exportExtensionAsProject`→`extension:exportInstalledAsProject`、`uninstallExtension`→`extension:uninstall`、`getExtensionLogs`→`extension:getLogs`、`clearExtensionLogs`→`extension:clearLogs`、`getExtensionPageUrl`→`extension:getPageUrl`、`extensionPageRequest`→`extension:pageRequest`、`openExtensionDataDir`→`extension:openDataDir`<br>**Push**（广播）：`onExtensionChanged`→`extension:changed` |
| 2 | `automation` | 20 invoke | `getAutomationStatus`→`automation:getStatus`、`listAutomationRules`→`automation:listRules`、`createAutomationRule`→`automation:createRule`、`updateAutomationRule`→`automation:updateRule`、`deleteAutomationRule`→`automation:deleteRule`、`setAutomationRuleEnabled`→`automation:setRuleEnabled`、`listAutomationExecutions`→`automation:listExecutions`、`clearAutomationExecutions`→`automation:clearExecutions`、`listAutomationGroups`→`automation:listGroups`、`saveLeaveNotificationRule`→`automation:saveLeaveNotificationRule`、`listSendableContacts`→`automation:listSendableContacts`、`getMsgInsertSwitches`→`automation:getMsgInsertSwitches`、`refreshMsgInsertSwitches`→`automation:refreshMsgInsertSwitches`、`setMsgInsertSwitch`→`automation:setMsgInsertSwitch`、`runScheduledReportRule`→`automation:runScheduledReportRule`、`listScheduledReportLegacyExecutions`→`automation:listScheduledReportLegacyExecutions`、`getScheduledReportNotificationSettings`→`automation:getScheduledReportNotificationSettings`、`getScheduledReportNotificationCapability`→`automation:getScheduledReportNotificationCapability`、`setScheduledReportNotificationEnabled`→`automation:setScheduledReportNotificationEnabled`、`testScheduledReportErrorNotification`→`automation:testScheduledReportErrorNotification` |
| 3 | `db` | 19 invoke | `initDb`→`db:init`、`getBootstrapCache`→`db:getBootstrapCache`、`getStartupCache`→`db:getStartupCache`、`getContacts`→`db:getContacts`、`getContactAvatars`→`db:getContactAvatars`、`getCachedMessages`→`db:getCachedMessages`、`getCachedMessagePage`→`db:getCachedMessagePage`、`getMessages`→`db:getMessages`、`getMessagesAround`→`db:getMessagesAround`、`getGroupSnapshot`→`db:getGroupSnapshot`、`search`→`db:search`、`getVoiceData`→`db:getVoiceData`、`parseMessage`→`db:parseMessage`、`getImage`→`db:getImage`、`getVideo`→`db:getVideo`、`getSticker`→`db:getSticker`、`testConnection`→`db:testConnection`、`reopenWithRoot`→`db:reopenWithRoot`、`disconnectDb`→`db:disconnect` |
| 4 | `wechat-personal` | 18 invoke | `getPersonalWechatSenderStatus`→`wechat-personal:getStatus`、`getMacLicenseStatus`→`wechat-personal:getMacLicenseStatus`、`getMacSendRuntimeAvailability`→`wechat-personal:getMacSendRuntimeAvailability`、`startMacSendRuntime`→`wechat-personal:startMacSendRuntime`、`listMacWechatResidualProcesses`→`wechat-personal:listMacResidualProcesses`、`cleanupMacWechatResidualProcesses`→`wechat-personal:cleanupMacResidualProcesses`、`refreshMacLicense`→`wechat-personal:refreshMacLicense`、`getPersonalWechatSendCapability`→`wechat-personal:getSendCapability`、`checkPersonalWechatSenderStatus`→`wechat-personal:checkStatus`、`checkPersonalWechatVoiceEncodingEnvironment`→`wechat-personal:checkVoiceEnvironment`、`installPersonalWechatPilk`→`wechat-personal:installPilk`、`openPersonalWechatVoicePythonDownload`→`wechat-personal:openVoicePythonDownload`、`openPersonalWechatVoiceFfmpegDownload`→`wechat-personal:openVoiceFfmpegDownload`、`rebindPersonalWechatSender`→`wechat-personal:rebind`、`sendGeneratedTtsVoice`→`wechat-personal:sendGeneratedTtsVoice`、`sendPersonalWechatMessage`→`wechat-personal:send`、`selectPersonalWechatFile`→`wechat-personal:selectFile`、`getPersonalWechatVoiceDiagnostic`→`wechat-personal:getVoiceDiagnostic` |
| 5 | `voice` | 15 invoke + 2 push | **Invoke**：`showVoiceSourceContextMenu`→`voice:showSourceContextMenu`、`getVoiceModelStatus`→`voice:getModelStatus`、`downloadVoiceModel`→`voice:downloadModel`、`cancelVoiceModelDownload`→`voice:cancelModelDownload`、`removeVoiceModel`→`voice:removeModel`、`openVoiceModelDirectory`→`voice:openModelDirectory`、`recognizeVoice`→`voice:recognize`、`getVoiceTranscriptSnapshot`→`voice:getTranscriptSnapshot`、`cancelVoiceRecognition`→`voice:cancelRecognition`、`getVoiceBatchPreflight`→`voice:getBatchPreflight`、`getVoiceBatchConversationSummaries`→`voice:getBatchConversationSummaries`、`getVoiceBatchProgress`→`voice:getBatchProgress`、`startVoiceBatch`→`voice:startBatch`、`cancelVoiceBatch`→`voice:cancelBatch`、`retryFailedVoiceBatch`→`voice:retryFailedBatch`<br>**Push**（广播）：`onVoiceBatchProgress`→`voice:batchProgress`、`onVoiceModelProgress`→`voice:modelProgress` |
| 6 | `api` | 15 invoke | `apiStatus`→`api:getStatus`、`apiTokenStatus`→`api:tokenStatus`、`revealApiToken`→`api:revealToken`、`copyApiToken`→`api:copyToken`、`rotateApiToken`→`api:rotateToken`、`apiStart`→`api:start`、`apiStop`→`api:stop`、`apiToggle`→`api:toggle`、`getReaderSkillStatus`→`api:skillStatus`、`readReaderSkill`→`api:readSkill`、`revealReaderSkill`→`api:revealSkill`、`openReaderSkillGithub`→`api:openSkillGithub`、`testLocalApiRequest`→`api:testLocalRequest`、`copyLocalApiCurl`→`api:copyCurl`、`copyText`→`api:copyText` |
| 7 | `agent-hub` | 11 invoke + 4 push | **Invoke**：`getAgentHubStatus`→`agent-hub:getStatus`、`getAgentHubLogs`→`agent-hub:getLogs`、`clearAgentHubLogs`→`agent-hub:clearLogs`、`startAgentHubLogin`→`agent-hub:startLogin`、`cancelAgentHubLogin`→`agent-hub:cancelLogin`、`reconnectAgentHub`→`agent-hub:reconnect`、`disconnectAgentHub`→`agent-hub:disconnect`、`selectAgentHubTestImage`→`agent-hub:selectTestImage`、`getAgentHubConversations`→`agent-hub:getConversations`、`getAgentHubConversation`→`agent-hub:getConversation`、`clearAgentHubConversations`→`agent-hub:clearConversations`<br>**Push**（广播）：`onAgentHubConversation`→`agent-hub:conversation`、`onAgentHubConversationsCleared`→`agent-hub:conversationsCleared`、`onAgentHubStatus`→`agent-hub:status`、`onAgentHubLog`→`agent-hub:log` |
| 8 | `image` | 14 invoke | `getImageDebugInfo`→`image:getDebugInfo`、`getImageMessageXml`→`image:getMessageXml`、`getImageKeyConfig`→`image:getConfig`、`getImageDecryptionStatus`→`image:getStatus`、`selectImageDecoder`→`image:selectDecoder`、`getImageDecoderStatus`→`image:getDecoderStatus`、`openImageDecoderDownload`→`image:openDecoderDownload`、`saveImageKeyConfig`→`image:saveConfig`、`testImageDecryption`→`image:testConfig`、`clearImageKeyConfig`→`image:clearConfig`、`imageListCandidates`→`image:listCandidates`、`imageAnalyze`→`image:analyze`、`getImageInsight`→`image:getInsight`、`listImageInsights`→`image:listInsights` |
| 9 | `key` | 9 invoke + 2 push | **Invoke**：`getSavedDbKey`→`key:getSavedDbKey`、`getDatabaseKeyEnvironment`→`key:getEnvironment`、`readDatabaseKeyClipboard`→`key:readClipboardDbKey`、`installIntelMacKeyRuntime`→`key:installIntelMacRuntime`、`autoGetDbKey`→`key:autoGetDbKey`、`autoGetImageKey`→`key:autoGetImageKey`、`pasteAndSaveDbKey`→`key:pasteAndSaveDbKey`、`saveDbKey`→`key:saveDbKey`、`clearSavedDbKey`→`key:clearSavedDbKey`<br>**Push**（`event.sender.send` 定向）：`onDbKeyStatus`→`key:dbKeyStatus`、`onImageKeyStatus`→`key:imageKeyStatus` |
| 10 | `ai` | 10 invoke | `aiChat`→`ai:chat`、`listAIProviders`→`ai:listProviders`、`getAIRuntimeConfig`→`ai:getRuntimeConfig`、`getAIVisionRuntimeConfig`→`ai:getVisionRuntimeConfig`、`saveAIProvider`→`ai:saveProvider`、`deleteAIProvider`→`ai:deleteProvider`、`setDefaultAIProvider`→`ai:setDefaultProvider`、`testAIProvider`→`ai:testProvider`、`testAIVision`→`ai:testVision`、`migrateLegacyAIConfig`→`ai:migrateLegacy` |
| 11 | `image-text-index` | 9 invoke + 1 push | **Invoke**：`getImageTextIndexStatus`→`image-text-index:getStatus`、`countImageMessages`→`image-text-index:count`、`startImageTextIndex`→`image-text-index:start`、`pauseImageTextIndex`→`image-text-index:pause`、`resumeImageTextIndex`→`image-text-index:resume`、`cancelImageTextIndex`→`image-text-index:cancel`、`clearImageTextIndex`→`image-text-index:clear`、`resetImageTextIndexFailures`→`image-text-index:resetFailures`、`repairImageTextIndex`→`image-text-index:repair`<br>**Push**（广播）：`onImageTextIndexStatus`→`image-text-index:status` |
| 12 | `app-update` | 7 invoke + 1 push | **Invoke**：`getAppUpdateState`→`app-update:getState`、`checkAppUpdate`→`app-update:check`、`downloadAppUpdate`→`app-update:download`、`installAppUpdate`→`app-update:install`、`openAppUpdateDownloadPage`→`app-update:openDownloadPage`、`getIgnoredUpdateVersion`→`app-update:getIgnoredVersion`、`setIgnoredUpdateVersion`→`app-update:setIgnoredVersion`<br>**Push**（广播）：`onAppUpdateState`→`app-update:state` |
| 13 | `group-exit-monitor` | 7 invoke + 1 push | **Invoke**：`getGroupExitMonitorState`→`group-exit-monitor:getState`、`listGroupExitMonitorEvents`→`group-exit-monitor:listEvents`、`setGroupExitMonitorEnabled`→`group-exit-monitor:setEnabled`、`setGroupExitMonitorGroups`→`group-exit-monitor:setGroups`、`checkGroupExitMonitorNow`→`group-exit-monitor:checkNow`、`clearGroupExitMonitorEvents`→`group-exit-monitor:clearEvents`、`markGroupExitMonitorRead`→`group-exit-monitor:markRead`<br>**Push**（广播）：`onGroupExitMonitorState`→`group-exit-monitor:state` |
| 14 | `report` | 8 invoke | `exportGroupReport`→`report:export`（`report-template-ipc.ts`）、`exportGroupReportSnapshot`→`report:exportSnapshot`、`prepareGeneratedReportTemplateSwitch`→`report:prepareTemplateSwitch`、`listGeneratedReports`→`report:listGenerated`、`saveGeneratedReport`→`report:saveGenerated`、`updateGeneratedReportTemplate`→`report:updateGeneratedTemplate`、`deleteGeneratedReport`→`report:deleteGenerated`、`revealGroupReport`→`report:reveal` |
| 15 | `tts` | 6 invoke | `getTextToSpeechSettings`→`tts:getSettings`、`saveTextToSpeechSettings`→`tts:saveSettings`、`listTextToSpeechVoices`→`tts:listVoices`、`synthesizeTextToSpeech`→`tts:synthesize`、`removeGeneratedTextToSpeechAudio`→`tts:removeGeneratedAudio`、`openFishAudioApiKeys`→`tts:openApiKeys` |
| 16 | `knowledge` | 4 invoke + 1 push | **Invoke**：`searchKnowledge`→`knowledge:search`、`getKnowledgeStatus`→`knowledge:getStatus`、`startKnowledgeIndex`→`knowledge:startIndex`、`cancelKnowledgeIndex`→`knowledge:cancelIndex`<br>**Push**（广播）：`onKnowledgeStatus`→`knowledge:status` |
| 17 | `ai-search` | 4 invoke + 1 push | **Invoke**：`runAiSearch`→`ai-search:run`、`cancelAiSearch`→`ai-search:cancel`、`getAiSearchProviderStatus`→`ai-search:getProviderStatus`、`authorizeAiSearchExternalProvider`→`ai-search:authorizeExternalProvider`<br>**Push**（`event.sender.send` 定向）：`onAiSearchProgress`→`ai-search:progress` |
| 18 | `export` | 4 invoke + 1 push | **Invoke**：`startExport`→`export:start`、`cancelExport`→`export:cancel`、`revealExport`→`export:reveal`、`selectExportDirectory`→`export:selectDirectory`<br>**Push**（广播）：`onExportProgress`→`export:progress` |
| 19 | `settings` | 5 invoke | `getSettings`→`settings:get`、`setSettings`→`settings:set`、`getSelf`→`settings:getSelf`、`selectDbRoot`→`settings:selectDbRoot`、`openAccountRoot`→`settings:openAccountRoot` |
| 20 | `ask-wechat` | 3 invoke + 1 push | **Invoke**：`getAskWechatConfig`→`ask-wechat:getConfig`、`runAskWechatQuery`→`ask-wechat:query`、`forgetAskWechatConversation`→`ask-wechat:forgetConversation`<br>**Push**（`event.sender.send` 定向）：`onAskWechatProgress`→`ask-wechat:progress` |
| 21 | `app-log` | 3 invoke | `writeAppLog`→`app-log:write`、`getAppLogPath`→`app-log:getPath`、`revealAppLog`→`app-log:reveal` |
| 22 | `cache` | 3 invoke | `getCacheSummary`→`cache:getSummary`、`clearCache`→`cache:clear`、`openKnowledgeDirectory`→`cache:openKnowledgeDirectory` |
| 23 | `report-template` | 3 invoke | `listReportTemplates`→`report-template:list`、`installReportTemplate`→`report-template:install`、`uninstallReportTemplate`→`report-template:uninstall`（`report-template-ipc.ts`） |
| 24 | `wechat-share` | 3 invoke | `getWechatShareConfig`→`wechat-share:getConfig`、`saveWechatShareConfig`→`wechat-share:saveConfig`、`publishWechatShareCard`→`wechat-share:publish` |
| 25 | `report-template-market` | 2 invoke | `listReportTemplateCatalog`→`report-template-market:list`、`installReportTemplateFromCatalog`→`report-template-market:install`（`report-template-ipc.ts`） |
| 26 | `system-ocr` | 2 invoke | `getSystemOcrCapability`→`system-ocr:getCapability`、`recognizeLocalImageText`→`system-ocr:recognize` |
| 27 | `accounts` | 1 invoke | `discoverAccounts`→`accounts:discover` |
| 28 | `group-stats` | 1 invoke | `getGroupMemberStats`→`group-stats:getMemberStats` |
| 29 | `wechat-action-log` | 1 invoke | `listWechatActionLogs`→`wechat-action-log:list` |
| 30 | `copy-image` | 1 invoke | `copyImage`→`copy-image` |
| 31 | `wcdb-change` | 1 push | **Push**（广播）：`onWcdbChange`→`wcdb-change` |

---

## 四、关键文件与符号索引

### 4.1 渲染进程关键文件与导出符号

| 文件路径 | 核心导出符号 / 关键逻辑位置 | 职责 |
|---|---|---|
| `src/renderer/src/main.tsx` | 全局 `error`/`unhandledrejection` 捕获、`ToastProvider`、`TooltipProvider` | 渲染进程启动与日志兜底 |
| `src/renderer/src/App.tsx` | `App`、`renderArchiveWorkspace`、`renderReportWorkspace`、`renderCurrentWorkspace`、`handleOpenSearchEvidence` | 根状态机、启动引导、10 工作区切换与深链协调 |
| `src/renderer/src/components/layout/navigation.ts` | `AppPage`、`NavigationItem`、`PRIMARY_NAV_ITEMS` | 一级工作区联合类型与导航顺序 |
| `src/renderer/src/components/layout/AppShell.tsx` | `AppShell` | 注入 `data-theme`、左侧主导航与全局工作区容器 |
| `src/renderer/src/components/layout/PrimaryNavigation.tsx` | `PrimaryNavigation`、`SEND_CAPABILITY_POLL_MS` | 导航渲染、未读退群数订阅、30 分钟发送能力探活告警 |
| `src/renderer/src/features/extensions/ExtensionPageHost.tsx` | `ExtensionPageHost` | 扩展沙箱 `iframe` 托管与 `postMessage` 白名单桥接 |
| `src/renderer/src/features/api-center/services/localApiClient.ts` | `sendLocalApiRequest` | 通过 `window.api.testLocalApiRequest` 代理本地 API 调试请求 |
| `src/renderer/src/components/search/queryAgentBridge.ts` | `resolveQueryAgentEnabled`、`requestAskWechatQuery`、`forgetAskWechatConversation` | 问问微信 Query Agent 开关检测与回退桥接 |
| `src/renderer/src/features/settings/model/settingsNavigation.ts` | `SETTINGS_NAVIGATION`、`SETTINGS_CATEGORY_LABELS` | 设置页 4 分组菜单配置与隐藏兼容项定义 |
| `src/renderer/src/components/ui/index.ts` | 导出全部 22 个封装组件（`Button`、`Dialog`、`SegmentedControl`、`ToastProvider` 等） | Radix UI 原语统一出口 |
| `src/renderer/src/lib/cn.ts` | `cn` | `clsx` + `tailwind-merge` 类名组合工具 |
| `src/renderer/src/styles/tailwind.css` & `tailwind.config.cjs` | `--tm-*` HSL 变量、`preflight: false`、`darkMode` | Tailwind 主题 Token 与暗色配置 |
| `src/renderer/src/styles/index.scss` & `src/renderer/src/styles/_tokens.scss` | `--wxex-*` → `hsl(var(--tm-*))` 兼容映射 | 存量 SCSS 样式向新版 Token 桥接 |

### 4.2 Preload 与 IPC 注册关键文件

| 文件路径 | 关键符号 / 行号范围 | 职责 |
|---|---|---|
| `src/preload/index.ts` | `api`（L150–813）、`contextBridge.exposeInMainWorld`（L815–821） | 封装 240 invoke + 17 on 并暴露 `window.api` / `window.electron` |
| `src/preload/index.d.ts` | `ParsedContent`（L190–244）、`Window.api`（L246–904） | 声明渲染层全局 `window.api` 类型签名 |
| `src/main/index.ts` | `createWindow`（`preload` & `sandbox: false` @ L1008–1009）、202 条 `ipcMain.handle`、`ipcMain.on('ping')`（L1509） | 主窗口宿主配置与绝大多数 IPC 通道实现 |
| `src/main/extensions/extension-ipc.ts` | `registerExtensionIpc`、`guard`（`isTrustedSender` 校验） | 集中注册 32 条 `extension:*` 通道 |
| `src/main/extensions/extension-protocol.ts` | `EXTENSION_SCHEME`、`registerExtensionScheme`、`installExtensionProtocolHandler` | `tm-extension://` 自定义协议与 CSP 沙箱边界 |
| `src/main/report-template-ipc.ts` | `registerReportTemplateIpc`（6 条 `ipcMain.handle`） | 日报模板管理、模板市场与 `report:export` |
| `src/main/report-template-test-entry.ts` | 模板离线验证子入口（L22–29 额外注册 6 条 `report:*`） | 供模板自动化验证脚本独立加载 |

### 4.3 `src/shared/` 核心枢纽文件

| 文件路径 | 关键导出符号 |
|---|---|
| `src/shared/types.ts` | `Contact`、`Message`、`MessagesAroundResult`、`ParsedContent`（15 分支）、`ChatTable` |
| `src/shared/report-templates.ts` | `ReportTemplateId`、`ReportTemplateSelectionId`、`DEFAULT_REPORT_TEMPLATE`、`REPORT_TEMPLATES` |
| `src/shared/report-template-package.ts` | `REPORT_TEMPLATE_PACKAGE_PROTOCOL_VERSION`、`REPORT_TEMPLATE_LIMITS`、`REPORT_TEMPLATE_PLACEHOLDERS`、`REPORT_TEMPLATE_ALLOWED_TAGS` / `ATTRS` / `ASSET_EXTENSIONS`、`ReportTemplateError` |
| `src/shared/group-report.ts` | `ReportSectionKey`、`REPORT_AVATAR_ALIAS_FIELDS`、`buildReportAvatarAliasIndex`、`mergeReportAvatars`、`GroupDailyReport` |
| `src/shared/automation.ts` | `AutomationRule`、`AutomationRuleDraft`、`AutomationExecution`、`AUTOMATION_RULE_TEMPLATES`、`BUILTIN_DAILY_REPORT_RULE_ID`、`BUILTIN_LEAVE_NOTIFICATION_RULE_ID`、`normalizeRuleDraft` |
| `src/shared/extensions/ipc.ts` | `EXTENSION_IPC`、`EXTENSION_PAGE_MESSAGE_SOURCE`、`EXTENSION_PAGE_HOST_SOURCE`、`isExtensionPageBridgeRequest` |
| `src/shared/local-query-api.ts` | `LOCAL_QUERY_TOOL_DEFINITIONS`、`QueryTemporalBasisKind`、`decodeMessageRef`、`QueryEvidenceItem` |
| `src/shared/knowledge.ts` | `KNOWLEDGE_SCHEMA_VERSION`、`KnowledgeRuntimeStatus`、`KnowledgeSearchIpcRequest` / `Result`、`KnowledgeWorkerRequest` / `Response` |
| `src/shared/ai-search.ts` | `AiSearchPipelineRequest` / `Result`、`AiSearchProgressEvent`、`aiSearchRangeStart`、`buildLocalAiSearchPlan` |
| `src/shared/image-text-index.ts` | `IMAGE_TEXT_INDEX_SCHEMA_VERSION`、`ImageTextIndexStatus`、`ImageTextBackfillTier`、`buildImageTextBackfillSegments` |
| `src/shared/local-api-test.ts` | `LOCAL_API_ENDPOINTS`、`LocalApiTestRequest` / `Response` |

---

## 五、后续维护与开发指南

### 5.1 已核实的真实类型偏差与遗留点（修改时务必注意）

在基线 `9efb8ac` 中，源码存在以下 **5 处真实的类型漂移或历史遗留**，后续扩展字段或重构 IPC 时应优先注意（或顺带收敛）：

1. **`AppSettings` 在 `src/preload/index.d.ts` 中内联手写导致严重缺字段**
   - 权威定义：`src/main/services/settings-store.ts:25–70` 定义 `AppSettings` 共 **23 个字段**；主进程 `settings:get`、`settings:set` 与 `key:autoGetImageKey` 返回的均为 `getLegacySettingsView()`（完整 `AppSettings`）。
   - 真实偏差：`src/preload/index.d.ts` 中 `autoGetImageKey` 返回体（L580–601）、`getSettings` 返回体（L622–643）与 `setSettings` 入参 `patch`（L647–668）均采用**内联手写 20 字段**，漏掉了 `imageKeyFallbackDisabled`、`queryAgentEnabled`、`skippedUpdateVersion` 3 个字段；更值得注意的是 `setSettings` 返回体（L670–688）仅声明 **17 个字段**，额外遗漏了 `ttsSelectedVoiceId`、`ttsModel`、`reportImagePostfixText`。
   - 维护提示：新增设置项时若未同步修改 `src/preload/index.d.ts`，渲染层读取或写入将无法获得 TypeScript 类型提示（推荐后续抽取公共 `SharedAppSettings` 至 `src/shared/`）。
2. **`ParsedContent` 重复定义且分叉不同步**
   - 权威定义：`src/shared/types.ts:183–198` 包含 **15 种联合分支**（含 `forwardBundle`），且包含 `share.articles`、`quote.quotedImageMd5` / `quotedImageDatName`、`system.raw` / `pat` / `recall`、`unknown.messageType` 等扩展字段；主进程 `parseMessage` 实际返回该完整形态。
   - 真实偏差：`src/preload/index.d.ts:190–244` 独立手写并导出了仅含 **14 种分支**的旧版 `ParsedContent`（缺少 `forwardBundle` 与上述新增字段），未从 `src/shared/types.ts` 导入复用。
3. **遗留未包装通道 `ipcMain.on('ping')`**
   - `src/main/index.ts:1509` 保留了来自 `@electron-toolkit` 模板的 `ipcMain.on('ping', () => console.log('pong'))`。`window.api` 未包装它，全渲染层无任何调用，仅理论上可通过 `window.electron.ipcRenderer.send('ping')` 触发。
4. **`src/preload/index.ts` 部分方法隐式类型与未绑定 `EXTENSION_IPC` 常量**
   - `src/preload/index.ts` 中 `copyImage`（L452）、`saveImageKeyConfig`（L586）、`testImageDecryption`（L587）、`setSettings`（L615）、`testLocalApiRequest`（L636）、`copyLocalApiCurl`（L637）未显式标注参数类型，且 `db:*` / `settings:*` / `api:*` 多数方法依赖隐式 `Promise<any>` 推断。
   - 此外，`src/shared/extensions/ipc.ts:3` 注释约定“不手写通道字符串”，但 `src/preload/index.ts:282–367` 仍手写 `'extension:*'` 字符串字面量（当前名称与 `EXTENSION_IPC` 一致，但缺乏编译器级防错绑定）。
5. **`src/env.d.ts` 与 `tsconfig.*.json` 作用域错位**
   - `src/env.d.ts`（仅 10 行，声明 `VITE_DEEPSEEK_API_KEY` 与 `VITE_SCHEDULED_REPORT_DEBUG`）仅被 `tsconfig.node.json`（L3）包含，而 `VITE_DEEPSEEK_API_KEY` 在 `src/` 中已不再使用；`tsconfig.web.json`（L3–8）只包含 `src/renderer/src/env.d.ts`（仅引入 `vite/client`）。渲染层实际读取的 `VITE_DB_KEY`（`src/renderer/src/App.tsx:86`）和 `VITE_FILTER_MSG_TYPES`（`src/renderer/src/components/ChatWindow.tsx:143`）能够通过类型检查，依赖的是 `vite/client` 默认的 `[key: string]: any` 宽松索引。

### 5.2 日常开发标准流程

1. **新增 IPC 接口的标准 4 步**：
   - 第一步：在 `src/shared/` 对应主题域文件定义请求/响应类型与输入校验函数（切忌放在 `src/main/` 或 `src/renderer/` 内造成双份定义）。
   - 第二步：在 `src/main/index.ts`（或模块级 `*-ipc.ts`）注册 `ipcMain.handle`；若是主动推送进度/状态，广播用 `window.webContents.send`，针对发起窗口的流式进度用 `event.sender.send`。
   - 第三步：在 `src/preload/index.ts` 显式标注参数与返回类型封装 `ipcRenderer.invoke` / `ipcRenderer.on`（`on*` 必须返回 `removeListener` 清理函数），并在 `src/preload/index.d.ts` 的 `Window.api` 同步声明。
   - 第四步：在 `src/renderer/` 中仅通过 `window.api.*` 调用，**严禁在渲染层使用 `fetch()` 直连本地 HTTP API 或外部接口**。
2. **新增一级工作区或设置子页**：
   - 新增一级工作区需同步更新 `AppPage` 与 `PRIMARY_NAV_ITEMS`（`src/renderer/src/components/layout/navigation.ts`）、`NavIcon`（`src/renderer/src/components/layout/PrimaryNavigation.tsx`）与 `App.tsx` 的 `renderCurrentWorkspace()`。若支持其他页面深链跳入，务必采用“父层状态 + 子层消费后回调清空”模式。
   - 新增设置子页需更新 `src/renderer/src/features/settings/model/types.ts`、`settingsNavigation.ts` 与 `SettingsWorkspace.tsx`。
3. **双轨样式编写规范**：
   - 新组件优先使用 Tailwind 工具类 + `src/renderer/src/components/ui/` 原语（颜色一律使用 `bg-surface`、`text-foreground`、`border-border` 等映射自 `--tm-*` 的语义类，自动兼容暗黑模式）。
   - 修改存量 SCSS 页面时优先消费 `--wxex-*` 或 `--tm-*` 变量，避免引入新的硬编码十六进制色值。
4. **常用验证命令**：
   - `pnpm typecheck:web`：单独检查 `tsconfig.web.json`（含渲染进程、`src/preload/*.d.ts` 与 `src/shared/`）。
   - `pnpm typecheck:node`：检查 `tsconfig.node.json`（含主进程、`src/preload/` 与 `src/shared/`）。
   - `pnpm lint`：运行 ESLint 与格式检查。
   - `pnpm test:component`：运行 `tests/component/` 下的渲染层组件行为测试。
