# 02. 主进程生命周期与核心数据访问

> **源码基线**：`8f47dca`｜**适用范围**：`src/main/`（174 文件）全景、应用启停生命周期、安全存储与跨身份迁移、`Wcdb4Client`/Koffi 数据底座、Win/Mac 密钥提取与图片解密双层缓存链路

---

## 1. 架构总览

主进程 `src/main/` 共 **174 个 TypeScript 文件**，是整个 TraceMemo 的核心控制面与本地数据网关。其架构围绕**「安全边界前置、只读微信数据、进程外隔离写/原生高危操作、异步非阻塞排空」**四条主线展开：

```text
[Electron Main Process 启动时序]
  preload-env.ts (Windows DLL 搜索路径前置)
  app-data-bootstrap.ts (锁定 TraceMemo / Helper 身份与 userData/logs 路径)
         │
         ▼ (app ready 前)
  installSafeConsole() + registerExtensionScheme() + wxe-media:// 特权注册
         │
         ▼ (app.whenReady)
  ┌─ isLegacyMigrationHelper? ──Yes──> runLegacySafeStorageHelper() ─> app.exit(0/1)
  └─ No ─> runFirstLaunchMigration() (WechatExplorer -> TraceMemo 断点续迁)
                │
                ▼
         实例化业务服务并连线 (Voice / Knowledge / ImageTextIndex / QueryAgent /
         AskWechat / AgentHub / SendGateway)
                │
                ▼
         注册 IPC (index.ts 203 + extension-ipc.ts 32 + report-template-ipc.ts 6)
         创建主窗口 createWindow() + 异步 bootstrapWcdbNativeAsync() + 启动 HTTP/AgentHub/托盘
```

### `src/main/` 全目录分布（实测 174 个文件）

| 子目录 | 文件数 | 核心职责边界 |
|---|---:|---|
| `src/main/`（根级模块） | 45 | 应用入口 `src/main/index.ts`、路径引导与迁移、4 类 `safeStorage` 存储、`Wcdb4Client` 与 `WechatDb`、消息解析、Win/Mac 密钥提取、图片解密、多媒体资产、导出、日报与模板、本地 HTTP 服务、日志脱敏、POC/测试入口 |
| `src/main/services/`（含 `src/main/services/wechat-ilink/` 13 个） | 81 | 会话与启动缓存、账号发现与权限探针、AI Provider 与双引擎检索（`QueryAgentService` / `AiSearchPipelineService`）、OCR 索引、实时监听与退群监控、防回环自动化、个人微信/iLink 发送网关、Agent Hub、设置/缓存/更新、外部组件定位 |
| `src/main/extensions/` | 21 | 扩展生命周期管理、安装/卸载、开发目录链接、权限管控、`ExtensionSecretStore`/`ExtensionStorage`、事件总线、`ExtensionSendGateway`、`tm-extension://` 协议、`extensionHost` 子进程宿主与 `src/main/extensions/host-runtime.ts` |
| `src/main/voice-pipeline/` | 17 | SILK/FFmpeg 解编码、SenseVoice 模型管理、串行调度器、`SqliteTranscriptRepository`、`RecognitionHost` 与 `src/main/voice-pipeline/voice-recognition-worker.ts` |
| `src/main/knowledge/` | 9 | 消息规范化与分块、SQLite FTS5 `KnowledgeStore`、`KnowledgeService`、`KnowledgeSearchService`、`KnowledgeWorkerHost` 与 `src/main/knowledge/knowledge-worker.ts` |
| `src/main/db/` | 1 | `src/main/db/image-insights-store.ts`（Vision 图片理解结果持久化存储） |

---

## 2. 模块职责与边界

