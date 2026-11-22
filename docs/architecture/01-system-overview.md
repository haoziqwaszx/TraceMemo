# 01. 系统架构总览

> **源码基线**：`8f47dca`（`package.json` 版本 `2.7.0`）｜**适用范围**：仓库全景、技术栈、多进程/线程拓扑、构建入口澄清与全局设计原则

---

## 1. 架构总览

TraceMemo（迹忆，原名 `WechatExplorer`）是一款**本地优先、可追溯的 AI 微信知识与分析桌面工作台**，围绕 WeChat 4.0（`xwechat_files`）本地加密数据构建归档浏览、全文与语义检索、群聊日报、退群监控、防回环自动化、个人微信/iLink 双通道发送、受鉴权本地 HTTP API 以及沙箱扩展生态。

从运行时进程模型看，系统以 **Electron 43 主进程** 为调度与安全边界核心，向上通过 **Preload (`contextBridge`)** 向 **React 19 渲染进程** 暴露统一能力接口，向下通过 **Koffi FFI + 原生 Helper 进程 + Node `fork` Worker + `worker_threads`** 隔离所有高风险、CPU 密集或阻塞型操作：

```text
+-------------------------------------------------------------------------+
|                       Renderer Process (React 19)                       |
|  src/renderer/src/main.tsx -> App.tsx (10 大工作区，零直接 fetch())     |
|  扩展页面运行于无 Preload 的 <iframe sandbox="allow-scripts"> +          |
|  tm-extension:// 特权协议 + postMessage 白名单桥接                      |
+------------------------------------+------------------------------------+
                                     | window.api (240 invoke + 17 push)
                                     v
+-------------------------------------------------------------------------+
|                   Preload Bridge (src/preload/index.ts)                 |
|       contextIsolation: true / sandbox: false -> window.api & electron  |
+------------------------------------+------------------------------------+
                                     | Electron IPC (241 运行期注册入口)
                                     v
+-------------------------------------------------------------------------+
|                    Main Process (src/main/index.ts)                     |
|  - 生命周期、窗口/托盘、safeStorage 与 WechatExplorer -> TraceMemo 迁移  |
|  - Wcdb4Client (Koffi FFI 只读访问微信分片 + 管道监听)                   |
|  - 密钥提取 (Win wx_key.dll / Mac xkey_helper & intel_mac_key_helper)   |
|  - QueryAgent / AI Search / GroupReport / Automation / SendGateway      |
|  - Local HTTP API (127.0.0.1:6131) & WechatConnectorService (iLink)     |
+---+--------------------+--------------------+-------------------+-------+
    | Node fork          | worker_threads     | spawn (短命/守护) | 外部服务
    | (ELECTRON_RUN_     | (eval: true)       |                   |
    |  AS_NODE=1)        |                    |                   |
    v                    v                    v                   v
+-------------------+ +-----------------+ +-------------------+ +-------------------+
| knowledgeWorker   | | 图片解密线程     | | tm-wcdb-config-   | | Cloudflare Worker |
| (node:sqlite FTS5)| | (AES-128-ECB +  | | helper (stdin JSON| | services/share-   |
+-------------------+ |  XOR + FFmpeg   | | 传密钥写库防-3004)| | card-worker/      |
| voiceRecognition- | |  WXGF 转 PNG)   | +-------------------+ +-------------------+
| Worker (ONNX)     | +-----------------+ | tm-wechat-host    |
+-------------------+                     | (macOS 127.0.0.1: |
| extensionHost     |                     |  4290-4293 HTTP)  |
| (每扩展独立子进程) |                     +-------------------+
+-------------------+                     | 迁移解密 Helper / |
                                          | SQLite 校验子进程 |
                                          +-------------------+
```

### 技术栈选型（已核实 `package.json`）

