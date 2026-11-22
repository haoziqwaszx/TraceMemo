# TraceMemo 架构知识库总览

> **源码基线**：Git commit `9efb8ac`（`package.json` 版本 `2.7.0`，`pnpm@7.33.7`）<br>
> **总览入口**：[根目录 AGENTS.md](../../AGENTS.md) · [文档首页](../README.md) · [贡献指南](../../CONTRIBUTING.md)

本目录承载 TraceMemo 全仓源码级别的系统化架构知识库，旨在让后续维护者与外部 AI 仅凭知识库与根目录入口即可准确理解系统拓扑、模块边界、数据流向、符号索引及日常开发/测试/打包规范。

---

## 一、五大核心内容维度

知识库每篇专题文档均严格遵循以下**五大维度**编写，且所有文件路径、导出符号、行号与参数均经基线 `9efb8ac` 源码实读核验：

| 维度 | 核心内容与覆盖要求 | 读者收益 |
|---|---|---|
| **1. 架构总览** | 子系统在全局中的定位、进程/线程拓扑图、技术栈与关键规模统计 | 快速建立全局心智模型与上下文边界 |
| **2. 模块职责与边界** | 目录树划分、核心模块职责、外部依赖隔离与明确禁止跨越的边界 | 修改代码前精准定位归属目录，不越界写错层 |
| **3. 核心数据流与设计思路** | 端到端时序链路、安全/降级/并发/防回环等关键权衡与底层原理 | 理解“为什么这样设计”，避免破坏隐含约束 |
| **4. 关键文件与符号索引** | 相对仓库根的标准路径、核心类/函数/常量/IPC 通道/配置键名对照表 | 秒级直达目标源码与关键函数入口 |
| **5. 后续维护与开发指南** | 日常验证命令、新增能力的标准联动清单、常见排障与已知历史遗留 | 零踩坑开展迭代、重构与故障排查 |

---

## 二、专题模块导航表

| 编号 | 专题文档 | 覆盖仓库源码范围 | 核心要点摘要 |
|---:|---|---|---|
| 01 | [01. 系统架构总览](./01-system-overview.md) | 根目录配置、`electron.vite.config.ts`、`src/`、`packages/`、`services/` | Electron 43 + React 19 四层边界、6 个构建入口、多进程/Worker 拓扑、根目录遗留 `index.js`/`index.html` 澄清 |
| 02 | [02. 主进程生命周期与核心数据访问](./02-main-process-and-data.md) | `src/main/`（174 文件）、`wcdb4-client.ts`、密钥与图片解密服务 | 启停与托盘、`safeStorage` 与 `WechatExplorer` 跨身份迁移、Koffi WCDB4/Junction 桥/`tm-wcdb-config-helper`、Win/Mac 密钥与图片双层缓存 |
| 03 | [03. 知识库、语音与 AI 检索管道](./03-knowledge-and-ai-pipeline.md) | `src/main/knowledge/`（9 文件）、`src/main/voice-pipeline/`（17 文件）、OCR 与 AI 检索服务 | SQLite FTS5 Worker、系统 OCR 分段调度、SenseVoice ONNX 语音管线、`AiSearchPipelineService` 与 `QueryAgentService` 双引擎及 POC |
| 04 | [04. 报告导出、自动化与 Agent Hub](./04-reports-automation-hub.md) | 导出/群日报/模板、退群监控、自动化、发送网关与 `wechat-ilink/`（13 文件） | 增量 HTML 归档、4 层模板沙箱、`tm-wcdb-config-helper` 写隔离、4 重防回环自动化、双通道发送网关与 `AgentHubService` |
| 05 | [05. Local HTTP API、扩展中心与外围服务](./05-http-api-and-extensions.md) | `src/main/http-server.ts`、`packages/extension-sdk/`、`src/main/extensions/`（21 文件）、`examples/`、`services/share-card-worker/` | `127.0.0.1:6131` 鉴权与 39 条路径模式 / 47 组方法+路径、扩展子进程与 `tm` API、模板锁与 Cloudflare Share Card Worker |
| 06 | [06. 渲染层、共享契约与 IPC 通道](./06-renderer-and-ipc.md) | `src/renderer/`（272 文件）、`src/shared/`（75 文件）、`src/preload/`（2 文件） | 10 大一级工作区、React State 路由与深链、零直接 `fetch()`、Tailwind + SCSS 双轨样式、240 invoke + 17 push 全量通道对照与已知类型偏差 |
| 07 | [07. 构建脚本与打包分发](./07-build-scripts-and-packaging.md) | `scripts/`（21 脚本，含 `scripts/check-knowledge-base.mjs` + `create_tag.sh`）、`resources/`、`build/`、`public/` | `electron-builder*.yml` 三套配置、macOS `public`/`native` 双版隔离、`after-pack.cjs` 裁剪与 ad-hoc 签名、扩展模板锁与 Skill 防漂移 |
| 08 | [08. 测试体系与质量门禁](./08-testing-and-quality-gates.md) | `tests/`（300 文件）、`vitest.*.config.ts`、`playwright.config.ts`、`.github/workflows/test.yml` | 6 层测试体系、`electron-main.cjs` E2E 确定性替身、平台与 OCR 分级门控、TS 测试基线棘轮（203 错误上限）与知识库校验门禁 |
| 09 | [09. 全仓文件、符号、通道与配置总索引](./09-symbol-and-file-index.md) | 全仓一级/二级目录、`src/`、`packages/`、`scripts/`、`services/`、`examples/`、`tests/` | 全仓文件计数、核心导出符号行号、241+17 IPC 通道、39 条路径模式 / 47 组方法+路径 Local HTTP 端点、55+ 环境变量与已核实源码细节偏差总览 |

