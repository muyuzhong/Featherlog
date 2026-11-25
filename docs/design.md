# 羽记 Featherlog v2 设计文档

> 状态：v2 正式设计（基于 `github.com/egoist/mygo` 的跨平台自适应常驻宿主：不透明弹出工作台面板 + 独立 3D 滚筒条 / KDE Plasma 6 原生底部 Dock 插件 + 跨平台系统托盘 + 本机环回 HTTP API + 本地 CLI Hooks）。
> 本文档定义羽记 v2 的架构、领域不变量、RPC 与 HTTP 契约、跨平台自适应展示与定位策略以及本地 Unix Socket 协议。

---

## 1. 产品定位与演进

羽记 v2 从旧版 Electron 羊皮卷游戏化任务面板重构为 **轻量级原生并发工作台**：

- **核心场景**：同时推进多个任务或 AI Agent 编排线程（例如正在手写功能 A、后台 Agent 跑测试 B、等 CI/审 PR C），在切换上下文时不再忘事或断片。
- **核心交互形态（跨平台自适应放置 / Cross-Platform Adaptive Placement）**：
  1. **常驻状态条（自动择优，绝不重复叠加）**：
     - **Linux KDE Plasma 6**：原生 Plasma 6 小组件（`plasmoid/io.github.muyuzhong.featherlog/`）直接嵌在 KDE 底部浮动 Dock 内，经 `127.0.0.1` 长轮询 API 实时同步；当检测到 KDE 会话且已安装 Plasmoid（或已有外部 `/api/bar` 客户端活跃连接）时，`auto` 模式自动让位隐藏独立悬浮条。
     - **Windows / macOS / 非 KDE Linux（或手动选 `standalone`）**：宿主自动展示 `312×40px` 不透明无边框**独立 3D 滚筒条**（标题 `featherlog-bar`，URL `/?mode=bar`），以 `ShowInactive()` 非抢焦浮起于屏幕底部居中（支持自由拖拽并防抖落盘坐标，Windows 11 下允许拖放至任务栏空白区域）；亦可切换为 `tray-only` 仅保留系统托盘。
  2. **跨平台单色系统托盘（`internal/tray`）**：纯 Go 生成 `32×32` 抗锯齿单色透明模板图标（`IconIsTemplate: true`），左键切换工作台显隐，右键/上下文菜单提供工作台开关、最多 6 个活跃槽位快切、「常驻滚筒条」模式单选、`重置滚筒条位置`与退出入口；macOS 以 `ActivationPolicyAccessory` + `LSUIElement` 隐藏 Dock 图标并在菜单栏显示简短状态文字（`┃ <标题>` 或 `待看 N`）。
  3. **弹出工作台面板（`MyGo` Opaque Workspace Panel）**：固定 `880×520px` 不透明无边框弹出窗口（标题 `featherlog-panel`，URL `/?mode=panel`），后台常驻、默认启动隐藏（传 `--show` 可立即显示），点击状态条/系统托盘或按全局快捷键 `Alt+Shift+Space` 时弹出并聚焦在底部正上方 `10px` 处；按 `Esc`、点收起 `⌄` 或未钉住失焦时立即隐藏窗口而不退出宿主进程。
  4. **CLI / Agent Hooks**：单文件二进制 `featherlog`（Windows 发布包同时提供无黑框 GUI 宿主 `featherlog.exe` 与同步终端输出 `featherlog-cli.exe`），通过本机 Unix Socket（`<userData>/featherlog.sock`）实时操作并发槽与随笔，AI 助手或构建脚本可直接汇报进度并同步刷新全部状态条与弹出面板。

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
│  main.go ──┬── 无子命令 ──► MyGo 跨平台桌面常驻宿主                                   │
│            │                   ├─ 不透明 880×520 弹出工作台 ("featherlog-panel")       │
│            │                   │   └─ WebView 加载 /?mode=panel (embed 或 dev URL)    │
│            │                   ├─ 不透明 312×40 独立 3D 滚筒条 ("featherlog-bar")      │
│            │                   │   └─ WebView 加载 /?mode=bar (自适应让位/可拖拽落盘)  │
│            │                   ├─ internal/tray (32×32 单色模板托盘 + 菜单 + 状态字)   │
│            │                   ├─ internal/dock (几何/策略/layer-shell/KWin Script)   │
│            │                   ├─ internal/barhttp (127.0.0.1:39173/39174 长轮询 API) │
│            │                   │       ▲  (含 35s 外部客户端活跃探测 -> 触发自动让位)  │
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
| `main.go`、`console_windows.go`、`console_other.go` | 统一入口：CLI 参数解析（含 `--show`、`--http-port`）、单实例协调、macOS `ActivationPolicyAccessory`、Windows 父控制台附加、`MyGo` 双窗口（Panel + MiniBar）与系统托盘/`barhttp` 生命周期 |
| `frontend_embed.go` / `frontend_noembed.go` | `embed.FS` 嵌入 `frontend/dist`（生产/默认构建）与无嵌入回退（纯 Go 测试/开发） |
| `internal/clock/` | 可注入时钟接口（`Now()`、`AfterFunc()`），真实时钟与确定性测试假时钟 |
| `internal/store/` | 原子 JSON 持久化（`*.tmp` → `fsync` → `rename`）、损坏文件保护（`store/corrupt`）、目录隔离（`Featherlog` / `Featherlog-dev`） |
| `internal/workbench/` | 并发工作槽领域逻辑、单焦点不变量、提醒定时器与睡眠恢复 |
| `internal/tasks/` | 扁平化精简任务（无主线/支线等级；可选自由子步骤、可选配额 `×N`、可选每日/每周重置）、`dayStartHour` 跨周期与单调保护 |
| `internal/notes/` | 随笔与任务手记（`1..20000` 字）、大小写不敏感检索、任务删除解绑（`DetachTask`） |
| `internal/settings/` | 应用设置校验（`settings/invalid`，含 `barMode`、`barX`/`barY` 成对与范围校验、`null` 重置）与损坏备份恢复（`settings.json.corrupt-<ms>-<id>`） |
| `internal/app/` | 组合根与 5 个 `mygo.Bind` 服务（含 `DockService.Toggle`）、跨领域协调、WebView 实时事件推送、IPC 命令路由 |
| `internal/dock/` | 底部居中几何、不透明 `880×520` 面板与 `312×40` 独立滚筒条显隐生命周期、跨平台自适应策略（`ShouldShowMiniBar` / `DetectKDEPlasmoid` / 400ms 拖拽防抖）、Linux Wayland `gtk-layer-shell`（`purego`）、KDE KWin Script 定位（`kwin_linux.go`）、全局快捷键 |
| `internal/tray/` | 跨平台系统托盘控制器与纯 Go `32×32` 单色抗锯齿模板图标（`TemplateIconPNG`）、macOS 菜单栏状态文字与左/右键行为适配 |
| `internal/barhttp/` | 仅绑定 `127.0.0.1` 的本机环回 HTTP 长轮询、控制 API 与外部 `/api/bar` 客户端活跃探测（`HasActiveClient` / `OnClientActivity`） |
| `internal/ipcsock/` | 单实例 Unix Domain Socket 服务/客户端（`0600` 权限、Windows `AF_UNIX` 错码/重解析点兼容、僵尸 socket 清理、换行分隔 JSON 协议） |
| `frontend/` | 独立 React + TypeScript + Vite 前端（`/?mode=panel` 工作台抽屉与 `/?mode=bar` 独立 3D 滚筒条，构建输出 `frontend/dist`） |
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
| `barMode` | `string` | `"auto"` \| `"standalone"` \| `"tray-only"` | `"auto"` |
| `barX` | `int \| null`（可省略） | 与 `barY` 同时省略/`null`，或同时在 `-32768..32767` 内 | `null`（省略） |
| `barY` | `int \| null`（可省略） | 与 `barX` 同时省略/`null`，或同时在 `-32768..32767` 内 | `null`（省略） |

