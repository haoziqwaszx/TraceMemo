# 08 · 六层测试体系与质量门禁架构

> **源码基线**：Git commit `9efb8ac`（`package.json` `v2.7.0`）<br>
> **相关文档**：[知识库总览](./README.md) · [系统整体架构](./01-system-overview.md) · [主进程与数据存储](./02-main-process-and-data.md) · [渲染层与 IPC 契约](./06-renderer-and-ipc.md) · [构建脚本与打包体系](./07-build-scripts-and-packaging.md)

---

## 一、架构总览

TraceMemo 在 `tests/` 目录下构建了覆盖 **300 个文件**（284 个测试文件 + 16 个夹具/支撑/基线/截图文件）的 **6 层自动化测试体系**，并与静态类型棘轮、代码规范、Skill 防漂移、扩展模板锁与知识库引用校验门禁共同组成全流程质量防线。核心设计原则是：**把不依赖微信客户端和私有数据的验证全部前置到快速、确定性的 CI 流水线中；把强依赖本机 OS 语言包、真实数据库或 100 万级压测的用例通过环境变量与平台门控（Gate）精准隔离**。

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                    静态与工程契约门禁 (秒级阻断)                          │
│  CI 必跑: pnpm typecheck (node/web + TS 棘轮) · pnpm check:skill-version │
│  仅本地门禁 (未接入 .github/workflows/test.yml):                         │
│    - pnpm lint (ESLint+Prettier)                                        │
│    - node scripts/build-extension-templates.cjs --check                 │
│    - node scripts/check-knowledge-base.mjs (文档路径/链接/锚点校验)       │
└────────────────────────────────────┬────────────────────────────────────┘
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Vitest 三层核心测试 + 独立脚本检查                     │
│  1. Unit (162)        node 环境 · 纯函数/状态机/打包门禁脚本单测          │
│  2. Component (74+2)  jsdom + RTL · 渲染层组件与 Hooks 回归              │
│  3. Integration (36)  node 环境 · Preload 契约/HTTP API/扩展/OCR 集成    │
│  4. Script Gates      test:skill-install (CI) · test:knowledge-worker (仅本地) │
└────────────────────────────────────┬────────────────────────────────────┘
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                 Playwright Electron E2E & Visual (8+4)                  │
│  - 加载真实构建产物 out/preload/index.js + out/renderer/index.html       │
│  - 主进程使用 tests/e2e/support/electron-main.cjs 确定性替身             │
│  - 功能 E2E (--grep-invert @visual) + 平台截图回归 (visual.spec.ts)      │
└────────────────────────────────────┬────────────────────────────────────┘
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              本地重负载与真机验收 (Opt-in / 手工 Gate)                   │
│  5. Benchmark (3)     20 分钟超时 · 检索质量评测 & 100w 容量压测         │
│  6. Smoke (1)         node --test · 真机 WCDB 数据目录与手工清单          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.1 `tests/` 全量分层盘点（实测 300 文件）

| 层级 / 目录 | 文件总数 | 测试文件 | 支撑 / 夹具 / 产物 | 框架与配置文件 | 触发命令 & CI 状态 |
|---|---|---|---|---|---|
| **1. Unit** (`tests/unit/`) | 162 | 162 (`*.test.ts`) | 0 | Vitest (`vitest.unit.config.ts`) | `pnpm test:unit`（CI 必跑） |
| **2. Component** (`tests/component/`) | 76 | 74 (`*.test.tsx`) | 2（`support/` 夹具与桩） | Vitest + jsdom (`vitest.component.config.ts`) | `pnpm test:component`（CI 必跑） |
| **3. Integration** (`tests/integration/`) | 36 | 36 (`*.test.ts`) | 0 | Vitest (`vitest.integration.config.ts`) | `pnpm test:integration`（CI 必跑） |
| **4. E2E & Visual** (`tests/e2e/`) | 12 | 8 (`*.spec.ts`) | 4（2 个 `support/` + 2 张 `win32` PNG） | Playwright (`playwright.config.ts`) | `pnpm test:e2e`（CI 必跑） / `pnpm test:visual`（CI 仅非 Windows） |
| **5. Benchmark** (`tests/benchmark/`) | 3 | 3 (`*.test.ts`) | 0 | Vitest (`vitest.knowledge-benchmark.config.ts`) | `pnpm benchmark:knowledge` / `pnpm benchmark:knowledge:capacity`（手动） |
| **6. Smoke** (`tests/smoke/`) | 1 | 1 (`native-environment.test.mjs`) | 0 | `node --test` | `pnpm test:smoke`（`WXE_REAL_DATA_SMOKE=1` 触发） |
| **支撑与基线** | 10 | 0 | 10（`tests/fixtures/` 8 + `tests/setup/component.ts` 1 + `tests/typecheck-baseline.json` 1） | — | 被上述各层直接引用 |

