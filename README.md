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

## 安装与发布

从 [GitHub Releases](https://github.com/muyuzhong/Featherlog/releases) 下载正式版：
Linux x64 使用 AppImage（赋予执行权限后运行），Windows x64 使用按用户安装的 NSIS，
macOS 按芯片选择 arm64 或 x64 的 dmg / zip。

v1 未签名：Windows 首次运行可能出现 SmartScreen 提示；macOS 需要右键应用选择“打开”。
Windows 安装版与 AppImage 会后台下载更新，退出时安装；macOS 和非 AppImage Linux
只提示前往 Release 页面下载。可在设置中关闭自动检查，手动检查仍可用。

```sh
pnpm app
pnpm --filter @featherlog/shell package:app
```

产物位于 `packages/shell/dist`。版本号只修改 `packages/shell/package.json` 的 `version`，
推送匹配的 `v<版本号>` 标签后，Actions 在三个平台构建并上传到同名草稿 Release。
维护者检查安装包及 `latest*.yml` 后手动发布；草稿和预发布版不会触发客户端更新。
