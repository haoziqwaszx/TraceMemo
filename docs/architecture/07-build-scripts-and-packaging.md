# 07 · 构建脚本、资源分发与双端打包签名体系

> **源码基线**：Git commit `9efb8ac`（`package.json` `v2.7.0`，`pnpm@7.33.7`）<br>
> **相关文档**：[知识库总览](./README.md) · [系统整体架构](./01-system-overview.md) · [主进程与数据存储](./02-main-process-and-data.md) · [渲染层与 IPC 契约](./06-renderer-and-ipc.md) · [测试与质量门禁](./08-testing-and-quality-gates.md)

---

## 一、架构总览

TraceMemo 是基于 **Electron 43 + electron-vite 5 + Vite 7 + React 19 + TypeScript 5.9** 构建的本地桌面应用，同时内嵌多套原生动态库、命令行 Helper、独立 Node 子进程 Worker 与扩展模板包。因此，项目的工程化流水线远不止常规的前端打包，而是围绕**跨平台原生二进制校验、macOS 双发行版隔离、防敏感文件泄漏、架构死重裁剪与自底向上 ad-hoc 签名**建立了一整套确定性构建体系。

```text
                         ┌───────────────────────────────────────┐
                         │    源码编译 (electron-vite build)      │
                         │  - main: 6 个独立 Rollup JS 入口       │
                         │  - preload: index.js                  │
                         │  - renderer: React 19 SPA             │
                         └───────────────────┬───────────────────┘
                                             │
            ┌────────────────────────────────┼────────────────────────────────┐
            ▼                                ▼                                ▼
┌───────────────────────┐      ┌──────────────────────────┐      ┌──────────────────────────┐
│   Windows x64 路径    │      │   macOS 通用/手动路径    │      │   macOS 双版隔离路径     │
│  pnpm build:win       │      │  build:mac:arm64 / x64   │      │  build:mac:public|native │
├───────────────────────┤      ├──────────────────────────┤      ├──────────────────────────┤
│ 1. build:templates    │      │ 1. build:templates       │      │ 1. prepare-macos-edition │
│ 2. pnpm typecheck     │      │ 2. pnpm typecheck        │      │    Staging + 符号/签名   │
│ 3. prepare:win-runtime│      │ 3. prepare:ffmpeg:mac:*  │      │    + tracememo-build.json│
│ 4. electron-vite build│      │ 4. electron-vite build   │      │ 2. electron-vite build   │
│ 5. builder.win.yml    │      │ 5. builder(.send-runtime)│      │    → staging/<ed>/out    │
└───────────┬───────────┘      └────────────┬─────────────┘      │ 3. 动态 YAML + builder   │
            │                               │                    └────────────┬─────────────┘
            └───────────────────────────────┼─────────────────────────────────┘
                                            ▼
                         ┌───────────────────────────────────────┐
                         │    打包后统一门禁 scripts/after-pack.cjs │
                         │  1. 发送运行时边界检查                 │
                         │  2. app.asar 依赖 & 防泄漏检查         │
                         │  3. Skill / 扩展模板 SHA-256 校验      │
                         │  4. Electron 主程序/FFmpeg/Native 架构 │
                         │  5. public/native 发行版符号边界复检   │
                         │  6. 外架构运行库与 Intel 工具裁剪      │
                         │  7. macOS 自底向上 ad-hoc codesign     │
                         └───────────────────┬───────────────────┘
                                             ▼
                                   dist/ 安装包产出 (.dmg / .zip / setup.exe)
```

### 1.1 核心工程约定与包管理基线

- **锁定包管理器**：`package.json` 声明 `"packageManager": "pnpm@7.33.7"`（L4）。`scripts/after-pack.cjs:626` 明确提示需使用 pnpm 7.33.7 以确保 `electron-builder` 正确解析 `pnpm-lock.yaml`。
- **`.npmrc` 跨平台配置**（8 行）：
  - `shamefully-hoist=true`：确保 Electron / Koffi / Native 子包在 `node_modules` 顶层扁平可达，满足 `electron-builder` 打包与运行时 `require()` 解析。
  - `electron_mirror=https://npmmirror.com/mirrors/electron/`：默认使用国内镜像加速 Electron 二进制下载。
  - `supportedArchitectures.os[]=darwin`、`supportedArchitectures.os[]=win32`、`supportedArchitectures.cpu[]=arm64`、`supportedArchitectures.cpu[]=x64`：跨平台保留可选原生包声明（供跨平台打包与裁剪使用）。
- **`onlyBuiltDependencies`**（`package.json:176-180`）：仅放行 `electron`、`esbuild`、`ffmpeg-static` 执行安装构建脚本，其余依赖保持静默快速安装。
- **`electron@43` 懒加载兜底**：由于 Electron 43 不再在自身 `postinstall` 下载二进制，`package.json:61` 的 `postinstall` 与 `predev` 钩子均挂载了 `scripts/ensure-electron-binary.cjs`，保障新克隆仓库不会出现 `node_modules/electron/dist` 空壳。

---

## 二、模块职责与边界

### 2.1 编译与打包配置矩阵

#### 1. `electron.vite.config.ts`（38 行）

编译期将主进程拆分为 **6 个独立入口**，避免后台 Worker 或一次性 POC/测试入口把完整 GUI 主进程逻辑拖入子进程，同时支持通过环境变量 `TRACEMEMO_EDITION_OUT_DIR` 将编译产物重定向至隔离的 macOS Staging 目录（默认输出至未跟踪的 `out/` 目录）：

