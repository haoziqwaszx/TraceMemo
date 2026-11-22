# 05. Local HTTP API、扩展系统与云端分享服务

> **源码基线**：`8f47dca`（`package.json` 版本 `2.7.0`）｜**适用范围**：Local HTTP API（`127.0.0.1:6131`）、`packages/extension-sdk/`、Extension Center（`src/main/extensions/` 21 文件 + `src/shared/extensions/` 10 文件 + 渲染端宿主与规则集成）、`examples/extensions/` 模板体系与 `services/share-card-worker/` Cloudflare Worker 服务

---

## 1. 架构总览

本专题覆盖 TraceMemo 面向**外部本地集成、进程外第三方扩展与边缘分享**的三大外延子系统。三者共用**「边界隔离、单点网关仲裁、显式授权与可校验契约」**设计原则：

```text
+---------------------------------------------------------------------------------+
|                         外部调用方 / 扩展页面 / 微信浏览器                         |
+----------------------+-------------------------------+--------------------------+
| 1. Local HTTP API    | 2. Extension Center           | 3. Share Card Worker     |
| curl / Agent / Skill | <iframe sandbox="allow-scripts| 微信端 /s/{id} /v/{id}   |
| API Center (via IPC) |  referrerPolicy="no-referrer"> | Cloudflare Edge Fetch    |
+----------+-----------+---------------+---------------+------------+-------------+
           | HTTP 127.0.0.1:6131       | tm-extension:// +          | HTTPS
           | Bearer + Loopback CORS    | postMessage 白名单桥       | (Worker + R2)
           v                           v                            v
+----------------------+   +---------------------------+  +-----------------------+
| src/main/http-server |   | ExtensionPageHost.tsx     |  | services/share-card-  |
| - 39 条路径模式 / 47 组 Method+Path |   | -> window.api             |  | worker/src/index.js   |
| - ApiTokenStore      |   | -> extension-ipc.ts (32)  |  | - R2 桶 REPORTS       |
| - LocalQueryApi      |   +-------------+-------------+  | - caches.default      |
| - LocalAgentApi      |                 |                | - Cron 17 3 * * *     |
| - ScheduledReportApi |                 v                +-----------------------+
| - HttpMediaService   |   +---------------------------+
+----------+-----------+   | ExtensionManager (Main)   |
           |               | - Registry / Storage /    |
           |               |   SecretStore (safeStorage)|
           |               | - ExtensionEventBus       |
           |               | - ExtensionSendGateway    |
           |               +-------------+-------------+
           |                             | fork (ELECTRON_RUN_AS_NODE=1)
           |                             v
           |               +---------------------------+
           |               | extensionHost (Subprocess)|
           |               | src/main/extensions/      |
           |               | host-runtime.ts (注入 tm) |
           |               +-------------+-------------+
           v                             v
+---------------------------------------------------------------------------------+
| 底层共享业务底座：Wcdb4Client / KnowledgeSearchService / VoicePipeline /         |
| AutomationRuleStore / WechatActionGateway / AgentHubService                     |
+---------------------------------------------------------------------------------+
```

> **页面桥双向回流注记**：当扩展 `iframe` 发起 `extension.request` 时，请求经 `ExtensionPageHost.tsx` → `window.api.extensionPageRequest` → `ExtensionManager` ↔ `ExtensionHost` ↔ `extensionHost`（`tm.page.onRequest`）调度同扩展后台处理，并将结果沿原路径通过 `postMessage` 双向回流至 `iframe`。

### 子系统规模与代码分布

| 子系统 | 核心源码目录 / 文件 | 规模统计 | 运行位置与隔离形态 |
|---|---|---|---|
| **Local HTTP API** | `src/main/http-server.ts`、`src/main/api-token-store.ts`、`src/main/http-media-service.ts`、`src/main/services/local-query-api-service.ts`、`src/main/services/local-agent-api-service.ts`、`src/main/services/scheduled-report-api-service.ts` | 6 个核心服务端文件 + `src/shared/` 4 个协议文件 | Electron 主进程内嵌 `node:http` 服务（默认 `127.0.0.1:6131`） |
| **Extension Center** | `src/main/extensions/`（21 文件）、`src/shared/extensions/`（10 文件）、`src/renderer/src/features/extensions/`（5 文件） | 36 个核心源码文件（32 IPC handle + 1 push） | 主进程控制面 + 每扩展独立 `ELECTRON_RUN_AS_NODE=1` Node 子进程 + 无 Preload `iframe` 沙箱 |
| **Extension SDK & 示例** | `packages/extension-sdk/`（3 文件）、`examples/extensions/`（3 套示例 + `template-lock.json`）、`scripts/build-extension-templates.cjs` | 3 个 SDK 文件 + 3 套官方模板（`keyword-bot`、`group-chat-bot`、`douyin-sender`） | 纯 `.d.ts` 类型契约（无运行期依赖）+ 确定性 ZIP 打包校验 |
| **Share Card Worker** | `services/share-card-worker/`（6 文件） | 1 个 Worker 入口 + 1 个单测文件 + 2 套 Wrangler 配置 | 独立 Cloudflare Worker + R2 存储桶 `wechatexplorer-share-reports` |

---

## 2. 模块职责与边界

### 2.1 Local HTTP API 模块职责与边界

Local HTTP API 是外部本地 Agent（如 Codex、Claude Code、Reader Skill 及内置 API Center）访问 TraceMemo 的唯一网络协议出口，严禁绕过 `src/main/http-server.ts` 直接暴露 Electron IPC 或数据库文件句柄。

