# 扩展 API 参考（v1）

## manifest.json

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `manifestVersion` | 是 | 固定 `1` |
| `id` | 是 | 反向域名，小写；禁止 `com.tracememo.` / `tracememo.` / `tm.` 前缀 |
| `name` | 是 | 展示名，≤ 64 字 |
| `version` | 是 | `x.y.z`（可带 prerelease） |
| `apiVersion` | 是 | 必须为 `1` |
| `minAppVersion` | 否 | 低于该版本拒绝安装 |
| `description` / `author` / `homepage` | 否 | 展示用；homepage 仅接受 http(s) |
| `permissions` | 是 | 见权限表；未知权限直接判 manifest 非法 |
| `entrypoints.page` | 二选一 | 页面 HTML 相对路径 |
| `entrypoints.background` | 二选一 | 后台入口相对路径 |
| `subscriptions` | 条件 | 申请 `messages.subscribe` 时必填 |
| `contributions.pages` | 否 | `[{ id, title, entry? }]`，`id` 形如 `settings` |
| `contributions.automationActions` | 否 | `[{ id, title, description? }]`，有此项必须提供 background |

路径规则：相对路径、不允许 `..`、反斜杠、盘符、控制字符、Windows 保留名；
安装时还会用 realpath 复核入口仍在扩展目录内。

## 权限

| 权限 | 风险 | 能力 |
| --- | --- | --- |
| `messages.subscribe` | 高 | 接收 `message.received` |
| `messages.query` | 高 | `tm.messages.query` |
| `contacts.list` | 中 | 配置页读取群列表（`contacts.listGroups`），不含聊天内容 |
| `wechat.send.text` | 高 | `tm.wechat.send`（文本）与自动化 `reply` |
| `wechat.send.image` | 高 | `tm.wechat.send({ type: 'image' })` |
| `wechat.send.video` | 高 | `tm.wechat.send({ type: 'video' })`，原生 Host 走 `/SendMsg` video |
| `wechat.send.voice` | 高 | `tm.wechat.send({ type: 'voice' })`，支持传入 `text` 用宿主 TTS 音色合成发送或传入音频 `path` |
| `ai.chat` | 中 | `tm.ai.chat` |
| `storage` | 低 | `tm.storage.*` 与页面存储 |
| `automation.action` | 中 | `tm.automation.registerAction` |
| `secrets` | 中 | `tm.secrets.*`（系统安全存储保存扩展私有凭据，不写明文） |

安装时只自动授予**低风险**权限；其余在「启用」确认后授予。停用后回落到低风险集合。

## 后台 API

### tm.extension

- `id: string`
- `dataDir: string`（扩展私有数据目录，媒体文件写这里才能通过发送校验）
- `permissions: string[]`（当前已授予）

### tm.page

```ts
tm.page.onRequest(method, (params) => {
  // 返回纯 JSON 值；单次响应体上限 64KB，超时上限 90s
  return { ok: true }
})
```

- 注册同扩展页面通过页面桥 `extension.request` 发起的请求处理器；
- 方法名须匹配 `/^[a-z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+){0,3}$/`，同一方法名不可重复注册。

### tm.secrets

```ts
await tm.secrets.set('cookie', '...')
await tm.secrets.get('cookie')    // → string | null
await tm.secrets.has('cookie')    // → boolean
await tm.secrets.delete('cookie') // → void
```

- 需声明并授予 `secrets` 权限，底层使用 Electron `safeStorage` 加密保存在 `<userData>/extensions-state/secrets/<id>.bin`（不支持加密时直接报错，不降级明文）；
- 单个扩展最多保存 `32` 个键，键名匹配 `/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/`，单值上限 `8KB`；
- 注：`host-runtime.ts` 中 `tm.secrets.delete` 执行后无返回值，运行期签名固定为 `Promise<void>`。

### tm.events

- `on('message.received', handler): () => void`
- `off('message.received', handler): void`

事件字段见 `TraceMemoMessageEvent`：`eventId / accountId / conversationId / messageId /
senderId? / senderName? / isGroup / isSelf / type / text? / mentionsMe / timestamp(ms)`。

### tm.messages.query

```ts
await tm.messages.query({ conversationId, startTime?, endTime?, limit? })
// → { messages: [{ messageId, conversationId, senderId?, senderName?, isSelf, type, text?, timestamp }] }
```

- 时间参数是 **epoch 毫秒**；默认最近 24 小时。
- 单次窗口最多 **35 天**，`limit` 上限 **500**（默认 `50`）。
- 数据库未连接时抛 `DATABASE_NOT_READY`。

### tm.wechat.send

```ts
// 文本
await tm.wechat.send({ to, text, at?, dedupeKey? })

// 图片
await tm.wechat.send({ type: 'image', to, path: '/abs/path/cover.png', dedupeKey? })

// 视频（原生 Host 以 {toWxid, type:'video', msg:<路径>} 提交）
await tm.wechat.send({ type: 'video', to, path: '/abs/path/clip.mp4', dedupeKey? })

// 语音（传 text 由宿主用已配置的 TTS 音色合成发送，或传 path 发送音频文件）
await tm.wechat.send({ type: 'voice', to, text: '你好呀', voiceId?, dedupeKey? })
// → { actionId, status: 'sent' }
```

按顺序检查：权限 → 参数（文本 ≤ 2000 字）→ manifest 会话范围 → 频率
（同扩展 2 秒一条、每分钟 10 条）→ 本机发送能力 → 授权校验 → Gateway。
任何一步不通过都抛带错误码的异常，不会「静默丢弃」。

媒体路径额外约束：