| 层级 | 核心技术与关键依赖 | 源码依据 |
|---|---|---|
| 应用外壳与构建 | `electron` (`^43.0.0`)、`electron-vite` (`^5.0.0`)、`vite` (`^7.2.6`)、`electron-builder` (`^26.0.12`)、`electron-updater` (`^6.6.2`) | `package.json:108,145-147` |
| 语言与包管理 | `typescript` (`^5.9.3`)、`pnpm` (`pnpm@7.33.7`)、`eslint` (`^9.39.1`)、`prettier` (`^3.7.4`) | `package.json:4,148,154,160` |
| 渲染层 UI 与状态 | `react` / `react-dom` (`^19.2.1`)、14 个 `@radix-ui/react-*` 原语包、`@tanstack/react-virtual` (`^3.14.6`)、`tailwindcss` (`3.4.17`)、`sass` (`^1.102.0`)、`class-variance-authority` | `package.json:88-105,155-158` |
| 本地数据库与 FFI | `koffi` (`^3.1.0`) + `@koromix/koffi-{darwin,win32}-x64`；Node 内置 `node:sqlite` (`DatabaseSync`) 驱动 FTS5 派生库与语音缓存 | `package.json:83-84,113`、`src/main/knowledge/knowledge-store.ts` |
| 多媒体与 AI 能力 | `@napi-rs/system-ocr` (`1.2.0`)、`sherpa-onnx-node` (`1.13.3`)、`silk-wasm` (`^3.7.1`)、`ffmpeg-static` (`5.3.0`)、`fzstd` (`^0.1.1`)、`openai` (`^6.10.0`)、`jsonrepair` (`^3.15.0`) | `package.json:85-87,109-121` |
| 测试与质量门禁 | `vitest` (`^4.1.10`)、`@playwright/test` (`^1.62.1`)、`@testing-library/react` (`^16.3.2`)、`jsdom` (`^30.0.1`) | `package.json:133-135,152,162` |
| 外部云端分享组件 | Cloudflare Worker (`wrangler` `^4.28.1`) + R2 桶 `wechatexplorer-share-reports` | `package.json:163`、`services/share-card-worker/wrangler.jsonc:12-16` |

---

## 2. 模块职责与边界

### 2.1 Electron 主进程、Preload、Renderer 与 Shared 四层边界

1. **Main Process（`src/main/`，共 174 个文件）**
   - 负责应用生命周期、窗口与托盘、`safeStorage` 凭据加解密与旧版本数据迁移、WCDB4 只读访问与实时管道监听、跨平台密钥提取、图片解密与双层缓存、FTS5 知识库/SenseVoice 语音/OCR 派生管道、AI 检索与 `QueryAgentService`、群日报、防回环自动化、个人微信/iLink 发送网关、本地 HTTP API（`127.0.0.1:6131`）及扩展宿主管理。
   - 运行期主进程共注册 **241 条 `ipcMain` 入口**（`src/main/index.ts` 注册 202 条 `ipcMain.handle` + 1 条 `ipcMain.on('ping')`、`src/main/extensions/extension-ipc.ts` 注册 32 条、`src/main/report-template-ipc.ts` 注册 6 条），并通过 **13 个 `webContents.send` 广播通道**与 **4 个 `event.sender.send` 定向通道**主动推送状态（详见[主进程与数据访问底座](./02-main-process-and-data.md)）。
2. **Preload（`src/preload/`，共 2 个文件：`index.ts`、`index.d.ts`）**
   - 主窗口创建配置为 `sandbox: false` 且默认启用 `contextIsolation: true`（`src/main/index.ts:1008-1009`）。
   - `src/preload/index.ts` 通过 `contextBridge.exposeInMainWorld` 暴露 `window.electron` 与 `window.api`（共 **257 个方法** = 240 个 `ipcRenderer.invoke` + 17 个 `ipcRenderer.on` 订阅），作为渲染层与主进程之间的唯一受控通道（详见[渲染进程、共享契约与 IPC 通道](./06-renderer-and-ipc.md)）。
3. **Renderer（`src/renderer/`，共 272 个文件）**
   - 以 `src/renderer/src/main.tsx` 和 `src/renderer/src/App.tsx` 为根状态机，采用基于 React State（`AppPage`）的切换机制托管 **10 大一级工作区**（`archive`、`search`、`report`、`exit-monitor`、`automation`、`extensions`、`agent-hub`、`export`、`api`、`settings`）。
   - 严格遵守**零直接 `fetch()` 约束**（包括 `api` 工作区的接口调试也经 `window.api.testLocalApiRequest` 由主进程代发）；样式采用 Tailwind `--tm-*` HSL Token 与 SCSS `--wxex-*` 映射双轨并行。
