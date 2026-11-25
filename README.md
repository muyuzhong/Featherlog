# 羽记 · Featherlog v2

**跨平台自适应并发状态条（独立 3D 滚筒条 / KDE Plasma 6 原生底部 Dock 插件）+ 跨平台单色系统托盘 + 不透明弹出工作台面板 + 轻量待办与随笔 + 终端 / AI Agent CLI Hooks。**

羽记 v2 基于 [`github.com/egoist/mygo`](https://github.com/egoist/mygo) 重构为单文件原生 Go 桌面常驻宿主，支持 **Linux（KDE Plasma 6 / Wayland / X11）、Windows 11 与 macOS**，告别臃肿的 Electron 运行时与复杂游戏化系统，专注解决**多线程工作 / 多开 AI 编程任务时频繁切换、切回来断片**的问题。

---

## 核心特性

### 1. 跨平台自适应状态条 + 系统托盘 + 弹出工作台面板
- **跨平台自适应放置（`barMode`: `auto` / `standalone` / `tray-only`）**：
  - **Linux KDE Plasma 6**：原生 Plasma 6 小组件（`plasmoid/io.github.muyuzhong.featherlog/`）直接嵌在底部 Dock 中，经本机环回 HTTP 长轮询 API（`127.0.0.1:39173`，开发模式 `39174`）实时呈现活跃并发槽位、今日任务进度与面板开关；在 `auto` 模式下检测到 KDE Plasmoid 已安装或已连接时自动让位，绝不出现重复悬浮条。
  - **Windows 11 / macOS / 非 KDE Linux**：默认自动启用 **`312×40` 独立 3D 滚筒条**（`featherlog-bar`，`/?mode=bar`），以不抢焦（`ShowInactive`）方式停靠底部居中，支持自由拖拽并防抖保存坐标（Windows 11 支持直接拖放至底部任务栏空白区域），随时可通过托盘或设置一键「重置滚筒条位置」或切为「仅系统托盘图标（`tray-only`）」。
- **跨平台单色系统托盘（`internal/tray`）**：纯 Go 32×32 单色透明模板图标，自动适配深浅任务栏/菜单栏；左键快速开关工作台，右键菜单支持切焦点（最多 6 个活跃槽位）、切换常驻滚筒条模式、重置位置与退出；macOS 隐藏 Dock 图标（`LSUIElement` / `ActivationPolicyAccessory`）并在菜单栏展示 `┃ <当前焦点>` 或 `待看 N`。
- **不透明 `880×520` 弹出工作台（`featherlog-panel`，`/?mode=panel`）**：宿主默认后台常驻并隐藏弹出窗口（传入 `--show` 可启动即显示），按全局快捷键（`Alt+Shift+Space` / `CmdOrCtrl+Shift+Space`）或点击滚筒条/系统托盘/KDE 插件时立即在底部正上方 `10px` 弹出并聚焦；按 `Esc`、点收起 `⌄` 或未钉住失焦时仅隐藏窗口而不退出宿主进程。
- **零彩色发光灯设计**：绝不使用红/黄/绿亮灯，纯靠实体文具质感与单色层次清晰区分并发三态：
  - **`focus`（专注中，全局至多 1 个）**：高对比度浮起卡片与深墨主标题，聚焦你此刻手头正在推进的一件事。
  - **`running`（后台推进中）**：低对比度哑光次级卡片，右侧等宽数字（`tabular-nums`）静默计时，可一键设回看提醒（`+10m` / `+20m` / `+45m`）。
  - **`ready`（待看）**：后台跑完或到点提醒后，右侧出现克制醒目的单色反白小签条 `待看`，低头 0.3 秒定位。
- **一句话断点备忘（Breadcrumb）**：每张卡片原位记录「下一步干嘛 / 等什么结果」，回车或失焦即存，悬停状态条或托盘即可预览，切回来零恢复成本。
- **双中性主题**：Warm Stone（`#F6F5F2` 温润纸石浅色）与 Graphite Ink（`#131416` 石墨暗色），工作台面板与独立滚筒条不透明底色与主题同步，支持 `Ctrl+P` 钉住面板（Pin）。

### 2. 精简待办 + 随笔手记
- **扁平待办清单**：不再区分「主线 / 支线」等级，所有任务平级统一管理；每条任务均可按需附带自由子步骤（任意顺序勾选、无顺序锁）、可选配额计数（`×N` 内联 `+1` / `-1`）与可选每日/每周重置（`dayStartHour` 跨周期自动重置与睡眠恢复），一键将任意任务推上并发工作槽。
- **随笔与手记**：无弹窗原位落笔，支持全文检索与任务关联；删除任务时其手记自动转为独立随笔，绝不丢字。

### 3. 本地 Unix Socket CLI（AI Agent / 终端 Hooks）
在 Linux 与 macOS 上，同一个 `featherlog` 二进制既是桌面客户端，也是终端命令行工具；在 Windows 发布包中则同时提供无黑框 GUI 宿主 **`featherlog.exe`**（`-H=windowsgui`）与同步终端命令行工具 **`featherlog-cli.exe`**（适合 PowerShell、`cmd` 与 AI Agent Hooks 稳定获取 stdout 与退出码）。所有平台均通过本机 `<userData>/featherlog.sock`（Unix `AF_UNIX`）与桌面端实时同步，未运行桌面端时亦可安全直连本地存储：

```sh
# 后台启动桌面宿主与 127.0.0.1:39173 环回 API（若已在运行，则切换面板显隐）
featherlog

# 启动并立即弹出 880×520 工作台面板（可用 --http-port 覆盖环回端口）
featherlog --show

# 查看当前所有并发槽位（支持 --json）
featherlog status
featherlog status --json

# 聚焦当前工作（原有 focus 槽位自动降级为 running）
featherlog focus "实现 OAuth 回调" --tag "Backend" --note "先补 token 刷新单测"

# 挂起后台任务并设置 15 分钟回看提醒
featherlog run "Claude 重构前端" --tag "Featherlog" --remind 15m --note "等 vitest 全绿"

# AI / CI 跑完后通知桌面卡槽与 KDE Dock 切为「待看」
featherlog ready "前端" --note "构建通过，等待核对视觉细节"

# 结束并移出槽位（加 --complete-task 可一并完成关联任务）
featherlog done "OAuth"

# 随手记一条随笔
featherlog note "KDE Wayland 下通过 KWin Script 精准锚定在底部 Dock 上方 10px"
```

### 4. 跨平台桌面适配（Linux Wayland / KDE、Windows 11、macOS）
- **不透明原生渲染**：弹出工作台（`featherlog-panel`）与独立 3D 滚筒条（`featherlog-bar`）均采用 `Transparent: false` + 主题纯色背景，避免 Intel+NVIDIA 双显卡下 WebKitGTK 透明窗口局部脏区重绘问题，无需强制 `GDK_BACKEND=x11`。
- **Linux 双层 Wayland 定位策略（零 CGO）**：
  - 安装了 `libgtk-layer-shell.so.0` 时通过 `purego` 动态加载，使用 `wlr-layer-shell` 底边居中锚定。
  - 在 KDE Plasma 6 Wayland 缺失 `libgtk-layer-shell.so.0` 时，自动加载 KWin Scripting 定位脚本（`<userData>/kwin/featherlog-panel.js`，经 `qdbus6` / `qdbus` / `gdbus` 管理），将 `"featherlog-panel"` 保持置顶、全桌面可见、禁止平铺，并始终置于底部 Dock 上方 `10px` 水平居中，退出时自动卸载。
- **Windows 11 & macOS 原生体验**：
  - Windows 发布包内含 GUI `featherlog.exe`（无控制台黑框）与 `featherlog-cli.exe`（同步 CLI），支持 Windows 11 任务栏物理边界拖拽停靠与 Windows `AF_UNIX` 单实例/僵尸套接字恢复。
  - macOS `.app` 配置 `LSUIElement = true` 与 `ActivationPolicyAccessory` 隐藏 Dock 图标，弹出面板与独立滚筒条启用原生 `Panel` 模式可覆盖全屏 Space 且不抢占原应用焦点。
- **本机环回 HTTP API（`internal/barhttp`）**：仅绑定 `127.0.0.1`（默认生产 `39173`、开发/自定义 `--data-dir` `39174`，可通过 `--http-port` 或 `FEATHERLOG_HTTP_PORT` 覆盖），支持 `/api/bar` 长轮询、外部客户端活跃探测（自动控制独立滚筒条让位）、`/api/panel/toggle`、`/api/slot/{focus,cycle,state,done}`，并将活跃地址原子写入 `<userData>/bar-http.url`。

---

## 快速构建与安装

需要 Go `1.24+`（推荐 Go `1.27`）与 Node `22+` / `pnpm`。

### 生产构建（单文件二进制，内嵌 `frontend/dist`）

```sh
# 1. 构建前端产物到 frontend/dist
cd frontend && pnpm install && pnpm build && cd ..

# 2. 编译单文件二进制（零 CGO，自动 embed frontend/dist）
CGO_ENABLED=0 go build -o featherlog ./cmd/featherlog

# 3. （KDE Plasma 6）安装/升级底部 Dock 小组件
./scripts/install-plasmoid.sh
```

### 开发模式（Vite HMR 热更新）

```sh
# 终端 1：启动前端开发服务器（默认 http://localhost:5173）
cd frontend && pnpm dev

# 终端 2：启动 MyGo 桌面宿主连接 dev server（数据隔离在 Featherlog-dev，环回 API 默认 127.0.0.1:39174）
go run -tags noembed ./cmd/featherlog --dev --show
```

### 运行测试

```sh
# Go 领域层 + 宿主层单元测试（含竞态检测）
go test -race ./internal/...

# 含 cmd/featherlog CLI 测试（已构建 frontend/dist 时无需 -tags noembed）
go test -race -tags noembed ./...

# 前端类型检查与单测
cd frontend && pnpm typecheck && pnpm test
```

---

## 架构文档

完整架构、领域不变量、RPC 契约与平台适配细节见 [`docs/design.md`](docs/design.md)，协作与开发规范见 [`AGENTS.md`](AGENTS.md)。

## 许可证

[MIT](LICENSE)