---

## 二、模块职责与边界

### 2.1 Vitest 四套独立配置边界

1. **`vitest.unit.config.ts`（Node 单元测试）**：
   - `environment: 'node'`、`clearMocks: true`、`restoreMocks: true`，配置 `@renderer` → `src/renderer/src`。
   - 覆盖领域：纯算法与工具函数、消息解析、自动化匹配/防回环、迁移与安全存储、AI Search 与 Query Agent 逻辑，以及构建打包门禁（如 `tests/unit/runtime-packaging.test.ts`、`tests/unit/after-pack-signing.test.ts`、`tests/unit/after-pack-electron-arch.test.ts`、`tests/unit/ensure-electron-binary.test.ts`）。
2. **`vitest.component.config.ts`（React 19 组件测试）**：
   - `environment: 'jsdom'`，启用 `@vitejs/plugin-react`，挂载 `setupFiles: ['tests/setup/component.ts']`。
   - `tests/setup/component.ts`（58 行）统一注入：
     - `@testing-library/jest-dom/vitest` 断言扩展与 `afterEach(() => cleanup())`；
     - Radix UI / 列表组件所需的 `HTMLElement.prototype.{hasPointerCapture,releasePointerCapture,setPointerCapture,scrollIntoView}` 空实现；
     - 独立内存版 `localStorage` 与 `sessionStorage`；
     - `URL.createObjectURL`（固定返回 `'blob:wxe-test-audio'`）与 `URL.revokeObjectURL` spy。
   - `tests/component/support/` 提供 `ai-search-fixtures.ts` 与 `image-text-index-api.ts` 两个复用测试辅助模块。
3. **`vitest.integration.config.ts`（跨模块集成测试）**：
   - `environment: 'node'`、`clearMocks: true`、`restoreMocks: true`。
   - 核心守卫包括：
     - `tests/integration/preload-contract.test.ts`：Mock Electron `contextBridge`/`ipcRenderer` 验证 `src/preload/index.ts` 暴露的 `window.api` 与主进程通道名、参数完全对齐；
     - `tests/integration/local-api-auth.test.ts`、`tests/integration/local-agent-api.test.ts`、`tests/integration/wechat-send-api.test.ts`：验证 Local HTTP Server 鉴权与路由边界；
     - `tests/integration/extension-templates-packaged.test.ts`、`tests/integration/extension-lifecycle.test.ts`、`tests/integration/extension-automation.test.ts`：验证扩展宿主、模板安装与自动化桥接；
     - `tests/integration/system-ocr-windows.test.ts` 与 `tests/integration/system-ocr-macos.test.ts`：平台原生 OCR 能力门控测试。
4. **`vitest.knowledge-benchmark.config.ts`（知识检索基准测试）**：
   - `environment: 'node'`、`fileParallelism: false`、`testTimeout: 20 * 60 * 1000`（20 分钟）。
   - `tests/benchmark/knowledge-benchmark.test.ts` 与 `tests/benchmark/knowledge-realistic-fts.benchmark.test.ts` 评测 Recall@5/10、MRR、证据准确率与 P50/P95 延迟；`tests/benchmark/knowledge-capacity.benchmark.test.ts` 压测 `100k` / `500k` / `1m` 消息规模下的存储与内存峰值（受 `KNOWLEDGE_CAPACITY=1` 门控）。

### 2.2 Playwright Electron E2E 与视觉回归边界