| 入口名（`rollupOptions.input`） | 源码路径 | 输出文件名 | 运行载体 / 用途 |
|---|---|---|---|
| `index` | `src/main/index.ts` | `index.js` | Electron 主进程主入口（`package.json` `"main": "./out/main/index.js"`） |
| `extensionHost` | `src/main/extensions/host-runtime.ts` | `extensionHost.js` | 扩展子进程独立宿主（`child_process.fork`） |
| `reportTemplateTest` | `src/main/report-template-test-entry.ts` | `reportTemplateTest.js` | 日报模板隔离测试 Electron 入口 |
| `queryAgentPoc` | `src/main/query-agent-poc-entry.ts` | `queryAgentPoc.js` | Query Agent 命令行 POC 入口（见 `docs/development/query-agent-poc.md`） |
| `voiceRecognitionWorker` | `src/main/voice-pipeline/voice-recognition-worker.ts` | `voiceRecognitionWorker.js` | SenseVoice 语音转写独立 Node Worker（`ELECTRON_RUN_AS_NODE=1`） |
| `knowledgeWorker` | `src/main/knowledge/knowledge-worker.ts` | `knowledgeWorker.js` | SQLite FTS5 知识检索独立 Node Worker（`ELECTRON_RUN_AS_NODE=1`） |

- **外部原生模块（`external`）**：`['koffi', 'sherpa-onnx-node', '@napi-rs/system-ocr']`（`electron.vite.config.ts:24`），编译期保持外部 `require()`，由 `electron-builder` 的 `asarUnpack` 展开至磁盘供原生加载器加载。
- **渲染器别名**：`renderer.resolve.alias` 将 `@renderer` 映射到 `src/renderer/src`。

#### 2. `electron-builder*.yml` 三套打包配置边界

| 配置维度 | `electron-builder.yml`（默认 / macOS / Linux） | `electron-builder.win.yml`（Windows x64 专属） | `electron-builder.send-runtime.yml`（macOS 发送运行时特例） |
|---|---|---|---|
| 继承关系 | 基础配置（88 行） | 独立 Win 配置（80 行） | `extends: ./electron-builder.yml`（20 行） |
| `afterPack` 钩子 | `scripts/after-pack.cjs` | `scripts/after-pack.cjs` | 继承 `scripts/after-pack.cjs` |
| `files` 排除规则 | 含 `out`，排除 `.vscode`、`src/*`、配置文件、`.env*`、`README.md`、`CHANGELOG.md`、`tsconfig*.json` 及 **`!AGENTS.md`** | 与 `electron-builder.yml` 一致，含 **`!AGENTS.md`** 防止知识库入口打入 `app.asar` | 继承 `electron-builder.yml` |
| `asarUnpack` | `resources/**`、`ffmpeg-static/**`、`silk-wasm/**`、`sherpa-onnx-node/**`、`sherpa-onnx-*/**`、`@napi-rs/system-ocr/**`、`@napi-rs/system-ocr-*/**` | 同左 | 继承 |
| `extraResources` | `build/app-update.yml`；`resources` 全量（**排除** `!runtime/darwin-arm64/**` 与 `!wcdb/**/tm-wcdb-config-helper*`）；`docs/skill/tracememo-reader` → `skill/tracememo-reader`；`build/extension-templates` → `extension-templates` | 仅白名单挑选 `icon.png`、4 个日报 HTML 模板、`key/win32/x64/**`、`runtime/win32/**`、`wcdb/win32/x64/**`（排除 `!wcdb/**/tm-wcdb-config-helper*`）；`build/extension-templates`；`docs/skill/tracememo-reader`；`build/app-update.yml` | 放开 `resources/**/*`，并显式打包 `wcdb/macos/arm64/tm-wcdb-config-helper`（外部构建产物，配合 `TM_SEND_RUNTIME_BUILD=1`） |
| 目标产物与签名 | `mac`: `dmg` + `zip`（`entitlementsInherit: build/entitlements.mac.plist`，`notarize: false`）；`linux`: `AppImage` / `snap` / `deb` | `win`: `nsis` (`x64`，`executableName: TraceMemo`，`electronLanguages: ['zh-CN', 'en-US']`) | `mac`: `dmg` + `zip` |
| `publish` 策略 | GitHub `Wxw-Gu/TraceMemo`，`releaseType: draft`（预发布通过 `EP_PRE_RELEASE=true` 覆盖） | 同左 | 继承 |

> **说明**：当通过 `pnpm build:mac:public` 或 `pnpm build:mac:native` 构建 macOS 发行版时，`scripts/build-macos-edition.cjs` 会在临时目录动态生成 `electron-builder-<edition>.yml`（同样显式包含 `'!AGENTS.md'` 及敏感到期文件排除规则），不直接使用仓库根的 `electron-builder.yml`。

---

### 2.2 `scripts/`（21 脚本）与 `create_tag.sh` 全量职责清单

