# 羽记 Featherlog v2 设计文档

> 状态：v2 正式设计（基于 `github.com/egoist/mygo` 的不透明弹出工作台面板 + KDE Plasma 6 原生底部 Dock 插件 + 本机环回 HTTP API + 本地 CLI Hooks）。
> 本文档定义羽记 v2 的架构、领域不变量、RPC 与 HTTP 契约、Linux Wayland 定位策略与本地 Unix Socket 协议。

---

## 1. 产品定位与演进

羽记 v2 从旧版 Electron 羊皮卷游戏化任务面板重构为 **轻量级原生并发工作台**：

- **核心场景**：同时推进多个任务或 AI Agent 编排线程（例如正在手写功能 A、后台 Agent 跑测试 B、等 CI/审 PR C），在切换上下文时不再忘事或断片。
- **核心交互形态**：
  1. **常驻底部 Dock 状态条（KDE Plasma 6 Bottom Dock Applet）**：原生 Plasma 6 小组件（`plasmoid/io.github.muyuzhong.featherlog/`）直接嵌在 KDE 底部浮动 Dock 内，单行高密度展示活跃并发槽位（`WorkSlot`）、今日任务进度与面板开关；滚轮快速切焦点、单击未聚焦槽位即切焦点、单击当前焦点槽位或箭头弹出/收起工作台。
  2. **弹出工作台面板（`MyGo` Opaque Workspace Panel）**：固定 `880×520px` 不透明无边框弹出窗口（标题 `featherlog-panel`），后台常驻、默认启动隐藏（传 `--show` 可立即显示），点击 KDE Dock 插件或按全局快捷键 `Alt+Shift+Space` 时弹出并聚焦在底部 Dock 正上方 `10px` 处；按 `Esc`、点收起 `⌄` 或未钉住失焦时立即隐藏窗口而不退出宿主进程。
  3. **CLI / Agent Hooks**：单文件二进制 `featherlog` 同时是桌面宿主与终端 CLI，通过本机 Unix Socket（`<userData>/featherlog.sock`）实时操作并发槽与随笔，AI 助手或构建脚本可直接汇报进度并同步刷新 KDE Dock 状态条与弹出面板。

### 1.1 视觉与美学铁律

- **严禁彩色发光状态灯（Zero Colored Status LEDs）**：不使用红/黄/绿圆点、呼吸灯或霓虹边框表示状态。
- **并发三态的无彩灯层次表达**：
  - `focus`（专注中，全局至多 1 个）：高对比度实心浮起卡片，在卡槽中微微向上探出，深墨主标题与 Medium/Semibold 字重。
  - `running`（后台推进中）：低对比度哑光次级卡片，右侧 `tabular-nums` 等宽显示已运行分钟数；设有提醒倒计时时仅在底边绘制极细 `1px` 单色刻度线。
  - `ready`（待看 / 到点提醒回看）：卡片右侧高对比度**单色反白小签条**（浅色主题深炭底暖白字，深色主题暖白底深炭字）。
- **双中性主题**：`stone`（Warm Stone 温润纸石浅色，默认）与 `graphite`（Graphite Ink 石墨暗色），内外严格满足同心圆角几何与临界阻尼物理弹簧过渡。

---

## 2. 系统架构