- **`playwright.config.ts`（22 行）**：
  - `testDir: './tests/e2e'`、`timeout: 45_000`、`expect: { timeout: 8_000 }`、`fullyParallel: false`、`workers: 1`（串行避免 Electron 窗口与用户目录抢占）。
  - `forbidOnly: Boolean(process.env.CI)`、`retries: process.env.CI ? 1 : 0`。
  - `snapshotPathTemplate: 'tests/e2e/__screenshots__/{platform}/{testFilePath}/{arg}{ext}'`：按 `process.platform`（如 `win32`/`darwin`）分别管理截图基线。
  - 失败诊断：`trace: 'retain-on-failure'`、`screenshot: 'only-on-failure'`、`video: 'retain-on-failure'`，输出到未跟踪的 `test-results/` 与 `playwright-report/`。
- **8 个 E2E 用例文件覆盖域**：
  - `tests/e2e/app.spec.ts`：首次启动、密钥校验与引导连接全流程；
  - `tests/e2e/export-archive.spec.ts`：聊天记录导出静态 HTML 归档交互与多视口测试；
  - `tests/e2e/scheduled-reports.spec.ts`：定时日报编辑器表单校验与状态联动；
  - `tests/e2e/report-template-fragment-contract.spec.ts`、`tests/e2e/report-template-market.spec.ts`、`tests/e2e/report-template-market-tab.spec.ts`、`tests/e2e/report-template-render.spec.ts`：日报模板片段契约、社区市场与渲染；
  - `tests/e2e/visual.spec.ts`：带 `@visual` 标签的像素级截图回归集。

### 2.3 脱敏夹具与跨测试门禁脚本

- **`tests/fixtures/`（8 文件）**：
  - `tests/fixtures/chat-data.json`：E2E 替身使用的脱敏会话与消息集；
  - `tests/fixtures/knowledge-rag.ts`、`tests/fixtures/knowledge-realistic.ts`：知识库 RAG 与仿真 FTS 基准合成数据集；
  - `tests/fixtures/report-template-production-fragments.json`：日报模板生产级片段契约样本；
  - `tests/fixtures/ocr/`（`system-ocr-en.png`、`system-ocr-mixed.jpg`、`system-ocr-mixed.png`、`system-ocr-zh.png`）：完全合成的中英混排 OCR 图像。
- **独立门禁脚本（不走 Vitest/Playwright）**：
  - `scripts/test-skill-install-instruction.cjs`（`pnpm test:skill-install`）：使用 `typescript.transpileModule` 转译渲染层 `src/renderer/src/features/api-center/utils/buildSkillInstallInstruction.ts`，验证 `codex` / `claude-code` / `openclaw` / `generic` 生成的指令均含 `/api/v1/health`、`TRACEMEMO_API_TOKEN`、`skill.version` 且不含 `mcpServers`。
  - `scripts/test-knowledge-worker.cjs`（`pnpm test:knowledge-worker`）：先构建后以 `ELECTRON_RUN_AS_NODE=1` fork 真实编译后的 `knowledgeWorker`，验证多账号 SQLite 隔离、索引、证据返回与移除。
  - `scripts/check-skill-version-drift.cjs`（`pnpm check:skill-version`）：防止 `docs/skill/tracememo-reader/SKILL.md` 内容变动但未升 `version`（详见 [构建脚本与打包体系](./07-build-scripts-and-packaging.md)）。
  - `scripts/check-knowledge-base.mjs`：**知识库引用与断链检查门禁**。使用命令 `node scripts/check-knowledge-base.mjs`（零第三方依赖纯 Node ESM），默认扫描根目录入口、说明文档与 `docs/` 下全部 `.md`（默认排除 `docs/skill/`，可用 `--include-skills` 纳入），逐一校验 Markdown 相对链接、GitHub 风格 `#heading-slug` 与 `#L行号` 锚点，以及反引号包裹的仓库源路径与目录，确保 **0 断链、0 无效路径**（支持 `--json` 结构化输出与指定文件/目录增量校验）。

---

## 三、核心数据流与设计思路

### 3.1 E2E 确定性替身架构（`electron.ts` + `electron-main.cjs`）