4. **Shared（`src/shared/`，共 75 个文件）**
   - 存放主进程、Preload 与渲染进程共享的纯类型契约、校验函数与协议常量，覆盖核心消息/联系人、群日报与模板、AI 检索/Query Agent/Knowledge、图片解密/OCR、语音与 TTS、自动化与退群监控、个人发送/Action Gateway/Agent Hub、扩展中心协议（`src/shared/extensions/`）、本地 HTTP API 与系统平台诊断 9 大主题域（详见[渲染进程、共享契约与 IPC 通道](./06-renderer-and-ipc.md)）。

### 2.2 构建与多进程/子进程 Worker 拓扑

`electron.vite.config.ts:12-20` 在 `main.build.rollupOptions.input` 中定义了 **6 个主进程侧编译入口**（均由 `external: ['koffi', 'sherpa-onnx-node', '@napi-rs/system-ocr']` 排除原生模块打包），并与独立子进程/线程/外部 Helper 共同组成运行时进程矩阵：

| 类别 | 组件 / 入口名称 | 源码入口 / 宿主文件 | 启动与隔离机制 | 职责边界与核心约束 |
|---|---|---|---|---|
| 构建主入口 | `index` | `src/main/index.ts` | Electron 主进程 | 唯一窗口宿主、IPC 注册中心、服务协调器 |
| 构建 Worker | `knowledgeWorker` | 入口：`src/main/knowledge/knowledge-worker.ts`<br>宿主：`src/main/knowledge/knowledge-worker-host.ts:143` | `child_process.fork` + `ELECTRON_RUN_AS_NODE=1`（Node IPC `serialization: 'advanced'`） | 托管 `node:sqlite` FTS5 同步读写，避免阻塞主进程事件循环；支持 `activeIndexRequestId` 精准取消索引而不中断并发搜索 |
| 构建 Worker | `voiceRecognitionWorker` | 入口：`src/main/voice-pipeline/voice-recognition-worker.ts`<br>宿主：`src/main/voice-pipeline/recognition-host.ts:86` | `child_process.fork` + `ELECTRON_RUN_AS_NODE=1`（Node IPC `serialization: 'advanced'`） | 加载 `sherpa-onnx-node` 运行 `SenseVoiceRecognizer`；默认单次识别超时 **120s**，空闲 **60s** 自动退出释放模型内存 |
| 构建 Worker | `extensionHost` | 入口：`src/main/extensions/host-runtime.ts`<br>宿主：`src/main/extensions/extension-host.ts:957` | 每扩展独立 `child_process.fork` + `ELECTRON_RUN_AS_NODE=1`（POSIX `detached: true` 进程组，Windows `taskkill /T`） | 主进程永不 `require` 扩展代码；向扩展注入受限 `tm` 全局对象，经白名单 RPC + 权限检验 + 令牌桶限流（100 容量 / 60/s）+ stderr 凭据脱敏与主进程交互 |
| 构建独立入口 | `reportTemplateTest` | `src/main/report-template-test-entry.ts` | 独立 Electron 测试入口（需 `TRACEMEMO_TEMPLATE_TEST_USER_DATA`） | 仅用于日报模板开发/测试，注册 6 条 `report:*` 句柄及模板 IPC，不随主应用启动 |
| 构建独立入口 | `queryAgentPoc` | `src/main/query-agent-poc-entry.ts` | Electron CLI 适配器（`pnpm poc:query-agent`） | 复用生产 `QueryAgentService`，通过本地 HTTP API（`127.0.0.1:6131/api/v1`）执行只读查询诊断，stdout 输出纯 JSON |
| 内联工作线程 | 图片解密 Worker | `IMAGE_DECRYPT_WORKER_SOURCE` 内联于 `src/main/image-decrypt-service.ts:192,1515` | `node:worker_threads`（`eval: true`） | 后台执行 V2 `.dat` 的 AES-128-ECB + XOR 解密与 `ffmpeg` WXGF/HEVC 转 PNG，30s 超时强制终止 |
| 一次性辅助进程 | 迁移安全解密 Helper | 入口：`src/main/legacy-safe-storage-helper.ts:120`<br>宿主：`src/main/app-data-migration.ts:391` | `spawn(process.execPath)` + `TRACEMEMO_LEGACY_MIGRATION_HELPER=1` | 以旧 `WechatExplorer` 应用身份启动并读取旧 `safeStorage` 密文，通过 `stdio[3]` 匿名管道传回明文（上限 5MB，超时 30s） |
| 一次性辅助进程 | 迁移 SQLite 校验 | `src/main/app-data-migration.ts:218-246` | `spawn(process.execPath, ['-e', ...])` + `ELECTRON_RUN_AS_NODE=1` | 使用 `DatabaseSync(..., { readOnly: true })` 对迁移后的 `knowledge.sqlite` 执行 `PRAGMA integrity_check` |
| 外部原生 Helper | `tm-wcdb-config-helper` | 宿主：`src/main/services/msg-insert-switch-service.ts`、`src/main/services/wechat-local-exit-notice-service.ts` | `child_process.spawn` 短生命周期进程（Windows 优先经 `src/main/services/external-component-locator.ts` 校验 SHA-256 定位） | 专责对微信数据库执行写操作（规则开关 `_tm_config` / `_tm_msg_insert_capture_*` 与退群提示插入），避免主进程只读池报 `-3004`；密钥仅走 stdin JSON |
| 外部守护进程 | `tm-wechat-host`（macOS） | 宿主：`src/main/services/mac-wechat-runtime-manager.ts:521` | `spawn` 独立守护进程（承载 `libtmwechat.dylib`），`127.0.0.1:4290`（备用 4291–4293）HTTP | Electron 主进程永不 `dlopen` 该 dylib；`before-quit` **刻意不停止**它以保留已绑定的 Frida 会话 |
| 外部进程注入端 | Windows 个人微信 Hook | 宿主：`src/main/services/personal-wechat-send-service.ts:63` | 运行于 `Weixin.exe` / `WeChat.exe` 内的外部组件 | 通过 `127.0.0.1:<windowsWechatPort>` HTTP 提供个人微信消息发送能力 |
| 密钥提取原生工具 | `wx_key.dll` / `xkey_helper*` / `intel_mac_key_helper` | `src/main/key-service-win.ts`、`src/main/key-service-mac.ts` | Win：Koffi 加载 DLL；Mac ARM64：`osascript` 管理员授权；Intel：`spawn` JSONL | 仅在用户主动触发获取密钥时运行，不常驻主进程 |

