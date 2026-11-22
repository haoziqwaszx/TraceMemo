# @tracememo/extension-sdk

TraceMemo 扩展 SDK v1 的**类型定义**。运行期不需要安装或打包这个包：宿主在扩展后台进程里注入全局 `tm`。

## 用法

把 `index.d.ts` 复制进扩展仓库（或作为 devDependency），然后：

```ts
import type { TraceMemoApi } from './extension-sdk'

module.exports = function activate(tm: TraceMemoApi): void {
  tm.events.on('message.received', async (event) => {
    if (event.isSelf || event.type !== 'text') return
    if (!event.text?.includes('你好')) return
    await tm.wechat.send({ to: event.conversationId, text: '你好呀！', dedupeKey: event.eventId })
  })
}
```

## 约定

- 所有能力都要在 `manifest.json` 里声明权限；未声明的调用返回 `PERMISSION_DENIED`（私有凭据需声明 `secrets` 权限并通过 `tm.secrets` 访问）。
- 后台是**独立 Node 子进程**，不是强沙箱：安装即表示信任该扩展代码。
- 页面运行在 `sandbox="allow-scripts"` 的 iframe 里，只能通过 postMessage 调用
  `storage.*` / `capabilities.get` / `contacts.listGroups` / `extension.request` / `extension.info`，不能直接发送微信消息；其中 `extension.request` 会转发给同扩展后台通过 `tm.page.onRequest` 注册的处理器。
- 发送永远经过宿主 Gateway：权限、授权校验、限流、审计与幂等都在宿主侧执行。