```text
Playwright Test (*.spec.ts)
  │  launchTestApp({ mode, now, appearanceTheme, templateMarket, ... })
  ▼
tests/e2e/support/electron.ts
  │  1. 创建隔离临时 userData (mkdtempSync) 或复用 stableUserData
  │  2. 注入 WXE_E2E_* 环境变量
  │  3. _electron.launch({ args: ['tests/e2e/support/electron-main.cjs'] })
  ▼
tests/e2e/support/electron-main.cjs (1634 行主进程替身)
  │  1. 加载 tests/fixtures/chat-data.json 并按 WXE_E2E_NOW_MS 平移消息时间戳
  │  2. 注册完整 ipcMain.handle(...) 桩矩阵（模拟连接/搜索/日报/自动化/更新等）
  │  3. 创建固定 1400×800 BrowserWindow
  │     ├─ preload: out/preload/index.js (真实构建产物)
  │     └─ renderer: out/renderer/index.html (真实构建产物)
  ▼
Playwright page 断言 & fixture.close() 清理临时目录
```

- **真实前端 + 可控后端替身**：E2E 启动前必须运行 `pnpm test:e2e:build`（即 `electron-vite build`）。替身进程不运行 `src/main/index.ts`（从而彻底摆脱本地微信客户端、WCDB 原生库和个人聊天数据），但**真实加载 `out/preload/index.js` 与 `out/renderer/index.html`**（`tests/e2e/support/electron-main.cjs:1624` 与 `tests/e2e/support/electron-main.cjs:1631`），确保 React 19 UI、Preload `contextBridge` 序列化和 IPC 通道名完全走真链。
- **固定 `1400×800` 窗口的工程取舍**：`electron-main.cjs:1615-1620` 注释明确指出，生产代码 `createWindow()` 已改为按工作区 60% 计算窗口尺寸，但 E2E 故意固定 `1400×800`，避免因 CI Runner 屏幕分辨率波动导致 `@visual` 截图尺寸失配。
- **时间确定性对齐**：`launchTestApp({ now })` 一方面通过 `WXE_E2E_NOW_MS` 让替身主进程把 `tests/fixtures/chat-data.json` 里的历史消息时间戳平移到 `now - 3600s` 附近（`electron-main.cjs:31-37`），另一方面调用 `page.clock.setFixedTime(options.now)` 冻结渲染层时钟，消除跨天/时区引起的断言抖动。
- **可控故障与边缘场景注入**：替身通过环境变量支持多种场景切换：
  - `WXE_E2E_MODE=disconnected`：模拟未连接状态引导登录流；
  - `WXE_E2E_AI_FAILURE`：触发 AI 搜索失败分支；
  - `WXE_E2E_UPDATE_SIMULATION` / `WXE_E2E_UNSIGNED_MAC_UPDATE`：模拟自动更新下载进度推送与 macOS 未签名更新提示；
  - `WXE_E2E_LARGE_CONTACTS` / `WXE_E2E_REALTIME_REORDER`：构造大规模联系人列表与实时重排测试样本；
  - `WXE_E2E_TEMPLATE_MARKET=fixture`：返回确定性社区日报模板目录；
  - `WXE_E2E_CLOSE_DELAY_MS`：本地调试默认 `2000ms` 延迟关窗便于肉眼观察，CI 环境统一设为 `0`。

### 3.2 平台与能力门控（Platform & Capability Gates）

为防止环境缺失造成 CI 误报或掩盖真机问题，测试套件设计了多级显式门控：

1. **视觉基线目录门控（`tests/e2e/visual.spec.ts:15-18`）**：
   - 检查 `tests/e2e/__screenshots__/` 下对应平台子目录（模式 “tests/e2e/__screenshots__/${process.platform}/visual.spec.ts”）是否存在且非 `WXE_UPDATE_VISUAL_BASELINES === '1'`。当前仓库仅提交了 `tests/e2e/__screenshots__/win32/visual.spec.ts/` 下的 `archive-page.png` 与 `login-page.png`（2 张）；若在其他平台未准备基线则跳过。
   - 此外，`CHAT-02`（个人微信发送弹窗视觉测试）在 `tests/e2e/visual.spec.ts:451` 额外门控 `process.platform === 'darwin'`。