| 分类 | 脚本路径 | 对应 npm scripts / 触发方式 | 核心职责与输入输出契约 |
|---|---|---|---|
| **macOS 双版构建** | `scripts/build-macos-edition.cjs` | `pnpm build:mac:public` / `pnpm build:mac:native` | 校验 `tracememo-build.json` 标记 → 设置 `TRACEMEMO_EDITION` / `TRACEMEMO_RUNTIME_PROFILE` / `TRACEMEMO_EDITION_OUT_DIR` → 调 `electron-vite build` → 生成临时 Builder 配置打 `TraceMemo-<ver>-mac-arm64-{oss|native}.dmg` → 清理临时配置目录（支持 `--reuse-staging`） |
| **macOS 双版 Staging** | `scripts/prepare-macos-edition.cjs` | 由 `build-macos-edition.cjs` 调用或直接 `node scripts/prepare-macos-edition.cjs <public\|native>` | 准备 `build/mac-staging/<edition>/resources`：检查敏感输入、`ffmpeg-static` 下载/校验 arm64 FFmpeg 与 3 个许可文件、`public` 版校验 WCDB 只读导出符号、`native` 版校验 7 文件清单 / `libtmlicense.dylib` 签名 / `/license/status` 路由 / 内嵌 SHA-256，写出 `tracememo-build.json` |
| **打包后统一门禁** | `scripts/after-pack.cjs` | `electron-builder` `afterPack` 钩子 | 执行发送运行时边界检查、`app.asar` 核心依赖与防泄漏检查、Skill/扩展模板校验、Electron 主程序及全部原生模块（FFmpeg/SILK/Sherpa/OCR/Koffi）存在性与架构校验、外架构运行库裁剪、macOS 自底向上 ad-hoc `codesign` |
| **二进制头解析** | `scripts/binary-arch.cjs` | 被 `after-pack.cjs`、`prepare-macos-edition.cjs`、`prepare-electron-runtime.cjs` 复用 | 只读前 64KB 文件头解析 Mach-O（Thin/Fat 32/64）与 PE（`0x8664` x64 / `0xaa64` arm64），返回标准架构名数组 |
| **运行时准备** | `scripts/prepare-electron-runtime.cjs` | `postinstall`、`prepare:ffmpeg:win`、`prepare:ffmpeg:mac:arm64`、`prepare:ffmpeg:mac:x64` | 核对并按 `--platform`/`--arch` 下载匹配架构的 `ffmpeg-static`（macOS 下以 `otool -l` 检查截断并 ad-hoc 签名）；Windows 下同步 `resources/runtime/win32/*.dll` 到 `node_modules/electron/dist` |
| **Win Sherpa 准备** | `scripts/prepare-win-runtime.cjs` | `pnpm prepare:win-runtime`（含在 `build:win` / `release:win` 前置链） | 检测 `node_modules/sherpa-onnx-win-x64/{package.json,sherpa-onnx.node}`，缺失则执行 `pnpm install --force --ignore-scripts` 拉取跨平台可选依赖 |
| **Mac 原生发送同步** | `scripts/prepare-wechat-native-runtime.cjs` | `pnpm prepare:wechat-native`（支持 `--source` / `--target`） | 从 `--source` / `TM_NATIVE_RUNTIME_DIR` / `.native-runtime-source` 校验 `tm-wechat-host`、`libtmwechat.dylib`、`runtime-manifest.json`（Mach-O arm64、capabilities、内嵌 SHA-256），以 staging+backup 方式原子同步到 `resources/runtime/darwin-arm64/` |
| **环境变量兜底** | `scripts/ensure-env.cjs` | `pnpm cp:env` / `pnpm prepare:env` / `pnpm dev` | 若 `.env.example` 存在且 `.env` 不存在，复制生成 `.env` |
| **Electron 二进制兜底** | `scripts/ensure-electron-binary.cjs` | `postinstall`、`predev` | 检测 `node_modules/electron/path.txt` 及对应可执行文件是否存在；缺失时读取 `.npmrc` 的 `electron_mirror`（回退 `https://npmmirror.com/mirrors/electron/`）执行 `node_modules/electron/install.js` |
| **官方扩展模板构建** | `scripts/build-extension-templates.cjs` | `pnpm build:templates`、`prebuild`（支持 `--check`、`--update-lock`） | 白名单扫描 `examples/extensions/{keyword-bot,group-chat-bot,douyin-sender}`，排除私有脚本，CRLF→LF 归一化 + 固定 DOS 时间戳生成确定性 ZIP 至 `build/extension-templates/`（含 `index.json`），并校验/更新 `examples/extensions/template-lock.json` |
| **日报模板示例打包** | `scripts/build-report-template-example.cjs` | 手动 `node scripts/build-report-template-example.cjs` | 使用 `archiver` 将 `examples/report-template-basic/{manifest.json,template.html}` 与 1×1 占位 `preview.png` 打包为 `examples/report-template-basic.zip` |
| **Skill 版本防漂移** | `scripts/check-skill-version-drift.cjs` | `pnpm check:skill-version`（CI 必跑） | 对比基准分支（`SKILL_VERSION_BASE` / `origin/main` / `origin/develop` / `HEAD~1`），若 `docs/skill/tracememo-reader/SKILL.md` 有改动但 frontmatter `version` 未递增则退出码 `1` |
| **Skill 安装指令测试** | `scripts/test-skill-install-instruction.cjs` | `pnpm test:skill-install`（CI 必跑） | 运行时用 `typescript` 转译 `src/renderer/src/features/api-center/utils/buildSkillInstallInstruction.ts`，断言 `codex`/`claude-code`/`openclaw`/`generic` 四端安装指令格式与版本号注入 |
| **TS 测试基线棘轮** | `scripts/typecheck-tests.cjs` | `pnpm typecheck:test`（含在 `pnpm typecheck` 与 CI 中，支持 `--update`） | 调用 `tsc` 检查 `tsconfig.test.json`，按“文件 → 错误数”对比 `tests/typecheck-baseline.json`，只许降不许升 |
| **知识库引用校验** | `scripts/check-knowledge-base.mjs` | 手动 / 提交前 `node scripts/check-knowledge-base.mjs`（支持 `--json`、`--include-skills`） | 纯 Node ESM 零依赖脚本，校验 `AGENTS.md`、`README.md` 与 `docs/**/*.md` 中的相对链接、标题/行号锚点及反引号仓库路径引用（0 断链门禁） |
| **Knowledge Worker 验真** | `scripts/test-knowledge-worker.cjs` | `pnpm test:knowledge-worker` | 构建后直接以 `ELECTRON_RUN_AS_NODE=1` fork `out/main/knowledgeWorker.js`（未跟踪构建产物），在临时目录实测多账号隔离索引、搜索、移除与关闭 |
| **Query Agent POC 运行** | `scripts/run-query-agent-poc.cjs` | `pnpm poc:query-agent:run`（`poc:query-agent` 前置构建） | 清除 `ELECTRON_RUN_AS_NODE` 后使用 Electron 启动已构建的 `out/main/queryAgentPoc.js`（`TRACEMEMO_POC_ELECTRON` 可覆写可执行文件） |
| **日报多版式预览生成** | `scripts/generate-report-template-preview.cjs` | 手动 `node scripts/generate-report-template-preview.cjs <现有日报.html> [输出目录]` | 用 `jsdom` 解析已有日报 HTML 并填充 `resources/daily_report_templates.html`，生成 5 套版式对照 HTML 到目标目录（默认 `.codex/report-template-preview`） |
| **日报 Fixture 截图渲染** | `scripts/render-report-fixtures.mjs` | 手动 Electron 脚本（支持 `--full`） | 使用 Electron `BrowserWindow` + CDP `Page.captureScreenshot` 将 `resources/mobile_daily_report.html` 渲染为精简/完整版脱敏 HTML 与长图 PNG 至系统临时目录 |
| **微信更新拦截（macOS）** | `scripts/manage-wechat-update-block.sh` | 手动 `sudo sh scripts/manage-wechat-update-block.sh {enable\|disable\|status}` | 通过 macOS `pfctl` anchor `com.tencent.wechat.update` 解析并阻断 `dldir*.qq.com` 微信更新域名（操作前自动备份 `/etc/pf.conf`） |
| **Local API 手工验收** | `scripts/manual-test-local-api.sh` | 手动 `bash scripts/manual-test-local-api.sh` | macOS 终端交互式 `curl` 脚本，输入 Token（不回显）后验证 `127.0.0.1:6131` 的 Bearer 鉴权、CORS 白名单及停止监听行为 |
| **发版打 Tag** | `create_tag.sh` | 手动 `./create_tag.sh`（仓库根目录） | 用 `jq -r '.version' package.json` 生成 `v${VERSION}` 标签并推送 `origin` |