### 2.3 外围子包、独立服务与仓库目录全景

1. **核心代码与子包目录**
   - `src/`：应用主体源码，含 `src/main/`（174 文件）、`src/preload/`（2 文件）、`src/renderer/`（272 文件）、`src/shared/`（75 文件）及 `src/env.d.ts`。
   - `packages/extension-sdk/`（3 文件：`package.json`、`index.d.ts`、`README.md`）：私有包 `@tracememo/extension-sdk`（v1.0.0），仅提供 TypeScript 类型定义（`TraceMemoApi`、`TraceMemoActivate` 等，已同步包含 `secrets` 权限、`tm.secrets` 与 `tm.page.onRequest`）；运行期由 `src/main/extensions/host-runtime.ts` 向子进程注入全局 `tm` 对象，扩展无需打包该 SDK（运行期行为与 `registerAction` 等细节差异详见 [05. Local HTTP API、扩展中心与外围服务](./05-http-api-and-extensions.md)）。
   - `services/share-card-worker/`（6 文件）：独立的 Cloudflare Worker 服务（`wechatexplorer-share-card`），使用 R2 桶 `wechatexplorer-share-reports` 托管实验性群日报分享卡片、过期清理 Cron（`17 3 * * *`）及 JS-SDK 签名，与主 Electron 进程仅通过客户端配置与 HTTP 发布协议交互（详见 `src/main/wechat-share-card-service.ts`）。