```
┌─────────────────────────── featherlog 二进制 (Go + MyGo) ────────────────────────────┐
│                                                                                      │
│  main.go ──┬── 无子命令 ──► MyGo 桌面常驻宿主                                          │
│            │                   ├─ 不透明 880×520 弹出工作台 ("featherlog-panel")       │
│            │                   │   ├─ WebView 加载 frontend/dist (embed) 或 dev URL   │
│            │                   │   ├─ window.mygo + __FEATHERLOG_MYGO__              │
│            │                   │   └─ internal/dock (layer-shell / KWin Script 定位) │
│            │                   ├─ internal/barhttp (127.0.0.1:39173/39174 长轮询 API) │
│            │                   │       ▲                                             │
│            │                   │       └── KDE Plasma 6 Dock Applet (plasmoid/)      │
│            │                   ├─ internal/app (5 个 mygo.Bind 服务 + 5 类事件广播)   │
│            │                   ├─ internal/ipcsock (<userData>/featherlog.sock)      │
│            │                   └─ 领域与存储层:                                       │
│            │                       internal/{clock,store,workbench,tasks,notes,      │
│            │                                 settings}                               │
│            │                                                                         │
│            └── CLI 子命令 (status/focus/run/ready/done/note/toggle)                  │
│                    └── 优先经 Unix Socket 通知运行中实例；未运行时安全直连本地存储    │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 目录结构

| 路径 | 职责 |
|---|---|
| `main.go` | 统一入口：CLI 参数解析（含 `--show`、`--http-port`）、单实例协调、`MyGo` 常驻宿主与 `barhttp` 启动 |
| `frontend_embed.go` / `frontend_noembed.go` | `embed.FS` 嵌入 `frontend/dist`（生产/默认构建）与无嵌入回退（纯 Go 测试/开发） |
| `internal/clock/` | 可注入时钟接口（`Now()`、`AfterFunc()`），真实时钟与确定性测试假时钟 |
| `internal/store/` | 原子 JSON 持久化（`*.tmp` → `fsync` → `rename`）、损坏文件保护（`store/corrupt`）、目录隔离（`Featherlog` / `Featherlog-dev`） |
| `internal/workbench/` | 并发工作槽领域逻辑、单焦点不变量、提醒定时器与睡眠恢复 |
| `internal/tasks/` | 扁平化精简任务（无主线/支线等级；可选自由子步骤、可选配额 `×N`、可选每日/每周重置）、`dayStartHour` 跨周期与单调保护 |
| `internal/notes/` | 随笔与任务手记（`1..20000` 字）、大小写不敏感检索、任务删除解绑（`DetachTask`） |
| `internal/settings/` | 应用设置校验（`settings/invalid`）与损坏备份恢复（`settings.json.corrupt-<ms>-<id>`） |
| `internal/app/` | 组合根与 5 个 `mygo.Bind` 服务、跨领域协调、WebView 实时事件推送、IPC 命令路由 |
| `internal/dock/` | 底部居中几何、不透明 `880×520` 面板显隐生命周期、Linux Wayland `gtk-layer-shell`（`purego`）、KDE KWin Script 定位（`kwin_linux.go`）、全局快捷键 |
| `internal/barhttp/` | 仅绑定 `127.0.0.1` 的本机环回 HTTP 长轮询与控制 API（供 KDE Plasma 6 Dock Applet 调用） |
| `internal/ipcsock/` | 单实例 Unix Domain Socket 服务/客户端（`0600` 权限、僵尸 socket 清理、换行分隔 JSON 协议） |
| `frontend/` | 独立 React + TypeScript + Vite 前端（MyGo 面板模式全铺不透明 Drawer，构建输出 `frontend/dist`） |
| `plasmoid/io.github.muyuzhong.featherlog/` | KDE Plasma 6 原生底部 Dock 状态条小组件（QML + 长轮询客户端，无彩色状态灯） |
| `scripts/install-plasmoid.sh` | Plasma 6 小组件幂等安装/升级脚本（`kpackagetool6`） |

### 2.2 架构约束

1. **所有时间逻辑必须经由注入的 `clock.Clock`**：领域层严禁直接调用 `time.Now()`、`time.AfterFunc()` 或 `time.NewTimer()`。
2. **所有跨进程/前后端载荷均为纯 JSON**：字段统一 camelCase；时间戳统一为 Unix 毫秒整数（`int64`）；业务日期统一为 `YYYY-MM-DD`。
3. **错误带机器可读错误码**：格式为 `<package>/<reason>`（例如 `store/corrupt`、`workbench/not-found`、`tasks/invalid-input`、`notes/invalid-content`、`settings/invalid`）。
4. **原子写入与损坏保护**：所有持久化写入采用临时文件 + `fsync` + 原子 `rename`；遇到损坏的 JSON 文件时返回错误码，绝不静默覆盖或删除用户数据（设置文件先备份为 `settings.json.corrupt-<ms>-<id>` 再回退默认值）。

---

## 3. 领域模型与不变量

### 3.1 并发工作槽（`internal/workbench`）

`WorkSlot` 字段：`id`、`title`、`state`（`focus | running | ready`）、`breadcrumb`（一句话断点备忘）、`tag?`、`linkedTaskId?`、`stateChangedAt`、`remindAt?`、`order`、`createdAt`、`updatedAt`。

核心规则：
- **单焦点不变量**：任意时刻至多存在 1 个 `state == "focus"` 的槽位。将任意槽位设为 `focus`（新建或状态流转）时，原 `focus` 槽位自动降级为 `running` 并刷新 `stateChangedAt`。
- **回看提醒定时器**：对 `running` 槽位设置 `remindInMinutes` 时，记录 `remindAt = now + duration` 并通过注入 `Clock.AfterFunc` 调度定时回调；到期后自动从 `running` 转为 `ready`、清除 `remindAt`、原子落盘并通知变更监听者推送 `workbench:changed`。
- **睡眠恢复**：启动时与每次读写操作前均检查过期提醒（`remindAt <= clock.Now()`），确保笔记本休眠唤醒后不漏提醒。
- **任务联动**：`WorkbenchService.Complete` 支持可选 `completeLinkedTask: true`，在移除活跃槽位的同时将关联任务标记完成。

### 3.2 扁平精简任务（`internal/tasks`）

所有任务均为平级待办，不再区分「主线 / 支线」RPG 等级，移除旧版角色属性、剧情简报、揭晓遮罩与顺序锁；任意任务均可按需附带自由子步骤清单、配额计数（`×N`）与每日/每周重置。

核心规则：
- **扁平模型与向后兼容**：`Create` 省略 `kind`（或传入 `"task"`）时默认按普通任务创建（内部兼容存为 `"side"`；若同时传入 `recurrence` 则自动启用周期重置并归为 `"daily"`）。为保证历史持久化文件与已有 RPC 调用零破坏，`Create`、`Reorder` 与持久化校验仍兼容接受 `"main"`、`"side"`、`"daily"`。
- **自由子步骤**：`items` 可按任意顺序勾选、增删、改名，不设顺序锁。
- **可选配额步进（`×N`）**：任务本体与子项均支持可选配额 `{ current, target }`，`StepQuota(delta)` 支持 `+1`/`-1` 步进，达到目标自动完成。
- **任意任务可开关周期重置**：通过 `Update` 传入 `recurrence: { freq: "daily" | "weekly", weekdays? }` 即可为任意任务开启每日/每周重置（自动切入周期重置语义）；传入 `recurrence: null` 即可关闭重置并恢复为普通任务。
- **统一排序（`Reorder`）**：`Reorder` 省略 `kind` 时直接按 `ids` 对扁平任务列表排序（指定 `kind` 时保留按分类排序的向后兼容行为）。
- **周期与 `dayStartHour`**：默认 `dayStartHour = 4`。周期键 `periodKey` 为 `now - dayStartHour 小时` 在本地时区的 `YYYY-MM-DD`。启动时、通过 `Clock` 定时到下一边界、以及**每次操作前**均检测跨周期；发现周期前进时重置开启了周期重置的任务进度并广播 `tasks:changed`。
- **单调倒退保护**：当系统时钟回调或用户修改 `dayStartHour` 导致计算的周期键早于已记录周期键时，保留已有周期进度与历史记录，不触发跨周期重置。
- **连续记录（`streak`）**：对开启周期重置的任务仅正向统计应做周期的连续完成数，断签无惩罚。

### 3.3 随笔与手记（`internal/notes`）

- 纯文本内容 trim 后长度限制 `1..20000` 字符。
- `taskId == nil` 为独立「随笔」，非空为挂载在任务下的「手记」。
- 支持按 `taskId` 与大小写不敏感 `query` 组合检索。
- **删除任务不删手记**：`TaskService.Delete` 成功后，`internal/app` 协调调用 `notes.DetachTask(taskID)`，将该任务下的所有手记转为独立随笔并广播 `notes:changed`。

### 3.4 设置（`internal/settings`）

| 字段 | 类型 | 合法值 | 默认值 |
|---|---|---|---|
| `theme` | `string` | `"stone"` \| `"graphite"` | `"stone"` |
| `dayStartHour` | `int` | `0..23` | `4` |
| `sound` | `bool` | `true` \| `false` | `true` |
| `volume` | `int` | `0..10` | `5` |
| `pinned` | `bool` | `true` \| `false` | `false` |

修改 `dayStartHour` 时立即通知 `tasks` 更新周期配置；修改 `pinned` 时立即同步到 `dock.Controller`。

---

## 4. 前后端 RPC 契约与事件推送

### 4.1 MyGo 绑定与双桥接暴露

后端在 `App.Run()` 之前通过 `mygo.Bind` 注册 5 个服务结构体：

1. `WorkbenchService`：`List`, `Create`, `Update`, `SetState`, `Complete`, `Reorder`
2. `TaskService`：`List`, `Create`, `Update`, `SetItems`, `ToggleItem`, `StepQuota`, `Complete`, `Delete`, `Reorder`
3. `NoteService`：`List`, `Create`, `Update`, `Delete`
4. `SettingsService`：`Get`, `Update`
5. `DockService`：`Resize`, `Quit`

MyGo 在页面文档加载起点注入 `window.mygo`：
- 方法调用：`window.mygo.call("ServiceName.MethodName", ...args)`
- 事件订阅：`window.mygo.on("event:name", handler)` / `window.mygo.once("event:name", handler)`
- 支持运行 `MYGO_GENERATE=<path>` 导出强类型 TypeScript 客户端。

同时，宿主通过 `PageOptions.PreloadScript` 在 `window.mygo` 就绪后挂载 `window.__FEATHERLOG_MYGO__` 便捷适配器（暴露 `call`、`on`、`once` 以及 camelCase 方法映射的 5 个服务对象），确保前端无论直接调用 `window.mygo`、生成的 TS 客户端还是 `window.__FEATHERLOG_MYGO__` 均可无缝衔接。

### 4.2 实时推送事件（Go → WebView）

| 事件名 | Payload 类型 | 触发时机 |
|---|---|---|
| `workbench:changed` | `WorkSlot[]` | UI 操作、定时提醒触发（`running` → `ready`）、CLI 命令修改槽位 |
| `tasks:changed` | `{ periodKey: string, tasks: Task[] }` | UI 操作、`dayStartHour` 变更、定时/唤醒跨周期重置、关联槽位完成联动 |
| `notes:changed` | `{ reason: string }` | UI 操作、CLI 记随笔、删除任务触发 `DetachTask` |
| `settings:changed` | `Settings` | 设置更新 |
| `dock:toggle` | `{ expanded?: boolean }` | 全局快捷键触发、重复启动主程序唤醒、未钉住抽屉失焦自动收起 |

---

## 5. 弹出工作台面板与 Linux Wayland 适配（`internal/dock`）

### 5.1 不透明窗口属性与常驻生命周期

- **窗口属性**：固定 `880×520px`（`MinWidth/MaxWidth = 880`、`MinHeight/MaxHeight = 520`）、`Title: "featherlog-panel"`、`Frameless: true`、`DisableShadow: false`、`Transparent: false`、`AlwaysOnTop: true`、`SkipTaskbar: true`、`Hidden: true`（默认后台常驻隐藏，传入 `--show` 时启动即显示）。
- **为何不透明**：在双显卡 Intel+NVIDIA Wayland 环境下（尤其开启 `WEBKIT_DISABLE_DMABUF_RENDERER=1` 时），GTK3/WebKitGTK 透明窗口会出现严重的局部脏区重绘缺陷；使用 `Transparent: false` 配合与主题一致的纯色 `BackgroundColor`（`stone`：`#F6F5F2`，`graphite`：`#131416`，切换主题时动态同步），在原生 Wayland 下无需 `GDK_BACKEND=x11` 即可保持 100% 锐利完整渲染。
- **常驻不退出**：窗口通过 `OnPageTitleUpdated` 锁定原生标题为 `"featherlog-panel"`，通过 `OnWindowAllClosed` 保持常驻；收起（`DockService.Resize({ expanded: false })`、`Esc`、点击 `⌄` 或未钉住失焦）时仅在主线程调用 `Hide()`，绝不退出进程，仅在 `DockService.Quit` / `SIGTERM` / `SIGINT` 时优雅退出。

