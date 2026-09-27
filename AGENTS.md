# AGENTS.md

羽记（Featherlog）是一个 Electron 桌面客户端，采用"一切皆插件"的架构：最小内核只负责送信，所有功能都是通过总线通信的插件。

**动手之前先读 `docs/design.md`。** 类型契约在 `packages/contracts`。

## 分工

| 目录 | 负责方 |
|---|---|
| `packages/kernel/` | Codex |
| `packages/shell/src/main/`、`packages/shell/src/preload/` | Codex |
| `plugins/*/src/main/` | Codex |
| `packages/shell/src/renderer/`、`plugins/*/src/ui/` | Claude（前端） |
| `packages/contracts/`、`plugins/*/manifest.json`、`docs/` | 共享接口，修改需审查 |

**不要修改前端目录。** 如果后端工作需要前端配合，在 PR 描述里写明。

## 硬性规则

1. **模块之间不得互相 import。** 插件只能 import `@featherlog/contracts` 和第三方库。插件之间、插件与外壳之间只通过总线通信。
2. **内核不认识任何具体消息类型。** `packages/kernel` 里不能出现 `quest/`、`shell/` 这类字符串（测试除外）。
3. **消息必须是纯 JSON**：不用 `undefined`、`Date`、`Map`、类实例、函数。时间用 ISO 字符串或毫秒数。
4. **契约只加不改。** 需要修改 `packages/contracts` 或 `manifest.json` 时，PR 描述里必须有单独的"契约变更"一节，列出每处改动和原因。不要为了让实现方便而悄悄修改契约。
5. **时间相关逻辑一律通过注入的 `Clock`**，不直接调用 `Date.now()` 或全局 `setTimeout`。
6. 插件只通过 `ctx.storage` 存储数据，不直接读写文件系统。
7. `packages/kernel` 没有运行时依赖，也不依赖 Electron 或 Node 专有 API，在 Node 和浏览器里都能运行。

## 代码风格

- TypeScript strict、ESM、只用具名导出。
- 不用 `any`；确实需要时用 `unknown` 加类型收窄。
- 相对路径 import 不带扩展名。
- 标识符和注释用英文；注释只写"为什么"，不复述代码。
- 错误要带 `code`：内核错误用 `KernelErrorCode`，插件错误用 `<插件id>/<原因>`。

## 测试

- 使用 vitest，测试文件和源码放在一起：`foo.ts` 对应 `foo.test.ts`。
- `docs/design.md` 里写明的每条行为规则都要有对应的测试，尤其是边界情况：超时、没有应答者、重复注册、卸载清理、跨天、跨周、`dayStartHour` 边界、笔记本睡眠后恢复。
- 时间相关的测试使用模拟时钟。

## 提交 PR

- 每个 PR 只做一件事。
- 合并前必须通过 `pnpm typecheck` 和 `pnpm test`。
- PR 描述包含：
  - 做了什么
  - 契约变更（没有就写"无"）
  - 测试覆盖了哪些规则
  - 与设计文档不一致或设计文档没写清楚的地方（这一节很重要，不要自己猜着实现）