2. **工程、测试与文档生态**
   - `scripts/`：构建、环境准备、原生依赖、双版 macOS 打包（`public`/`native`）、扩展模板打包与质量校验脚本（详见[构建脚本与打包分发](./07-build-scripts-and-packaging.md)）。
   - `tests/`：涵盖 `unit`、`component`、`integration`、`e2e`、`benchmark`、`smoke` 的 6 层测试体系与 TS 棘轮基线（详见[测试体系与质量门禁](./08-testing-and-quality-gates.md)）。
   - `examples/`：扩展示例（`keyword-bot`、`group-chat-bot`、`douyin-sender`）与最小群日报模板示例（`report-template-basic`），用于模板打包与开发参考。
   - `resources/` 与 `build/`：原生动态库/Helper（`wx_key.dll`、`WCDB.dll`、`libWCDB.dylib`、`xkey_helper*`、`intel_mac_key_helper`、`resources/runtime/win32/` VC++ 运行库）、日报 HTML 模板资源、扩展模板 zip 产物与打包签名配置。
   - `docs/`：面向用户、Agent、扩展开发者与架构维护者的全套文档；其中 `docs/skill/tracememo-reader/SKILL.md` 受版本防漂移检查保护。

---

## 3. 核心数据流与设计思路

### 3.1 构建入口与运行产物映射（含根目录遗留文件澄清）

初次接触本仓库的开发者或 AI 常会注意到仓库根目录存在 `index.js` 和 `index.html`，**必须明确澄清它们是历史快照遗留文件，不参与任何当前构建与运行**：

| 文件路径 | 真实角色 | 核实依据 |
|---|---|---|
| `package.json:26` | 运行入口指向编译产物 `./out/main/index.js` | `"main": "./out/main/index.js"` |
| `electron.vite.config.ts:12-37` | **唯一真实构建配置**：主进程入口为 `src/main/index.ts`（及 5 个子入口），Preload 为 `src/preload/index.ts`，Renderer 入口位于 `src/renderer/`（`src/renderer/index.html` → `src/renderer/src/main.tsx`）；支持 `TRACEMEMO_EDITION_OUT_DIR` 覆盖输出目录 | `electron.vite.config.ts:5,10,12-37` |
| `src/renderer/index.html` | **真实渲染进程 HTML 宿主**：配置严格 CSP（允许 `wxe-media:` 媒体与 `tm-extension:` `frame-src`）并加载 `/src/main.tsx` | `src/renderer/index.html:1-18` |
| 根目录 `index.js`（遗留） | 历史旧版 CommonJS `preload` 编译快照，未被 `electron.vite.config.ts` 或 `electron-builder*.yml` 引用 | `index.js:1-140` |
| 根目录 `index.html`（遗留） | 历史旧版 Vite 打包生成的带 hash 资源引用静态页（引用不存在的 `./assets/index-CRoZdOvo.js`），不参与当前编译 | `index.html:1-19` |

### 3.2 四大核心设计原则

1. **本地优先与只读隔离（不破坏微信原库）**：
   - 主进程中 `Wcdb4Client` 对微信原库（`db_storage/session/session.db`、`message_*.db` 等）严格保持只读消费心智。所有派生索引（FTS5 `knowledge.sqlite`、OCR `image-text-index`、语音转写 `voice-transcripts.sqlite`、解密图片磁盘缓存）全部落在 TraceMemo 自身的 `userData` 目录内。
   - 少数确需向微信分片写入配置/提示的场景（如防撤回规则开关、退群本地提示），由于 WCDB `CommonCore` 按路径池化底层对象且只读标记不可逆（同进程写入会触发 `-3004`），系统强制派生短命的 `tm-wcdb-config-helper` 子进程完成写入并立即销毁连接池，且密钥仅经 `stdin` 传递。
2. **高风险原生逻辑与不可信扩展的进程/线程隔离**：
   - macOS 发送能力核心 `libtmwechat.dylib` 隔离在独立进程 `tm-wechat-host` 中，通过 `127.0.0.1` HTTP 通信；
   - 第三方扩展的后台逻辑隔离在每扩展一个的 Node 子进程 `extensionHost` 中，扩展 UI 运行于无 Preload、禁用 `connect-src` 的 `iframe` 中，仅允许 `postMessage` 白名单请求；
   - 同步型 `node:sqlite` FTS5 索引与 ONNX 语音模型推理下沉到 `knowledgeWorker` 与 `voiceRecognitionWorker`，AES+XOR+FFmpeg 解密下沉到 `worker_threads`。