### 2.1 启动引导与生命周期模块
- `src/main/app-data-bootstrap.ts`：**必须作为 `src/main/index.ts` 的首个业务导入**（`src/main/index.ts:3-7`），防止后续静态导入的 `src/main/services/settings-store.ts` 等模块过早解析旧路径。支持 `TRACEMEMO_LEGACY_MIGRATION_HELPER=1`（临时切换 `WechatExplorer` 身份）与 `WXE_USER_DATA`（测试/隔离模式）并独立设置 `logs` 目录（macOS 为 `~/Library/Logs/TraceMemo`，Windows 为 `<userData>/logs`）。
- `src/main/preload-env.ts`：Windows 下把本地 `resources/wcdb/win32/`、`resources/key/win32/`、`resources/runtime/win32/` 前置写入 `PATH` 并设置 `WCDB_RESOURCES_PATH`，确保随包 MSVC 运行库与原生 DLL 优先加载。
- `src/main/safe-log.ts` & `src/main/app-logger.ts`：`installSafeConsole()` 包裹 `console.*` 吞掉 `electron-vite` 关闭管道产生的 `EPIPE`；`AppLogger` 将结构化 JSON 日志写入 `tracememo.log`（5MB 轮转 `.1`），并对 `sk-*`、`Bearer`、64 位 hex DB Key 及敏感键名自动脱敏。
- `src/main/index.ts`：统筹单应用生命周期、窗口/托盘、协议注册、服务连线与 203 条核心 IPC（202 `handle` + 1 `on('ping')`）。

### 2.2 安全存储与跨身份迁移模块
- 4 类 `safeStorage` 凭据存储：`DatabaseKeyStore`（`src/main/database-key-store.ts`）、`ImageKeyStore`（`src/main/image-key-store.ts`）、`AIProviderKeyStore`（`src/main/ai-provider-key-store.ts`）、`ApiTokenStore`（`src/main/api-token-store.ts`）。所有写入均以 `0o600` 权限落盘，且对未完成迁移的旧 API Token 采用 `setAutomaticGenerationBlocked` 阻断静默重建。
- 迁移与路径仲裁：`src/main/app-data-paths.ts`、`src/main/app-data-migration.ts`、`src/main/legacy-safe-storage-helper.ts`。

### 2.3 核心数据访问、密钥与解密模块
- **WCDB4 原生数据层**：`src/main/wcdb4-client.ts`（4519 行）直接通过 Koffi FFI 对接 `wcdb_api.dll` / `libwcdb_api.dylib`；`src/main/wechat-db.ts` 在其上封装 `WechatDb` 业务模型；`src/main/services/chat-service.ts` 维护会话连接、格式化性能统计与 `imageMessageReferences`；`src/main/services/bootstrap-cache.ts` 提供带内容指纹与退出刷盘纪元（`flushEpoch`）的启动缓存。
- **跨平台密钥提取**：`src/main/key-service-win.ts`（1167 行）与 `src/main/key-service-mac.ts`（752 行）。
- **图片解密与缓存**：`src/main/image-decrypt-service.ts`（1954 行），结合 `worker_threads` 与双层 LRU/持久化磁盘缓存。

---

## 3. 核心数据流与设计思路

### 3.1 主进程启动、窗口/托盘与优雅退出流程（`src/main/index.ts`）

1. **启动与协议前置**：
   - 顶层首组导入 `app-data-bootstrap.ts` 与 `preload-env.ts`（`src/main/index.ts:3-8`），第 651 行立即安装 `installSafeConsole()`。
   - 在 `app.whenReady()` 之前调用 `registerExtensionScheme()`（`L1093`）和 `protocol.registerSchemesAsPrivileged` 注册 `wxe-media`（`L827-832`）。
