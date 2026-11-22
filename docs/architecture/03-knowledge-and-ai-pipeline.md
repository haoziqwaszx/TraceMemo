# 03. 本地知识库、多模态索引与 AI 检索双引擎

> **源码基线**：`8f47dca`｜**适用范围**：`src/main/knowledge/`（9 文件）、`src/main/voice-pipeline/`（17 文件）、System OCR 与图片文字索引（`src/main/services/system-ocr-service.ts`、`src/main/services/image-text-index-service.ts`、`src/main/services/image-text-index-store.ts`）、本地查询与 AI 检索双引擎（`LocalQueryApiService`、`QueryAgentService`、`AskWechatService`、`AiSearchPipelineService`）以及 CLI POC 链路

---

## 1. 架构总览

TraceMemo 的本地知识库与多模态 AI 检索体系在 `src/main/index.ts:1163-1369` 完成装配，整体遵循**「主进程编排调度 + 独立 Node 子进程承载重计算 + 账号隔离的派生 SQLite 存储 + 结构化边界硬约束」**四项架构原则。所有模块均只读消费 [主进程生命周期与核心数据访问](./02-main-process-and-data.md) 提供的微信源库（`Wcdb4Client`）与解密服务（`ImageDecryptService`），**绝不修改任何微信原始数据库表**，所有派生结果（全文分片、图片 OCR 文本、语音转写文本）均独立落盘于 `<userData>` 下的派生 SQLite 库中。

```text
[微信源层 (只读)] ──> chat-service / Wcdb4Client / ImageDecryptService / VoiceService
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
[Voice SenseVoice 管线]  [Image System OCR 管线]  [Knowledge FTS5 管线]
VoiceRecognitionUseCase  SystemOcrService         KnowledgeSearchService
  ├─ VoiceTaskScheduler    (@napi-rs/system-ocr)    ├─ WCDB 双车道队列 (interactive > background)
  ├─ SilkAudioDecoder      Win: PNG 归一化           ├─ KnowledgeService ──> KnowledgeWorkerHost
  ├─ PcmAudioProcessor     Mac: 原始字节直通          │      │ (ELECTRON_RUN_AS_NODE=1, IPC v1)
  ├─ RecognitionHost     ImageTextIndexService      │      ▼
  │   │ (60s 空闲退出)      ├─ recent-first 分段     │  out/main/knowledgeWorker.js
  │   ▼                    ├─ maxLocalId 增量水位    │  └─ KnowledgeStore (node:sqlite + FTS5 trigram)
  │  out/main/             └─ 单 Writer Store       │      <userData>/knowledge/<key>/knowledge.sqlite
  │  voiceRecognitionWorker    <userData>/          │
  │  (sherpa-onnx-node)        image-text-index/... │
  └─ SqliteTranscriptRepository ─── onTranscriptUpdate ──┘ (会话级快照重索引)
                                └── onConversationIndexed ──┘

                                ▼
                    [本地检索与 AI 检索双引擎]
           LocalQueryApiService (4 Tool + voice-transcribe, Scope 硬强制)
             ├─ 进程内 Tool Executor ──> QueryAgentService (主引擎: 5 次 Tool 上限 + E1..E40)
             │                              ▲
             │                              ├── AskWechatService (desktop / agent-hub)
             │                              │     └─ 仅 runtime_error / tool_limit 且仅 desktop 回退
             │                              │           ▼
             │                              │    AiSearchPipelineService (Legacy: Query Compiler
             │                              │      + runControlledSearchAgent + 确定性兜底)
             └─ HTTP 127.0.0.1:6131 (/api/v1/query/*) <── POC: scripts/run-query-agent-poc.cjs
```

### 核心子域与代码分布

| 子域 | 核心源码位置 | 运行进程 / 线程 | 持久化产物（均按账号隔离） |
|---|---|---|---|
| **Knowledge FTS5 索引** | `src/main/knowledge/`（9 文件）+ `src/shared/knowledge.ts` + `scripts/test-knowledge-worker.cjs` | 主进程编排 + 独立 Node 子进程 `knowledgeWorker` | `<userData>/knowledge/<sha256前32位>/knowledge.sqlite` |
| **System OCR 与图片索引** | `src/main/services/system-ocr-service.ts`、`src/main/services/image-text-index-service.ts`、`src/main/services/image-text-index-store.ts`、`src/shared/system-ocr.ts`、`src/shared/image-text-index.ts` | 主进程（`prepare` 同步 + `@napi-rs/system-ocr` libuv 线程池异步 + 单 Writer） | `<userData>/image-text-index/<sha256前32位>/image-text-index.sqlite` |
| **Voice SenseVoice 管线** | `src/main/voice-pipeline/`（17 文件）+ `src/shared/voice-recognition.ts` | 主进程解码/预处理 + 独立 Node 子进程 `voiceRecognitionWorker` | `<userData>/cache/voice-transcripts.sqlite` + `<userData>/models/sensevoice-small-int8/` |
| **AI 检索双引擎与 POC** | `src/main/services/local-query-api-service.ts`、`query-agent-service.ts`、`ask-wechat-service.ts`、`query-agent-conversation-memory.ts`、`ai-search-pipeline-service.ts`、`ai-search-agent.ts`、`ai-search-evidence.ts`、`src/shared/query-agent.ts`、`src/shared/local-query-api.ts`、`scripts/run-query-agent-poc.cjs`、`src/main/query-agent-poc-*.ts` | 主进程（及通过 HTTP API 调度的 CLI POC 独立 Electron 进程） | 无独立业务库；内存态有界澄清上下文 `QueryAgentConversationMemory` |

---

## 2. 模块职责与边界

| 模块 / 服务 | 做什么（职责范围） | 明确不做什么（严禁越界的红线） |
|---|---|---|
| **消息身份唯一真源** (`src/main/knowledge/message-identity.ts`) | 定义 `sourceMessageId(message)`（按 `local:<localId>` → `id` → `createTime:serverId/content` 归一化），供 Knowledge 写入、Image OCR binding、Evidence 跳转共同消费。 | 任何下游模块不得各自复制实现一套 ID 生成逻辑，以免在 `local:` 前缀上出现静默失配。 |
| **Knowledge FTS5 Worker** (`src/main/knowledge/`) | 主进程 `KnowledgeSearchService` 读取只读 WCDB 消息与语音/OCR 派生文本，通过 `KnowledgeWorkerHost` 交由 `knowledgeWorker` 分块并写入 `knowledge.sqlite`；支持增量追赶、单群发言聚合 `memberStats` 与多路搜索。 | **绝不接收** WCDB 数据库句柄、密钥、Electron 对象；**绝不将**未转写错误详情、图片/语音二进制或本地路径写入索引；**绝不在**跨会话之间合并分块。 |
| **System OCR 运行时** (`src/main/services/system-ocr-service.ts`) | 探测平台引擎与语言包可用性（Windows `Windows.Media.Ocr.OcrEngine` / macOS Apple Vision），按平台归一化图片格式（Win 转 PNG，Mac 直通），执行本地识别并做 CJK 空格清洗与错误码映射。 | **绝不发起**任何网络请求；**不读写** `AIProvider` / Vision 配置；**不写入** `image-insights.json`（Vision 缓存）或 Knowledge；**不负责**历史扫描。 |
| **图片文字索引服务与存储** (`src/main/services/image-text-index-service.ts`, `image-text-index-store.ts`) | 负责全量 SQL 统计、按固定 `anchorMs` 分段调度、增量 `maxLocalId` 水位比对、有界并发流水线、`image_ocr_artifacts` 内容去重与 `image_ocr_bindings` 绑定，以及触发单会话 Knowledge 重建。 | **绝不修改** WCDB 原表；**绝不产生**虚拟「OCR 消息」；**绝不在**解密服务缺失时写入大面积假 `decrypt_failed` 脏状态；派生修复路径（`repairKnowledgeIndex`）**编译期禁止**触发 OCR（`ocrExecutions: 0`）。 |
| **Voice SenseVoice Pipeline** (`src/main/voice-pipeline/`) | 管理 `sensevoice-small-int8` 模型下载与 SHA-256 校验、SILK 解码、PCM 裁剪与重采样、交互抢占后台的串行调度、ONNX 离线推理子进程、`voice-transcripts.sqlite` 两级缓存及批量/API 网关协调。 | **绝不将**语音转写结果写回微信库；批量/API 任务绝不阻塞聊天界面的交互式单条语音点击（必须可被即时抢占）。 |
| **Local Query API** (`src/main/services/local-query-api-service.ts`) | 实现 4 个查询 Tool（`query_messages` / `search_messages` / `message_context` / `conversation_overview`）与 `transcribeVoice`，结构性强制 `QueryCorpusScope`，处理索引新鲜度等待与单会话直读兜底。 | 4 个读/搜 Tool **绝不触发**图片解密、System OCR 或语音转写（只读缓存快照）；**绝不依赖** LLM 提示词约束范围（越界 `target` 直接返回 `outsideScopeError`）。 |
| **Query Agent 与 Adapter** (`src/main/services/query-agent-service.ts`, `ask-wechat-service.ts`) | `QueryAgentService` 集中托管 System Prompt、`ANSWER_RULES`、参数 Schema 校验、Host 侧时间边界锁、`recall_hint` 自动扩查、`EvidenceCollector`（`E1..E40`）与 `sanitizeAnswerCitations`；`AskWechatService` 托管多轮澄清记忆与受控 Legacy 回退。 | `QueryAgentService` 不持有任何 UI 状态或长期记忆；`AskWechatService` 对 `provider_unavailable` / `provider_failure` / `invalid_question` / 0 结果**绝不回退** Legacy；`agent-hub` 入口不注入 `runLegacy`。 |
| **Legacy AI Search** (`src/main/services/ai-search-pipeline-service.ts`, `ai-search-agent.ts`, `ai-search-evidence.ts`) | 仅作为桌面端回退引擎：本地意图规划 + 可选 LLM Query Compiler + 6 工具受控 Agent（不透明 `conversation-N`/`message-N` 句柄）+ 确定性 FTS 兜底 + `buildFinalEvidence` + 流式回答生成。 | 候选列表绝不绕过 `buildFinalEvidence` 直接进入最终回答上下文；不消费 Query Agent 的 `freshness` 口径。 |