3. **跨身份平滑升级与安全降级（Fail-Closed）**：
   - 从旧版 `WechatExplorer` 更名升级为 `TraceMemo` 时，由于 Electron `safeStorage` 在操作系统层绑定应用身份，主进程不能在自身进程内切换身份，而是保持 `TraceMemo` 身份不变，在 `app.whenReady()` 早期派生 `TRACEMEMO_LEGACY_MIGRATION_HELPER=1` 子进程以 `WechatExplorer` 身份读取旧加密资产并经匿名管道回传重加密。
   - 若旧版 `local-api-token.bin` 迁移未完成，`ApiTokenStore.setAutomaticGenerationBlocked` 会主动阻止静默生成新 Token，宁可安全停用本地 API 也不覆盖用户既有凭据。
4. **向后兼容的历史品牌标识（`wxe` / `WXE_` / `WechatExplorer`）**：
   - 源码中有意保留了少量 `WechatExplorer` 时期的前缀以保证升级平滑与已有测试/工具兼容（非 bug），维护时不可随意重命名：
     - 特权媒体协议：`wxe-media://`（`src/main/index.ts:827,1376`、`src/renderer/index.html:10`）；
     - 环境变量：`WXE_USER_DATA`（`src/main/app-data-bootstrap.ts:20`）、`WXE_TRAY`（`src/main/index.ts:840`）、`WXE_VOICE_RECOGNITION_FAKE_TEXT`（`src/main/voice-pipeline/voice-recognition-worker.ts:25`）、`WECHATEXPLORER_RESOURCES_PATH`（`src/main/resource-paths.ts:20`）、`WECHATEXPLORER_DEBUG_IMAGE`（`src/main/image-decrypt-service.ts:16`）；
     - 数据库/临时文件前缀：`_wxe_capture_*` / `_wxe_recall_journal_*`（`src/main/wcdb4-client.ts:550` 附近）、`wxe-wxgf-`（`src/main/image-decrypt-service.ts:348`）。

---

## 4. 关键文件与符号索引

| 路径 | 关键符号 / 配置项 | 作用说明 |
|---|---|---|
| `package.json` | `version: "2.7.0"`, `main: "./out/main/index.js"`, `scripts` | 项目元信息、运行入口及构建/测试/检查全量脚本 |
| `electron.vite.config.ts` | `main.build.rollupOptions.input` (6 入口), `external`, `TRACEMEMO_EDITION_OUT_DIR` | 定义 Main/Preload/Renderer 真实编译入口与 `@renderer` 别名 |
| `tsconfig.json` / `tsconfig.node.json` / `tsconfig.web.json` / `tsconfig.test.json` | `references`, `include`, `paths` | TypeScript Solution 工程划分（Node 侧、Web 侧、测试侧） |
| `src/main/index.ts` | `createWindow`, `app.whenReady`, `before-quit`, `BUILD_MARK`, `TRAY_MODE` | 主进程总调度入口、服务实例化与 203 条核心 IPC 注册 |
| `src/main/app-data-bootstrap.ts` | `isLegacyMigrationHelper`, `isUserDataIsolated`, `selectedUserData` | 首行导入引导，锁定 `app.setName`、`userData` 与 `logs` 路径 |
| `src/main/preload-env.ts` | `prependPath`, `WCDB_RESOURCES_PATH`, `TRACEMEMO_PROJECT_NAME` | Windows 预置本地 `wcdb`/`key`/`runtime` DLL 搜索路径 |
| `src/preload/index.ts` & `src/preload/index.d.ts` | `api` (257 方法), `contextBridge.exposeInMainWorld` | 渲染层唯一受控 API 桥接与类型声明 |
| `src/renderer/index.html` & `src/renderer/src/main.tsx` | `#root`, `Content-Security-Policy` | 渲染层真实 HTML 宿主与 React 19 启动入口 |
| `packages/extension-sdk/index.d.ts` | `TraceMemoApi`, `TraceMemoActivate`, `TraceMemoMessageEvent` | 扩展开发纯类型契约 |
| `services/share-card-worker/wrangler.jsonc` & `services/share-card-worker/src/index.js` | `wechatexplorer-share-card`, `REPORTS` R2 桶 | Cloudflare Worker 分享卡片独立服务 |