2. **平台功能门控**：
   - `tests/e2e/app.spec.ts:55`（`P0-01` 手动编辑数据库目录）仅在 `win32` 运行；
   - `tests/e2e/scheduled-reports.spec.ts:34-37` 与 `tests/e2e/scheduled-reports.spec.ts:152-155`（定时日报发送能力）仅在 `darwin` 与 `win32` 运行；
   - `tests/e2e/export-archive.spec.ts:433`（`EXPORT-ARCHIVE-04`）因无头 Electron 滚动锚点对环境敏感，当前显式 `test.skip` 隔离。
3. **系统 OCR 能力分层门控**：
   - Windows（`tests/integration/system-ocr-windows.test.ts:39-52`）：划分三级门控——`platformGate`（仅 `win32`）、`nativeGate`（`win32` 且 `capability.available`）、`nativeChineseGate`（额外校验 `/^zh/i.test(capability.language ?? '')`）。由于 GitHub Windows Runner 默认仅装 `en-US` 语言包，中文识别用例在缺包环境下自动跳过，英文与 JPEG→PNG 归一化断言照常强制通过。
   - macOS（`tests/integration/system-ocr-macos.test.ts:39-42`）：Apple Vision 无语言包缺失问题，只需 `onMac && capability.available`，同时通过 `ffmpegResolver` spy 反向断言 macOS 路径绝不触发图片转码归一化。
4. **Opt-in 压测与真机冒烟门控**：
   - `tests/benchmark/knowledge-capacity.benchmark.test.ts:11-12` 仅在 `KNOWLEDGE_CAPACITY=1` 时执行百万级压测；
   - `tests/smoke/native-environment.test.mjs` 仅在 `WXE_REAL_DATA_SMOKE=1` 且提供 `WXE_SMOKE_DB_ROOT` 时校验真机 WCDB 目录（其第 18、22 行手工检查项 skip 文案指向 `docs/architecture/08-testing-and-quality-gates.md`）。

### 3.3 TypeScript 双轨类型检查与基线棘轮机制

TraceMemo 将生产源码与测试源码拆分为两条类型检查轨道（由 `pnpm typecheck` 串联执行）：

1. **生产代码零容忍轨道**：
   - `pnpm typecheck:node` → `tsc --noEmit -p tsconfig.node.json --composite false`（覆盖 `electron.vite.config.*`、`src/main/**/*`、`src/preload/**/*`、`src/shared/**/*`、`src/env.d.ts`）。
   - `pnpm typecheck:web` → `tsc --noEmit -p tsconfig.web.json --composite false`（覆盖 `src/renderer/src/**/*`、`src/preload/*.d.ts`、`src/shared/**/*`）。
   - 任何错误直接退出码 `1` 阻断构建与 CI。
2. **测试代码按文件基线棘轮（`scripts/typecheck-tests.cjs` + `tests/typecheck-baseline.json`）**：
   - `tsconfig.test.json` 继承 `tsconfig.web.json`，纳入 `tests/**/*.ts`、`tests/**/*.tsx`、`src/**/*.d.ts`、4 份 `vitest.*.config.ts` 与 `playwright.config.ts`。
   - **按“文件 → 错误数”锁死上限**：`tests/typecheck-baseline.json` 当前记录 `total: 203` 个历史遗留错误（分布于 44 个测试/支撑文件中）。脚本执行 `tsc --noEmit --pretty false -p tsconfig.test.json` 后逐文件对比：
     - **禁止抵消**：即使某天修复了 A 文件的 5 个错误，只要 B 文件新增了 1 个错误，或新增了一个带类型错误的测试文件，检查立即返回退出码 `1`；
     - **单向收紧**：当现有测试错误被修复减少时，提示运行 `node scripts/typecheck-tests.cjs --update` 下调基线，不允许逆向放宽。

### 3.4 `.github/workflows/test.yml` 双平台 CI 流水线

CI 工作流（79 行）在每次 `push` 与 `pull_request` 触发单个 `desktop-tests` Job，采用 `fail-fast: false` 的双系统矩阵 `[windows-latest, macos-latest]`：