---

## 3. 核心数据流与设计思路

### 3.1 Knowledge FTS5 Worker 与增量索引流水线

#### 1) Worker 隔离与 IPC 协议（版本 1）

为避免同步 `node:sqlite`（`DatabaseSync`）操作阻塞 Electron 主进程事件循环与界面渲染，`KnowledgeService`（`src/main/knowledge/knowledge-service.ts:18-73`）通过 `KnowledgeWorkerHost`（`src/main/knowledge/knowledge-worker-host.ts:39-223`）派生独立子进程 `out/main/knowledgeWorker.js`（由 `src/main/knowledge/knowledge-worker.ts` 构建）：

- **进程启动方式**：`fork(this.workerPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })`（`knowledge-worker-host.ts:143-147`）。
- **协议契约（`src/shared/knowledge.ts:572-619`、`src/main/knowledge/worker-protocol.ts:3-6`）**：固定 `KNOWLEDGE_WORKER_PROTOCOL_VERSION = 1`。
  - **9 类请求 `type`**：`'index' | 'preflight' | 'search' | 'status' | 'remove' | 'cancel' | 'close' | 'highWater' | 'memberStats'`。
  - **3 类响应 `type`**：`'progress' | 'result' | 'error'`。其中 `search` 响应在 Worker 侧通过 `v8.serialize(payload)` 实测 `responseSerializeMs` 并附带 `transport` 时间戳（`workerReceivedAt`、`workerCompletedAt`、`workerQueueMs`），供 `KnowledgeWorkerHost.applyTransportTimings`（`knowledge-worker-host.ts:190-218`）精确拆分进程启动、IPC 调度、序列化与 SQLite 执行耗时。
- **并发取消隔离**：`KnowledgeWorkerHost.activeIndexRequestId`（`knowledge-worker-host.ts:50,88-93`）仅追踪当前活跃的 `'index'` 请求。调用 `cancelActiveIndex()` 向 Worker 发送 `'cancel'`，Worker 内仅触发对应 `requestId` 的 `AbortController.abort()`（`knowledge-worker.ts:226-230`），已提交的会话保留不回滚，`run_state` 置为 `'cancelled'`，且**完全不影响并发执行中的 `'search'` 或 `'memberStats'` 请求**。
- **事件循环分片让出**：`KnowledgeStore` 内部在 `BEGIN IMMEDIATE` 事务中通过 `YIELD_EVERY = 500` 与 `waitForWorkerTurn()`（`setImmediate`）每处理 500 条记录/分片（及每个会话结束时）让出一次 Worker 事件循环（`knowledge-store.ts:33,86-88,245,1178-1293`），避免长时间同步写库饿死 IPC 消息分发；不过同进程并发 `search` 仍需等待当前 500 条切片结束才能拿到 Worker 执行权。

#### 2) 派生库 Schema、标准化与分块策略

`KnowledgeStore`（`src/main/knowledge/knowledge-store.ts:141-1571`）按 `knowledgeAccountKey(accountId) = sha256('knowledge-account-v1:' + accountId).slice(0, 32)` 将每个账号隔离于 `<userData>/knowledge/<key>/knowledge.sqlite`（开启 `WAL`、`synchronous = NORMAL`、`foreign_keys = ON`、`busy_timeout = 5000`，`knowledge-store.ts:91-99,988-992`）：

- **4 张核心表与 1 张 FTS5 虚表（`knowledge-store.ts:993-1105`）**：
  1. `knowledge_meta`：保存 `schema_version`、`account_id`、`fts_config` 指纹（变更时拒绝静默复用并要求重建）、`run_state`、`source_message_count`、`source_latest_at` 及全局统计快照 `stats_*`（避免每次热路径查询都全表 `COUNT(*)`）。
  2. `knowledge_messages`：主键 `(conversation_id, message_id)`，除 `searchable_text`、`content_hash` 外，显式留存独立列 `voice_transcript`、`voice_transcript_state` 与 `image_ocr_text`，便于证据生成时结构化判定 `derivedSource`（不靠截取前缀字符串）。建有 `(conversation_id, create_time)`、`(create_time)`（加速短词跨会话 `LIKE + ORDER BY create_time DESC`）及 `(kind, conversation_id)`（加速 `getVoiceCoverage`）索引。
  3. `knowledge_chunks`：保存按会话聚合的文本分块、包含的消息 ID 列表 `message_ids_json` 与时间边界 `start_time`/`end_time`。
  4. `knowledge_index_state`：按会话记录 `state`、`high_water_time`（被建模消息最新时间）、`complete_snapshot` 与 `source_high_water_time`（源侧原始消息最新时间）。
  5. `knowledge_fts`：默认配置 `DEFAULT_KNOWLEDGE_FTS_CONFIG`（`src/shared/knowledge.ts:112-118`）选用 `tokenizer = 'trigram'`、`contentMode = 'external'`（`content = 'knowledge_chunks', content_rowid = 'rowid'`，避免正文双份存储）、`detail = 'full'`、`columnsize = 1`。
- **标准化与前缀约定（`src/main/knowledge/normalizer.ts:17-61`）**：`normalizeKnowledgeMessage` 将正文、语音转写（前缀 `语音转写：`）、图片 OCR（前缀 `图片文字：`）及链接/附件标题拼接为 `searchableText` 并计算 `contentHash`，刻意排除本地文件绝对路径与二进制载荷。内部标签 `图片文字：` 在输出给模型或 UI 前必须由 `toEvidenceDisplayText()`（`src/shared/knowledge.ts:252-258`）剥离，改为通过 `derivedSource: 'image_ocr'` 表达。
- **分块策略（`src/main/knowledge/chunker.ts:51-88`）**：`chunkConversation` 严禁跨账号或跨会话成块；默认配置 `DEFAULT_KNOWLEDGE_CHUNKER`（`src/shared/knowledge.ts:621-627`）为 `version: 'conversation-v1'`、`maxGapMs: 600_000`（10 分钟）、`maxMessages: 12`、`maxCharacters: 1200`、`overlapMessages: 3`。在 `KnowledgeStore.indexConversation`（`knowledge-store.ts:1107-1245`）增量更新时，先找出内容哈希变更的最早消息下标 `changedAt`，向前退回 `overlapMessages` 条定位 `boundaryTime`，仅删除并重建 `end_time >= boundaryTime` 的旧 chunk 及外部内容 FTS 索引行。