- **`src/main/http-server.ts`（传输与路由边界）**：负责 `http.createServer` 监听（`DEFAULT_HTTP_HOST = '127.0.0.1'`、`DEFAULT_HTTP_PORT = 6131`）、`X-Request-Id` 透传/生成、Loopback CORS 校验、Bearer Token 鉴权、`withMethods` 动词守卫、1 MiB 请求体读取与排空保护，以及全部静态路由与 4 类动态路由工厂（Agent API、WeChat Send、Scheduled Report、Query、Media）分发。
- **`src/main/api-token-store.ts`（凭据边界）**：管理单一高熵随机 Bearer Token（32 字节 `base64url`，43 字符正则校验），经 Electron `safeStorage` 加密写入 `<userData>/local-api-token.bin`（`0o600` 权限）；支持迁移期的 `automaticGenerationBlockedReason` 防重建闸门。**服务端不接受环境变量覆盖 Token**。
- **`src/main/http-media-service.ts`（媒体读边界）**：`readImageMedia(messageId)` 仅通过 `getImageMessageReference(messageId)` 解析会话内部定位，先查高清原图再回退缩略图，调用 `ImageDecryptService.decryptImageToBase64WithFallbackAsync` 解密为二进制图片流，不接受客户端传入任意文件路径。
- **`src/main/services/local-query-api-service.ts`（结构化查询边界）**：向 `/api/v1/query/*` 提供确定性消息读取（`LIMIT_MAX = 200`）、受限语义关键词检索（结合 `ensureFreshness` 与单会话 WCDB `directReadKeywordFallback`）、前后文读取（`CONTEXT_MAX = 50`）、会话时间片概览（`OVERVIEW_SOURCE_CAP = 2000` / `OVERVIEW_EVIDENCE_TARGET = 60`）与离线语音转写调度（1–20 条 `messageRefs`）。
- **`src/main/services/local-agent-api-service.ts`（Agent 控制面边界）**：实现应用级 `/api/v1/capabilities`、退群监控读写 `/api/v1/monitors/group-exits*`、群成员活跃统计 `/api/v1/groups/{conversationId}/member-stats` 以及规范化自动化 CRUD/校验 `/api/v1/automations*`（强制创建时 `enabled: false`、禁止通过 `PATCH` 篡改 `ruleType/enabled`、保护 `leave_notification` 单例与内置规则）。
- **`src/main/services/scheduled-report-api-service.ts`（兼容投影边界）**：为 `/api/v1/scheduled-reports*` 与 `/api/v1/wechat-personal/send-capability` 提供旧 DTO 兼容适配，底层仍读写唯一的 `AutomationRuleStore`（仅投影 `target === source_chat` 的规则）；`retrySend` 固定返回 `501 not_supported`。

### 2.2 Extension Center（`src/main/extensions/` 21 文件 + `src/shared/extensions/` 10 文件）

扩展中心在主进程与子进程间严格划分**控制面（Main）**、**协议契约（Shared）**、**运行时（ExtensionHost）**与**页面容器（Renderer）**四层边界：

1. **共享契约层（`src/shared/extensions/`，10 文件）**：
   - `src/shared/extensions/permissions.ts`：定义 `EXTENSION_PERMISSIONS` 共 **11 项权限**，按风险分级：`storage` 为低风险（安装自动授予）；`contacts.list`、`ai.chat`、`automation.action`、`secrets` 为中风险；`messages.subscribe`、`messages.query`、`wechat.send.text`、`wechat.send.image`、`wechat.send.video`、`wechat.send.voice` 为高风险（均需启用时人工确认）。
   - `src/shared/extensions/manifest.ts`：定义 `EXTENSION_MANIFEST_VERSION = 1`、`EXTENSION_API_VERSION = '1'`、`EXTENSION_MIN_APP_VERSION = '2.6.0'`；校验反向域名 ID（禁止 `com.tracememo.` / `tracememo.` / `tm.`）、semver、安全相对路径 `isSafeRelativeEntryPath`（禁止绝对路径、`..`、Windows 保留名）与订阅/贡献结构（**未知权限或字段直接拒绝，不静默丢弃**）。
   - `src/shared/extensions/errors.ts`：定义 `EXTENSION_ERROR_CODES` 共 **23 个稳定错误码**与 `ExtensionError` / `toExtensionErrorPayload`。
   - `src/shared/extensions/rpc.ts`：定义 `EXTENSION_HOST_PROTOCOL_VERSION = 1`、15 个 `ExtensionHostCallMethod` 白名单调用与主↔子进程双向消息联合类型。
   - `src/shared/extensions/action-schema.ts`：定义动作输入 Schema 受控子集（`ACTION_SCHEMA_MAX_BYTES = 4096`、`ACTION_SCHEMA_MAX_PROPERTIES = 24`，支持 `string` / `number` / `integer` / `boolean` 与 `required` / `enum` / `default` / `minimum` / `maximum` / `minLength` / `maxLength`），供宿主与子进程共用 `validateActionInput`。
   - `src/shared/extensions/events.ts`：消息类型映射（`mapWechatMessageType`）与 `buildExtensionMessageEvent`（幂等事件标识 `eventId = message:<sha1(sessionId:localId)>`、`timestamp` 为毫秒）。
   - `src/shared/extensions/source.ts`：4 种来源 `'directory' | 'package' | 'template' | 'development'`。
   - `src/shared/extensions/templates.ts`：官方模板条目与 `python` / `chrome` / `externalScript` 依赖探测结构。
   - `src/shared/extensions/ipc.ts`：`EXTENSION_IPC` 共 **33 个键**（32 个 invoke + 1 个推送 `extension:changed`）及页面桥消息源常量与类型守卫 `isExtensionPageBridgeRequest`。
   - `src/shared/extensions/types.ts`：`InstalledExtension`、8 个白名单 `ExtensionPageMethod`、`ExtensionActionInfo`、`ExtensionCapabilitySnapshot`（含可选 `tts`）。