1. **Checkout & 环境**：`actions/checkout@v4` 显式配置 **`fetch-depth: 0`**（L19-20，确保 `pnpm check:skill-version` 能读取到 `origin/main` 等基准分支）；安装 `pnpm@7.33.7` 与 Node `22`，随后执行 `pnpm install` 与 `pnpm exec playwright install chromium`。
2. **串行质量门禁链**：
   - `pnpm typecheck`（`typecheck:node` + `typecheck:web` + `typecheck:test`）
   - `pnpm test:unit`
   - `pnpm test:component`
   - `pnpm test:integration`
   - `pnpm test:skill-install`
   - `pnpm check:skill-version`
   - `pnpm test:e2e:build`
   - `pnpm exec playwright test --grep-invert="@visual"`（`WXE_E2E_CLOSE_DELAY_MS=0`）
   - `pnpm exec playwright test tests/e2e/visual.spec.ts`（带条件 `if: matrix.os != 'windows-latest'`：注释说明 GitHub 托管 Windows Runner 无法稳定容纳 `1400×800` 窗口，Windows 视觉回归改由可控桌面环境执行）。
3. **诊断归档**：无论成败（`if: always()`）上传 `test-results/` 与 `playwright-report/`，保留 `14` 天。

---

## 四、关键文件与符号索引

### 4.1 测试配置、CI 与代码规范文件

| 文件路径 | 核心职责与关键配置 |
|---|---|
| `vitest.unit.config.ts` | `unit` 项目配置：`environment: 'node'`、`tests/unit/**/*.test.ts`、`@renderer` 别名 |
| `vitest.component.config.ts` | `component` 项目配置：`environment: 'jsdom'`、React 插件、`setupFiles: ['tests/setup/component.ts']` |
| `vitest.integration.config.ts` | `integration` 项目配置：`environment: 'node'`、`tests/integration/**/*.test.ts` |
| `vitest.knowledge-benchmark.config.ts` | `knowledge-benchmark` 配置：`fileParallelism: false`、`testTimeout: 1_200_000` |
| `playwright.config.ts` | E2E 配置：`workers: 1`、`timeout: 45_000`、`snapshotPathTemplate`、失败保留 trace/video/screenshot |
| `tsconfig.json` / `tsconfig.node.json` / `tsconfig.web.json` | 生产代码 TS Solution 与主进程/渲染层编译边界 |
| `tsconfig.test.json` | 测试代码 TS 检查范围配置 |
| `tests/typecheck-baseline.json` | 测试类型错误棘轮基线（`total: 203`，44 个文件） |
| `eslint.config.mjs` | ESLint 9 Flat Config（TS + React + React Hooks + React Refresh + Prettier，对 `examples/` 下的 `.js`/`.mjs` 示例放宽返回类型与 `require` 规则） |
| `.github/workflows/test.yml` | GitHub Actions 双端 CI 流水线定义 |

### 4.2 测试支撑、夹具与门禁脚本

| 文件路径 | 核心符号 / 能力说明 |
|---|---|
| `tests/setup/component.ts` | `createMemoryStorage`、DOM pointer/scroll polyfill、`URL.createObjectURL` mock、`afterEach(cleanup)` |
| `tests/e2e/support/electron.ts` | `launchTestApp(options)`、`TestApplication` 接口、`WXE_E2E_*` 环境变量封装 |
| `tests/e2e/support/electron-main.cjs` | E2E 主进程替身（`formatFixtureDateTime`、`aiSearchResult`、`handle`、`1400×800` 固定窗口） |
| `tests/integration/preload-contract.test.ts` | `loadApi()` 验证 `window.api` 与主进程 IPC 通道参数契约 |
| `tests/integration/system-ocr-windows.test.ts` | `platformGate` / `nativeGate` / `nativeChineseGate` 分级门控 |
| `tests/integration/system-ocr-macos.test.ts` | `platformGate` / `nativeGate` 与 `ffmpegResolver` 零归一化验证 |
| `tests/smoke/native-environment.test.mjs` | `WXE_REAL_DATA_SMOKE=1` + `WXE_SMOKE_DB_ROOT` 真机目录冒烟测试 |
| `tests/fixtures/chat-data.json` | E2E 脱敏群聊/私聊数据夹具 |
| `tests/fixtures/knowledge-rag.ts` / `tests/fixtures/knowledge-realistic.ts` | RAG 与仿真 FTS 基准生成夹具 |
| `tests/fixtures/report-template-production-fragments.json` | 日报模板片段结构契约夹具 |
| `scripts/typecheck-tests.cjs` | `runTypeScript`、`collectErrors`、`readBaseline`、`--update` 基线更新 |
| `scripts/test-skill-install-instruction.cjs` | 验证 `buildSkillInstallInstruction.ts` 四端安装指令 |
| `scripts/check-skill-version-drift.cjs` | `resolveBase`、`versionOf`、`SKILL_PATH` 版本防漂移检查 |
| `scripts/test-knowledge-worker.cjs` | 编译后 `knowledgeWorker` 隔离库真进程冒烟脚本 |
| `scripts/check-knowledge-base.mjs` | 知识库文档相对链接、锚点与仓库反引号路径自动化校验脚本 |