#### 3) 增量调度、WCDB 双车道与时间单位契约

`KnowledgeSearchService.indexAccount`（`src/main/knowledge/knowledge-search-service.ts:625-825`）驱动后台全量/增量同步：

1. **零开销跳过与任务优先级排序**：拉取各会话在库内的 `marks = highWaterMarks()`（epoch **毫秒**）与缓存的源侧 `activity = chat.getConversationActivityMs()`（epoch **毫秒**）。若某会话 `previousActivity <= mark`，直接跳过（0 WCDB 查询、0 Worker IPC）。其余会话按**「`catchUpContacts`（已有 checkpoint 且源侧更新）优先于 `backfillContacts`（无 checkpoint 历史缺口）」**排序，防止历史补全堵住今日新消息。
2. **ms / s 单位换算与安全阀**：`DELTA_OVERLAP_MS = 24 * 60 * 60 * 1000`（`knowledge-search-service.ts:51`）。构建增量查询起点时必须将毫秒换算为 WCDB 所需的**秒**：`sinceTime = Math.max(0, Math.floor((mark - DELTA_OVERLAP_MS) / 1000))`（`L716-718`），且增量请求必须置 `completeSnapshot: false`（否则 Store 会将不在增量窗口内的历史消息误判为被删除而全量重建）。若遇到 `isDelta && messages.length === 0 && previousActivity > mark`（`suspiciousEmptyDelta`），**绝不推进** `sourceHighWaterTime`。
3. **交互让路与 WCDB 双车道（`knowledge-search-service.ts:1383-1447`）**：由于 `Wcdb4Client` 异步分页不允许重叠，所有 WCDB 读取均进入 `wcdbPending` 队列。交互式查询通过 `beginInteractiveQuery()`/`endInteractiveQuery()` 阻塞后台循环的下一个会话推进（`await this.interactiveIdle`），且 `enqueueWcdbRead(..., 'interactive')` 会直接插队到队列中首个 `'background'` 任务之前。
4. **事件循环监控**：同步期间开启 `monitorEventLoopDelay({ resolution: 10 })` 统计主线程 lag 分位数（`p50`/`p95`/`p99`/`max`），验证重计算已成功下沉至 Worker。

#### 4) 三路检索与分批合并

`KnowledgeStore.searchMeasured`（`knowledge-store.ts:494-669`）根据查询条件分流三条路径：
1. **单会话边界（`conversationBoundary: 'first' | 'last'`）**：直接按 `create_time ASC/DESC` 在 `knowledge_messages` 取首/末条非系统消息。
2. **无关键词（`!terms.length`）**：走 `searchByMetadata`（`L744-866`）。单会话场景取最多 2000 条消息按 2 小时/24 条切分时间片，每片轮转挑选最长文本、首条与末条代表（上限 60 条），避免长会话近期记录被截断。
3. **关键词检索**：长度 ≥3 个可索引字符的词走 `knowledge_fts MATCH`（`bm25(knowledge_fts)` 排序，限制命中 `min(limit * 4, 100)` 个 chunk 后展开消息按 `messageTermScore` 重排）；若无结果且 tokenizer 为 `trigram`，则对 <3 字符的短词走 `searchShortTerms`（`searchable_text LIKE '%term%' COLLATE NOCASE ORDER BY create_time DESC LIMIT ?`，`L671-742`）。当过滤的 `conversationIds.length > 700`（`MAX_CONVERSATION_FILTERS_PER_WORKER_SEARCH = 700`，`knowledge-search-service.ts:37`）时，主进程自动按 700 分批调用 Worker 并合并去重。

#### 5) 独立集成验证脚本

`scripts/test-knowledge-worker.cjs`（`L1-153`）直接 `fork` 编译产物 `out/main/knowledgeWorker.js`（`ELECTRON_RUN_AS_NODE=1`），依次验证双账号目录隔离、写入检索（消息级 `KnowledgeEvidence` 字段完整性）、单账号 `remove` 不越界破坏另一账号，以及删除后查询返回 `state: 'unavailable'`。

---

### 3.2 图片 System OCR 派生索引与分层回填调度

#### 1) System OCR 跨平台运行时（`SystemOcrService`）

`SystemOcrService`（`src/main/services/system-ocr-service.ts:206-638`）封装原生依赖 `@napi-rs/system-ocr`（1.2.0），与 `src/shared/system-ocr.ts` 共同约束跨平台行为差异：

- **能力探测（`getCapability` / `probeLanguage`，`L342-472`）**：使用 64×32 纯白测试 PNG（`SYSTEM_OCR_PROBE_PNG_BASE64`）探测引擎是否可加载与语言包是否就绪：
  - **Windows（`windows-system-ocr`）**：通过 `resolveWindowsOcrLanguageTag` 映射系统 locale（如 `zh-cn` → `zh-Hans-CN`），若语言包缺失引擎返回 `Windows error 操作成功完成。 (0x00000000)`（HRESULT 为 `S_OK` 却无引擎），`mapSystemOcrNativeError`（`src/shared/system-ocr.ts:316-332`）将其精准识别为 `OCR_LANGUAGE_UNAVAILABLE`。
  - **macOS（`macos-system-ocr`）**：Apple Vision 自动决定语言，不传语言提示；若纯白测试图抛出 `No text recognized`，恰恰说明 Vision 识别器运行正常。
- **格式归一化（`toPngBytes`，`L308-339`）**：
  - **Windows 路径**：`Windows.Media.Ocr.OcrEngine` 的 Buffer 接口仅支持 PNG。JPEG 优先使用 `electron.nativeImage.createFromBuffer(buffer).toPNG()` 进程内转码；其余格式（GIF/BMP/WEBP/TIFF）通过 `ffmpeg` 内存管道（`-f image2pipe -vcodec png pipe:1`，超时 `FFMPEG_TIMEOUT_MS = 10_000`）转成 PNG，不落盘。
  - **macOS 路径**：Apple Vision 原生支持 PNG/JPEG/WEBP/GIF/BMP/TIFF，原始字节直接透传。
- **结果归一化与缓存**：调用 `runtime.recognize(prepared, undefined, ...)`（`accuracy` 保持默认 `Accurate`，不降级为 `Fast`），输出经 `normalizeSystemOcrText`（`src/shared/system-ocr.ts:164-184`）仅剔除两侧均为 CJK 字符的引擎伪空格；macOS 的 `No text recognized` 映射为正常终态 `OCR_EMPTY_RESULT`；内存缓存上限 `MAX_CACHE_ENTRIES = 32`，有效期 `SYSTEM_OCR_CACHE_TTL_MS = 10min`，键空间由 `buildSystemOcrCacheKey` 绑定引擎、平台、语言与运行时版本。

#### 2) 独立派生库 Schema 与双层去重（`ImageTextIndexStore`）

`ImageTextIndexStore`（`src/main/services/image-text-index-store.ts:98-671`）将派生数据独立存放于 `<userData>/image-text-index/<imageTextIndexAccountKey(accountId)>/image-text-index.sqlite`（不混入 `knowledge.sqlite`，保证清理零残留与 zero migration risk）：

- `image_ocr_artifacts`：按 `artifact_key = buildImageOcrArtifactKey({ imageIdentity, provenance })`（内容 `sha256` 前 32 位 + `engine|platform|runtimeVersion|language`）去重，同一图片被转发到多个群仅识别一次。
- `image_ocr_bindings`：主键 `(conversation_id, message_id)`（使用 `sourceMessageId(message)` 与 Knowledge 完全对齐），将某条图片消息绑定到对应的 `artifact_key` 与持久化终态（`'indexed' | 'empty' | 'metadata_missing' | 'image_missing' | 'decrypt_unavailable' | 'decrypt_failed' | 'decode_failed' | 'ocr_failed' | 'cancelled'`，见 `src/shared/image-text-index.ts:376-411`）。
- `image_ocr_scan_state`：按会话记录扫描进度与插入序增量水位 `image_max_local_id`。
- `image_ocr_meta`：存储总数统计快照 `total_image_messages` / `total_image_counted_at` / `total_image_messages_complete`（防止重启后分母缩水把部分完成谎报成 100%），以及回填计划状态 `backfill_anchor_ms`、`backfill_tier_states`、`backfill_covered_to_ms`。