- `SettingsService.Update` 支持显式 JSON `{"barX": null, "barY": null}` 清除自定义坐标（恢复默认底部居中），也支持 `{"barX": 420, "barY": 980}` 保存拖拽坐标；相等性判定按 `*int` 指向值比较，避免同值无变更触发多余写盘与广播。
- 修改 `dayStartHour` 时立即通知 `tasks` 更新周期配置；修改 `pinned`、`theme`、`barMode`、`barX`/`barY` 时立即同步到 `dock.Controller`。

---

## 4. 前后端 RPC 契约与事件推送

### 4.1 MyGo 绑定与双桥接暴露

后端在 `App.Run()` 之前通过 `mygo.Bind` 注册 5 个服务结构体：

1. `WorkbenchService`：`List`, `Create`, `Update`, `SetState`, `Complete`, `Reorder`
2. `TaskService`：`List`, `Create`, `Update`, `SetItems`, `ToggleItem`, `StepQuota`, `Complete`, `Delete`, `Reorder`
3. `NoteService`：`List`, `Create`, `Update`, `Delete`
4. `SettingsService`：`Get`, `Update`
5. `DockService`：`Resize`, `Toggle`, `Quit`
   - `Toggle(input?: { expanded?: boolean }) -> { expanded: boolean }`：供独立 3D 滚筒条（`/?mode=bar`）及前端直接切换工作台面板显隐。

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