2. **主进程管理与隔离层（`src/main/extensions/`，21 文件）**：
   - **组装与编排**：`src/main/extensions/extension-service.ts`（主进程接线入口 `initExtensionSystem` 与模板根解析）、`src/main/extensions/extension-manager.ts`（1758 行，核心生命周期与开发模式编排）。
   - **子进程宿主与运行时**：`src/main/extensions/extension-host.ts`（主进程侧进程管理、背压、重启退避、stderr 脱敏采样与权限守门）与 `src/main/extensions/host-runtime.ts`（独立构建入口 `out/main/extensionHost.js`，向扩展注入受限 `tm` 全局对象）。
   - **安装、解析与指纹**：`src/main/extensions/extension-paths.ts`（`<userData>/extensions/`、`extensions-data/`、`extensions-state/`、`extensions-staging/` 路径解析与跨平台 `isPathInside`）、`src/main/extensions/extension-root-resolver.ts`（统一解析正式安装或开发模式代码根目录，拒绝指向宿主数据目录/系统根/用户主目录）、`src/main/extensions/extension-installer.ts`（目录/ZIP 安装、防符号链接逃逸、暂存原子替换、升级失败自动回滚）、`src/main/extensions/extension-code-digest.ts`（代码 SHA-256 指纹防模板静默覆盖）、`src/main/extensions/extension-project-files.ts`（模板创建独立项目并重写扩展 ID、导出已安装副本）、`src/main/extensions/extension-template-catalog.ts`（读模板 `index.json`、校验 ZIP SHA-256、静态探测本机 Python/Chrome/外部脚本）。
   - **状态、存储与安全凭据**：`src/main/extensions/extension-registry.ts`（`registry.json` + `.bak` 轮换 + `.corrupt-*` 保留与降级恢复）、`src/main/extensions/extension-storage.ts`（每扩展独立 `storage.json`，键 ≤64 字符，单值 ≤256KB，总量 ≤1MB，带损坏暂停闸门）、`src/main/extensions/extension-secret-store.ts`（`secrets/<id>.bin` 强制 `safeStorage` 加密，最多 32 键、单值 ≤8KB，不可用直接拒写不降级明文）、`src/main/extensions/extension-log.ts`（200 条环形缓冲 + 256KB 轮转 JSONL，剥离 ANSI 与控制字符）。
   - **协议、IPC 与业务桥**：`src/main/extensions/extension-protocol.ts`（`tm-extension://` 特权协议与严格 CSP）、`src/main/extensions/extension-ipc.ts`（32 个 IPC handler + `isTrustedSender` 校验）、`src/main/extensions/extension-event-bus.ts`（挂载 `MessageListenerService`，10 分钟/5000 条去重）、`src/main/extensions/extension-send-gateway.ts`（权限/范围/频率/能力/授权五重关卡后交 `WechatActionGateway`）、`src/main/extensions/extension-entitlement.ts`（macOS Native license / Windows `/license/status` 授权检查）、`src/main/extensions/extension-action-registry.ts`（分离 `declared` 与 `registered` 动作）、`src/main/extensions/extension-automation-bridge.ts`（自动化动作上下文注入覆盖）。

3. **渲染端容器与自动化集成（`src/renderer/src/features/`）**：
   - `src/renderer/src/features/extensions/ExtensionPageHost.tsx`：在 `<iframe sandbox="allow-scripts" referrerPolicy="no-referrer">` 中承载 `tm-extension://` 页面，通过 `postMessage` 白名单中继至 `window.api.extensionPageRequest`。
   - `src/renderer/src/features/extensions/ExtensionWorkspace.tsx`、`DevelopmentGuide.tsx`、`CreateProjectDialog.tsx`、`ExtensionTemplateGallery.tsx`：提供扩展安装/授权/日志/模板画廊与 M4 二次开发引导界面。
   - `src/renderer/src/features/automation/RuleEditorPanel.tsx`：已集成 `ExtensionActionList` 组件，监听 `window.api.onExtensionChanged`，允许用户在规则「触发后执行 → 执行扩展动作」中直接勾选与配置已注册扩展动作。

### 2.3 SDK 与扩展示例边界

- **`packages/extension-sdk/`**：`@tracememo/extension-sdk`（`private: true`）为纯粹给外部扩展作者使用的 TypeScript 类型包（`packages/extension-sdk/index.d.ts` + `packages/extension-sdk/README.md` + `packages/extension-sdk/package.json`）。仓库内部 `src/` 与 `tests/` 不导入此包，但该类型定义必须与 `src/shared/extensions/` 及 `src/main/extensions/host-runtime.ts` 的运行期行为保持严格一致。
- **`examples/extensions/`**：包含 3 套可独立安装或用作官方模板的示例扩展（`examples/extensions/keyword-bot/`、`examples/extensions/group-chat-bot/`、`examples/extensions/douyin-sender/`），受 `examples/extensions/template-lock.json` 与 `scripts/build-extension-templates.cjs` 确定性打包锁保护。

### 2.4 云端 Share Card Worker 边界（`services/share-card-worker/`）

`services/share-card-worker/` 是完全独立部署在 Cloudflare Workers 的实验性无状态边缘服务，不与 TraceMemo 本地数据库直连，仅由客户端将脱敏后的日报图片/缩略图与标题描述通过 `POST /api/cards` 主动上传至 R2 桶 `wechatexplorer-share-reports`。

---

## 3. 核心数据流与设计思路

### 3.1 Local HTTP API 请求处理管道与安全模型

```text
HTTP Request ──▶ 生成/校验 X-Request-Id (写入响应头 & 错误体)
                      │
                      ▼
               applyCorsHeaders (仅允许 http://localhost|127.0.0.1|[::1][:port])
                 ├─ 非法 Origin ──────────────────▶ 403 Forbidden
                 └─ OPTIONS 预检 ─────────────────▶ 204 No Content (鉴权前放行)
                      │
                      ▼
               路由匹配 (routes 静态表 -> Agent -> WechatSend -> Scheduled -> Query -> Media)
                 ├─ 未匹配 ───────────────────────▶ 404 Not Found
                 └─ 动词不在 allowedMethods ──────▶ 405 + Allow 响应头
                      │
                      ▼
               Bearer Token 鉴权 (仅 /api/v1/health 豁免)
                 └─ SHA-256 摘要 + timingSafeEqual 失败 ──▶ 401 Unauthorized
                      │
                      ▼
               readBody (非 GET/HEAD, 上限 MAX_JSON_BODY_BYTES = 1 MiB)
                 └─ 超限: req.resume() 排空 socket ──▶ 413 + Connection: close
                      │
                      ▼
               业务 Handler 执行并输出 JSON / Binary (Cache-Control: no-store)
```