### 5.2 底部居中几何算法

给定目标显示器可用工作区 `WorkArea`（含底边距 `PanelBottomInset = 10px`）：
- 宽度夹紧在 `[320, 1280]` 且不超过 `WorkArea.Width`；高度夹紧在 `[36, 900]` 且不超过 `WorkArea.Height`。
- 水平居中：`x = WorkArea.X + (WorkArea.Width - width) / 2`，夹紧在 `[WorkArea.X, WorkArea.X + WorkArea.Width - width]`。
- 底边锚定：`bottomY = WorkArea.Y + WorkArea.Height - effectiveInset`，`y = bottomY - height`，严格夹紧在 `WorkArea` 范围内。

### 5.3 Linux Wayland `gtk-layer-shell` 与 KDE KWin Script 定位

1. **优先 `gtk-layer-shell`**：在支持 `wlr-layer-shell` 且安装了 `libgtk-layer-shell.so.0` 的 Wayland 环境下，`internal/dock` 通过 `purego` 动态加载（零 CGO），锚定底边（`EDGE_BOTTOM = true`、`exclusive_zone = -1`、`KEYBOARD_MODE_ON_DEMAND`）。
2. **KDE Plasma Wayland KWin Scripting 回退（`internal/dock/kwin_linux.go`）**：当 `WAYLAND_DISPLAY` 非空、`XDG_CURRENT_DESKTOP` 包含 `KDE` 且系统缺失 `libgtk-layer-shell.so.0` 时，Wayland 会忽略 `gtk_window_move` 与 `keep_above`。宿主自动原子写入 `<dataDir>/kwin/featherlog-panel.js`，依次探测 `qdbus6` / `qdbus` / `gdbus` 调用 `org.kde.KWin /Scripting` 先卸载旧脚本再加载运行，并在退出 `Close()` 时自动卸载：
   - 监听 `windowList()`、`windowAdded` 与 `captionChanged`，匹配 `w.caption === "featherlog-panel"`。
   - 设置 `keepAbove = true`、`onAllDesktops = true`、`skipTaskbar = true`、`skipPager = true`、`skipSwitcher = true` 与 `w.tile = null`（附 `tileChanged` 保护，防止被 KDE 平铺接管）。
   - 在初次接管及 `minimizedChanged` / `activeChanged` / `frameGeometryChanged` / `outputChanged` 时，将窗口精确置于 `workspace.clientArea(KWin.PlacementArea, w.output, workspace.currentDesktop)` 底边上方 `10px` 且水平居中。