#### 3) Recent-First 分段调度、增量水位与有界流水线

`ImageTextIndexService`（`src/main/services/image-text-index-service.ts:294-2146`）通过以下机制保障「最近聊天图片先可搜、新消息不被历史阻塞、重启断点可续」：

1. **前置依赖硬拦截（`runPass`，`L1331-1350`）**：启动前同时检验 `systemOcrService.getCapability()` 与 `decryptService()` 是否可用，缺失则立即失败退出而不写入一条记录，杜绝产生数万条假 `decrypt_failed` 污染终态。
2. **固定锚点分段与增量优先（`resolveBackfillPlan` / `runPass` / `sweepIncremental`，`L1440-1582`）**：
   - 首次规划时落盘固定 `anchorMs`，按 `IMAGE_TEXT_BACKFILL_TIER_ORDER` 派生四个互不重叠的半开区间 `[startMs, endMs)`：`recent_7d`（7 天）→ `recent_30d`（30 天）→ `recent_1y`（365 天）→ `archive`（`-∞`），经 `imageTextWindowToSeconds`（`src/shared/image-text-index.ts:169-183`）统一 `Math.floor` 换算为 WCDB 秒级闭区间。
   - 外层循环按分段从新到旧推进，**每个调度点先执行 `sweepIncremental`**（窗口 `[max(anchorMs, coveredToMs), +∞)`）。在增量模式中，若 `imageWatermark` 可用且 `maxLocalId > previous.maxLocalId`（发现新插入或等量替换的图片），`processWindow`（`L1658-1673`）会**去掉时间窗限制**扫描该会话，以接住网络补发或恢复带来的「晚到的旧时间消息」；水位未涨则单条 SQL 跳过。
3. **三段重叠的有界并发流水线（`processBatch`，`L1177-1261`）**：
   - 每批 `IMAGE_TEXT_INDEX_BATCH_SIZE = 12` 条（批间 `setImmediate` 让出事件循环），进度推送节流 `IMAGE_TEXT_INDEX_PROGRESS_INTERVAL_MS = 5000`ms（状态切换立即 emit）。
   - **同步 `prepareImage`（`L957-1038`）**：按 `allowThumbnail: true, preferThumbnail: true` 定位并解密 `.dat` → 算 `sha256` → 命中已有终态 artifact 则短路不占槽位。
   - **异步 `runOcr`（`L1066-1086`）**：受限于 `DEFAULT_IMAGE_TEXT_OCR_CONCURRENCY = 2`（硬上限 `MAX_IMAGE_TEXT_OCR_CONCURRENCY = 4`，支持环境变量 `TRACEMEMO_OCR_CONCURRENCY` 覆盖，保护 libuv 共享线程池），同批相同 `artifactKey` 复用 `inFlightOcr` Promise。
   - **单 Writer `settle`（`L1094-1162`）**：主线程 `prepare` 与后台异步 OCR 并行重叠，但写库严格串行在 `settle` 中完成。仅当 `state === 'indexed'` 且非空时标记 `knowledgeDirty = true`。
4. **Knowledge 联动、修复与清理**：
   - **增量同步**：单个会话图片扫完且 `knowledgeDirty === true` 时，触发 `onConversationIndexed(conversationId)` → `KnowledgeSearchService.indexImageOcr(conversationId)` 重建该会话分片（`src/main/index.ts:1282-1283`）。
   - **派生修复（`repairKnowledgeIndex`，`L2084-2124`）**：仅基于已落盘的 `image_ocr_artifacts` 与 `image_ocr_bindings` 触发受影响会话的 Knowledge 重建，类型上锁死 `ocrExecutions: 0`。
   - **可重试重置与彻底清理**：`resetRetriableFailures()`（`L2133-2141`）仅删除 `IMAGE_OCR_RETRIABLE_FAILURE_STATES`（`decrypt_unavailable`/`decrypt_failed`/`decode_failed`/`ocr_failed`）的绑定、孤儿 artifact 与对应会话 checkpoint，保留已成功的识别结果；`clear()`（`L1987-2061`）在删库前先记录 `affectedConversations`，折叠 WAL 并校验 `removeImageTextIndexDatabase` 确实无 `-wal`/`-shm` 残留后，逐会话重建 Knowledge 使派生文本彻底失效，并在最后二次关闭因 resolver 回调可能重开的 store 句柄。

---

### 3.3 Voice SenseVoice ONNX Pipeline

语音转写流水线位于 `src/main/voice-pipeline/`（共 17 个 TypeScript 文件），通过离线 ONNX 模型将微信 SILK 语音转为文字并同步进入 Knowledge 索引。

#### 17 个文件分工与端到端链路

1. **模型下载与校验（`model-manager.ts`）**：
   - `VoiceModelManager`（`L44-309`）管理模型 `DEFAULT_VOICE_MODEL_ID = 'sensevoice-small-int8'`（版本 `'2024-07-17'`），仅在 `win32 x64` 与 `darwin x64/arm64` 启用。
   - 清单 `SENSEVOICE_MODEL_FILES`（`L12-25`）包含 `model.int8.onnx`（239,233,841 B）与 `tokens.txt`（315,894 B），使用 Electron 的 `net.fetch`（遵循系统代理配置）写入 `.partial` 临时文件，逐字节校验精确大小与 SHA-256 后落盘 `verified.json`。
2. **音频解码、预处理与质量契约（`audio-decoder.ts`, `audio-processor.ts`, `voice-quality.ts`）**：
   - `SilkAudioDecoder`（`audio-decoder.ts:71-92`）按开发/解包/resources/asar 顺序定位 `silk-wasm/lib/silk.wasm` 并解码为 16kHz 单声道 PCM（另有 `SilkAudioEncoder` 供发送语音编码使用）。
   - `PcmAudioProcessor`（`audio-processor.ts:12-91`，版本 `VOICE_PROCESSOR_VERSION = 'pcm16-mono-16k-v1'`）将 Int16LE PCM 转为 Float32Array → 按阈值 `0.008` 与前后保留 `80ms` 裁剪静音 → 线性重采样至 16kHz → 若峰值超过 `0.92`（且 ≥`0.001`）则峰值归一化。
   - `voice-quality.ts`（`L26-66`）导出 `validateVoicePcm`、`validateVoiceSilk`、`validateVoiceSilkMetadata` 校验采样率（16kHz 单声道）、最小时长（20ms / 640B）与 `\x02#!SILK_V3` 头（主要服务于语音发送/编码侧门禁）。
3. **抢占式单并发调度（`task-scheduler.ts`）**：
   - `VoiceTaskScheduler`（`task-scheduler.ts:10-74`）维护按优先级排序的单并发队列。当交互式请求（`priority !== 'background'`，默认 `1`，例如用户在聊天窗口点开某条语音）到来且当前正在执行后台任务（`priority === 0`）时，立即对当前后台任务的 `AbortController` 调用 `abort()` 触发抢占，保证前台点击零长排队等待。
4. **独立推理 Worker 进程与懒加载（`recognition-host.ts`, `voice-recognition-worker.ts`, `sensevoice-recognizer.ts`, `worker-protocol.ts`, `worker-recognizer-registry.ts`）**：
   - `RecognitionHost`（`recognition-host.ts:23-146`）通过 `fork(..., { serialization: 'advanced', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })` 启动 `out/main/voiceRecognitionWorker.js`，支持协议版本 `VOICE_WORKER_PROTOCOL_VERSION = 1` 直接传输 `Float32Array` 采样。
   - 单次识别超时 `timeoutMs = 120_000`ms，被抢占（`signal.aborted`）或超时时直接 `terminate()` 销毁子进程；全部请求完成后启动 `idleTimeoutMs = 60_000`ms 空闲计时器自动退出释放数百 MB 模型内存。
   - Worker 内部 `SenseVoiceRecognizer`（`sensevoice-recognizer.ts:24-58`）懒加载 `sherpa-onnx-node` 的 `OfflineRecognizer.createAsync`（`language: 'auto'`、`useInverseTextNormalization: 1`、`numThreads` 取 `WXE_VOICE_THREADS` 钳制于 `1..4`，默认 `2`）；测试环境下支持 `WXE_VOICE_RECOGNITION_FAKE_TEXT` 环境变量返回固定文本。