2. **迁移与服务实例化（`app.whenReady`, `L1095-1496`）**：
   - 若为 `isLegacyMigrationHelper`，执行 `runLegacySafeStorageHelper()` 并直接 `app.exit(0/1)`（`L1095-1103`）。
   - 非 `WXE_USER_DATA` 隔离模式下执行 `runFirstLaunchMigration(appDataRoots)`，并将结果注入 `apiTokenStore.setAutomaticGenerationBlocked(migration?.tokenBlockReason)`（`L1106-1107`）。
   - 顺序实例化并绑定核心链路：`VoiceRecognitionUseCase` ↔ `KnowledgeSearchService`（语音转写与索引双向同步）、`imageTextIndexService.bind(...)`（OCR 派生文本）、`AiSearchPipelineService`、`LocalQueryApiService`、`GroupStatsService`、`VoiceTranscriptionGateway`、`QueryAgentService`、`AskWechatService`、`agentHubService`、`wechatSendGateway.configureIlinkSender(...)`（`L1163-1360`）。
   - 注册 `wxe-media://` Range 流媒体响应器（`L1376-1385`）、输出外置发送组件定位日志（`L1398-1419`）、对齐 `msgInsertCapabilityService` 能力门禁（`L1421-1425`）。
   - 在原生 WCDB 初始化前先调用 `createWindow()`（按主屏工作区 60% 计算尺寸，下限 1400×900 夹逼，最小 960×640，开启 `preload: ../preload/index.js` 且 `sandbox: false`，`L989-1011`），再异步启动 `initExtensionSystem()` 与 `bootstrapWcdbNativeAsync()`（`L1476-1489`），确保界面秒开可见。
   - 注册完其余 IPC 后，在 `L3721-3733` 确保 API Token、按需启动 `apiServer`（默认 `127.0.0.1:6131`）、启动 `agentHubService` / `scheduledReportService` / `setupTray()`（支持 `--tray` 或 `WXE_TRAY=1` 启动隐藏至托盘，`L839-840`）。
3. **关闭弹窗与 `before-quit` 幂等清理（`L1025-1074, L3755-3812`）**：
   - 关闭主窗口时读取 `settings.closeAction`（`ask`/`tray`/`quit`），首次支持弹窗勾选「记住我的选择」；隐藏托盘时 macOS 同步调用 `app.dock?.hide()`。
   - `before-quit` 通过 `quitCleanupStarted`/`quitCleanupComplete` 保证幂等：`event.preventDefault()` 后依次取消 `voiceBatchService`、停止 `agentHubService` / `scheduledReportService` / `groupExitMonitorService`、销毁扩展系统、同步刷盘 `flushBootstrapCacheWritesSync()`、并 `Promise.all` 并发停止 `apiServer`、排空 WCDB (`chat.closeChatDbForQuit()`)、释放语音与知识库 Worker。**刻意保留 macOS `tm-wechat-host` 不随主进程关闭**（`L3776-3790`），以保留已绑定的 Frida 会话避免重启重新绑定；最终调用 `app.exit(0)`（`L3810`）避免 macOS 二次 `before-quit` 挂起。

### 3.2 安全存储矩阵与 `WechatExplorer` → `TraceMemo` 跨身份迁移链路

1. **四类 `safeStorage` 加密资产**

| 存储类 | 落盘路径（`<userData>` 下） | 存储结构与安全策略 |
|---|---|---|
| `DatabaseKeyStore` | `database-keys/<sha256(lower(resolve(accountRoot)))>.bin` | 仅接受 64 位 hex（去 `0x`）；文件权限 `0o600`；兼容读取并清理旧版单文件 `wechat-db-key.bin` |
| `ImageKeyStore` | `wechat-image-keys.bin` | JSON `{ version: 1, accounts: Record<string, { xorKey, aesKey, updatedAt }> }` 整包加密，`0o600` |
| `AIProviderKeyStore` | `ai-provider-keys.bin` | JSON `{ version: 1, keys: Record<string, string> }` 加密保存 |
| `ApiTokenStore` | `local-api-token.bin` | 32 字节 `base64url`（43 字符正则校验）；存在阻塞开关 `automaticGenerationBlockedReason` 防旧 Token 未迁先建 |

