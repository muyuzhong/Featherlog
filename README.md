# 羽记 Featherlog

游戏任务风格的个人面板桌面客户端。待办、学习进度、日常习惯都是"任务"。平时收起在屏幕边缘，悬停预览今日任务，点击打开完整面板。

> 早期开发中。

## 架构

"一切皆插件"：最小内核只负责送信，所有功能（包括任务面板本身）都是通过总线通信的插件。消息是纯 JSON，契约集中在 `packages/contracts`。

详见 [docs/design.md](docs/design.md)。

## 开发

需要 Node 22+ 和 pnpm。

```sh
pnpm install
pnpm typecheck
pnpm test
```