5. **两级 SQLite 缓存与业务入口（`voice-pipeline.ts`, `transcript-repository.ts`, `voice-recognition-use-case.ts`, `voice-message-identity.ts`, `types.ts`）**：
   - `voiceMessageIdentity(reference)`（`voice-message-identity.ts:8-14`）以 `sha256(sessionId|localId|createTime|svrId)` 生成账号内唯一语音消息键。
   - `SqliteTranscriptRepository`（`transcript-repository.ts:38-273`）管理 `<userData>/cache/voice-transcripts.sqlite` 内的 `voice_transcripts`（7 列复合主键）与 `voice_transcript_message_states`（`pending`/`transcribed`/`failed`）。
   - `VoicePipeline.run`（`voice-pipeline.ts:37-108`）执行**两级缓存查询**：非 `force` 时先查 `findCompatible`（匹配消息身份 + 预处理版本 + 识别器/模型指纹，免解码秒回）；未命中或 `force: true` 时解析原始 SILK、解码预处理并计算 `audioHash`，再查精确主键 `find(key)`；仍未命中则送 Worker 推理并落盘。
   - `VoiceRecognitionUseCase`（`voice-recognition-use-case.ts:29-234`）引入 `accountGeneration` 防止切换微信账号时旧任务异步结果串号写库。
6. **批量转写、API 网关与 Knowledge 联动（`voice-batch-service.ts`, `voice-transcription-gateway.ts`）**：
   - `VoiceBatchService`（`voice-batch-service.ts:65-369`）提供 `preflight`、`conversationSummaries`、`start`、`cancel`、`retryFailed`。循环内以 `priority: 'background', publishTranscriptUpdate: false` 调用识别；若收到被交互抢占产生的 `CANCELLED` 错误码，**将该条目重新压回 `task.items` 队尾继续后续处理**；整批循环完成后按受影响会话调用一次 `publishTranscriptSnapshot(reference)`，将单条重建收敛为每个会话一次。
   - `VoiceTranscriptionGateway`（`voice-transcription-gateway.ts:34-154`）为 Local Query API 托管请求去重（`inFlight` Map）、容量保护（`VOICE_TRANSCRIBE_MAX_IN_FLIGHT = 100`，超限整批返回 `null` 触发 HTTP/Tool `busy` 提示）、限时等待（`Promise.race` `waitMs`，超时返回 `pending` 而后台继续转写）以及被交互抢占后最多 `MAX_PREEMPTION_RETRIES = 5` 次自动重排。
   - 单条交互识别成功后，`VoiceRecognitionUseCase` 通过 `onTranscriptUpdate` 通知 `KnowledgeSearchService.indexVoiceTranscript`（`src/main/index.ts:1175-1177`），后者按 `accountIdentity:sessionId` 在微任务中合并并发更新后重建对应会话分片（`knowledge-search-service.ts:411-461`）。

---

### 3.4 AI 检索双引擎与 POC

#### 1) LocalQueryApiService：统一查询执行器与双重新鲜度保障

`LocalQueryApiService`（`src/main/services/local-query-api-service.ts:371-1030`）同时服务于进程内 `QueryAgentService`（通过 `createLocalQueryToolExecutor`）与本地 HTTP 服务（`/api/v1/query/*`）：

- **结构性范围强制（`resolveCorpus`，`L439-459`）**：将前端/API 传入的 `QueryCorpusScope`（`all` / `groups` / `contact` / `current`）解析为白名单会话集合；任何显式 `target` 若解析后不在该集合内，立即返回 `outsideScopeError`（不依赖 LLM 自我约束）。
- **五大能力动作**：
  - `messages`（`query_messages`，`L461-508`）：直读 WCDB（按方向 `from_target`/`to_target`、消息类型、升/降序与 `limit ≤ 200` 过滤），只读附加 `imageOcrEntry` 与 `voiceSnapshot` 派生字段（通过 `sourceMessageId` 对齐，不触发任何识别）。注意：群聊不允许传 `from_target`/`to_target`（返回 `unsupported_query`）。
  - `search`（`search_messages`，`L509-637`）：支持主词 + 最多 4 个变体（`probes.length ≤ 5`）。执行时用 `beginInteractiveQuery()`/`endInteractiveQuery()` 暂停后台索引，随后经过 `ensureFreshness`（`L821-849`）：若索引覆盖 `indexLatestAt` 未达到 `min(requestedEnd, sourceLatestAt)` 且落后超过 `max(QUERY_CATCH_UP_MIN_LAG_MS (2min), knowledge.lastPassDurationMs())`，则调用 `requestCatchUp(30s)` 并在 `QUERY_FRESHNESS_WAIT_BUDGET_MS = 15s` 预算内等待，只要触发或复用了索引任务就重新执行 `probe`（`resynced: true`）。
  - **单会话直读兜底（`directReadKeywordFallback`，`L649-711`）**：若等待后索引仍未覆盖请求结尾，且本次范围**恰好为单个会话**，则在交互窗口内直接按秒级起点 `Math.floor(fromMs / 1000)` 读取 WCDB 该会话增量区间的消息，联合正文、语音转写与已索引 OCR 文本做子串匹配并按 `conversationId:normalizedMessageId` 与索引结果去重合并；若为跨会话范围，因全库直读开销过大，诚实置 `coverage.state = 'partial'` 并通过 `indexCoverage` 提示模型引导用户缩小到单会话再查。
  - `context`（`message_context`，`L869-882`）：解析 base64url 编码的 opaque `messageRef`（`src/shared/local-query-api.ts:185-206`），校验越界后返回锚点前后最多各 `CONTEXT_MAX = 50` 条消息。
  - `overview`（`conversation_overview`，`L973-1029`）：事实源是 WCDB 而非可能滞后的派生索引，读取最多 `OVERVIEW_SOURCE_CAP = 2000` 条（注意不向 `listMessagesAsync` 传 `limit`，而是在 JS 侧切片保留最新 2000 条）并由 `selectTemporalCoverageEvidence` 采样最多 60 条代表消息，如实标记 `coverage.state` 为 `'complete'` 或 `'partial'`。
  - `transcribeVoice`（`L889-964`）：唯一触发计算的 Query API 端点，校验 `messageRefs`（上限 `VOICE_TRANSCRIBE_MAX_REFS = 20`）与 `waitMs`（0..60000ms，`VOICE_TRANSCRIBE_MAX_WAIT_MS`），转发至 `VoiceTranscriptionGateway`。

#### 2) QueryAgentService：主引擎与 Host 侧结构性防线

`QueryAgentService`（`src/main/services/query-agent-service.ts:1237-1569`）与 `AskWechatService`（`src/main/services/ask-wechat-service.ts:55-303`）构成生产主检索链路（桌面「问问微信」与 `AgentHubService` 共用同一个实例，`src/main/index.ts:1319-1338`）：

- **循环上限与真实生命周期事件**：最大允许 `MAX_TOOL_CALLS = 5` 次工具调用（`tool_limit` 判定在批次执行前进行：`result.toolCallCount + calls.length > MAX_TOOL_CALLS`，`L1389`）；`ZERO_RESULT_RETRY_LIMIT = 1`。运行期间仅在真实阶段边界发出 `understanding` → `searching` → `organizing_evidence` → `generating_answer` → `completed`（`finally` 兜底，无伪造百分比）。
- **Host 侧五道结构性防线**：
  1. **参数清洗与时间转换（`validateToolArguments`，`L860-881`）**：禁用 `FORBIDDEN_INPUT_KEYS`（`apiKey`、`authorization`、`token`、`databasePath`、`sql`、`wxid`、`md5`）；`absolute` 时间强制校验带时区偏移的 ISO-8601 字符串并由 Host 换算成 epoch 秒。
  2. **时间策略锁与自动扩查（`lockConstraintTimeRange` / `shouldAutoBroaden`，`L739-778, L1465-1494`）**：若模型声明 `temporalBasis.kind === 'constraint'`，首次 `query_messages` 后即锁定 `timeRange` 签名，后续重试改变时间会被直接拒绝（只允许调整 `direction`/`messageTypes`）；若声明 `temporalBasis.kind === 'recall_hint'` 且有界范围首次返回 0 条，Host **自动在全部历史再调一次 `query_messages`**（`AUTO_FALLBACK_REASON = 'soft_temporal_hint_zero_result'`），结果挂载到 `fallbackLookup`，**不计入 `MAX_TOOL_CALLS` 也不增加 LLM 往返**。
  3. **重复重试拦截与工具动态收窄（`duplicateRetry` / `nextToolDefinitions`，`L810-819, L1019-1054`）**：按实质检索条件（忽略 `limit`/`order`）生成签名拦截完全相同的重试；`search_messages` 一旦返回证据，下一轮可用工具集自动收窄为仅开放 `message_context`。
  4. **证据真源与上下文脱敏（`EvidenceCollector` / `toolResultForModel`，`L964-1017, L1110-1235`）**：在把 Tool Result 放入模型 `messages` 之前，`EvidenceCollector` 先按首次命中顺序收录最多 `MAX_EVIDENCE_ITEMS = 40` 条证据并分配稳定编号 `E1..E40`；`toolResultForModel` 为可引用条目注入 `citationId`、剥离与 `text` 重复的 `imageOcrText`，并将内部 `timings` 留在 `traces` 不进模型上下文。
  5. **引用白名单清洗（`sanitizeAnswerCitations`，`L1376-1383`）**：复用 `src/main/services/ai-search-evidence.ts:266-287`，从最终回答中剥除所有未在 `evidence.citationIds()` 中分配过的 `[E#]` 幻觉引用并记录 `invalidCitationIds`。