2. **跨身份迁移流程（`app-data-paths.ts` + `app-data-migration.ts` + `legacy-safe-storage-helper.ts`）**
   - **源目录识别与冲突仲裁**：`selectUserDataRoot()`（`app-data-paths.ts:163-249`）结合 `hasValidUserAssets()`（`L125-146`，排除 Chromium 运行时文件，只认 `settings.json`、`knowledge/*/knowledge.sqlite`、`.bin` 密钥、报告/撤回/数字分身/退群监控等资产）检测 `WechatExplorer` 与小写 `wechatexplorer`（v2.1.9 遗留）。若两处独立存在有效资产，确定性选择 `WechatExplorer` 并标记 `legacyConflict: true`。
   - **Staging 无覆盖迁移**：`executeMigration()`（`app-data-migration.ts:447-569`）将文件（`settings.json`、`ai-providers.json`、`image-insights.json`、`group-exit-monitor.json`）与目录（`knowledge`、`reports`、`recall-archive`、`Local Storage`、`digital-twin`、`group-exit-monitor`）先拷贝至临时目录 `.tracememo-migration-staging-v1` 再原子移入目标（目标已有则 `skipped`，绝不删改旧目录）。
   - **一致性与增量合并**：`knowledge` 拷贝后逐库比对主库及 `-wal`/`-shm` 字节大小，并派生 `ELECTRON_RUN_AS_NODE=1` 子进程以 `DatabaseSync(..., { readOnly: true })` 执行 `PRAGMA integrity_check`（`L218-269`）；语音缓存 `cache/voice-transcripts.sqlite` 走增量合并；Agent 凭据树从 `~/.wechatexplorer/wechat-connector/accounts` 补全至 `~/.tracememo/wechat-connector/accounts`（`L358-366`）。
   - **跨身份加密解密桥**：`runLegacySecretHelper()`（`L384-445`）派生带 `TRACEMEMO_LEGACY_MIGRATION_HELPER=1` 的子进程，子进程在 `app-data-bootstrap.ts` 中以 `WechatExplorer` 身份调用 `safeStorage.decryptString` 解密旧 `.bin` 文件，再通过 `stdio[3]` 匿名管道（上限 5MB，30s 超时）将明文 JSON 传回父进程，由父进程以 `TraceMemo` 身份重加密写盘；全过程状态记录于 `tracememo-migration-v1.json`，支持 `deferred`/`partial` 断点续迁。

### 3.3 `Wcdb4Client` 数据访问、管道监听与 `tm-wcdb-config-helper` 写入隔离

`src/main/wcdb4-client.ts`（4519 行）是微信 4.0 数据读写的底层引擎：

1. **进程级单例引导与 FFI 排空**：
   - `bootstrapWcdbNative()` / `bootstrapWcdbNativeAsync()`（`L218-379`）预加载 `WCDB.dll` + `SDL2.dll`（Windows）或 `libWCDB.dylib`（macOS），调用 `InitProtection` 与 `wcdb_init()` 并缓存模块级单例 `wcdbBootstrapLib`（`L149`），避免 Windows 下二次调用 `wcdb_init()` 返回 `-1006` 错误。
   - `loadNativeLibrary()`（`L3428-3681`）通过 Koffi 绑定 30 余个原生导出符号（涵盖开库 `wcdb_open_account`、会话 `wcdb_get_sessions`、游标 `wcdb_open_message_cursor`/`fetch`/`close`、任意只读 SQL `wcdb_exec_query`、群成员/群昵称/头像、语音/图片/视频硬链解析、表情 CDN 解析、消息插入开关与监听管道）。
   - `closeAsync(8_000)`（`L939-951`）先停监听再通过 `waitForNativeCalls()`（`L981-1001`）等待 `nativeCallsInFlight`（`L605`）集合排空，最后仅在排空成功且非 Windows 平台时调用 `wcdb_shutdown()`（`L953-965`）；若超时返回 `false`，`finishClose(false)` 会跳过 `wcdbShutdown()` 但仍清理 JS 侧句柄与缓存（`L966-979`）。
   - 针对错误码 `-3002`（一码四因），`describeDbOpenFailure()`（`L166-189`）先实测文件存在性与 `R_OK` 权限再区分密钥错误/损坏；对 macOS 权限受拒则抛出 `PathAccessDeniedError`（`L715-728`）。
2. **Windows 非 ASCII 路径 NTFS Junction 桥（`L412-470`）**：
   - `resolveWindowsNativeAccountRoot()` 检测 `accountRoot` 是否含中文等非 ASCII 字符；若是，则在 `%PUBLIC%\TraceMemo\path-bridges\<sha256(lower(resolvedAccountRoot))[0:24]>`（并优先复用匹配的旧 `%PUBLIC%\WechatExplorer\path-bridges\<id>`）建立 `junction` 软链接，向 C++ WCDB 提供纯 ASCII 路径。