### 专题知识库导航

- 主进程启动、迁移、WCDB4、密钥与图片解密：[02. 主进程生命周期与核心数据访问](./02-main-process-and-data.md)
- Knowledge FTS5、OCR、Voice Pipeline 与 AI Search / Query Agent：[03. 知识库、语音与 AI 检索管道](./03-knowledge-and-ai-pipeline.md)
- 导出、群日报、退群监控、自动化防回环、发送网关与 Agent Hub：[04. 报告导出、自动化与 Agent Hub](./04-reports-automation-hub.md)
- Local HTTP API、扩展中心、`extension-sdk` 与分享卡片服务：[05. Local HTTP API、扩展中心与外围服务](./05-http-api-and-extensions.md)
- 渲染层 10 大工作区、双轨样式、`src/shared/` 9 域与 257 条 IPC 全表：[06. 渲染层、共享契约与 IPC 通道](./06-renderer-and-ipc.md)
- 构建脚本、原生运行时与双版签名打包：[07. 构建脚本与打包分发](./07-build-scripts-and-packaging.md)
- 6 层测试体系、E2E 替身与质量门禁：[08. 测试体系与质量门禁](./08-testing-and-quality-gates.md)
- 全仓符号、文件、IPC 与环境变量总索引：[09. 全仓文件、符号、通道与配置总索引](./09-symbol-and-file-index.md)

---

## 5. 后续维护与开发指南

1. **新增 IPC 通道或修改跨层数据类型时的三端联动**
   - 任何新增或变更的跨进程契约优先定义在 `src/shared/`，随后同步更新 `src/main/` 注册端、`src/preload/index.ts` 与 `src/preload/index.d.ts`（注意：目前 `src/preload/index.d.ts` 中 `AppSettings` 与 `ParsedContent` 存在手写重复定义，修改相关字段时需特别核查，详情见[06. 渲染层、共享契约与 IPC 通道](./06-renderer-and-ipc.md)）。
   - 渲染层严禁直接调用 `fetch()` 访问本地或外部 HTTP 接口，必须经 IPC 由主进程代为转发或调度。
2. **新增主进程独立 Worker 或构建入口**
   - 若需新增脱离主事件循环的 Node 子进程入口，必须在 `electron.vite.config.ts` 的 `main.build.rollupOptions.input` 中登记新入口，使开发态与打包态均能产出独立的 `<entry>.js`；若用到原生 `.node` 模块，需同步检查 `external` 列表与 `scripts/after-pack.cjs` 打包校验规则。
3. **绝对不可破坏的工程红线**
   - **禁止**在 `src/main/index.ts` 中将任意带路径副作用的模块静态 `import` 放到 `./app-data-bootstrap` 之前（`app-data-bootstrap.ts:10-13`）。
   - **禁止**把 `node:sqlite` 等同步长耗时操作或不可信第三方扩展代码放到主进程主线程中执行。
   - **禁止**在未经版本检查与独立核验的情况下修改 `docs/skill/tracememo-reader/SKILL.md`（受 `pnpm check:skill-version` / `pnpm test:skill-install` 门禁保护）。
   - **禁止**将根目录遗留的 `index.js` 或 `index.html` 当作真实入口进行修改；改动前端或 Preload 请始终编辑 `src/renderer/` 与 `src/preload/`。
4. **日常本地开发与检查命令**
   - 本地开发启动：`pnpm dev`（先自动执行 `ensure-electron-binary.cjs` 与 `ensure-env.cjs`）。
   - 全量类型检查：`pnpm typecheck`（串行执行 `typecheck:node`、`typecheck:web`、`typecheck:test`）。
   - 代码格式化与 Lint：`pnpm format`、`pnpm lint`。