---

### 2.3 `resources/`、`build/` 与 `public/` 资源目录边界

#### 1. `resources/`（28 个 Git 跟踪文件，区分现行与历史遗留）

| 分类 | 仓库跟踪路径 | 用途与源码加载入口 | 状态说明 |
|---|---|---|---|
| **日报 HTML 模板（4）** | `resources/daily_report_templates.html`<br>`resources/mobile_daily_report.html`<br>`resources/mobile_daily_report_v1.html`<br>`resources/mobile_daily_report_v2.html` | `src/main/group-report-service.ts`（`v1`/`v2`）、`src/shared/report-templates.ts`、预览与 fixture 生成脚本 | **现行**（全平台打包） |
| **应用与托盘图标（4）** | `resources/icon.png`、`resources/trayTemplate.png`、`resources/trayTemplate@2x.png`、`resources/trayTemplate.svg` | `src/main/tray-icon.ts` 与主窗口图标加载 | **现行** |
| **macOS WCDB 双架构库（4）** | `resources/wcdb/macos/arm64/{libWCDB.dylib,libwcdb_api.dylib}`<br>`resources/wcdb/macos/x64/{libWCDB.dylib,libwcdb_api.dylib}` | `src/main/native-runtime-paths.ts:44-55`（`resolveWcdbLibrary` / `resolveWcdbDependency`） | **现行**（双版构建时 arm64 由 `prepare-macos-edition.cjs` 从 `WCDB_DIST_ROOT`/`NATIVE_DIST_ROOT` 替换验证） |
| **macOS 密钥获取工具（4）** | `resources/xkey_helper`、`resources/xkey_helper_4_1_13`、`resources/xkey_helper_4_1_13.sha256`<br>`resources/macos-key-tool/intel_mac_key_helper` | `src/main/key-service-mac.ts`（ARM64 按微信版本 `4.1.13` 分流 `xkey_helper*`；Intel 使用 `intel_mac_key_helper`） | **现行**（`intel_mac_key_helper` 约 33.9MB，在非 `darwin` x64/universal 包中由 `after-pack.cjs` 裁剪） |
| **Windows x64 原生库（8）** | `resources/key/win32/x64/wx_key.dll`<br>`resources/wcdb/win32/x64/{SDL2.dll,WCDB.dll,wcdb_api.dll}`<br>`resources/runtime/win32/{msvcp140.dll,msvcp140_1.dll,vcruntime140.dll,vcruntime140_1.dll}` | `src/main/key-service-win.ts`、`src/main/wcdb4-client.ts:3724-3755`、`scripts/prepare-electron-runtime.cjs` | **现行**（仅 `electron-builder.win.yml` 打入 Windows 包） |
| **历史遗留动态库（4）** | `resources/libwcdb_api.dylib`、`resources/libwx_key.dylib`<br>`resources/macos/{libWCDB.dylib,libwcdb_api.dylib}` | `prepare-macos-edition.cjs` 的 `PUBLIC_FILES` 白名单与 `native-runtime-paths.ts` 均不再引用 | **历史遗留**（`libwx_key.dylib` 在 `src/` 下已无任何引用） |
| **未入库发送运行时（1 目录）** | `resources/runtime/darwin-arm64/`（被 `.gitignore:13` 忽略） | `src/main/native-runtime-paths.ts:63-90`；本地开发通过 `scripts/prepare-wechat-native-runtime.cjs` 注入 | **未跟踪运行时注入目录**（默认禁止随通用包分发） |

