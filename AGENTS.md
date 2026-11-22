# AGENTS.md — TraceMemo 开发者与 AI 总览入口

> **源码基线**：Git commit `8f47dca`（`package.json` 版本 `2.7.0`，包管理器 `pnpm@7.33.7`，Node `22`）
> **延伸导航**：[架构知识库总览](./docs/architecture/README.md) · [文档首页](./docs/README.md) · [贡献指南](./CONTRIBUTING.md)

本文件面向后续维护者与 AI 编程代理，提供 TraceMemo 全仓的架构定位、技术栈、核心目录地图、知识库专题路由、高频命令、常用环境变量及关键工程红线。

---

## 1. 项目定位

**TraceMemo（迹忆，原名 `WechatExplorer`）** 是一款**本地优先、可追溯的 AI 微信知识与分析桌面工作台**，面向微信 4.x（`xwechat_files`）构建：

- 本地数据归档、联系人/群聊检索与消息上下文追溯；
- 派生知识库（SQLite FTS5）、图片文字索引（系统 OCR）、本地语音转写（SenseVoice）与双引擎 AI 检索（`QueryAgentService` / `AiSearchPipelineService`）；
- 群聊日报与社区模板市场、群发言统计、退群监控与 4 重防回环自动化引擎；
- 个人微信与微信 iLink 双通道发送网关、Agent Hub、受鉴权 Local HTTP API（`127.0.0.1:6131`）以及独立子进程扩展中心。

系统以 **Electron 43 主进程**为唯一控制面与安全边界：所有微信原库消费默认只读，派生索引与缓存均落在 TraceMemo 自有 `userData` 目录内。

---

## 2. 技术栈与多进程拓扑

### 2.1 核心技术选型（已核实 `package.json`）

- **应用外壳与构建**：`electron` (`^43.0.0`)、`electron-vite` (`^5.0.0`)、`vite` (`^7.2.6`)、`electron-builder` (`^26.0.12`)、`electron-updater` (`^6.6.2`)。
- **语言与包管理**：`typescript` (`^5.9.3`)、`eslint` (`^9.39.1`)、`prettier` (`^3.7.4`)、锁定 `pnpm@7.33.7`（`.npmrc` 启用 `shamefully-hoist=true` 与跨平台可选依赖保留）。
- **渲染层 UI 与样式**：`react` / `react-dom` (`^19.2.1`)、14 个 `@radix-ui/react-*` 原语包、`@tanstack/react-virtual` (`^3.14.6`)、`tailwindcss` (`3.4.17`，关闭 `preflight`) 与 `sass` (`^1.102.0`) 双轨样式体系。
- **数据与 FFI**：`koffi` (`^3.1.0`) 对接原生 `WCDB.dll` / `libWCDB.dylib`；Node 内置 `node:sqlite` (`DatabaseSync`) 驱动 FTS5 与语音转写库。
- **多媒体与 AI**：`@napi-rs/system-ocr`（系统 OCR）、`sherpa-onnx-node`（SenseVoice 语音识别）、`silk-wasm`、`ffmpeg-static`、`fzstd`、`openai`、`jsonrepair`。
- **测试与验证**：`vitest` (`^4.1.10`)、`@playwright/test` (`^1.62.1`)、`@testing-library/react`、`jsdom`。

### 2.2 进程与线程隔离矩阵

1. **Main Process（`src/main/index.ts`）**：统筹生命周期、窗口/托盘、`safeStorage` 与跨身份迁移、`Wcdb4Client`、密钥提取、Local HTTP API（`127.0.0.1:6131`）、自动化与发送网关；运行期注册 **241 条 `ipcMain`**（240 `handle` + 1 `on('ping')`）与 **17 条主动推送**（13 广播 + 4 定向）。
2. **Preload Bridge（`src/preload/index.ts`）**：在 `contextIsolation: true`、`sandbox: false` 下暴露 `window.api`（240 `invoke` + 17 `on`）与 `window.electron`。
3. **Renderer SPA（`src/renderer/src/App.tsx`）**：React 19 根状态机，托管 10 大一级工作区，严格禁止直接 `fetch()`；扩展页面运行在 `<iframe sandbox="allow-scripts">` 与 `tm-extension://` 协议中。
4. **独立 Node `fork` Worker（`ELECTRON_RUN_AS_NODE=1`）**：
   - `knowledgeWorker`（`src/main/knowledge/knowledge-worker.ts`）：托管 `node:sqlite` FTS5 同步读写，支持精准取消索引；
   - `voiceRecognitionWorker`（`src/main/voice-pipeline/voice-recognition-worker.ts`）：运行 SenseVoice ONNX 识别，空闲 60s 自动退出；
   - `extensionHost`（`src/main/extensions/host-runtime.ts`）：每扩展独立子进程，主进程永不 `require` 扩展代码，注入受限 `tm` 全局 API。