**关键设计权衡**：
1. **单一全权限 Token 与安全停用**：`ApiTokenStore` 不允许通过环境变量覆写服务端 Token，且当 `safeStorage.isEncryptionAvailable()` 为 `false` 或旧版迁移未完成时（`setAutomaticGenerationBlocked`）主动停用本地 API，杜绝明文密钥或新旧 Token 静默覆盖。因为全端点共用同一 Token 且无 Scope 拆分，写入/外发端点（`/api/v1/wechat/send`、`/api/v1/automations*`、`/api/v1/monitors/group-exits` 等）必须与读取端点同等严密保管。
2. **413 请求体排空防 RST**：`src/main/http-server.ts:244-272` 在检测到 `Content-Length > 1 MiB` 或累计 chunk 超限时，**刻意调用 `req.resume()` 丢弃后续字节后再返回 `413` + `Connection: close`**，而非直接 `pause()` 关闭连接——防止 Windows TCP 栈与 Node `undici` 客户端因 socket 缓冲残留触发 `ECONNRESET` 而读不到 `413` 响应。
3. **Method Guard 全覆盖**：`withMethods(methods, handler)` 将允许的 HTTP 动词挂载在每个静态与动态路由函数上，彻底消除早期版本静态读路由未校验 `req.method` 的漏洞。
4. **敏感字段剥离与透明语音状态**：`/api/v1/chatlog` 通过 `sanitizeChatlogMessage` 移除 `contentData.aeskey`，并利用 `withChatlogVoiceTranscript` 附带只读缓存的 `voiceTranscriptState` 与 `messageRef`，引导外部 Agent 按需调用 `/api/v1/query/voice-transcribe`（队列繁忙返回 `429` + `Retry-After` 头）。

#### Local HTTP API 全量路由清单（实证 `src/main/http-server.ts:351-1365`）