- **AskWechatService 记忆边界与受控回退**：
  - `QueryAgentConversationMemory`（`src/main/services/query-agent-conversation-memory.ts:9-70`）仅在内存中保存最近 `CONVERSATION_MEMORY_MAX_TURNS = 2` 轮问答对（问题截断 300 字、回答 800 字、TTL 10 分钟），绝不落盘也不存 Tool 结果/原文。
  - 回退 Legacy（`ask-wechat-service.ts:96-192`）**仅当**注入了 `runLegacy`（桌面端）且发生 Runtime 未捕获异常、`errorKind === 'tool_limit'` 或 `answer` 为空时触发；`provider_unavailable`、`provider_failure`、`invalid_question` 及正常回答的 0 结果/澄清追问均不回退。

#### 3) Legacy AI Search 管线与 POC 诊断工具

- **Legacy 管线（`AiSearchPipelineService`，`src/main/services/ai-search-pipeline-service.ts:206-1990`）**：
  1. 先运行本地规则规划 `buildLocalAiSearchPlan`；若为 `general` 或 `isSuspiciousLocalPlan` 则调用 LLM Query Compiler 输出结构化 JSON 计划。
  2. 在非 `conversation_boundary` / `semantic` 场景下，调用 `runControlledSearchAgent`（`src/main/services/ai-search-agent.ts:115-206`，`MAX_AGENT_TOOL_CALLS = 5`），通过 6 个 Tool（`search_conversations`/`search_people`/`search_messages`/`get_conversation_messages`/`get_messages_by_time`/`get_message_context`）与不透明 `conversation-N`/`message-N` 句柄交互，Tool 结果包在 `UNTRUSTED_TOOL_RESULT` 中防提示词注入。
  3. 若 Agent 无效或已选定会话却未找到证据，退回确定性 `knowledge.search` 兜底；随后由 `buildFinalEvidence`（`src/main/services/ai-search-evidence.ts:135-183`）去重、按 `recall_chunk_coverage`/`sender_coverage`/`conversation_coverage` 重排并分配 `E#`，取前 `DISPLAY_EVIDENCE_LIMIT = 8` 条进 `answerPrompt`，通过 `createDeltaBatcher`（40ms 批量推流）输出并经 `sanitizeAnswerCitations` 校验。
- **Query Agent CLI POC（`scripts/run-query-agent-poc.cjs`, `src/main/query-agent-poc-entry.ts`, `src/main/query-agent-poc-cli.ts`, `src/main/query-agent-poc-report.ts`）**：
  - `scripts/run-query-agent-poc.cjs` 清除 IDE 可能注入的 `ELECTRON_RUN_AS_NODE` 后使用 Electron 启动构建产物 `out/main/queryAgentPoc.js`。
  - `query-agent-poc-entry.ts`（`L27-82`）从 `apiTokenStore` 取本地 Bearer Token，将 `QueryAgentService` 的 Tool Executor 指向 `http://127.0.0.1:6131/api/v1/query/*`（支持 `TRACEMEMO_QUERY_API_BASE` 覆盖），在无 GUI 下直接复用同一份 `QueryAgentService` 与生产配置；支持自然语言提问（含 `--scope '<json>'`）或 `--tool <name> --args '<json>'` 裸工具诊断，stdout 输出纯 JSON，stderr 输出 `formatTiming` 与脱敏 `formatProviderDiagnostics`。

---

## 4. 关键文件与符号索引

### 4.1 Knowledge FTS5 子域

| 仓库文件路径 | 核心导出符号 / 关键常量 | 行号范围 | 说明 |
|---|---|---|---|
| `src/shared/knowledge.ts` | `KNOWLEDGE_SCHEMA_VERSION` (`1`), `DEFAULT_CHUNKER_VERSION` (`'conversation-v1'`), `DEFAULT_KNOWLEDGE_FTS_CONFIG`, `DEFAULT_KNOWLEDGE_CHUNKER`, `KNOWLEDGE_FRESHNESS_TOLERANCE_MS` (`60_000`), `toEvidenceDisplayText`, `isKnowledgeFresh` | `L7-118`, `L252-258`, `L557-627` | 派生库契约、trigram 默认配置、freshness 判据与前缀剥离函数 |
| `src/main/knowledge/message-identity.ts` | `sourceMessageId` | `L20-24` | 跨 Knowledge、Image OCR、Evidence 跳转的消息身份唯一真源 |
| `src/main/knowledge/normalizer.ts` | `normalizeKnowledgeMessage`, `isIndexableKnowledgeMessage` | `L17-61` | 源消息标准化文本拼装（`语音转写：`/`图片文字：`）与内容哈希 |
| `src/main/knowledge/chunker.ts` | `chunkConversation` | `L51-88` | 单会话时间/条数/字符数边界分块（严禁跨会话成块） |
| `src/main/knowledge/worker-protocol.ts` | `KNOWLEDGE_WORKER_PROTOCOL_VERSION` (`1`) | `L3-6` | Worker IPC 协议版本常量与类型别名 |
| `src/main/knowledge/knowledge-store.ts` | `KnowledgeStore`, `knowledgeAccountKey`, `getKnowledgeDatabasePath`, `removeKnowledgeDatabase`, `estimateKnowledgeCapacityPreflight` | `L91-105`, `L141-1571`, `L1578-1642` | SQLite FTS5 存储引擎、增量重分片、三路检索、短词 LIKE 回退与群员聚合 `memberStats` |
| `src/main/knowledge/knowledge-worker.ts` | `handle`（9 类 IPC 请求路由）, `sendSearchResult`（`v8.serialize` 计时） | `L32-53`, `L224-285` | Worker 子进程入口与按 `requestId` 的 `AbortController` 取消管理 |
| `src/main/knowledge/knowledge-worker-host.ts` | `KnowledgeWorkerHost`, `cancelActiveIndex`, `applyTransportTimings` | `L39-223` | 主进程 Worker 托管、单索引请求取消隔离与 IPC 耗时拆解 |
| `src/main/knowledge/knowledge-service.ts` | `KnowledgeService` | `L18-73` | 绑定 `<userData>/knowledge` 根路径的主进程服务封装 |
| `src/main/knowledge/knowledge-search-service.ts` | `KnowledgeSearchService`, `DELTA_OVERLAP_MS` (`24h`), `MAX_CONVERSATION_FILTERS_PER_WORKER_SEARCH` (`700`) | `L37-51`, `L259-1509` | 增量追赶编排、ms/s 换算、WCDB 双车道队列、交互让路、OCR/语音联动与昵称补全 |
| `scripts/test-knowledge-worker.cjs` | `main` | `L75-148` | `knowledgeWorker` 独立进程集成测试脚本 |

### 4.2 图片 OCR 索引子域

