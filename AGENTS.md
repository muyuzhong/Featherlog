# AGENTS.md

羽记（Featherlog v2）是一个基于 `github.com/egoist/mygo` 的轻量桌面并发工作台：Go 原生常驻宿主（不透明 `880×520` 弹出工作台面板）+ KDE Plasma 6 底部 Dock 状态条插件（Plasmoid）+ 本机环回 HTTP 长轮询 API + 精简待办与随笔 + 本地 Unix Socket CLI Hooks。

**动手之前先读 [`docs/design.md`](docs/design.md)。**

## 仓库分工

| 路径 | 职责 |
|---|---|
| `main.go`、`frontend_embed.go`、`frontend_noembed.go` | Go 应用入口（含 `--show`、`--http-port`）、CLI 子命令分发、前端资源嵌入 |
| `internal/clock/`、`internal/store/` | 可注入时钟、原子 JSON 存储与损坏保护 |
| `internal/workbench/`、`internal/tasks/`、`internal/notes/`、`internal/settings/` | 领域模型、业务规则与单元测试 |
| `internal/app/` | `mygo.Bind` 的 5 个服务、跨领域协调、事件推送与 IPC 命令路由 |
| `internal/dock/` | 底部居中几何、不透明面板显隐生命周期、Linux Wayland `gtk-layer-shell`（`purego`）、KDE KWin Script 定位（`kwin_linux.go`）、全局快捷键 |
| `internal/barhttp/` | 仅绑定 `127.0.0.1` 的本机环回 HTTP 长轮询与控制 API（供 KDE Plasma 6 Dock Applet 消费） |
| `internal/ipcsock/` | 单实例 Unix Domain Socket（`<userData>/featherlog.sock`）协议与客户端/服务端 |
| `plasmoid/io.github.muyuzhong.featherlog/`、`scripts/install-plasmoid.sh` | KDE Plasma 6 原生底部 Dock 状态条插件与安装脚本 |
| `frontend/` | 独立 React + TypeScript + Vite 前端（MyGo 面板模式全铺不透明 Drawer，构建产物 `frontend/dist`） |
| `docs/design.md` | 架构与契约单一事实来源 |

## 硬性规则

1. **严禁彩色状态灯**：界面与文档中绝不引入红/黄/绿圆点或发光呼吸灯；并发三态（`focus` / `running` / `ready`）仅通过浮起层级、字重对比、等宽数字计时与单色反白小签条表达。
2. **时间逻辑一律通过注入的 `clock.Clock`**：`internal/workbench`、`internal/tasks`、`internal/notes`、`internal/settings` 及领域协调逻辑严禁直接调用 `time.Now()`、`time.AfterFunc()` 或 `time.NewTimer()`。
3. **纯 JSON 契约**：Go 服务与前端之间、Unix Socket IPC 以及本机环回 `internal/barhttp` 之间全部使用 camelCase 纯 JSON；时间戳统一用 Unix 毫秒（`int64`），业务日期统一用 `YYYY-MM-DD`。
4. **原子写入与损坏保护**：所有落盘通过 `internal/store` 的 `*.tmp` → `fsync` → `rename` 完成；损坏 JSON 返回带错误码的 error，不静默覆盖或删除用户文件。
5. **零 CGO & 严禁透明窗口脏绘回退**：Linux Wayland `libgtk-layer-shell.so.0` 与系统集成全部通过 `purego` 动态加载，缺失时在 KDE Wayland 上通过 KWin Scripting（`kwin_linux.go`）安全定位；弹出面板固定 `Transparent: false` + 主题纯色背景。
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
  - 损坏存储保护与设置损坏备份回退
  - 底部向上展开几何（底边不变、水平居中、多屏/小屏夹紧）、收起即隐藏不退出、KDE Wayland KWin Scripting 定位与 `libgtk-layer-shell` 缺失安全回退
  - `internal/barhttp` 仅绑定 `127.0.0.1`、长轮询唤醒、扁平待办计数（`todayDone/todayTotal`）、槽位切换/滚轮循环/面板开关与 `bar-http.url` 原子落盘清理
  - Unix Socket 单实例冲突、`0600` 权限、僵尸 socket 自动清理与并发 CLI 请求
- 前端测试（在 `frontend/` 下）：`pnpm typecheck`、`pnpm test`、`pnpm build`。