#### 2. `build/`（5 个 Git 跟踪文件 + 构建期生成目录）

- **Git 跟踪文件（5 个）**：
  - `build/app-update.yml`：GitHub Releases 自动更新配置（`provider: github`, `owner: Wxw-Gu`, `repo: TraceMemo`, `updaterCacheDirName: tracememo-updater`）。
  - `build/entitlements.mac.plist`：macOS 权限声明（允许 `allow-jit`、`allow-unsigned-executable-memory`、`allow-dyld-environment-variables`）。
  - `build/icon.icns`、`build/icon.ico`、`build/icon.png`：各平台安装包应用图标。
- **构建期生成目录（不入 Git）**：
  - `build/extension-templates/`（`.gitignore:42` 忽略）：由 `scripts/build-extension-templates.cjs` 生成 `index.json` 与 3 个扩展模板 ZIP，随包复制到 `extension-templates`。
  - `build/mac-staging/`（`.gitignore:34` 忽略）：macOS `public` / `native` 双版构建的隔离暂存根目录。

#### 3. `public/`（15 个 Git 跟踪配图文件）

存放 `README.md` 与 `docs/` 用户指南引用的展示截图与二维码（如 `public/日报.png`、`public/自动化.png`、`public/setup-page.png`、`public/微信卡片分享.png` 等），不参与 Electron 编译或安装包资源复制。

---

## 三、核心数据流与设计思路

### 3.1 macOS 双版（`public` vs `native`）隔离构建与签名门禁

TraceMemo 在 macOS ARM64 上区分 **OSS 公开版（`public`）** 与 **Native 完整版（`native`）**。为彻底杜绝构建环境污染或闭源发送组件误入开源构建包，项目采用 **Staging 目录全隔离 + 双重校验** 设计：

1. **输入隔离与防污染检查（`scripts/prepare-macos-edition.cjs`）**：
   - Staging 根目录默认为 `build/mac-staging/<edition>`，输出目录为 `dist/mac/<edition>`（均可通过 `TRACEMEMO_MAC_STAGE_ROOT` / `TRACEMEMO_MAC_OUTPUT_ROOT` 覆写）。若目标目录已存在，除非显式传 `--reuse-staging`，否则直接拒绝覆写（`assertStagingTargetDoesNotExist`）。
   - `assertNoProtectedInputs` 禁止仓库根目录 `1.txt` 或受保护路径 “runtime/runtime.zip” 作为构建输入。
   - **FFmpeg 独立分发**：从 `TRACEMEMO_FFMPEG_ARM64_PATH` 或 GitHub Release (`b6.1.1`) 下载 `ffmpeg-darwin-arm64.gz` 解压至暂存目录 `ffmpeg/ffmpeg`，同时拷贝 `LICENSE`、`FFMPEG-LICENSE.txt`、`FFMPEG-BUILD-INFO.txt` 3 个开源许可文件并记录 SHA-256。
2. **双版原生符号与签名校验**：
   - **`public` 版**：从 `TRACEMEMO_WCDB_DIST_ROOT`（默认 `../wcdb-dist/build/macos-package-universal`）校验 `libwcdb_api.dylib` 与 `libWCDB.dylib` 含 `arm64` 切片且通过 `@loader_path/libWCDB.dylib` 链接；用 `/usr/bin/nm -gU` 扫描导出符号，只允许 `PUBLIC_ALLOWED_MSG_INSERT` 定义的 4 个只读符号（`wcdb_msg_insert_get_switches`、`wcdb_msg_insert_inspect_shard`、`wcdb_msg_insert_list_shard_catalog`、`wcdb_msg_insert_get_rooms_status`），发现任何写入符号立即阻断。
   - **`native` 版**：从 `TRACEMEMO_NATIVE_DIST_ROOT`（默认 `../native-runtime-dist`）定位 `manifest.json`，强校验精确 7 文件清单、字节数与 SHA-256、`libtmlicense.dylib` 有效 `codesign --verify --strict`、`/license/status` 路由、`libtmwechat.dylib` 内嵌 `tmSendSourceSha256` 与 `addressProfileSha256` 哈希、`tm-wcdb-config-helper` 的 `@loader_path/libwcdb_api.dylib` 依赖，以及 `libwcdb_api.dylib` 导出全部 9 个 `wcdb_msg_insert_*` 符号。
   - **Fail-closed 部署约定**：`prepare-macos-edition.cjs:457-462` 将 `libtmlicense.dylib` 放置在 `wcdb/macos/arm64/libtmlicense.dylib`（与 `tm-wcdb-config-helper` 同目录），使 Helper 能通过 `<exe dir>/libtmlicense.dylib` 命中 `dlopen`。