---

## 三、推荐阅读路径

- **新 AI / 架构全局速览**：[AGENTS.md](../../AGENTS.md) → [01. 系统架构总览](./01-system-overview.md) → 按需速查 [09. 全仓文件、符号、通道与配置总索引](./09-symbol-and-file-index.md)。
- **主进程数据与底层排障**：[02. 主进程生命周期与核心数据访问](./02-main-process-and-data.md) → [07. 构建脚本与打包分发](./07-build-scripts-and-packaging.md)（重点看 `resources/` 与 `native-runtime-paths.ts`）。
- **AI 检索、语音转写与知识库**：[03. 知识库、语音与 AI 检索管道](./03-knowledge-and-ai-pipeline.md) → [02. 主进程生命周期与核心数据访问](./02-main-process-and-data.md)。
- **群日报、自动化与微信发送**：[04. 报告导出、自动化与 Agent Hub](./04-reports-automation-hub.md) → [05. Local HTTP API、扩展中心与外围服务](./05-http-api-and-extensions.md)。
- **外部 Agent 接入与扩展开发**：[05. Local HTTP API、扩展中心与外围服务](./05-http-api-and-extensions.md) → [09. 全仓文件、符号、通道与配置总索引](./09-symbol-and-file-index.md)。
- **前端界面与跨进程联调**：[06. 渲染层、共享契约与 IPC 通道](./06-renderer-and-ipc.md) → [08. 测试体系与质量门禁](./08-testing-and-quality-gates.md)（重点看 `preload-contract` 与 E2E 替身）。
- **打包发布与 CI 门禁维护**：[07. 构建脚本与打包分发](./07-build-scripts-and-packaging.md) → [08. 测试体系与质量门禁](./08-testing-and-quality-gates.md)。

---

## 四、知识库维护与自动化校验约定

1. **路径与链接书写规范**：
   - 仓库内文件与目录引用须使用**相对仓库根的正斜杠路径**并用反引号包裹（例如 `` `src/main/wcdb4-client.ts:939` ``、`` `src/main/extensions/` ``，目录以 `/` 结尾）。
   - 知识库文档间交叉引用须使用标准 Markdown 相对链接 `[标题](./01-system-overview.md#1-架构总览)`。
2. **禁止擅自改动的冻结契约**：
   - `docs/skill/tracememo-reader/SKILL.md` 受 `pnpm check:skill-version` 门禁保护，非同步发布 Skill 版本严禁修改。
   - `examples/extensions/` 模板受 `examples/extensions/template-lock.json` 与 `node scripts/build-extension-templates.cjs --check` 保护。
3. **提交前自动化校验**：
   ```bash
   node scripts/check-knowledge-base.mjs
   node scripts/check-knowledge-base.mjs --json
   ```
   校验通过标准为 **0 断链、0 无效仓库路径，退出码 `0`**。