- 必须是**绝对路径**的普通文件，realpath 后仍位于**扩展数据目录**或**系统临时目录**；
- 大小 1B–100MB；
- 图片扩展名：jpg/jpeg/png/gif/webp/bmp；视频扩展名：mp4/mov/m4v；
- 视频走 `type: 'video'`，不复用图片通道；发送失败不会降级成图片。

### tm.ai.chat

```ts
await tm.ai.chat([{ role: 'user', content: '...' }])
// → { text }
```

使用 TraceMemo 已配置的 AI Provider；扩展拿不到 API Key。

### tm.storage

```ts
await tm.storage.set('config', { ... })
await tm.storage.get('config')
await tm.storage.remove('config')
await tm.storage.list()
```

键：`[A-Za-z0-9._-]{1,64}`；单值 ≤ 256KB，总量 ≤ 1MB；只接受 JSON 值。

### tm.automation.registerAction

```ts
tm.automation.registerAction({ id, title, description?, inputSchema?, handler })
```

`id`：`[a-z0-9][a-z0-9._-]{1,63}`。`handler` 返回：

```ts
{ success: boolean, output?: object, reply?: { type: 'text', text, at? }, error?: string }
```

`inputSchema` 支持顶层 `type: 'object'` 与最多 `24` 个 `properties`（整体 JSON ≤ `4KB`），字段类型支持 `string | number | integer | boolean`，支持 `required`、`title`、`description`、`enum`、`default`、`minimum`、`maximum`、`minLength`、`maxLength` 约束；运行期执行 `invokeAction` 时会在子进程按 `inputSchema` 校验输入（注：当前 `src/main/extensions/host-runtime.ts` 发送的 `register-action` IPC 消息仅携带 `hasInputSchema` 布尔标记，未直接携带完整 `inputSchema` 对象）。

执行超时默认 15 秒（宿主可配，最大 60 秒），超时返回 `ACTION_TIMEOUT`。

### tm.capabilities.get

返回只读快照：`extensionId / enabled / permissions / platform / databaseReady / send{...} / ai{...} / tts?`（含可选的文字转语音 `configured / model / selectedVoiceId / selectedVoice` 状态）。

### tm.log

`info / warn / error`，写入扩展日志（详情页可见，最多保留 200 条，单行 ≤ 500 字）。

## 页面桥

页面 → 宿主：

```ts
{ source: 'tracememo-extension-page', extensionId, requestId, method, params }
```

宿主 → 页面：

```ts
{ source: 'tracememo-extension-host', requestId, ok: true, result }
{ source: 'tracememo-extension-host', requestId, ok: false, error: { code, message } }
```

页面方法白名单：`storage.get|set|remove|list`、`capabilities.get`、`contacts.listGroups`、`extension.request`、`extension.info`。
其中 `extension.request` 仅在扩展已启用且后台进程运行时可用，由宿主将其路由到同扩展后台通过 `tm.page.onRequest` 注册的处理器。
页面不能直接发送微信消息、不能查询消息、不能直接读写 `secrets`、不能调用 AI。

## 错误码

| 码 | 含义 |
| --- | --- |
| `EXTENSION_NOT_FOUND` | 扩展不存在 / 已卸载 |
| `EXTENSION_DISABLED` | 扩展未启用 |
| `EXTENSION_INCOMPATIBLE` | apiVersion 或 minAppVersion 不满足 |
| `EXTENSION_ALREADY_INSTALLED` | 已安装同名扩展或开发目录已链接 |
| `EXTENSION_INSTALL_FAILED` | 扩展安装或升级失败 |
| `EXTENSION_INVALID_MANIFEST` | manifest 不合法 |
| `EXTENSION_INVALID_PATH` | 入口 / 资源 / 开发目录路径越界 |
| `EXTENSION_HOST_UNAVAILABLE` | 后台进程未运行 |
| `PERMISSION_DENIED` | 未授予权限，或超出声明范围 |
| `CAPABILITY_UNAVAILABLE` | 本机能力不具备（未绑定 / 未就绪 / 安全存储不可用） |
| `LICENSE_REQUIRED` | 无有效授权 |
| `DATABASE_NOT_READY` | 微信数据库未连接 |
| `SEND_NOT_SUPPORTED` | 当前平台或内容类型不支持 |
| `ACTION_TIMEOUT` | 处理超时 |
| `ACTION_FAILED` | 执行失败 |
| `RATE_LIMITED` | 触发频率限制 |
| `INVALID_REQUEST` | 参数非法 |
| `STORAGE_LIMIT_EXCEEDED` | 存储超限 |
| `EXTENSION_REGISTRY_UNREADABLE` | 扩展状态文件损坏且无法恢复；写入已拒绝并保留现场 |
| `EXTENSION_STORAGE_CORRUPTED` | 扩展配置或私有凭据损坏且无可用备份；读写暂停 |
| `EXTENSION_SOURCE_MISSING` | 开发模式源码目录被移动或删除；Registry 与配置保留 |
| `EXTENSION_PROJECT_EXISTS` | 目标目录非空或不可写；创建/导出项目被拒绝 |
| `EXTENSION_MODIFIED_LOCALLY` | 检测到模板安装副本已被本地修改，拒绝自动覆盖 |

## 自动化动作输入

规则里保存的静态 `input` 会与宿主注入字段合并，同名键以宿主为准：

```json
{
  "url": "https://example.com/video",
  "conversationId": "xxx@chatroom",
  "isGroup": true,
  "accountId": "wxid_self",
  "message": { "eventId": "message:...", "text": "...", "mentionsMe": false }
}
```