| 仓库文件路径 | 核心导出符号 / 关键常量 | 行号范围 | 说明 |
|---|---|---|---|
| `src/shared/system-ocr.ts` | `SYSTEM_OCR_ENGINE_WINDOWS`, `SYSTEM_OCR_ENGINE_MACOS`, `resolveSystemOcrEngine`, `buildSystemOcrCacheKey`, `normalizeSystemOcrText`, `mapSystemOcrNativeError`, `detectSystemOcrImageFormat` | `L22-41`, `L137-184`, `L316-370` | 跨平台引擎标识、CJK 空格清洗、native 错误映射与魔数检测 |
| `src/main/services/system-ocr-service.ts` | `SystemOcrService`, `systemOcrService`, `MAX_CACHE_ENTRIES` (`32`), `FFMPEG_TIMEOUT_MS` (`10_000`) | `L64-65`, `L206-638` | `@napi-rs/system-ocr` 封装、能力自检、Win PNG 归一化 / Mac 直通 |
| `src/shared/image-text-index.ts` | `IMAGE_TEXT_INDEX_BATCH_SIZE` (`12`), `DEFAULT_IMAGE_TEXT_OCR_CONCURRENCY` (`2`), `MAX_IMAGE_TEXT_OCR_CONCURRENCY` (`4`), `IMAGE_TEXT_BACKFILL_TIER_ORDER`, `buildImageTextBackfillSegments`, `imageTextWindowToSeconds`, `imageTextRangeCoverage`, `IMAGE_OCR_RETRIABLE_FAILURE_STATES` | `L24-68`, `L96-194`, `L265-316`, `L449-488` | 分段规划算法、ms→s 边界换算、artifact key 规则与覆盖度判据 |
| `src/main/services/image-text-index-store.ts` | `ImageTextIndexStore`, `imageTextIndexAccountKey`, `getImageTextIndexDatabasePath`, `removeImageTextIndexDatabase` | `L33-68`, `L98-671` | `image_ocr_artifacts` / `bindings` / `scan_state` 持久化与 WAL 截断删除验证 |
| `src/main/services/image-text-index-service.ts` | `ImageTextIndexService`, `imageTextIndexService` | `L294-2146` | 固定 `anchorMs` 分段调度、`maxLocalId` 水位、有界异步 OCR 流水线与 Knowledge 修复/清理联动 |

### 4.3 Voice SenseVoice ONNX 子域（17 文件 + 共享契约）

| 仓库文件路径 | 核心导出符号 / 关键常量 | 行号范围 | 说明 |
|---|---|---|---|
| `src/shared/voice-recognition.ts` | `DEFAULT_VOICE_MODEL_ID` (`'sensevoice-small-int8'`), `VoiceMessageReference`, `VoiceTranscriptUpdate`, `VoiceModelStatus`, `VoiceBatchRequest` | `L1-128` | 语音识别模型、进度、批处理与状态变更共享契约 |
| `src/main/voice-pipeline/types.ts` | `SpeechRecognizerRegistry`, `PipelineAudio`, `TranscriptRepository` | `L4-106` | 管线内部抽象接口与识别器注册表 |
| `src/main/voice-pipeline/worker-protocol.ts` | `VOICE_WORKER_PROTOCOL_VERSION` (`1`), `WorkerRecognitionRequest`, `WorkerRecognitionResponse` | `L1-30` | 语音识别子进程 IPC 协议定义 |
| `src/main/voice-pipeline/worker-recognizer-registry.ts` | `WorkerRecognizerRegistry`, `WorkerRecognizerEngine` | `L9-29` | Worker 侧推理引擎注册表 |
| `src/main/voice-pipeline/voice-message-identity.ts` | `voiceMessageIdentity`, `voiceAccountIdentity`, `voiceMessageReferenceOf` | `L8-52` | 语音消息与账号稳定 SHA-256 标识生成及消息引用提取 |
| `src/main/voice-pipeline/model-manager.ts` | `VoiceModelManager`, `SENSEVOICE_MODEL_FILES`, `MODEL_VERSION` (`'2024-07-17'`) | `L9-30`, `L44-309` | Hugging Face 下载（`net.fetch`）、SHA-256 校验与 `verified.json` |
| `src/main/voice-pipeline/audio-decoder.ts` | `SilkAudioDecoder`, `SilkAudioEncoder`, `AudioDecoderRegistry`, `createDefaultAudioDecoderRegistry`, `getSilkWasmRuntimeLocations` | `L38-130` | `silk-wasm` 路径定位与 SILK ↔ 16kHz PCM 编解码 |
| `src/main/voice-pipeline/audio-processor.ts` | `VOICE_PROCESSOR_VERSION` (`'pcm16-mono-16k-v1'`), `PcmAudioProcessor` | `L3-91` | Int16LE 解码、静音裁剪、线性重采样与峰值归一化 |
| `src/main/voice-pipeline/voice-quality.ts` | `VOICE_SAMPLE_RATE` (`16_000`), `validateVoicePcm`, `validateVoiceSilk`, `validateVoiceSilkMetadata` | `L1-66` | 16kHz 单声道 PCM 与 SILK V3 音频头/时长契约校验 |
| `src/main/voice-pipeline/task-scheduler.ts` | `VoiceTaskScheduler` | `L10-74` | 交互优先级抢占后台任务的单并发串行队列 |
| `src/main/voice-pipeline/transcript-repository.ts` | `SqliteTranscriptRepository` | `L38-273` | `voice-transcripts.sqlite` 持久化、`findCompatible` 与迁移合并 `mergeFrom` |
| `src/main/voice-pipeline/recognition-host.ts` | `RecognitionHost` (`timeoutMs = 120_000`, `idleTimeoutMs = 60_000`), `WorkerSpeechRecognizer` | `L23-179` | 托管 `voiceRecognitionWorker` 进程生命周期、超时终止与空闲退出 |
| `src/main/voice-pipeline/voice-recognition-worker.ts` | Worker `message` 监听（支持 `WXE_VOICE_RECOGNITION_FAKE_TEXT`） | `L9-43` | 推理子进程入口 |
| `src/main/voice-pipeline/sensevoice-recognizer.ts` | `SenseVoiceRecognizer` | `L24-58` | 懒加载 `sherpa-onnx-node` `OfflineRecognizer.createAsync` 执行推理 |
| `src/main/voice-pipeline/voice-pipeline.ts` | `VoiceSourceResolver`, `VoicePipeline` | `L13-109` | 两级缓存检查（`findCompatible` → `find(key)`）与端到端识别落盘 |
| `src/main/voice-pipeline/voice-recognition-use-case.ts` | `VoiceRecognitionUseCase` | `L29-234` | 对外统一用例门面、`accountGeneration` 账号隔离与结果广播 |
| `src/main/voice-pipeline/voice-batch-service.ts` | `VoiceBatchService` | `L65-369` | 批量转写预检、被抢占重试队列与会话级批量更新 Knowledge |
| `src/main/voice-pipeline/voice-transcription-gateway.ts` | `VoiceTranscriptionGateway`, `VOICE_TRANSCRIBE_MAX_IN_FLIGHT` (`100`), `MAX_PREEMPTION_RETRIES` (`5`) | `L11-13`, `L34-154` | Local Query API 语音转写并发上限、去重、超时等待与抢占重排 |

### 4.4 AI 检索双引擎与 POC 子域