3. **其他平台 / 合成器**：安全回退到标准 `win.SetBounds`，绝不崩溃。

### 5.4 全局快捷键、Pin 与 Dock 防抖

- 启动时依次尝试注册 `Alt+Shift+Space`、`CommandOrControl+Shift+Space`，触发时调用 `Controller.Toggle(nil)`（展开时自动 `Show` + `Focus`、重算底边居中坐标并广播 `dock:toggle`；收起时 `Hide`）。
- 面板处于展开态且 `pinned == false` 时，原生窗口 `OnBlur` 自动隐藏；内置 `300ms` 失焦防抖窗口（基于注入 `Clock`），避免点击 KDE 底部 Dock 按钮收起面板时因先触发 `OnBlur` 再收到 `POST /api/panel/toggle` 而误弹回；`pinned == true` 时常驻展开。

---

## 6. 本机环回 HTTP API 与 KDE Plasma 6 Dock 插件（`internal/barhttp`）

### 6.1 监听地址与端口发现

- **严格环回绑定**：仅监听 `127.0.0.1:<port>`，绝不暴露到局域网或公网，也不允许跨域写访问。
- **默认端口**：默认生产数据目录使用 `39173`；`--dev` 或自定义 `--data-dir` / `FEATHERLOG_DATA_DIR` 使用 `39174`；可通过 `--http-port <port>` 或 `FEATHERLOG_HTTP_PORT` 覆盖（`0` 表示测试用临时端口）。
- **地址文件**：启动时原子写入 `http://127.0.0.1:<actualPort>` 到 `<dataDir>/bar-http.url`（`0600` 权限），关闭时自动删除。

