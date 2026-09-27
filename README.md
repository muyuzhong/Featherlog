# 羽记 Featherlog

游戏任务风格的个人面板桌面客户端。待办、学习进度、日常习惯都是"任务"。平时收起在屏幕边缘，悬停预览今日任务，点击打开完整面板。

> 早期开发中。MIT 许可证。

## 架构

"一切皆插件"：最小内核只负责送信，所有功能（包括任务面板本身）都是通过总线通信的插件。消息是纯 JSON，契约集中在 `packages/contracts`。

详见 [docs/design.md](docs/design.md)。

## 开发

需要 Node 22+ 和 pnpm。

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm dev        # 浏览器演示台：http://127.0.0.1:5173
```

演示台（`packages/playground`）在浏览器里运行外壳的界面和各插件的界面，后端由内存里的模拟总线和模拟任务服务代替，方便在 Electron 外壳就绪之前开发和预览前端。