| 仓库文件路径 | 核心导出符号 / 关键常量 | 行号范围 | 说明 |
|---|---|---|---|
| `src/shared/local-query-api.ts` | `LOCAL_QUERY_TOOL_DEFINITIONS`, `QueryCorpusScope`, `encodeMessageRef`, `decodeMessageRef`, `normalizeMessageIdentity` | `L66-94`, `L146-206` | 4 个 Query Tool Schema、语料范围定义与 `Buffer` 无关的 `messageRef` 编解码 |
| `src/shared/query-agent.ts` | `AskWechatScope`, `AskWechatEvidenceItem`, `AskWechatStats`, `QueryAgentProgressEvent`, `QueryAgentDiagnostics`, `AskWechatQueryResult` | `L13-242` | 桌面问问微信与 Agent Hub 共用的请求/进度/证据/诊断跨层契约 |
| `src/main/services/local-query-api-service.ts` | `LocalQueryApiService`, `selectTemporalCoverageEvidence`, `QUERY_FRESHNESS_WAIT_BUDGET_MS` (`15_000`), `QUERY_CATCH_UP_MIN_LAG_MS` (`120_000`) | `L71-86`, `L371-1076` | 4 工具 + 语音转写执行、Scope 强制、freshness 追赶等待与单会话直读兜底 |
| `src/main/services/query-agent-service.ts` | `QueryAgentService`, `ANSWER_RULES`, `validateToolArguments`, `MAX_TOOL_CALLS` (`5`), `MAX_EVIDENCE_ITEMS` (`40`), `EvidenceCollector` | `L20-31`, `L247-319`, `L860-881`, `L1110-1569` | Query Agent 主运行时、Host 参数与时间锁、自动扩查、证据分配与引用清洗 |
| `src/main/services/query-agent-conversation-memory.ts` | `QueryAgentConversationMemory`, `CONVERSATION_MEMORY_MAX_TURNS` (`2`), `CONVERSATION_MEMORY_TTL_MS` (`600_000`) | `L9-70` | 内存态有界多轮澄清上下文（不存原文与 Tool 结果） |
| `src/main/services/ask-wechat-service.ts` | `AskWechatService`, `buildAskWechatStats` | `L55-303` | Adapter 入口、统计组装及受控 Legacy 回退决策 |
| `src/main/services/ai-search-pipeline-service.ts` | `AiSearchPipelineService`, `isSuspiciousLocalPlan`, `DISPLAY_EVIDENCE_LIMIT` (`8`) | `L32-35`, `L68-78`, `L206-1990` | Legacy 双阶段检索管线（Query Compiler + Agent + 确定性兜底 + 流式生成） |
| `src/main/services/ai-search-agent.ts` | `runControlledSearchAgent`, `MAX_AGENT_TOOL_CALLS` (`5`) | `L3`, `L115-206` | Legacy 6 工具受控 JSON Agent 循环 |
| `src/main/services/ai-search-evidence.ts` | `buildFinalEvidence`, `buildEvidenceAggregation`, `sanitizeAnswerCitations` | `L39-287` | 证据去重/策略排序、`E#` 分配与双引擎共用的幻觉引用剥除器 |
| `scripts/run-query-agent-poc.cjs` | `pocEntry` 启动包装逻辑 | `L1-54` | 清除 `ELECTRON_RUN_AS_NODE` 并拉起已构建的 `out/main/queryAgentPoc.js` |
| `src/main/query-agent-poc-entry.ts` | `callQueryApi`, `executePocTool`, `main` | `L27-82` | CLI POC 主入口（经 Local HTTP API 复用同一 `QueryAgentService`） |
| `src/main/query-agent-poc-cli.ts` | `parsePocInvocation`, `POC_TOOL_NAMES` | `L26-97` | CLI `--scope`、`--tool`、`--args` 与 `--pretty` 参数解析 |
| `src/main/query-agent-poc-report.ts` | `formatTiming`, `formatProviderDiagnostics` | `L19-78` | stderr 耗时拆解与脱敏后的 Provider 诊断输出 |

---

## 5. 后续维护与开发指南

### 5.1 高风险常见陷阱

1. **毫秒 vs 秒的时间单位契约**：
   - `Knowledge`、`ImageTextIndex`（内存窗口与持久化）以及 `QueryEvidence` 内部统一使用 **epoch 毫秒**；而微信源库读取接口（`chat.listMessagesAsync`、`ResolvedTimeRange`）使用 **epoch 秒**。
   - 任何涉及增量下界（`DELTA_OVERLAP_MS`）、分段边界换算（`imageTextWindowToSeconds`）或 `directReadKeywordFallback`（`Math.floor(fromMs / 1000)`）的修改，必须显式核对单位，混用会导致静默读空或边界重复/漏扫且不报错。
2. **消息身份不可私自派生**：
   - `sourceMessageId(message)`（带 `local:` 前缀）是 Knowledge 写入与 Image OCR binding 共同的主键；`normalizeMessageIdentity`（剥离 `local:` 前缀）用于 `messageRef` 编解码与检索结果去重；`voiceMessageIdentity` 是语音缓存主键。改动任一处必须全链路同步，避免跨模块静默失配。
3. **派生内容与源数据的正交红线**：
   - `图片文字：`、`语音转写：` 仅用于 `searchableText` 索引匹配，展示给模型或 UI 前必须经过 `toEvidenceDisplayText()` 剥离，并通过 `derivedSource`（`'image_ocr' | 'voice_transcript'`）表达来源。严禁将派生文本写回 WCDB，也严禁在 `image_ocr_artifacts` 或 `knowledge_messages` 中写入本地文件路径或详尽错误堆栈。
4. **System OCR 跨平台与线程池约束**：
   - Windows 后端只支持 PNG 且语言包缺失时返回 HRESULT `S_OK` 的空引擎错误（`(0x00000000)`）；macOS 空白图会抛出 `No text recognized` 错误，必须保持映射为正常终态 `'empty'`（`OCR_EMPTY_RESULT`）。
   - `@napi-rs/system-ocr` 占用 Node libuv 共享线程池，默认并发为 `2`、硬上限为 `4`，调大可能挤占同进程的文件 IO 与 zlib 解压缩工作；同时打包配置必须保持 `@napi-rs/system-ocr`、`sherpa-onnx-node`、`silk-wasm` 位于 `asarUnpack` 与 external 列表中（参见 [构建脚本与打包分发](./07-build-scripts-and-packaging.md)）。
5. **待查小问题实证记录**：
   - 在 `src/main/knowledge/knowledge-store.ts:501,648,662` 中，`shortTermSearchMs` 初始化为 `0` 并在结果中返回，但短词回退耗时 `Date.now() - shortTermStartedAt` 在第 `648` 行被累加到了 `ftsMs` 而非 `shortTermSearchMs`，导致诊断字段里的 `shortTermSearchMs` 恒为 `0`。后续如需在诊断面板细分短词 LIKE 耗时，应同步累加 `shortTermSearchMs`。

### 5.2 标准扩展方式

- **新增 Query Tool**：须同步更新 `src/shared/local-query-api.ts` 的 `LOCAL_QUERY_TOOL_DEFINITIONS`、`src/main/services/local-query-api-service.ts` 的执行方法与范围校验、`src/main/services/query-agent-service.ts` 的 `validateToolArguments`/`toolResultForModel`/`EvidenceCollector`（注意过滤敏感键与重复文本），并在 `src/main/http-server.ts`（参见 [本地 HTTP API 与扩展生态](./05-http-api-and-extensions.md)）暴露对应路由。
- **新增语音识别器或音频解码器**：解码器实现 `VoiceAudioDecoder` 并注册到 `createDefaultAudioDecoderRegistry()`（`src/main/voice-pipeline/audio-decoder.ts`）；推理引擎在 Worker 侧实现 `WorkerRecognizerEngine` 并注册到 `WorkerRecognizerRegistry`（`src/main/voice-pipeline/voice-recognition-worker.ts`），同时在主进程侧通过 `SpeechRecognizerRegistry` 提供带 `modelVersion`/`modelFingerprint` 的适配器以保证缓存自动失效重算。
- **修改本地 HTTP API 与 Agent Hub 接入**：参见 [自动化引擎、日报与 AgentHub](./04-reports-automation-hub.md) 与 [本地 HTTP API 与扩展生态](./05-http-api-and-extensions.md)。

### 5.3 日常验证与诊断命令

（测试体系全景与 TS 基线门禁参见 [测试体系与质量门禁](./08-testing-and-quality-gates.md)）

```bash
# 1. 类型检查（Main / Renderer / Tests）
pnpm typecheck

# 2. Knowledge Worker 独立子进程集成验证（自动先构建再 fork out/main/knowledgeWorker.js）
pnpm test:knowledge-worker

# 3. 运行单元与集成测试（涵盖 Knowledge、OCR、Voice Pipeline 与 Query Agent）
pnpm test:unit
pnpm test:integration

# 4. Knowledge FTS5 性能与容量基准测试
pnpm benchmark:knowledge
pnpm benchmark:knowledge:capacity

# 5. Query Agent CLI POC（需先运行 TraceMemo 桌面端或开启本地 HTTP API 6131）
pnpm poc:query-agent "昨天张三在群里发的文件是什么？"
pnpm poc:query-agent:run -- --tool search_messages --args '{"query":"报价","timeRange":{"kind":"last_7_days"}}'

# 6. 知识库引用与断链自动化校验
node scripts/check-knowledge-base.mjs
```