5. **工作线程与外部原生 Helper**：
   - 图片解密线程（内联于 `src/main/image-decrypt-service.ts`）：基于 `node:worker_threads` 执行 AES-128-ECB + XOR 解密与 FFmpeg WXGF 转码；
   - `tm-wcdb-config-helper`：短命独立进程，隔离 WCDB 写入操作防 `-3004`，密钥仅经 `stdin` JSON 传入；
   - `tm-wechat-host`（macOS `127.0.0.1:4290-4293` HTTP 守护进程）与迁移解密 Helper（`TRACEMEMO_LEGACY_MIGRATION_HELPER=1`）。

---

## 3. 核心目录地图与运行时资产

> **构建入口澄清**：根目录遗留的 `index.js`（旧 CommonJS preload 快照）与 `index.html`（旧 Vite 静态页）**不参与当前任何构建与运行**；真实入口由 `package.json`（`"main": "./out/main/index.js"`）与 `electron.vite.config.ts`（6 个主进程 Rollup 入口）定义。

### 3.1 主体源码目录（`src/`）

- `src/main/`（**174 文件**）：
  - 根级模块（45 文件）：入口 `src/main/index.ts`、路径引导与迁移、`safeStorage` 密钥存储、`Wcdb4Client` / `WechatDb`、Win/Mac 密钥提取、图片解密、导出与群日报、本地 HTTP 服务 `src/main/http-server.ts`；
  - `src/main/services/`（81 文件，含 `src/main/services/wechat-ilink/` 13 文件）：会话/启动缓存、AI Provider 与双引擎搜索、OCR 索引、实时监听与退群监控、自动化、发送网关与 Agent Hub；
  - `src/main/extensions/`（21 文件）：扩展管理、安装校验、开发目录链接、权限/Secret/Storage、事件总线与 `tm-extension://` 协议；
  - `src/main/voice-pipeline/`（17 文件）、`src/main/knowledge/`（9 文件）、`src/main/db/`（1 文件）。
- `src/preload/`（**2 文件**）：`src/preload/index.ts` 与 `src/preload/index.d.ts`。
- `src/renderer/`（**272 文件**）：`src/renderer/index.html` → `src/renderer/src/main.tsx` → `App.tsx`，含 10 大一级工作区（`archive` / `search` / `report` / `exit-monitor` / `automation` / `extensions` / `agent-hub` / `export` / `api` / `settings`）、22 个 Radix UI 原语及 `--tm-*` / `--wxex-*` 双轨样式。
- `src/shared/`（**75 文件**）：纯类型契约、校验函数与协议常量，按 9 大主题域划分，零 Electron/DOM 依赖。

### 3.2 子包、独立服务、工程脚本与资源目录

- `packages/extension-sdk/`（**3 文件**）：私有类型包 `@tracememo/extension-sdk`，定义 `TraceMemoApi` 等扩展开发契约。
- `services/share-card-worker/`（**6 文件**）：独立 Cloudflare Worker + R2 存储服务，托管实验性微信日报分享卡片与 JS-SDK 签名。
- `scripts/`（**21 个脚本**，另根目录 `create_tag.sh`）：涵盖 macOS 双版构建与签名、打包门禁 `scripts/after-pack.cjs`、运行时准备、扩展模板打包、TS 基线棘轮、Skill 防漂移与知识库校验。
- `tests/`（**300 文件**）：`tests/unit/` (162)、`tests/component/` (74+2)、`tests/integration/` (36)、`tests/e2e/` (8+4，替身 `tests/e2e/support/electron-main.cjs`)、`tests/benchmark/` (3)、`tests/smoke/` (1)、`tests/fixtures/` (8)、`tests/setup/` (1) 及 `tests/typecheck-baseline.json`（203 错误基线）。
- `examples/`（**29 文件**）：3 套官方扩展示例（`examples/extensions/`：`keyword-bot`、`group-chat-bot`、`douyin-sender`，受 `examples/extensions/template-lock.json` 保护）+ `examples/report-template-basic/`。
- `resources/`（28 跟踪文件，区分现行目录与历史遗留）、`build/`（5 跟踪文件 + 构建生成目录）、`public/`（15 文档配图）与 `docs/`（用户文档、Agent/API/扩展文档及 `docs/architecture/` 知识库）。