3. **双向兼容的管道监听（`L472-543, L1003-1158`）**：
   - `startMonitor()` 调用原生 `wcdb_start_monitor_pipe` + `wcdb_get_monitor_pipe_name` 获取管道/Socket 路径，通过 `node:net` `createConnection` 建立长连接，处理 `\0` 与 `}\s*{` 粘包拆包，并在断开后每 **3 秒**自动重连。
   - `parseMonitorEvent()` 严格校验 v2 契约（`version === 2 && kind === 'message_change' && Boolean(session_id)`）；不满足时自动降级为 `protocol: 1`（仅触发最近会话回读），防止不可信会话 ID 误读。
4. **分片查询与进程外写库隔离**：
   - `getMessagesAsync()`（`L1411-1483`）结合原生游标与跨分片表扫描（应对历史消息落在游标未枚举分片的边界情况），并按 `recallJournalEnabled` 合并 `_wxe_recall_journal_` 召回记录。
   - `scanLegacyRecallResidue()`（`L2462-2515`）以只读方式扫描旧版 `_wxe_capture_*` 触发器并识别 `RAISE(IGNORE)` 阻塞型 vs 被动型；而所有真正向微信库写入配置（`_tm_config`、`_tm_msg_insert_capture_<md5>`）或插入退群提示的动作，均由 `src/main/services/msg-insert-switch-service.ts` 与 `src/main/services/wechat-local-exit-notice-service.ts` 派生短生命周期的 **`tm-wcdb-config-helper`** 子进程执行（规避同进程 WCDB 只读连接池报 `-3004`），密钥仅经 `stdin` JSON 传入，Windows 下由 `src/main/services/external-component-locator.ts` 校验 `%LOCALAPPDATA%\TraceMemo\Pro\windows-x64\current.json` 及文件 SHA-256 定位。

### 3.4 Win/Mac 密钥提取与图片解密/双层缓存链路

1. **Windows 密钥提取（`src/main/key-service-win.ts`）**
   - **数据库密钥（`autoGetDbKey`, `L626-698`）**：Koffi 加载 `wx_key.dll`（若 DLL 位于 `\\` 网络路径则先缓存至 `%TEMP%\tracememo_dll_cache`，`L111-126`）；结合 `tasklist` 与 `user32.dll` 检测微信窗口组件就绪状态，调用 `InitializeHook(pid)` 并以 120ms 间隔轮询 `PollKeyData`，支持微信重启自动重绑与登录界面检测提示。
   - **图片密钥（`autoGetImageKeyByMemoryScan`, `L712-830`）**：
     1. 扫描最新 `*_t.dat`（V2 头 `07 08 56 32 08 07`），由末尾两字节反推 JPEG 尾 `FF D9` 计算 1 字节 `xorKey`，并提取偏移 `0x0f..0x1f` 的 16 字节密文；
     2. **优先本地元数据推导（`_deriveImageKeyByLocalMetadata`, `L832-867`）**：扫描 `kvcomm` 目录 `key_<code>_*.statistic` 提取 `code`，结合标准化 `wxid` 枚举生成 `{ xorKey, aesKey }` 并用 AES-128-ECB 解密检验图像魔数（JPEG/PNG/WEBP/WXGF/GIF）；
     3. **RW 内存扫描兜底（`_scanMemoryForAesKey`, `L986-1166`）**：若本地推导未命中，调用 `OpenProcess(0x1f0fff)` + `VirtualQueryEx` 枚举 ≤50MB 的 `MEM_COMMIT` 可写内存页，以 4MB 分块（65B 重叠）扫描 ASCII 32B 与 UTF-16LE 32B 候选密钥并用 AES-128-ECB 验真。