---

## 五、后续维护与开发指南

### 5.1 日常开发与提交前标准自检命令

```bash
# 代码格式化与静态规范检查（仅本地门禁，未接入 .github/workflows/test.yml）
pnpm format
pnpm lint

# 全量类型检查（含 node / web 与测试棘轮，CI 必跑）
pnpm typecheck

# 核心三层自动化测试 + 契约与文档校验
pnpm test:unit
pnpm test:component
pnpm test:integration
pnpm test:skill-install
pnpm check:skill-version
node scripts/build-extension-templates.cjs --check   # 仅本地门禁，未接入 CI
node scripts/check-knowledge-base.mjs                # 仅本地门禁，未接入 CI
pnpm test:knowledge-worker                           # 仅本地门禁，未接入 CI

# 完整 E2E（或本地运行含构建的一键全套测试）
pnpm test:e2e
pnpm test
```

### 5.2 新增测试用例选层指南

- **纯逻辑、数据转换、协议解析、打包脚本函数**：放入 `tests/unit/*.test.ts`（毫秒级反馈，禁止依赖 Electron 窗口或真实文件系统用户目录）。
- **React 组件交互、Hooks 状态流、无障碍角色断言**：放入 `tests/component/*.test.tsx`，通过 mock `window.api` 验证交互与错误恢复。
- **多服务串联、Local HTTP API 鉴权、Preload 通道契约、扩展生命周期**：放入 `tests/integration/*.test.ts`。凡新增或修改 `src/preload/index.ts` 方法，**务必同步更新 `tests/integration/preload-contract.test.ts`**。
- **端到端页面流转、路由深链、布局防横向溢出**：放入 `tests/e2e/*.spec.ts`，若引入新 IPC 通道，必须在 `tests/e2e/support/electron-main.cjs` 补齐对应的 `handle(...)` 桩实现，避免界面卡死在未处理 IPC 调用上。

### 5.3 收紧 TS 基线与更新视觉截图规范

- **下调 `tests/typecheck-baseline.json`**：每当顺手清理测试文件里的 TypeScript 历史类型错误后，运行 `node scripts/typecheck-tests.cjs --update` 提交更新后的基线；严禁为绕过校验而临时调高错误数。
- **更新 `@visual` 截图基线**：仅当 UI 布局或主题有预期变更时，在目标桌面平台运行：
  ```bash
  pnpm test:e2e:build
  WXE_UPDATE_VISUAL_BASELINES=1 pnpm exec playwright test tests/e2e/visual.spec.ts
  ```
  并将生成的截图人工审阅后提交到 `tests/e2e/__screenshots__/<platform>/visual.spec.ts/`（注意保持 `1400×800` 固定视口与禁用动画参数）。

---

> **关联专题**：
> - [03. 知识库、语音与 AI 检索管道](./03-knowledge-and-ai-pipeline.md)
> - [04. 报告导出、自动化与 Agent Hub](./04-reports-automation-hub.md)
> - [05. Local HTTP API、扩展中心与外围服务](./05-http-api-and-extensions.md)
> - [09. 全仓文件、符号、通道与配置总索引](./09-symbol-and-file-index.md)
