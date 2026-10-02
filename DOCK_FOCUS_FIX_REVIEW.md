# 修复其他窗口最小化后卷轴自动展开

## 做了什么

根因是窗口焦点恢复：卷轴默认可获得键盘焦点。其他窗口最小化后，KDE Wayland 会把焦点交回卷轴，Chromium 恢复先前聚焦的图标；`CollapsedView.tsx` 的 `onFocus` 与悬停一样调用 `open(icon)`，所以即使鼠标没有悬停，仍会发出 `expanded: true` 的尺寸请求。

仅修改 `packages/shell/src/main/windows.ts`：卷轴创建时不接受页面键盘焦点；明确鼠标按下时才允许并请求焦点，失去焦点后撤销许可。若桌面拒绝激活，在鼠标抬起时也撤销许可，避免一次失败点击留下自动恢复焦点的机会。完整面板保持可聚焦。没有拦截鼠标事件、移除前端的键盘处理或修改渲染代码。

## 契约变更

无。IPC、preload 接口、插件 manifest、存储和消息类型均未改变。

## 测试覆盖了哪些规则

- 卷轴以不可聚焦方式创建；面板仍可聚焦。
- 原生 focus 通知和鼠标移动不授予页面焦点，也不主动切换预览状态。
- 明确点击允许焦点；成功激活后鼠标抬起保留键盘操作；blur 或激活被拒绝后撤销许可。
- 鼠标事件不被 preventDefault，完整面板不使用这套焦点限制。
- `pnpm typecheck`、`pnpm test`（21 个文件、486 项）、`pnpm build:app` 和 `git diff --check` 通过。

本机 Electron 44.4.5／KDE Wayland 的独立 BrowserWindow 对照使用现有渲染构建和临时数据目录：原行为在点击卷轴、移出并收起预览、切到测试窗口再最小化后，记录到 `contents:focus` 和 `resize:true`；修复路径在测试窗口最小化后没有这两类触发，明确点击仍能发出 `shell/open-panel` 请求。测试没有卸载或修改用户的 KWin 脚本，也没有使用真实任务数据。`--disable-gpu` 和固定缩放仅用于诊断，不是产品设置。

诊断脚本与日志在 `/tmp/featherlog-focus-probe/`：`probe.mjs`、`default.log`、`fixed-scale1.log`。Wayland 下 Electron 合成鼠标事件受宿主窗口焦点和缩放影响，尝试用它自动验证首次悬停的检查未通过，不能据此声称实机悬停与所有键盘操作已经完整验收；前端悬停逻辑保持原样，需在新版本中补充实际鼠标、拖动、右键及键盘交互验收。

## 与设计文档不一致或设计文档没写清楚的地方

§9.3 规定 showInactive，但没有规定卷轴之后何时允许键盘焦点。本次只在明确点击后允许；§6.2 的交互预览及完整面板键盘交互保留。KWin 的 focusSafe 仍为 false，本次不把“抑制页面自动恢复焦点”扩张成“桌面永不激活原生窗口”的保证。

[Electron 文档](https://www.electronjs.org/docs/latest/api/base-window#winsetfocusablefocusable-macos-windows)将动态 setFocusable 标注为 macOS／Windows；其[当前 NativeWindowViews 实现](https://github.com/electron/electron/blob/main/shell/browser/native_window_views.cc)会更新 Widget 的 CanActivate。本机 Linux Wayland 动态路径已实测，但其他 Electron 版本及 Windows／macOS 仍需平台验证。KWin 脚本和契约保持原样。

## 前端需要配合的地方

本次无需前端改动。后续若扩展预览的纯键盘入口，需要明确区分用户键盘导航与桌面自动恢复焦点，不能无条件把任何 focus 都解释成展开意图。

运行旧版本的用户需要更新到包含修复的新构建后再启动。