2. **macOS 密钥提取（`src/main/key-service-mac.ts`）**
   - **安全校验顺序（`autoGetDbKey`, `L363-472`）**：严格执行「平台校验 → `getMacArchSnapshot()` 架构检查 → `csrutil status` SIP 检查」，防止 Apple Silicon 用户误跑 x64 Rosetta 构建时被误导关闭 SIP。
   - **双架构分支**：Intel Mac 调用 `macos-key-tool/intel_mac_key_helper`（`status`/`install`/`capture` JSONL 流，面向用户的进度文案将 `"Frida"` 脱敏为 `"连接组件"`，`L371`）；Apple Silicon 根据微信版本是否为 `4.1.13` 分流至 `xkey_helper_4_1_13`（120s，`--profile wechat-4.1.13 --account`）或 `xkey_helper`（30s），通过 `/usr/bin/osascript` 请求管理员授权执行。
   - **图片密钥（`autoGetImageKey`, `L474-521`）**：扫描 macOS 沙箱 `kvcomm` 获取 `code`，按 `xorKey = code & 0xff`、`aesKey = md5("${code}${normalizeAccountId(wxid)}").slice(0,16)`（`L684-692`）匹配 `_t.dat` 模板密文。
3. **图片解密与双层缓存（`src/main/image-decrypt-service.ts`）**
   - **五级定位与清晰度排序（`findImageFile`, `L571-692`）**：内存路径缓存 `imagePathCache` → 气泡缩略图 → 会话定界目录 `msg/attach/{sessionMd5}/{YYYY-MM}/Img` 概率搜索 → `wcdb4Client.resolveImageHardlink` → 全量目录递归；变体按 `_hd`/`_h` > base > `_t`/`_thumb` 排序。
   - **V2 解密与 WXGF 转码（`decryptDatV4` & `unwrapWxgf`, `L272-378, L1334-1631`）**：
     - 直接图片魔数直接透传；加密文件仅支持 WeChat 4.0 V2 头（`07 08 56 32 08 07`），读取 `aesSize`（offset 6..10）与 `xorSize`（offset 10..14），首段按 16B 对齐执行 **AES-128-ECB**（含严格 PKCS#7 去填充），中段原文拼接，尾段逐字节异或 `xorKey`；不支持的旧版 `.dat`（`getDatVersion` 仅识别 V2 头并对其余版本返回 `0`，`L1560-1571`）由 `decryptImage` 写入 `UNSUPPORTED_DAT_VERSION` 诊断状态并返回 `null`（`L1383-1392`）。
     - 解密载荷若为 `wxgf`（`0x77 0x78 0x67 0x66`），先扫前 4KB 是否内嵌 JPG/PNG，否则提取最大 HEVC NAL 分片并调用 `ffmpeg` 转码单帧 PNG。
   - **双层缓存与 Worker 线程隔离**：
     - **内存 LRU**（`L728-747`）：上限 **48 MB**（`MAX_DECODED_IMAGE_CACHE_BYTES`）；
     - **磁盘持久化缓存**（`L749-886`）：落盘 `<userData>/cache/images`，以 `sha256(version=2 + accountDir + key)` 命名 `.json` + 图像载荷，命中时校验源文件 `size` 与 `mtimeMs`，上限 **512 MB / 512 文件**；
     - **异步并发隔离**（`L192-472, L1507-1554`）：通过 `worker_threads.Worker(IMAGE_DECRYPT_WORKER_SOURCE, { eval: true })` 在独立线程解密并自动回退同目录其他清晰度变体（30s 超时强杀）。

### 3.5 `src/main/` 其他服务模块边界路由

