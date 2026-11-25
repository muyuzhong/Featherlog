# AGENTS.md

羽记（Featherlog v2）是一个基于 `github.com/egoist/mygo` 的跨平台轻量桌面并发工作台：Go 原生常驻宿主（不透明 `880×520` 弹出工作台面板 `/?mode=panel` + 自适应跨平台 `312×40` 独立 3D 滚筒条 `/?mode=bar` + 跨平台单色系统托盘）+ KDE Plasma 6 底部 Dock 状态条插件（Plasmoid）+ 本机环回 HTTP 长轮询 API + 精简待办与随笔 + 本地 Unix Socket CLI Hooks（Windows 提供 GUI `featherlog.exe` 与终端 `featherlog-cli.exe` 双二进制）。

**动手之前先读 [`docs/design.md`](docs/design.md)。**

## 仓库分工

| 路径 | 职责 |
|---|---|
| `cmd/featherlog/` | Go 应用入口（`main.go`、`frontend.go`、`console_windows.go`、`console_other.go`）：含 `--show`、`--http-port`、macOS `ActivationPolicyAccessory`、Windows 控制台回退、CLI 子命令分发、前端资源装载 |
| `internal/clock/`、`internal/store/` | 可注入时钟、原子 JSON 存储与损坏保护 |
| `internal/workbench/`、`internal/tasks/`、`internal/notes/`、`internal/settings/` | 领域模型、业务规则与单元测试（含 `language`（`"zh" \| "en"`）归一化、`barX`/`barY` 自定义坐标与 `null` 重置，无害忽略历史 `barMode` 字段） |
| `internal/app/` | `mygo.Bind` 的 5 个服务（含 `DockService.Toggle`）、跨领域协调、事件推送与 IPC 命令路由 |
| `internal/dock/` | 底部居中几何、不透明面板（`featherlog-panel`）与按需创建的独立 3D 滚筒条（`featherlog-bar`）生命周期、单一自动单条策略（`NeedsMiniBarWindow` / `ShouldShowMiniBar` / `DetectKDEPlasmoid` / 400ms 防抖拖拽落盘）、Linux Wayland `gtk-layer-shell`（`purego`）、KDE KWin Script 定位与防平铺（`kwin_linux.go`）、全局快捷键 |
| `internal/tray/` | 跨平台系统托盘控制器与纯 Go 32×32 单色模板图标（中英双语状态文案与菜单，macOS 菜单栏文字 + 左键开关/右键菜单，Windows/Linux 常驻托盘菜单） |
| `internal/barhttp/` | 仅绑定 `127.0.0.1` 的本机环回 HTTP 长轮询（含 `language`）、控制 API 与外部客户端活跃探测（`HasActiveClient` / `OnClientActivity`） |
| `internal/ipcsock/` | 单实例 Unix Domain Socket（`<userData>/featherlog.sock`）协议与客户端/服务端（含 Windows `AF_UNIX` 错码与僵尸重解析点清理） |
| `plasmoid/io.github.muyuzhong.featherlog/`、`scripts/install-plasmoid.sh` | KDE Plasma 6 原生底部 Dock 状态条插件（支持中英双语）与安装脚本 |
| `frontend/` | 独立 React + TypeScript + Vite 前端（支持 `/?mode=panel` 工作台抽屉含设置浮层与 `/?mode=bar` 独立 3D 滚筒条，中英双语，构建产物 `frontend/dist`）及 `embed.go`/`noembed.go`（`package frontend` 仅用 stdlib 暴露 `DistFS()`） |
| `docs/design.md` | 架构与契约单一事实来源 |

## 硬性规则