| 路径 | 允许方法 | 处理器 / 依赖 Service | 关键约束与特殊状态码 |
|---|---|---|---|
| `/api/v1/health` | `GET` | `isReady()`、`app.getVersion()`、`skillResourceService` | 唯一免 Token；返回 `2.7.0` 与 Skill 状态 |
| `/api/v1/skill/tracememo-reader` | `GET` | `skillResourceService.getDocument()` | 返回 `markdown` 与 `contentHash`；缺失 `503` |
| `/api/v1/current_time` | `GET` | 系统时钟与 `Intl` | 返回 ISO 时间、时区、Unix 秒、`localDate` |
| `/api/v1/contact` | `GET` | `listContactsAsync(filter)` | 异步水合（解决 macOS 仅 raw id 问题）；`type=user\|group` |
| `/api/v1/chatroom` | `GET` | `listContactsAsync()` | 过滤群聊，支持 `keyword` |
| `/api/v1/recent_chat` | `GET` | `listRecentChat(limit)` | 默认 `limit=50` |
| `/api/v1/chatlog` | `GET` | `resolveMd5`、`listMessagesAsync` | 必填 `talker`；脱敏 `aeskey`；语音附 `messageRef` |
| `/api/v1/group_snapshot` | `GET` | `getGroupSnapshot(md5)` | 必填 `md5`；不存在 `404` |
| `/api/v1/resolve` | `GET` | `resolveMd5(q)` | 必填 `q`；未匹配 `404` |
| `/api/v1/report` | `POST` | `exportGroupReport` | 需 `{ report, metadata }`；禁传 `templateRef`（`400`） |
| `/api/v1/agent/group-report` | `POST` | `generateAgentGroupReport` | AI 总结并导出群日报图片 |
| `/api/v1/agent/status` | `GET` | `agentHubService.getStatus()` | 返回 Hub/Connector/DB 就绪状态 |
| `/api/v1/agent/send` | `POST` | `agentHubService.testSend` | iLink 机器人测试发送；Token 过期 `401`，离线 `503` |
| `/api/v1/wechat/send` | `POST` | `personalWechatCapabilityService`、`wechatActionGateway.execute` | 本机个人微信发 `text/image/voice/file`；支持 `fileName`、`at`（≤50人）、`idempotencyKey`；返回扁平 `{ success, errorCode, error }`（`400`/`403`/`500`/`502`/`503`） |
| `/api/v1/wechat-personal/send-capability` | `GET` | `ScheduledReportApiService.getCapability` | 查询个人微信发送能力；非 Win/Mac 降级 `unsupported` |
| `/api/v1/scheduled-reports` | `GET`, `POST` | `ScheduledReportApiService` | 旧 DTO 兼容投影（仅 `source_chat` 目标）；重复 `409` |
| `/api/v1/scheduled-reports/{taskId}` | `GET`, `PATCH`, `DELETE` | `ScheduledReportApiService` | 查询/更新/删除定时日报任务 |
| `/api/v1/scheduled-reports/{taskId}/enable\|disable` | `POST` | `ScheduledReportApiService.setEnabled` | 启用/暂停定时日报任务 |
| `/api/v1/scheduled-reports/{taskId}/run` | `POST` | `ScheduledReportApiService.run` | 立即执行一次 |
| `/api/v1/scheduled-reports/{taskId}/executions` | `GET` | `ScheduledReportApiService.executions` | 查询任务执行历史 |
| `/api/v1/scheduled-reports/executions/{executionId}/retry-send` | `POST` | `ScheduledReportApiService.retrySend` | 固定返回 `501 not_supported` |
| `/api/v1/media/{messageId}` | `GET`, `HEAD` | `readImageMedia` | 禁 `/` 与 `\`（`422`）；`private, no-store`、`nosniff`；`503/422/404/500` |
| `/api/v1/query/capabilities` | `GET` | `LocalQueryApiService.capabilities` | 返回 Query Tool v1 能力目录 |
| `/api/v1/query/messages` | `POST` | `LocalQueryApiService.messages` | 确定性消息查询（`limit` 上限 `200`） |
| `/api/v1/query/search` | `POST` | `LocalQueryApiService.search` | Knowledge + 新鲜度追赶 + WCDB 补齐 + OCR 覆盖度；未完整覆盖返回 `206` |
| `/api/v1/query/message-context` | `POST` | `LocalQueryApiService.context` | 通过 `messageRef` 取前后文（`CONTEXT_MAX = 50`） |
| `/api/v1/query/conversation-overview` | `POST` | `LocalQueryApiService.overview` | 直读 WCDB 按时间片采样概览证据 |
| `/api/v1/query/voice-transcribe` | `POST` | `LocalQueryApiService.transcribeVoice` | 1–20 条 `messageRefs`，`waitMs` ≤60000；队列忙 `429` + `Retry-After` |
| `/api/v1/capabilities` | `GET` | `LocalAgentApiService.getCapabilities` | 汇总应用版本、DB、Query、Automation、退群监控、群统计、个人/iLink 能力 |
| `/api/v1/monitors/group-exits` | `GET`, `PATCH` | `LocalAgentApiService` | 读取或原子修改 `enabled`/`monitoredConversationIds`（只认群 `xxx@chatroom`） |
| `/api/v1/monitors/group-exits/events` | `GET` | `LocalAgentApiService.listGroupExitMonitorEvents` | ISO-8601 `since`/`until`、`limit` 1..200 |
| `/api/v1/groups/{conversationId}/member-stats` | `GET` | `LocalAgentApiService.getGroupMemberStats` | 必填群 ID 及 ISO-8601 `start`/`end` |
| `/api/v1/automations` | `GET`, `POST` | `LocalAgentApiService` | 创建强制 `enabled: false`（`201`）；拒绝创建 `leave_notification`（`409`） |
| `/api/v1/automations/validate` | `POST` | `LocalAgentApiService.validateAutomation` | 干校验草稿与计算 `nextRunAt`，不落盘 |
| `/api/v1/automations/executions` | `GET` | `LocalAgentApiService.listExecutions` | 过滤 `ruleId`/`status`/`since`/`until`/`limit` |
| `/api/v1/automations/{id}` | `GET`, `PATCH`, `DELETE` | `LocalAgentApiService` | `PATCH` 禁改元数据与 `enabled`；`DELETE` 保护内置规则（`409`） |
| `/api/v1/automations/{id}/enable\|disable` | `POST` | `LocalAgentApiService.setAutomationEnabled` | 启用前校验 DB 就绪与规则有效 |

---

### 3.2 Extension Center 运行时隔离、页面桥与安全网关链路

1. **进程隔离与双层校验**：
   - 主进程永不 `require()` 扩展文件；每个启用且含 `entrypoints.background` 的扩展由 `forkExtensionHost` 启动独立 `ELECTRON_RUN_AS_NODE=1` 子进程运行 `host-runtime.ts`（`out/main/extensionHost.js`）。
   - 激活握手超时 `8s`；事件投递采用令牌桶背压（容量 `100`，每秒补充 `60`）避免突发消息拖死 `MessageListenerService`；stderr 持续消费并按 10s / 64KB / 20 条采样且通过 `redactSecrets` 脱敏 `Bearer` / `cookie` / `token` / `secret` 等键；异常退出采用 `1s / 2s / 4s` 指数退避重启，5 分钟内达 3 次自动进入 `crashed`；停用时先发 `shutdown` 等 `2.5s`，超时后执行进程树强杀（POSIX 进程组 `kill(-pid)` / Windows `taskkill /PID /T /F`）。
   - 子进程注入全局 `tm` 11 个命名空间（`extension`、`page`、`secrets`、`events`、`messages`、`wechat`、`ai`、`storage`、`automation`、`capabilities`、`log`），每次调用在 `host-runtime.ts` 与 `extension-host.ts` **双侧校验已授予权限**。
2. **页面沙箱与 `extension.request` 双向通道**：
   - 渲染端 `ExtensionPageHost.tsx` 用 `<iframe sandbox="allow-scripts" referrerPolicy="no-referrer" src="tm-extension://...">` 隔离扩展页面（无 Node、无 `preload`、无 `window.api`）。
   - `extension-protocol.ts` 在响应 `tm-extension://` 时使用 `realpath` 校验防符号链接逃逸，强制严格 CSP（`script-src 'self'`、`connect-src 'none'`、`object-src 'none'`），单文件上限 `20MB`。
   - 页面只能通过 `postMessage` 调用 `ExtensionPageMethod` 中的 **8 个白名单方法**：`storage.{get,set,remove,list}`、`capabilities.get`、`contacts.listGroups`（需 `contacts.list` 权限）、`extension.info` 与 `extension.request`。其中 `extension.request` 经 `ExtensionManager.pageRequest` → `ExtensionHost.requestPage` 路由至同扩展后台 `tm.page.onRequest` 注册的处理器（要求扩展已启用且后台运行，响应限制纯 JSON ≤64KB、超时 ≤90s）。
3. **微信发送五重安全闸门（`ExtensionSendGateway`）**：
   - 权限检查 → 收件人与文本长度/媒体路径校验（`realpath` 复核必须位于该扩展的 `extensions-data/<id>/` 或 `os.tmpdir()` 内，1B–100MB）→ manifest `subscriptions.conversationIds` 范围检查 → 扩展发送频率限制（2 秒间隔、60 秒最多 10 条）→ 本机发送能力与 `checkExtensionSendEntitlement` 授权校验 → 统一交 `WechatActionGateway`（强制标记 `origin: 'extension'`、`purpose: 'extension_send'`、幂等键前缀 `extension:<id>:`）。