### 3.3 运行时数据与安全存储约定

- **4 类 `safeStorage` 加密凭据**（均位于 `<userData>`，权限 `0o600`）：`database-keys/<sha256>.bin`（DB 密钥）、`wechat-image-keys.bin`（图片 AES/XOR 密钥）、`ai-provider-keys.bin`（模型 API Key）、`local-api-token.bin`（本地 HTTP Bearer Token，32B `base64url`）。
- **排障关键路径**：主日志 `<logs>/tracememo.log`（5MB 轮转 `.1`，自动脱敏 `sk-*`、`Bearer` 与 64 位 hex Key）；迁移状态 `<userData>/tracememo-migration-v1.json`；解密图片磁盘缓存 `<userData>/cache/images`（512MB / 512 文件上限）。

---

## 4. `docs/architecture/` 专题路由

所有知识库专题均按**架构总览、模块职责与边界、核心数据流与设计思路、关键文件与符号索引、后续维护与开发指南**五大维度组织：

- [架构知识库总览与阅读路径](./docs/architecture/README.md)
- [01. 系统架构总览](./docs/architecture/01-system-overview.md) — 四层进程边界、技术栈、6 个编译入口、遗留文件澄清与设计原则
- [02. 主进程生命周期与核心数据访问](./docs/architecture/02-main-process-and-data.md) — 启停与托盘、`safeStorage` 矩阵、`WechatExplorer` 迁移、`Wcdb4Client`、Win/Mac 密钥与图片缓存
- [03. 知识库、语音与 AI 检索管道](./docs/architecture/03-knowledge-and-ai-pipeline.md) — Knowledge FTS5 Worker、图片 OCR 索引、Voice SenseVoice ONNX Pipeline、`AiSearchPipelineService` 与 `QueryAgentService`
- [04. 报告导出、自动化与 Agent Hub](./docs/architecture/04-reports-automation-hub.md) — 聊天导出、群日报与模板沙箱、退群监控、4 重防回环自动化引擎、双通道发送网关与 `AgentHubService`
- [05. Local HTTP API、扩展中心与外围服务](./docs/architecture/05-http-api-and-extensions.md) — Local HTTP API（`127.0.0.1:6131`）、`packages/extension-sdk/`、`src/main/extensions/`、`examples/` 与 `services/share-card-worker/`
- [06. 渲染层、共享契约与 IPC 通道](./docs/architecture/06-renderer-and-ipc.md) — 10 大工作区、React State 路由与深链、零 `fetch()`、双轨样式、`src/shared/` 9 域、257 条 `window.api` 全表与类型偏差提示
- [07. 构建脚本与打包分发](./docs/architecture/07-build-scripts-and-packaging.md) — `electron-builder*.yml` 三套配置、21 个脚本、macOS 双版隔离、`after-pack.cjs` 裁剪与 ad-hoc 签名
- [08. 测试体系与质量门禁](./docs/architecture/08-testing-and-quality-gates.md) — 6 层测试、E2E 确定性替身、平台/OCR 门控、TS 棘轮与 `.github/workflows/test.yml`
- [09. 全仓文件、符号、通道与配置总索引](./docs/architecture/09-symbol-and-file-index.md) — 全仓目录统计、核心导出符号、241+17 IPC、39 条 Local HTTP 端点、环境变量与已核实源码细节偏差总索引

---

## 5. 高频命令与环境变量速查

### 5.1 开发、测试与打包命令