## 5. 跨平台自适应定位、弹出面板、独立滚筒条与系统托盘（`internal/dock` & `internal/tray`）

### 5.1 不透明窗口属性与常驻生命周期

- **弹出工作台面板（`featherlog-panel`，`/?mode=panel`）**：固定 `880×520px`（`MinWidth/MaxWidth = 880`、`MinHeight/MaxHeight = 520`）、`Frameless: true`、`DisableShadow: false`、`Transparent: false`、`CornerRadius: 18`、`AlwaysOnTop: true`、`SkipTaskbar: true`、`Panel: runtime.GOOS == "darwin"`、`Hidden: true`（默认后台常驻隐藏，传入 `--show` 时启动即显示）。
- **独立 3D 滚筒条（`featherlog-bar`，`/?mode=bar`）**：固定 `312×40px`（`MinWidth/MaxWidth = 312`、`MinHeight/MaxHeight = 40`）、`Frameless: true`、`DisableShadow: false`、`Transparent: false`、`CornerRadius: 14`、`AlwaysOnTop: true`、`SkipTaskbar: true`、`DisableResize/Maximize/Minimize/FullScreen: true`、`Panel: runtime.GOOS == "darwin"`、`Hidden: true`。按策略展示时通过 `ShowInactive()` 浮起，绝不抢占当前编辑窗口焦点。
- **为何不透明**：在双显卡 Intel+NVIDIA Wayland 环境下（尤其开启 `WEBKIT_DISABLE_DMABUF_RENDERER=1` 时），GTK3/WebKitGTK 透明窗口会出现严重的局部脏区重绘缺陷；两个窗口均使用 `Transparent: false` 配合与主题一致的纯色 `BackgroundColor`（`stone`：`#F6F5F2`，`graphite`：`#131416`，切换主题时同步更新双窗口），在原生 Wayland / Windows / macOS 下均保持 100% 锐利完整渲染。
- **常驻不退出**：面板与滚筒条分别通过 `OnPageTitleUpdated` 锁定原生标题为 `"featherlog-panel"` 与 `"featherlog-bar"`，并通过 `OnClose` 与 `OnWindowAllClosed` 防止意外关闭导致进程退出；仅在 `DockService.Quit` / 系统托盘「退出羽记」/ `SIGTERM` / `SIGINT` 时优雅退出。

### 5.2 跨平台自适应放置策略（`ShouldShowMiniBar`）与坐标持久化

- **展示策略**：
  - `barMode == "tray-only"`：始终隐藏独立滚筒条。
  - `barMode == "standalone"`：始终显示独立滚筒条（即使用户处于 KDE Plasma 且安装了 Plasmoid）。
  - `barMode == "auto"`（默认）：
    1. 若 `internal/barhttp` 存在活跃外部 `/api/bar` 客户端（`waiters > 0` 或最近 35 秒内有请求，如 KDE Plasmoid 已连接），自动让位隐藏独立滚筒条；
    2. 若运行在 `linux` 且检测到 KDE 会话（`XDG_CURRENT_DESKTOP` / `DESKTOP_SESSION` / `KDE_FULL_SESSION`）且存在 `<XDG_DATA_HOME 或 ~/.local/share>/plasma/plasmoids/io.github.muyuzhong.featherlog/metadata.json` 或 `/usr/share/plasma/plasmoids/io.github.muyuzhong.featherlog/metadata.json`，自动让位隐藏独立滚筒条；
    3. 其余平台（Windows、macOS、GNOME/Hyprland 等非 KDE Linux 或未安装 Plasmoid 的 KDE）自动展示独立 3D 滚筒条。