4. **开发模式与数据保护**：
   - `ExtensionRootResolver` 使正式安装（`<userData>/extensions/<id>/`）与开发模式（用户本地目录）共用同一代码根目录解析器，避免后台读外部目录而页面读安装副本的错位；开发模式支持链接、重载、移除链接（绝不删除源码）、转为正式安装、从模板创建并重写 ID、以及导出已安装副本。
   - `ExtensionRegistry` 与 `ExtensionStorage` 均实行 `.tmp` 写回校验原子替换 + `.bak` 轮换 + 最多 3 份 `.corrupt-*` 现场保留；故障恢复后自动降级或暂停扩展（`storageHolds`），防止未确认的旧配置继续自动发送微信消息。
5. **已核实源码细节事实（仅作记录，不改变运行逻辑）**：
   - **Action `inputSchema` 传输差异**：`src/main/extensions/host-runtime.ts:274-286` 在 `tm.automation.registerAction` 向主进程发送 `register-action` 消息时，仅发送 `hasInputSchema: Boolean(definition.inputSchema)` 而未携带 `inputSchema: definition.inputSchema` 本体（尽管主进程 `src/main/extensions/extension-host.ts:632` 检查了 `action.inputSchema !== undefined`）。因此主进程 `ExtensionActionRegistry` 暂无法取得运行期动态注册的 `inputSchema`（仅子进程运行期执行 `invokeAction` 时会在 `host-runtime.ts:454` 按本地 `definition.inputSchema` 做校验）。
   - **`tm.secrets.delete` 返回值语义**：`src/main/extensions/host-runtime.ts:123-126` 中 `tm.secrets.delete(key)` 执行 `await callHost('secrets.delete', { key })` 但未 `return`，因此运行期返回 `Promise<void>`（主进程 `src/main/extensions/extension-host.ts:760` 实际返回 `{ removed: boolean }`），SDK 类型声明已同步对齐为 `Promise<void>`。

---

### 3.3 官方模板确定性打包锁（`examples/extensions/`）

`scripts/build-extension-templates.cjs` 负责将 `examples/extensions/` 下白名单中的 3 套模板（`keyword-bot`、`group-chat-bot`、`douyin-sender`）构建至 `build/extension-templates/`：

1. 排除 `".git"`、`"node_modules"`、`"tests/"` 目录以及未分发脚本（如 `"scripts/douyin.py"`、`"lib/bot-engine.js"`）等非分发或未确认许可文件；
2. 对文本文件执行 CRLF → LF 归一化（`normalizeLineEndings`），并用固定 DOS 时间戳与排序条目手写生成确定性 ZIP；
3. 计算每个模板 ZIP 的 `sha256` 与字节数，与 `examples/extensions/template-lock.json` 中 `<templateId>@<version>` 比对：若同一版本号内容发生变更且未传 `--update-lock`，构建与 `--check` 门禁直接失败退出，防止模板被意外篡改或忘记递增版本。

---

### 3.4 Cloudflare Share Card Worker 架构（`services/share-card-worker/`）

`services/share-card-worker/src/index.js` 通过无状态边缘路由 + R2 私有存储托管临时分享卡片：

1. **R2 对象布局与双层过期清理**：每张卡片在 R2 存储 3 个键——`cards/${id}/card.json`、`cards/${id}/report.png`、`cards/${id}/thumbnail.jpg`。`readCard` 读取后若判定 `Date.parse(card.expiresAt) <= Date.now()` 立即惰性删除 3 键并返回 `404`；同时由 `wrangler.jsonc` 配置的 Cron（`17 3 * * *`）定期触发 `cleanup(env)` 分页扫描清理。
2. **微信 JS-SDK 签名与缓存**：`GET /api/wx-signature` 校验 `pageUrl` 的 `origin === publicOrigin(request, env)` 后，利用 `caches.default` 缓存微信 `access_token` 与 `jsapi_ticket`（TTL 6900 秒），计算 SHA-1 签名供 `/s/{uuid}` 页面注入 `wx.config`。
3. **Origin 回退修复（基线修复项）**：`createCard`、`sharePage`、`signature` 与 `/l/{uuid}` 重定向均调用 `publicOrigin(request, env)`（`String(env.PUBLIC_ORIGIN || new URL(request.url).origin).replace(/\/+$/, '')`）。修复前 `viewPage` 漏传 `request` 且直接使用 `String(env.PUBLIC_ORIGIN)`，导致 `PUBLIC_ORIGIN` 缺失时渲染出 `src="undefined/a/${card.id}/report"` 破图；现已统一改为 `viewPage(request, env, card)` 并调用 `publicOrigin(request, env)`，并补充回归单测覆盖。

---

## 4. 关键文件与符号索引

### 4.1 Local HTTP API 核心文件与符号

| 文件路径 | 核心导出符号 / 关键实现 | 职责说明 |
|---|---|---|
| `src/main/http-server.ts` | `DEFAULT_HTTP_HOST`、`DEFAULT_HTTP_PORT`、`startHttpServer`、`apiServer`、`withMethods`、`readBody`、`applyCorsHeaders`、`isAuthorized` | 本地 HTTP 服务器主入口、安全中间件、39 条路径模式 / 47 组 Method+Path 路由分派与 `EADDRINUSE` 退避重试 |
| `src/main/api-token-store.ts` | `ApiTokenStore`、`apiTokenStore` | 32 字节 `base64url` Token 生成、Electron `safeStorage` 加密持久化（`0o600`）与迁移阻塞闸门 |
| `src/main/http-media-service.ts` | `readImageMedia`、`resetHttpMediaService`、`HttpMediaError` | 按消息引用解密图片消息为二进制流（高清优先，缩略图回退） |
| `src/main/services/local-query-api-service.ts` | `LocalQueryApiService`、`buildImageOcrCoverage` | Query Tool v1 五个查询与转写操作实现（`capabilities`/`messages`/`search`/`context`/`overview`/`transcribeVoice`） |
| `src/main/services/local-agent-api-service.ts` | `LocalAgentApiService`、`LocalAgentApiError` | `/api/v1/capabilities`、退群监控、群统计与自动化 CRUD/干校验适配层 |
| `src/main/services/scheduled-report-api-service.ts` | `ScheduledReportApiService`、`ScheduledReportApiError` | 旧版 `/api/v1/scheduled-reports*` 兼容投影与 `501` `retrySend` |
| `src/shared/local-api-test.ts` | `LOCAL_API_ENDPOINTS`（24 项） | API Center 本地接口测试器的共享端点目录定义 |
| `src/shared/local-api-auth.ts` | `ApiTokenStatus`、`ApiTokenActionResult`、`ApiTokenRevealResult` | 本地 API Token 状态与 Reveal/Rotate IPC 类型 |
| `src/shared/local-query-api.ts` | `encodeMessageRef`、`decodeMessageRef`、`VOICE_TRANSCRIBE_MAX_REFS` | `messageRef` 编解码与 Query Tool 请求/响应契约 |
| `src/shared/scheduled-report-api.ts` | `ScheduledReportApiCreateRequest`、`ScheduledReportApiTask` | 定时日报 HTTP 兼容 API DTO 类型 |