### 6.2 HTTP JSON 契约

| 方法与路径 | 请求体 / 查询参数 | 响应 |
|---|---|---|
| `GET /api/bar` | `?rev=<uint64>&wait=<0..25>`；当 `rev > 0` 且等于当前修订号且 `wait > 0` 时阻塞至多 `wait` 秒，任一槽位 / 任务 / 设置 / `panelOpen` 变化立即唤醒 | `200 OK`：`{ rev, panelOpen, pinned, theme, todayDone, todayTotal, slots: [{ id, title, state, breadcrumb, tag, stateChangedAt, remindAt, order }] }` |
| `POST /api/panel/toggle` | 可选 `{ "open": true \| false }`（空体或 `{}` 表示取反切换） | `200 OK`：`{ "panelOpen": bool, "rev": uint64 }` |
| `POST /api/slot/focus` | `{ "id": "<slotId>" }` | `200 OK`：更新后的完整 `GET /api/bar` 快照 |
| `POST /api/slot/cycle` | `{ "delta": 1 \| -1 }`（无焦点时 `+1` 聚焦首个，`-1` 聚焦末个） | `200 OK`：更新后的完整 `GET /api/bar` 快照 |
| `POST /api/slot/state` | `{ "id": "<slotId>", "state": "focus" \| "running" \| "ready" }` | `200 OK`：更新后的完整 `GET /api/bar` 快照 |
| `POST /api/slot/done` | `{ "id": "<slotId>", "completeLinkedTask"?: bool }` | `200 OK`：更新后的完整 `GET /api/bar` 快照 |

