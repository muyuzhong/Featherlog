# 羽记 · Featherlog

一本羊皮纸任务日志，收在桌面边上的一只小卷轴里。

需要 Node.js 22.12+ 和可运行 Electron 的 Linux、Windows 或 macOS 桌面环境：

```sh
npx featherlog-app@latest
```

首次启动会下载 Electron。支持 `--help`、`--version`，其他参数交给 Electron。也可以 `npm install -g featherlog-app` 后运行 `featherlog`，用 `npm update -g featherlog-app` 更新。

启动时会自动添加带羽记图标的“Featherlog (npm)”启动入口：Linux 位于应用菜单（显示“羽记（npm）”），Windows 位于开始菜单，macOS 位于用户的 `~/Applications/Featherlog (npm).app`。之后可直接点击启动本地程序，并通过系统菜单固定到任务栏、Dock 或添加到桌面；不会覆盖安装版的入口，也不需要管理员权限。

清理 npm 缓存或更换 Node 安装位置后，请重新运行上面的命令修复快捷方式。快捷方式创建失败只在终端提示，不阻止应用启动。Linux 入口位于 `${XDG_DATA_HOME:-~/.local/share}/applications/featherlog-npm.desktop`。图标由 `resources/icon.png` 生成，维护者修改图标后用 ImageMagick 运行 `node packages/shell/scripts/gen-shortcut-icons.mjs` 更新 Windows/macOS 图标。

数据保存在系统应用数据目录下的 `Featherlog`，与桌面安装版共用，与开发版 `Featherlog-dev` 分开。删除 npm 缓存或更新 npm 包不会删除任务。npm 版由 npm 管理更新，不使用应用内的安装包更新器。

界面、主线与支线任务、每日委托、笔记和书记官等功能见 [项目主页](https://github.com/muyuzhong/Featherlog)。本包名为 `featherlog-app`；npm 上的 `featherlog` 是其他维护者的项目，与本项目无关。

MIT；随包字体的授权文本见 `licenses/`。