3. **标记固化与二次构建（`scripts/build-macos-edition.cjs`）**：
   - `prepare-macos-edition.cjs` 写出 `tracememo-build.json`（记录 `profile`、`appVersion` 与全部关键文件的 SHA-256）；运行时 `src/main/native-runtime-paths.ts` 也依据该标记决定是否启用 Native 能力（未打包时默认允许本地 `native` 调试）。
   - `build-macos-edition.cjs` 校对标记后，注入 `TRACEMEMO_EDITION`、`TRACEMEMO_RUNTIME_PROFILE`、`TRACEMEMO_EDITION_OUT_DIR`，编译至 `build/mac-staging/<edition>/out`，动态生成 YAML 配置并调 `electron-builder --mac --arm64` 产出 `TraceMemo-<ver>-mac-arm64-oss.dmg` 或 `TraceMemo-<ver>-mac-arm64-native.dmg`，最后无论成功与否都在 `finally` 中清理临时 `configs/`（失败时同步回滚 `outputRoot`）。

### 3.2 `after-pack.cjs` 打包后门禁与自底向上 ad-hoc 签名

`scripts/after-pack.cjs`（910 行）是所有桌面端打包（Win/Mac/Linux）的最后一道防线，在 `electron-builder` 完成文件组装与 `app.asar` 打包后触发 `afterPack(context)`：

1. **发送运行时边界硬拦截（`enforceSendRuntimeBoundary`）**：macOS 包除非显式声明 `TM_SEND_RUNTIME_BUILD=1` 或 `TRACEMEMO_EDITION=native`，否则发现 `tm-wechat-host` 即刻失败，防止内部发送组件意外随公开包流出。
2. **运行时完整性校验**：
   - `validateAsarRuntimeDependencies`：检查 `app.asar` 内必须包含 8 个核心包（`@electron-toolkit/preload`、`@electron-toolkit/utils`、`archiver`、`electron-updater`、`ffmpeg-static`、`fs-extra`、`jsonrepair`、`koffi`）。
   - `validateReaderSkillRuntime` & `validateExtensionTemplates`：核实 `skill/tracememo-reader/SKILL.md` 及 `extension-templates/index.json` 中每个扩展模板 ZIP 的 SHA-256 一致性。
   - `validateSilkWasmRuntime`、`validateFfmpegRuntime`、`validateElectronMainBinary`、`validateSherpaRuntime`、`validateSystemOcrRuntime`、`validateKoffiRuntime`：逐一验证 unpacked 原生二进制存在性，并通过 `scripts/binary-arch.cjs` 校验 Mach-O/PE 目标架构（特别防止 Electron 缓存残留导致 arm64 包混入 x64 主程序，逃过开发检查并在用户侧 Rosetta 静默降级）。
3. **发行版隔离与敏感文件防泄漏**：当 `TRACEMEMO_EDITION` 存在时，`validateMacEditionResources` 与 `validateMacEditionProtectedFiles` 二次核验 `tracememo-build.json`、导出符号与二进制哈希，并扫描 `app.asar` 确保未打入 `1.txt`、`runtime.zip`、`.env*`、`*.db`/`*.sqlite*`、`*.log`。
4. **跨平台死重裁剪**：
   - `pruneIntelMacKeyTool`：除 `darwin` + `x64`/`universal` 外全部删除约 33.9MB 的 `intel_mac_key_helper`。
   - `pruneForeignArchConnectors` 与 `pruneForeignArchNativeRuntimes`：裁剪非当前目标平台/架构的 `sherpa-onnx-*`、`koffi-*` 与 `@napi-rs/system-ocr-*` 目录，避免单包白白膨胀上百 MB。
5. **macOS 自底向上 ad-hoc 签名（`signMacosHelpers` + `signMacosAppBundle`）**：
   - 由于 `electron-builder` 在未配置 Developer ID 时会跳过签名，且 Electron 43.1.0 官方 `darwin-x64` zip 内嵌框架/helper 为未签名状态，macOS 会在运行期（甚至 SIP 关闭后）直接击杀未签或签名受损的二进制。
   - **刻意禁用 `--deep`**：Apple 已废弃 `--deep`，且它会把外层 App 的 entitlements 错误套用到所有子 helper 上。因此 `findNestedMacosCodePaths` 仅遍历 `MACOS_CODE_LOCATIONS`（`Frameworks`、`MacOS`、`PlugIns`、`XPCServices`、`Helpers`、`Library/LoginItems`），跳过 `Contents/Resources/app.asar.unpacked` 中的海量依赖与 framework 符号链接（如 `Versions/Current`），按“深度优先、同深度文件先于 bundle”顺序自底向上执行 `codesign --force --sign -`，最后对所有 helper 按实际切片架构执行 `--verify --strict --arch`。

### 3.3 扩展模板确定性构建与 Skill 版本防漂移