- **独立滚筒条几何（`ComputeMiniBarBounds`）**：
  - 未保存自定义坐标（`barX == nil || barY == nil`）时：在目标显示器 `WorkArea` 内水平居中，位于底边上方 `MiniBarBottomInset = 8px` 处，严格保持 `312×40`（仅当屏幕窄于 `312px` 时夹紧，不向上放大到 `MinWidth = 320`）。
  - 保存了自定义坐标时：优先通过 `Screen.ActiveDisplay` 匹配所在显示器，并按**物理屏幕边界 `display.Bounds`**（而非 `WorkArea`）夹紧，使 Windows 11 用户将 `312×40` 滚筒条拖放至底部任务栏空白区域时可精确保留坐标；若拔掉外接屏导致坐标与当前显示器 `Bounds` 无交集，则自动回退到主屏默认底部居中。
  - **400ms 拖拽防抖落盘**：`Controller` 监听 `OnMove`（忽略程序化 `SetBounds`），经注入 `clock.Clock.AfterFunc(400ms)` 防抖后回调 `OnMiniBarMoved` 持久化 `barX`/`barY`。

### 5.3 弹出面板底部居中几何算法

给定目标显示器可用工作区 `WorkArea`（含底边距 `PanelBottomInset = 10px`）：
- 宽度夹紧在 `[320, 1280]` 且不超过 `WorkArea.Width`；高度夹紧在 `[36, 900]` 且不超过 `WorkArea.Height`。
- 水平居中：`x = WorkArea.X + (WorkArea.Width - width) / 2`，夹紧在 `[WorkArea.X, WorkArea.X + WorkArea.Width - width]`。
- 底边锚定：`bottomY = WorkArea.Y + WorkArea.Height - effectiveInset`，`y = bottomY - height`，严格夹紧在 `WorkArea` 范围内。

### 5.4 系统托盘与平台适配（`internal/tray`）

- **纯 Go 单色模板图标**：`TemplateIconPNG()` 在内存中通过 4×4 超采样生成 `32×32` 抗锯齿羽毛+滚筒图标（透明底 + 深炭墨 `RGB(24,24,27)`，零彩色像素），配合 `IconIsTemplate: true` 自动适配 macOS 菜单栏、Windows 11 深/浅色任务栏与 Linux StatusNotifierItem。
- **平台交互**：
  - **macOS**：启动前设置 `ActivationPolicyAccessory`（且打包 `Info.plist` 含 `LSUIElement = true`）隐藏 Dock 图标；菜单栏标题在有焦点时展示 `┃ <最多14字标题>`，无焦点但有待看槽位时展示 `待看 N`；`TrayOptions.Menu` 保持 `nil` 以便左键直接切换工作台面板，右键按需弹出上下文菜单。
  - **Windows / Linux**：菜单栏标题留空，悬停 Tooltip 显示当前焦点、断点备忘与 `待办 done/total`；左键切换工作台面板，右键打开上下文菜单；若 Linux 缺少托盘库导致 `mygo.NewTray` 失败，仅记录一次日志并安全降级。
- **上下文菜单**：`打开/收起工作台` → 最多 6 个活跃槽位（标 `[专注]`/`[待看]`，点击即切焦点）→ 子菜单 `常驻滚筒条`（`自动（推荐）` / `始终显示桌面滚筒条` / `仅系统托盘图标`）→ `重置滚筒条位置`（发送 `barX: null, barY: null`）→ `退出羽记`。

### 5.5 Linux Wayland `gtk-layer-shell` 与 KDE KWin Script 定位