```bash
# 1. 首次初始化与本地开发（predev 自动保障 Electron 二进制与 .env）
pnpm install
pnpm cp:env
pnpm dev
pnpm dev:update                         # 模拟自动更新调试模式

# 2. 类型检查、代码规范与工程门禁（提交前必跑）
pnpm typecheck                          # 串联 typecheck:node + typecheck:web + typecheck:test（棘轮）
pnpm lint
pnpm test:skill-install                 # 验证 API Center 中 Reader Skill 安装指令生成
pnpm check:skill-version                # 验证 SKILL.md 修改是否递增 version
node scripts/build-extension-templates.cjs --check
node scripts/check-knowledge-base.mjs   # 校验知识库链接、锚点与仓库路径（支持 --json）

# 3. 自动化测试分层执行
pnpm test:unit                          # Node 单元测试（162 文件）
pnpm test:component                     # React 19 + jsdom 组件测试（74 文件）
pnpm test:integration                   # Preload 契约/HTTP API/扩展/OCR 集成测试（36 文件）
pnpm test:e2e                           # electron-vite build + Playwright 非视觉 E2E
pnpm test                               # 本地完整串联 CI 测试链

# 4. 打包与发行版构建
pnpm build                              # typecheck + electron-vite build
pnpm build:win                          # Windows x64 NSIS 安装包（electron-builder.win.yml）
pnpm build:mac:public                   # macOS ARM64 OSS 公开版（仅 4 只读 msg_insert 符号）
pnpm build:mac:native                   # macOS ARM64 Native 完整版（含发送运行时与授权校验）
```

### 5.2 关键环境变量

- **构建与打包**：`TRACEMEMO_EDITION`（`public`/`native`）、`TRACEMEMO_EDITION_OUT_DIR`（覆写编译输出目录）、`TM_SEND_RUNTIME_BUILD=1`（放行发送运行时打包）。
- **测试与诊断**：`WXE_USER_DATA`（隔离 `userData` 跳过迁移）、`WXE_TRAY=1`（托盘静默启动）、`WXE_E2E_CLOSE_DELAY_MS`（CI 置 `0`）、`KNOWLEDGE_CAPACITY=1`（解锁百万级压测）、`WXE_REAL_DATA_SMOKE=1`（解锁真机冒烟）。

---

## 6. 关键工程红线

1. **严禁擅自修改 `docs/skill/tracememo-reader/SKILL.md`**：
   - 受 `pnpm check:skill-version` 与 `scripts/after-pack.cjs` 打包校验监控；非同步发版升级 Skill 严禁修改。
   - 修改 `examples/extensions/` 须同步递增模板 `manifest.json` 的 `version` 并运行 `pnpm build:templates`。
2. **渲染层零直接 `fetch()`**：
   - `src/renderer/` 内严禁直接调用 `fetch()` 访问本地或外部服务，全部经 `window.api.*` 由主进程代理。
   - 新增跨进程契约优先定义在 `src/shared/`，并同步更新 `src/preload/index.ts`、`src/preload/index.d.ts` 与 `tests/integration/preload-contract.test.ts`。
3. **主进程引导顺序与 WCDB 写入隔离**：
   - `src/main/index.ts` 首组静态导入必须保持 `./app-data-bootstrap` 与 `./preload-env` 在最前，确保先锁定 `TraceMemo` 路径与 Windows DLL 搜索路径。
   - 禁止在主进程对微信分片执行 DDL/DML 写入（防 `-3004`），写操作统一派生 `tm-wcdb-config-helper` 并经 `stdin` JSON 传入密钥。
4. **Windows 非 ASCII 路径 NTFS Junction 桥**：
   - 当微信账号目录含中文等非 ASCII 字符时，必须保留 `Wcdb4Client` 在 `%PUBLIC%\TraceMemo\path-bridges\` 建立 NTFS Junction 软链的逻辑，向 C++ WCDB 提供纯 ASCII 路径。
5. **macOS 双版隔离与架构安全顺序**：
   - `public` 版严禁混入 `tm-wechat-host` 或写入型 `wcdb_msg_insert_*` 符号；打包后由 `scripts/after-pack.cjs` 执行跨架构裁剪与自底向上 ad-hoc `codesign`（禁用 `--deep`）。
   - macOS 取密钥必须先执行 `getMacArchSnapshot()` 架构检查再查 SIP。
6. **保留历史兼容标识与 PR 分支规范**：
   - `wxe-media://`、`WXE_*`、`_wxe_*` 属有意保留的升级兼容标识，不可随意改名。
   - 开发请基于 `develop` 拉新分支并向 `develop` 提 PR（详见 [CONTRIBUTING.md](./CONTRIBUTING.md)），严禁提交真实聊天数据、密钥、Token、构建产物或本机绝对路径。
7. **打包配置同步排除文档入口**：
   - `electron-builder.yml`、`electron-builder.win.yml` 与 `scripts/build-macos-edition.cjs` 均显式声明 `!AGENTS.md`，确保仓库维护入口不会打入安装包 `app.asar`。