- **扩展模板确定性 ZIP + 模板锁（`scripts/build-extension-templates.cjs`）**：
  - 官方扩展模板只打包 `TEMPLATE_SPECS` 白名单（`keyword-bot`、`group-chat-bot`、`douyin-sender`），自动剔除扩展包内私有/外部脚本（“scripts/douyin.py”、“lib/bot-engine.js”）。
  - 为避免 Windows（CRLF）与 macOS（LF）跨平台构建出不同哈希的 ZIP，脚本统一执行 CRLF→LF 归一化、按字典序排序条目，并使用固定 DOS 时间戳（`1980-01-01 00:00`）与权限（`0o100644`）手写 ZIP 二进制流。
  - 产物写入 `build/extension-templates/` 后与 `examples/extensions/template-lock.json` 比对：若某模板 `id@version` 已存在于锁文件中但内容 SHA-256 变化，构建立即失败，迫使开发者提升 `manifest.version` 或显式确认 `--update-lock`。
- **Reader Skill 版本防漂移（`scripts/check-skill-version-drift.cjs`）**：
  - 外部 Agent 依赖 `/api/v1/health` 返回的 `skill.version` 判断本地安装的 `SKILL.md` 是否过期。脚本将 `docs/skill/tracememo-reader/SKILL.md` 的 frontmatter `version` 设为唯一真源；只要该文件相对基准分支（`SKILL_VERSION_BASE` / `origin/main` / `origin/develop` / `HEAD~1`）发生任何改动而 `version` 未变，CI 即刻失败阻断（浅克隆无法解析基准时安全跳过）。

---

## 四、关键文件与符号索引

### 4.1 构建与打包配置文件索引

| 文件路径 | 核心配置项 / 作用 |
|---|---|
| `package.json` | `version: "2.7.0"`、`packageManager: "pnpm@7.33.7"`、`main: "./out/main/index.js"`、全量构建/测试/发布 `scripts` |
| `.npmrc` | `shamefully-hoist=true`、`electron_mirror`、跨平台 `supportedArchitectures` |
| `.gitignore` | 忽略 `resources/runtime/darwin-arm64/`（L13）、`build/mac-staging/`（L34）、`build/extension-templates/`（L42）等（`/AGENTS.md` 已解除忽略以受 Git 跟踪） |
| `electron.vite.config.ts` | 6 个 `main` Rollup 入口、`external` 原生模块声明、`TRACEMEMO_EDITION_OUT_DIR` 覆盖、`@renderer` 别名 |
| `electron-builder.yml` | 默认 / macOS / Linux 打包配置，含 `!AGENTS.md`、`asarUnpack`、排除原生发送运行时的 `extraResources` |
| `electron-builder.win.yml` | Windows x64 NSIS 专属打包配置，含 `!AGENTS.md`、精简 Win 资源白名单与 `zh-CN`/`en-US` 语言裁剪 |
| `electron-builder.send-runtime.yml` | 继承 `electron-builder.yml` 并放开全量 `resources/**/*` 与 `tm-wcdb-config-helper` |
| `build/app-update.yml` | GitHub Updater 目标仓库配置（`Wxw-Gu/TraceMemo`） |
| `build/entitlements.mac.plist` | macOS JIT、未签名可执行内存与 dyld 环境变量权限 |
| `create_tag.sh` | 读取 `package.json` 版本并创建/推送 `v<version>` Git Tag |

### 4.2 核心脚本导出符号与关键函数

| 文件路径 | 核心导出符号 / 内部关键函数 |
|---|---|
| `scripts/build-macos-edition.cjs` | `buildEdition(edition, options)`、`createBuilderConfig(...)` |
| `scripts/prepare-macos-edition.cjs` | `prepareEdition(edition)`、`validateStagedEdition(edition)`、`validateWcdbPair`、`readAndValidateNativeManifest`、`validateNativeBundle`、`validateNativeBundleFromStaging`、`resolveEditionRoots`、`assertNoProtectedInputs`、`prepareFfmpeg` |
| `scripts/after-pack.cjs` | `default` (`afterPack`)、`enforceSendRuntimeBoundary`、`validateAsarRuntimeDependencies`、`validateReaderSkillRuntime`、`validateExtensionTemplates`、`validateSilkWasmRuntime`、`validateFfmpegRuntime`、`validateElectronMainBinary`、`validateRuntimeBinaryArchitecture`、`validateSherpaRuntime`、`validateSystemOcrRuntime`、`validateKoffiRuntime`、`validateMacEditionResources`、`validateMacEditionProtectedFiles`、`pruneIntelMacKeyTool`、`pruneForeignArchConnectors`、`pruneForeignArchNativeRuntimes`、`signMacosHelpers`、`signMacosAppBundle`、`findNestedMacosCodePaths` |
| `scripts/binary-arch.cjs` | `readBinaryArchitectures(filePath)`（Mach-O / PE 头解析） |
| `scripts/prepare-electron-runtime.cjs` | `prepareFfmpegRuntime(targetPlatform, targetArch)`、`ensureFfmpegArchitecture`、`assertMachOIntact` |
| `scripts/prepare-win-runtime.cjs` | `hasWindowsSherpaRuntime`、`ensureWindowsSherpaRuntime` |
| `scripts/prepare-wechat-native-runtime.cjs` | `REQUIRED_FILES`、`assertMachOArm64`、`readAndValidateArtifact`、`syncArtifact` |
| `scripts/ensure-electron-binary.cjs` | `ensureElectronBinary`、`isElectronBinaryInstalled`、`resolveElectronPackageRoot` |
| `scripts/build-extension-templates.cjs` | `buildTemplates`、`buildZip`、`collectTemplateFiles`、`TEMPLATE_SPECS`、`OUTPUT_DIR`、`LOCK_FILE` |
| `src/main/native-runtime-paths.ts` | `hasMacNativeBundle`、`isMacNativeRuntimeUnavailable`、`resolveWcdbLibrary`、`resolveWcdbDependency`、`resolveWcdbConfigHelper`、`resolveWechatHost`、`resolveWechatDylib`、`resolveWechatRuntimeManifest` |