1. **优先 `gtk-layer-shell`**：在支持 `wlr-layer-shell` 且安装了 `libgtk-layer-shell.so.0` 的 Wayland 环境下，`internal/dock` 通过 `purego` 动态加载（零 CGO），锚定底边（`EDGE_BOTTOM = true`、`exclusive_zone = -1`、`KEYBOARD_MODE_ON_DEMAND`）。
2. **KDE Plasma Wayland KWin Scripting 回退（`internal/dock/kwin_linux.go`）**：当 `WAYLAND_DISPLAY` 非空、`XDG_CURRENT_DESKTOP` 包含 `KDE` 且系统缺失 `libgtk-layer-shell.so.0` 时，Wayland 会忽略 `gtk_window_move` 与 `keep_above`。宿主自动原子写入 `<dataDir>/kwin/featherlog-panel.js`，依次探测 `qdbus6` / `qdbus` / `gdbus` 调用 `org.kde.KWin /Scripting` 先卸载旧脚本再加载运行，并在退出 `Close()` 时自动卸载：
   - 监听 `windowList()`、`windowAdded` 与 `captionChanged`，匹配 `w.caption === "featherlog-panel"`。
   - 设置 `keepAbove = true`、`onAllDesktops = true`、`skipTaskbar = true`、`skipPager = true`、`skipSwitcher = true` 与 `w.tile = null`（附 `tileChanged` 保护，防止被 KDE 平铺接管）。
   - 在初次接管及 `minimizedChanged` / `activeChanged` / `frameGeometryChanged` / `outputChanged` 时，将窗口精确置于 `workspace.clientArea(KWin.PlacementArea, w.output, workspace.currentDesktop)` 底边上方 `10px` 且水平居中。
3. **其他平台 / 合成器**：安全回退到标准 `win.SetBounds`，绝不崩溃。

### 5.6 全局快捷键、Pin 与 Dock 防抖

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

### 6.3 外部客户端活跃探测

`barhttp.Server` 使用注入 `clock.Clock` 记录 `/api/bar` 外部消费端活跃状态（`HasActiveClient()` 在 `waiters > 0` 或距最近一次 `/api/bar` 请求不超过 `35s` 时返回 `true`），并在状态变化（首次连接、超时到期或 `Close()`）时通过 `OnClientActivity` 回调通知 `dock.Controller.SetExternalBarActive`，使 `barMode == "auto"` 在外部 Dock 插件接入时自动隐藏独立滚筒条、断开超时后自动恢复。

---

## 7. 本地 Unix Socket、Windows 双二进制与 CLI Hooks（`internal/ipcsock` & `main.go`）

### 7.1 单实例 Socket 与 Windows 兼容

- 路径：`<userData>/featherlog.sock`（生产 `<configDir>/Featherlog/featherlog.sock`，开发 `<configDir>/Featherlog-dev/featherlog.sock`，可通过 `FEATHERLOG_DATA_DIR` 或 `--data-dir` 覆盖）。
- 权限：目录 `0700`，非 Windows 平台 Socket 文件 `0600`。
- 僵尸 Socket 清理：监听前若路径已存在且为 Unix Socket（Windows 下同时识别 `AF_UNIX` NTFS 重解析点或 0 字节残留），先 `DialTimeout` 探测；若对端活跃则返回 `ErrAlreadyRunning`；若对端不可达则删除残留文件后重新监听；若路径被非空普通文件或目录占用则拒绝覆盖。
- Windows 错误码映射：`WSAECONNREFUSED (10061)`、`WSAENOTSOCK (10038)`、`ERROR_FILE_NOT_FOUND (2)`、`ERROR_PATH_NOT_FOUND (3)` 统一归一为 `ErrNotRunning`，确保未启动桌面端时 CLI 自动回退到本地直连模式。
- 帧格式：单行 JSON（上限 1 MiB）请求 `{"command":"...","params":{...}}\n` → 单行 JSON 响应 `{"ok":true,"data":...}\n` 或 `{"ok":false,"error":{"code":"...","message":"..."}}\n`。

### 7.2 Windows 双二进制发布

Windows 发布包（`featherlog-<version>-windows-amd64.zip`）同时提供两个零 CGO 可执行文件：
- **`featherlog.exe`**：以 `-ldflags "-H=windowsgui"` 编译，双击或开机自启时无黑色 `cmd.exe` 窗口；带 CLI 参数调用时也会尝试通过 `AttachConsole(ATTACH_PARENT_PROCESS)` 附加父控制台。
- **`featherlog-cli.exe`**：标准控制台子系统编译，供 PowerShell、`cmd` 与 AI Agent CLI Hooks 同步获取标准输出与退出码。

### 7.3 CLI 子命令

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