1. **严禁彩色状态灯**：界面与文档中绝不引入红/黄/绿圆点或发光呼吸灯；并发三态（`focus` / `running` / `ready`）仅通过浮起层级、字重对比、等宽数字计时与单色反白小签条表达。
2. **时间逻辑一律通过注入的 `clock.Clock`**：`internal/workbench`、`internal/tasks`、`internal/notes`、`internal/settings` 及领域协调逻辑严禁直接调用 `time.Now()`、`time.AfterFunc()` 或 `time.NewTimer()`。
3. **纯 JSON 契约**：Go 服务与前端之间、Unix Socket IPC 以及本机环回 `internal/barhttp` 之间全部使用 camelCase 纯 JSON；时间戳统一用 Unix 毫秒（`int64`），业务日期统一用 `YYYY-MM-DD`。
4. **原子写入与损坏保护**：所有落盘通过 `internal/store` 的 `*.tmp` → `fsync` → `rename` 完成；损坏 JSON 返回带错误码的 error，不静默覆盖或删除用户文件。
5. **零 CGO & 严禁透明窗口脏绘回退**：Linux Wayland `libgtk-layer-shell.so.0` 与系统集成全部通过 `purego` 动态加载，缺失时在 KDE Wayland 上通过 KWin Scripting（`kwin_linux.go`）安全定位；弹出面板（`featherlog-panel`）与独立滚筒条（`featherlog-bar`）均固定 `Transparent: false` + 主题纯色背景。
6. **错误带机器可读错误码**：格式为 `<包名>/<原因>`（如 `workbench/not-found`、`tasks/invalid-input`、`store/corrupt`、`settings/invalid`、`barhttp/invalid-input`）。
7. **不擅改共享契约**：修改 5 个绑定服务（`WorkbenchService`、`TaskService`、`NoteService`、`SettingsService`、`DockService`）方法签名、5 类推送事件（`workbench:changed`、`tasks:changed`、`notes:changed`、`settings:changed`、`dock:toggle`）或 `internal/barhttp` 端点契约时，必须同步更新 `docs/design.md`、前端 `frontend/src/rpc/` 与 `plasmoid/`。
8. **扁平化统一任务模型**：严禁重新引入「主线 / 支线」等 RPG 等级区分；所有待办平级，按需附带自由子步骤、可选配额 `×N` 与可选每日/每周重置（`internal/tasks` 仅在存储与 RPC 层面保持 `main` / `side` / `daily` 向后兼容）。

## 代码风格

- Go：遵循标准 `gofmt`，简洁包内封装，并发访问使用显式 `sync.Mutex` 保护，标识符和注释使用英文，注释只解释"为什么"。
- Frontend：TypeScript strict、React + Vite、模块化样式，无 Tailwind 杂乱状态灯；支持 `stone`（Warm Stone）与 `graphite`（Graphite Ink）双主题。

## 测试与验收

- Go 后端测试：`go test -race ./internal/...`（前端已构建 `frontend/dist` 时运行 `go test -race ./...`；未构建时可用 `go test -race -tags noembed ./...`）。
- 必须覆盖的关键边界：
  - 单 `focus` 槽位不变量（切换焦点自动将旧焦点降为 `running`）
  - 定时提醒到期（`running` → `ready`）与睡眠恢复（操作前检测过期提醒）
  - 扁平任务创建（省略 `kind` 或传 `"task"`）、任意任务经 `Update` 开关 `recurrence`（含 `null` 清除）与省略 `kind` 的统一 `Reorder`
  - `dayStartHour` 跨天/跨周边界、睡眠恢复、周期倒退单调保护
  - 删除任务时手记解绑为随笔（`DetachTask`），不丢失内容
  - 损坏存储保护与设置损坏备份回退（含 `language` 归一化与校验、无害忽略旧版 `barMode`、`barX`/`barY` 校验、指针值相等判定与 JSON `null` 重置）
  - 底部向上展开几何（底边不变、水平居中、多屏/小屏夹紧）、收起即隐藏不退出、单一自动单条策略（`NeedsMiniBarWindow` / `ShouldShowMiniBar` / `ComputeMiniBarBounds` 含 Windows 11 任务栏物理边界坐标与 400ms 拖拽防抖）、KDE Wayland KWin Scripting 定位（同时涵盖 `featherlog-panel` 与 `featherlog-bar`）与 `libgtk-layer-shell` 缺失安全回退
  - `internal/tray` 纯 Go 32×32 单色透明模板图标、中英双语状态文案与上下文菜单（含 `语言`/`Language` 子菜单与条件显示 `重置滚筒位置`/`Reset Bar Position`）
  - `internal/barhttp` 仅绑定 `127.0.0.1`、长轮询唤醒（含 `language` 字段）、外部客户端活跃状态（35s 窗口与通知）、扁平待办计数（`todayDone/todayTotal`）、槽位切换/滚轮循环/面板开关与 `bar-http.url` 原子落盘清理
  - Unix Socket 单实例冲突、`0600` 权限、僵尸 socket（含 Windows `AF_UNIX` 错码与重解析点）自动清理与并发 CLI 请求
- 前端测试（在 `frontend/` 下）：`pnpm typecheck`、`pnpm test`、`pnpm build`。