### 4.2 Extension Center（Main 21 + Shared 10 + Renderer）

| 文件路径 | 核心导出符号 / 关键实现 | 职责说明 |
|---|---|---|
| `src/main/extensions/extension-service.ts` | `initExtensionSystem`、`getExtensionManager`、`disposeExtensionSystem` | 扩展系统主进程组装接线与官方模板路径解析 |
| `src/main/extensions/extension-manager.ts` | `ExtensionManager` | 扩展全生命周期、开发模式、页面桥转发、事件订阅、查询与能力快照编排 |
| `src/main/extensions/extension-host.ts` | `ExtensionHost`、`forkExtensionHost`、`redactSecrets`、`killProcessTree` | 独立子进程宿主、令牌桶背压、指数退避重启与白名单 RPC 执行 |
| `src/main/extensions/host-runtime.ts` | 全局 `tm`（11 命名空间）、`activate`、`invokeAction`、`handlePageRequest` | 子进程运行期入口（构建产物 `out/main/extensionHost.js`） |
| `src/main/extensions/extension-protocol.ts` | `EXTENSION_SCHEME`、`registerExtensionScheme`、`installExtensionProtocolHandler` | `tm-extension://` 特权协议、`realpath` 校验与严格 CSP |
| `src/main/extensions/extension-ipc.ts` | `registerExtensionIpc` | 32 条 `extension:*` `ipcMain.handle` 与 `isTrustedSender` 校验 |
| `src/main/extensions/extension-paths.ts` | `createExtensionPaths`、`getExtensionPaths`、`isPathInside`、`isSamePath` | 扩展四类 `userData` 目录解析与跨平台路径包含判定 |
| `src/main/extensions/extension-root-resolver.ts` | `createExtensionRootResolver`、`assertSafeDevelopmentRoot` | 正式安装与开发模式代码根目录唯一解析器及目录安全边界 |
| `src/main/extensions/extension-installer.ts` | `ExtensionInstaller` | 目录/ZIP 校验安装、防符号链接穿越、暂存原子替换与升级回滚 |
| `src/main/extensions/extension-code-digest.ts` | `computeDirectoryDigest`、`countDigestFiles` | 扩展安装副本代码 SHA-256 指纹计算 |
| `src/main/extensions/extension-registry.ts` | `ExtensionRegistry` | 扩展状态表持久化（`.bak` 轮换、`.corrupt-*` 保留与降级恢复） |
| `src/main/extensions/extension-storage.ts` | `ExtensionStorage` | 每扩展私有键值 JSON 存储（单值 ≤256KB、总量 ≤1MB、恢复确认闸门） |
| `src/main/extensions/extension-secret-store.ts` | `ExtensionSecretStore` | `safeStorage` 加密的扩展私有凭据存储（最多 32 键、单值 ≤8KB） |
| `src/main/extensions/extension-send-gateway.ts` | `ExtensionSendGateway`、`extensionIdempotencyKey` | 扩展微信发送五重校验（权限/媒体边界/范围/频率/授权）并交 `WechatActionGateway` |
| `src/main/extensions/extension-entitlement.ts` | `checkExtensionSendEntitlement` | 主进程可信扩展发送授权检查（macOS Native / Windows Hook） |
| `src/main/extensions/extension-event-bus.ts` | `ExtensionEventBus`、`buildEventId` | 消息事件规范化、10 分钟/5000 条去重、`mentionsMe` 精确判定与分发 |
| `src/main/extensions/extension-action-registry.ts` | `ExtensionActionRegistry` | 维护扩展自动化动作的 `declared` 与 `registered` 视图 |
| `src/main/extensions/extension-automation-bridge.ts` | `invokeExtensionAction`、`canExtensionSendText` | 自动化动作桥接，向用户输入强制覆盖宿主上下文 |
| `src/main/extensions/extension-log.ts` | `ExtensionLogStore` | 每扩展 200 条内存环形缓冲 + 256KB 轮转 JSONL 日志 |
| `src/main/extensions/extension-project-files.ts` | `createProjectFromTemplate`、`exportInstalledCopy`、`rewriteExtensionIdentity` | 从模板生成独立扩展项目与导出已安装副本 |
| `src/main/extensions/extension-template-catalog.ts` | `ExtensionTemplateCatalog` | 官方模板索引读取、ZIP SHA-256 校验与本机依赖探测 |
| `src/shared/extensions/`（10 文件） | `manifest.ts`、`permissions.ts`、`errors.ts`、`rpc.ts`、`action-schema.ts`、`events.ts`、`source.ts`、`templates.ts`、`ipc.ts`、`types.ts` | 扩展 Manifest、11 项权限、23 个错误码、RPC、Schema、事件、模板、33 键 IPC 与页面桥契约 |
| `src/renderer/src/features/extensions/ExtensionPageHost.tsx` | `ExtensionPageHost` | `<iframe sandbox="allow-scripts">` 扩展页面宿主与 `postMessage` 中继 |
| `src/renderer/src/features/automation/RuleEditorPanel.tsx` | `RuleEditorPanel`（集成 `ExtensionActionList`） | 自动化规则编辑器中的扩展动作选择与参数表单集成 |