| 业务域 | 核心文件（相对仓库根路径） | 职责摘要与归属专题 |
|---|---|---|
| 会话抽象与缓存 | `src/main/wechat-db.ts`、`src/main/message-parser.ts`、`src/main/services/chat-service.ts`、`src/main/services/bootstrap-cache.ts`、`src/main/services/account-discovery.ts`、`src/main/windows-db-root-discovery.ts`、`src/main/services/connection-diagnostics.ts`、`src/main/services/path-access-probe.ts`、`src/main/services/contact-resolution-service.ts`、`src/main/services/messages-around.ts` | 封装 WCDB 查询、20w+ 行消息格式化打点、启动缓存（300ms 防抖 + `flushEpoch`）与 10+ 种微信 XML 消息解析 |
| 多媒体与文件资产 | `src/main/voice-service.ts`、`src/main/sticker-service.ts`、`src/main/video-asset-service.ts`、`src/main/file-asset-service.ts`、`src/main/http-media-service.ts`、`src/main/ffmpeg-path.ts` | SILK→WAV 转换、表情缓存、`wxe-media://` HTTP Range 令牌流、视频/文件定位 |
| Knowledge / OCR / Voice / AI | `src/main/knowledge/` (9)、`src/main/voice-pipeline/` (17)、`src/main/services/system-ocr-service.ts`、`src/main/services/image-text-index-service.ts`、`src/main/db/image-insights-store.ts`、`src/main/services/ai-provider-service.ts`、`src/main/services/query-agent-service.ts`、`src/main/services/ai-search-pipeline-service.ts`、`src/main/services/ask-wechat-service.ts`、`src/main/services/local-query-api-service.ts` | 派生知识库、SenseVoice 语音转写、OCR 索引与双引擎 AI 搜索 — 详见 [03. 知识库、语音与 AI 检索管道](./03-knowledge-and-ai-pipeline.md) |
| 导出、日报、监听与发送 | `src/main/export-service.ts`、`src/main/group-report-service.ts`、`src/main/report-history-service.ts`、`src/main/report-template-service.ts`、`src/main/services/message-listener-service.ts`、`src/main/services/group-exit-monitor-service.ts`、`src/main/services/automation-service.ts`、`src/main/services/automation-rule-store.ts`、`src/main/services/wechat-action-gateway.ts`、`src/main/services/wechat-send-gateway.ts`、`src/main/services/agent-hub-service.ts` | 导出、群日报沙箱、退群监控、4 重防回环自动化与双通道发送 — 详见 [04. 报告导出、自动化与 Agent Hub](./04-reports-automation-hub.md) |
| HTTP API、iLink 与扩展中心 | `src/main/http-server.ts`、`src/main/services/wechat-ilink/` (13)、`src/main/services/local-agent-api-service.ts`、`src/main/services/skill-resource-service.ts`、`src/main/extensions/` (21)、`src/main/wechat-share-card-service.ts` | `127.0.0.1:6131` HTTP API、微信 iLink 长轮询与独立子进程扩展中心 — 详见 [05. Local HTTP API、扩展中心与外围服务](./05-http-api-and-extensions.md) |
| 设置、更新与运维 | `src/main/services/settings-store.ts`、`src/main/services/image-key-config-service.ts`、`src/main/services/cache-service.ts`、`src/main/services/app-update-service.ts`、`src/main/resource-paths.ts`、`src/main/native-runtime-paths.ts`、`src/main/runtime-mode.ts`、`src/main/tray-icon.ts` | 应用设置（含历史 `WeChat Files` → `xwechat_files` 路径纠偏）、缓存清理、自动更新与平台资源定位 |

---

## 4. 关键文件与符号索引