---

## 五、后续维护与开发指南

### 5.1 常用开发与打包命令速查

```bash
# 1. 首次克隆环境初始化（会自动触发 postinstall 下载 Electron 与准备 ffmpeg/VC++ DLL）
pnpm install
pnpm cp:env

# 2. 日常开发启动（含模拟自动更新调试模式）
pnpm dev
pnpm dev:update

# 3. 仅编译构建（生成构建期扩展模板、运行三端类型检查并输出到未跟踪的 out/）
pnpm build

# 4. Windows x64 安装包构建
pnpm build:win

# 5. macOS ARM64 双发行版构建（需先准备对应的 WCDB 或 Native Runtime 输入目录）
pnpm build:mac:public
pnpm build:mac:native

# 6. 校验官方扩展模板与模板锁（只检查不写文件）
node scripts/build-extension-templates.cjs --check

# 7. 发布与打 Tag（草稿发布到 GitHub Releases；beta 会设置 EP_PRE_RELEASE=true）
pnpm release:beta
pnpm release:stable
./create_tag.sh
```

### 5.2 新增原生依赖（Native Module）必改清单

每当向项目引入新的 C++/Rust/FFI 原生 Node 模块或平台专属可选包时，必须同步更新以下 4 处，否则在开发态正常但安装包必报 `MODULE_NOT_FOUND` 或架构不匹配：

1. **`package.json`**：将全平台子包显式列在 `dependencies` 中（避免 pnpm 7 跳过可选平台包）。
2. **`electron.vite.config.ts`**：将主包名加入 `main.build.rollupOptions.external`，禁止 Rollup 内联打包。
3. **`electron-builder.yml` 与 `electron-builder.win.yml`**：在 `asarUnpack` 中加入对应包路径，确保 `.node` / `.dylib` / `.dll` 解包到磁盘。
4. **`scripts/after-pack.cjs`**：
   - 增加 `validate*Runtime()` 存在性与架构核验；
   - 若存在外平台同级包（如 `*-win32-x64` / `*-darwin-arm64`），将其规则加入 `NATIVE_RUNTIME_PACKAGES` 让 `pruneForeignArchNativeRuntimes` 在打包后裁掉死重。

### 5.3 修改扩展模板或 Reader Skill 的红线流程

- **修改官方扩展模板（`examples/extensions/`）**：
  1. 修改代码后，必须同步递增该模板 `manifest.json` 的 `version`；
  2. 运行 `pnpm build:templates`，脚本会生成新版本 ZIP 并把新条目写入 `examples/extensions/template-lock.json`；
  3. **禁止**在未升版本的情况下习惯性使用 `--update-lock`，否则已安装旧模板的用户将无法识别版本变更。
- **修改内置 Reader Skill（`docs/skill/tracememo-reader/SKILL.md`）**：
  - 任何对 `SKILL.md` 内容的修改都必须同时递增文件顶部 frontmatter 的 `version` 字段，并确保 `pnpm check:skill-version` 返回退出码 `0`。

### 5.4 常见构建故障排查

| 故障现象 | 根因定位 | 解决措施 |
|---|---|---|
| `pnpm dev` 报 `Electron failed to install correctly` | Electron 43 懒加载导致 `node_modules/electron/dist` 未下载或网络失败 | 运行 `node scripts/ensure-electron-binary.cjs`（可用 `ELECTRON_MIRROR` 覆盖镜像） |
| macOS `codesign` 或运行 `ffmpeg` 失败 | `ffmpeg-static` 下载被网络截断（`otool -l` 报 `past end of file`） | 删除 `node_modules/ffmpeg-static/ffmpeg` 后重跑 `pnpm prepare:ffmpeg:mac:arm64`（或 `x64`） |
| `build:mac:public\|native` 报 `Refusing to overwrite existing build staging` | 上一次构建保留了未跟踪的 `build/mac-staging/<edition>` 或 `dist/mac/<edition>` | 确认无误后手动清理旧目录，或传 `--reuse-staging` 复用已校验的 staging |
| 打包报 `Missing packaged runtime dependencies` | 未使用推荐 pnpm 版本导致 `pnpm-lock.yaml` 解析异常 | 切换至 `pnpm@7.33.7` 后重新 `pnpm install` 打包 |

---

> **关联专题**：
> - [03. 知识库、语音与 AI 检索管道](./03-knowledge-and-ai-pipeline.md)
> - [04. 报告导出、自动化与 Agent Hub](./04-reports-automation-hub.md)
> - [05. Local HTTP API、扩展中心与外围服务](./05-http-api-and-extensions.md)
> - [09. 全仓文件、符号、通道与配置总索引](./09-symbol-and-file-index.md)