### 4.3 SDK、示例与 Share Card Worker

| 文件路径 | 核心符号 / 内容 | 职责说明 |
|---|---|---|
| `packages/extension-sdk/index.d.ts` | `ExtensionPermission`、`TraceMemoApi`、`TraceMemoAutomationActionDefinition`、`TraceMemoActivate` | `@tracememo/extension-sdk` 类型定义（含 `tm.secrets` 与 `tm.page.onRequest`） |
| `packages/extension-sdk/package.json` & `packages/extension-sdk/README.md` | `@tracememo/extension-sdk`（`private: true`） | SDK 包元数据与使用约定说明 |
| `examples/extensions/keyword-bot/` | `manifest.json`、`background/index.js`、`lib/matcher.js`、`ui/`、`examples/extensions/keyword-bot/tests/matcher.test.mjs` | 关键词回复与自动化动作示例（v1.0.1） |
| `examples/extensions/group-chat-bot/` | `manifest.json`、`background/index.js`、`ui/` | 多人格群聊记忆 + AI + TTS 语音示例（v1.0.0） |
| `examples/extensions/douyin-sender/` | `manifest.json`、`background/index.js`、`lib/douyin.js`、`ui/`、`examples/extensions/douyin-sender/tests/douyin.test.mjs` | @我 触发抖音视频解析 + `tm.secrets` Cookie 存储示例（v1.0.5） |
| `examples/extensions/template-lock.json` & `scripts/build-extension-templates.cjs` | `buildTemplates`、`TEMPLATE_SPECS` | 官方扩展模板确定性 ZIP 打包与防篡改锁 |
| `services/share-card-worker/src/index.js` | `router`、`createCard`、`serveAsset`、`sharePage`、`viewPage`、`signature`、`cleanup`、`publicOrigin` | Cloudflare Worker 路由、R2 管理、微信 JS-SDK 签名与定期清理 |
| `services/share-card-worker/test/index.test.js` | `MemoryR2` + 6 个 `node:test` 用例 | 鉴权、R2 缺失 503、卡片创建/过期清理、HTML 转义/SHA-1、`/v/:id` origin 回退单测 |
| `services/share-card-worker/wrangler.jsonc` & `wrangler.verify.jsonc` | `REPORTS` binding、`17 3 * * *` Cron | Wrangler 生产与无 R2 验证配置 |

---

## 5. 后续维护与开发指南

### 5.1 新增 Local HTTP API 端点的标准联动清单

1. 在 `src/main/http-server.ts` 注册路由并使用 `withMethods([...], handler)` 声明允许方法（严禁裸挂未校验动词的 handler）；若属 Agent 控制面，路径纳入 `isAgentApiPath` 并使用 `sendAgentHttpError` 输出统一 `{ error: { code, message, details? }, requestId }` 结构。
2. 如需在桌面端 API Center 测试器展示，同步补充 `src/shared/local-api-test.ts` 的 `LOCAL_API_ENDPOINTS`。
3. 同步更新 `docs/agent/api.md` 与 `docs/agent/api-security.md`（写/执行操作必须补入安全边界清单）。**严禁擅自修改 `docs/skill/tracememo-reader/SKILL.md`**（除非同步发版并提升其 `version` 以通过 `pnpm check:skill-version`）。

### 5.2 扩展系统与模板维护注意事项

1. **权限/API 变更四处同步**：任何 `src/shared/extensions/` 与 `src/main/extensions/host-runtime.ts` 能力增减，必须同步更新 `packages/extension-sdk/index.d.ts`、`packages/extension-sdk/README.md` 与 `docs/extensions/api-reference.md`。
2. **模板锁红线**：严禁在不更新版本或确认 `--update-lock` 的情况下修改 `examples/extensions/` 下的模板源文件；打包/发布前运行 `node scripts/build-extension-templates.cjs --check` 校验一致。
3. **跨进程状态安全**：不要绕过 `ExtensionSecretStore` 落盘明文凭据；不要让 `ExtensionPageHost` 或 `extension-protocol.ts` 放宽 `connect-src 'none'` 与 `sandbox="allow-scripts"` 隔离边界。

### 5.3 日常校验与测试命令

```powershell
# 1. Cloudflare Share Card Worker 语法与回归测试
node --check services/share-card-worker/src/index.js
node --test services/share-card-worker/test/index.test.js

# 2. 扩展模板锁与 Skill 版本防漂移检查
node scripts/build-extension-templates.cjs --check
pnpm check:skill-version

# 3. 官方扩展示例单测
node --test examples/extensions/keyword-bot/tests/matcher.test.mjs examples/extensions/douyin-sender/tests/douyin.test.mjs

# 4. 知识库路径与交叉链接自动化校验
node scripts/check-knowledge-base.mjs
```

### 5.4 相关专题交叉导航

- 整体进程拓扑与技术栈：[01. 系统架构总览](./01-system-overview.md)
- 主进程生命周期、`safeStorage` 与数据底座：[02. 主进程生命周期与核心数据访问](./02-main-process-and-data.md)
- Knowledge FTS5、OCR、语音与 Query 底层链路：[03. 知识库、语音与 AI 检索管道](./03-knowledge-and-ai-pipeline.md)
- 群日报、自动化规则引擎、退群监控与 `WechatActionGateway` / `AgentHubService`：[04. 报告导出、自动化与 Agent Hub](./04-reports-automation-hub.md)
- 渲染层工作区、`window.api` Preload 与 IPC 通道全表：[06. 渲染层、共享契约与 IPC 通道](./06-renderer-and-ipc.md)
- 构建脚本、双版打包与模板资源注入：[07. 构建脚本与打包分发](./07-build-scripts-and-packaging.md)
- 6 层测试体系与质量门禁：[08. 测试体系与质量门禁](./08-testing-and-quality-gates.md)
- 全仓文件与导出符号总索引：[09. 核心符号与文件总索引](./09-symbol-and-file-index.md)