其中 `todayDone / todayTotal` 按扁平统一待办统计：包含所有活跃任务（排除当前周期非应做的周循环任务）以及当前 `periodKey` 内已完成的任务，与弹出面板「待办」计数保持一致。

---

## 7. 本地 Unix Socket 与 CLI Hooks（`internal/ipcsock` & `main.go`）

### 7.1 单实例 Socket

- 路径：`<userData>/featherlog.sock`（生产 `<configDir>/Featherlog/featherlog.sock`，开发 `<configDir>/Featherlog-dev/featherlog.sock`，可通过 `FEATHERLOG_DATA_DIR` 或 `--data-dir` 覆盖）。
- 权限：目录 `0700`，Socket 文件 `0600`。
- 僵尸 Socket 清理：监听前若路径已存在且类型为 Unix Socket，先 `DialTimeout` 探测；若对端活跃则返回 `ErrAlreadyRunning`；若对端不可达则删除残留文件后重新监听；若路径被普通文件占用则拒绝覆盖。
- 帧格式：单行 JSON（上限 1 MiB）请求 `{"command":"...","params":{...}}\n` → 单行 JSON 响应 `{"ok":true,"data":...}\n` 或 `{"ok":false,"error":{"code":"...","message":"..."}}\n`。

### 7.2 CLI 子命令

| 命令 | 行为 |
|---|---|
| `featherlog [--show] [--dev] [--data-dir <dir>] [--http-port <port>]` | 启动桌面常驻宿主与 `barhttp` API（默认隐藏面板，加 `--show` 立即弹出）；若已有实例运行，发送 `toggle` 命令并退出 |
| `featherlog status [--json]` | 输出当前所有并发 `WorkSlot`（默认紧凑表格，`--json` 输出纯 JSON） |
| `featherlog focus <title> [--tag <tag>] [--note <breadcrumb>]` | 聚焦指定槽位（匹配已有或新建），自动将原 `focus` 槽位退为 `running` |
| `featherlog run <title> [--tag <tag>] [--remind <duration>] [--note <breadcrumb>]` | 创建或切入 `running` 后台推进槽位，支持 `--remind 15m` 定时回看提醒 |
| `featherlog ready <id-or-substring> [--note <breadcrumb>]` | 按 ID 精确匹配或标题子串（大小写不敏感）将槽位标为 `ready`（待看）并可附断点备忘 |
| `featherlog done <id-or-substring> [--complete-task]` | 完成并移出匹配槽位（可选同步完成关联任务） |
| `featherlog note <text> [--task <taskId>]` | 追加一条随笔或任务手记 |
| `featherlog toggle [--expand \| --collapse] [--json]` | 切换运行中桌面工作台面板的显示/隐藏 |

所有子命令优先通过 Unix Socket 发送给运行中的桌面实例（立即触发实时 UI 与 KDE Dock 刷新及定时器）；若桌面端未运行，则自动以直连本地存储模式执行，保证终端脚本与 AI Agent 随时可用。