| 路径 | 关键符号 | 核心作用 |
|---|---|---|
| `src/main/index.ts` | `createWindow`, `cleanupLegacyRecallResidueOnStart`, `configureRecallProtection`, `ensureImageDecryptService`, `TRAY_MODE` | 主进程入口、窗口/托盘、服务连线与 203 条核心 IPC 注册 |
| `src/main/app-data-bootstrap.ts` | `LEGACY_MIGRATION_HELPER_ENV`, `isLegacyMigrationHelper`, `isUserDataIsolated`, `selectedUserData` | 首行导入锁定 `app.setName`/`userData`/`logs` |
| `src/main/app-data-paths.ts` | `selectUserDataRoot`, `hasValidUserAssets`, `getUserDataRoots` | 旧版 `WechatExplorer`/`wechatexplorer` 资产识别与冲突仲裁 |
| `src/main/app-data-migration.ts` | `runFirstLaunchMigration`, `assessMigration`, `executeMigration`, `runLegacySecretHelper`, `verifyKnowledgeCopy` | 无覆盖 staging 迁移、SQLite 完整性校验与断点状态管理 |
| `src/main/legacy-safe-storage-helper.ts` | `runLegacySafeStorageHelper`, `decryptLegacySecrets`, `writeLegacySecretHelperResult` | 子进程旧身份 `safeStorage` 解密并通过 `stdio[3]` 回传 |
| `src/main/database-key-store.ts`、`src/main/image-key-store.ts`、`src/main/ai-provider-key-store.ts`、`src/main/api-token-store.ts` | `DatabaseKeyStore`, `ImageKeyStore`, `AIProviderKeyStore`, `ApiTokenStore.setAutomaticGenerationBlocked` | 4 类 `safeStorage` 加密存储与防覆盖保护 |
| `src/main/wcdb4-client.ts` | `bootstrapWcdbNativeAsync`, `Wcdb4Client`, `resolveWindowsNativeAccountRoot`, `parseMonitorEvent`, `describeDbOpenFailure`, `scanLegacyRecallResidue` | Koffi FFI 单例引导、Junction 桥、v1/v2 管道监听、消息查询与残留扫描 |
| `src/main/services/msg-insert-switch-service.ts` & `src/main/services/external-component-locator.ts` | `resolveHelperPath`, `runHelper`, `resolveExternalComponent` | 派生 `tm-wcdb-config-helper` 进程外写库与外部组件 SHA-256 校验 |
| `src/main/key-service-win.ts` | `KeyService.autoGetDbKey`, `autoGetImageKeyByMemoryScan`, `_deriveImageKeyByLocalMetadata`, `_scanMemoryForAesKey` | Windows DLL Hook 取库密钥 + 本地推导/RW 内存扫描取图片密钥 |
| `src/main/key-service-mac.ts` | `KeyServiceMac.autoGetDbKey`, `autoGetImageKey`, `buildAppleSiliconXkeyInvocation`, `mapXkeyHelperFailure` | macOS 架构优先校验、Intel JSONL / ARM64 `osascript` 取密钥 |
| `src/main/image-decrypt-service.ts` | `ImageDecryptService.findImageFile`, `decryptImage`, `decryptDatV4`, `unwrapWxgf`, `decryptImageToBase64WithFallbackAsync`, `IMAGE_DECRYPT_WORKER_SOURCE` | 5 级图片定位、V2 AES+XOR 解密、WXGF 转码、48MB/512MB 双层缓存与多线程隔离 |

---

## 5. 后续维护与开发指南

1. **排障优先查看的运行时日志与状态文件**
   - 主日志：`<logs>/tracememo.log`（及轮转文件 `tracememo.log.1`），重点关注 `app-data-migration`、`component-locate`（`src/main/services/external-component-locator.ts` 校验结果）、`wcdb-bootstrap`、`recall-residue`、`capability-gate` 等 scope。
   - 迁移状态：`<userData>/tracememo-migration-v1.json`；若遇旧 API Token 迁移失败，勿手动删旧目录或强行清状态文件，应引导用户在 API 页面主动 `rotateToken` 或保留旧目录重启完成续迁。
   - WCDB 详细调试可通过 `src/main/wcdb-debug.ts`（`isWcdbDebugEnabled()`）与 `WECHATEXPLORER_DEBUG_IMAGE` 开启，但日志写入前必须经过脱敏函数，禁止输出明文 Key、Token 或具体会话路径/联系人信息。
2. **修改 `Wcdb4Client` 与微信库写入逻辑的约束**
   - 严禁在主进程直接对微信消息分片执行任何 DDL/DML 写操作，所有写库需求必须通过 `tm-wcdb-config-helper` 以 `stdin` JSON 传密钥完成，并由主进程侧只读复核最终状态。
   - 新增 Koffi 原生函数绑定时，必须通过 `nativeCallsInFlight` 追踪在途异步调用，确保 `closeAsync()` 退出排空阶段不会发生悬空回调崩溃；非必需导出符号需像 `wcdbGetEmoticonCdnUrl` 一样包 `try/catch` 降级为 `null`。
3. **修改图片解密、缓存与设置配置的注意事项**
   - `src/main/services/image-key-config-service.ts:61-63` 规定仅 `import.meta.env.DEV` 才允许读取 `.env` 中的 `VITE_IMAGE_AES_KEY` 作为调试兜底，严禁放开到生产构建。
   - 代码清理提醒：`src/main/index.ts:560-640` 目前在 `cleanupLegacyRecallResidueOnStart` 函数之后穿插了部分 `import` 语句，后续维护新增顶层 `import` 时应放在文件头部（`./app-data-bootstrap` 与 `./preload-env` 之后），避免破坏模块初始化顺序语义。
