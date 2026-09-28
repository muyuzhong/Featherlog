# 羽记 Featherlog 设计文档

> 状态：v1 草案（2026-09-27）。类型层面的唯一真相是 `packages/contracts`；本文解释这些类型的**语义和规则**。两者冲突时以本文为准，并修正契约。

## 1. 项目概述

羽记是一个游戏任务风格的个人面板桌面客户端。学习计划、要做的事、日常习惯都被组织成游戏式的"任务"：任务线分章节推进，目标逐个解锁，完成时有仪式感，帮助人坚持下去。

交互形态：一个收起视图（置顶的浮动卷轴，用户可拖到任意位置，通常是屏幕边缘），鼠标悬停显示预览，点击打开完整面板。

**v1 范围**：内核 + Electron 外壳 + 任务面板插件。
**v1 明确不做**：奖励系统（XP、金币）、AI、八股弹窗、钱包、游戏接入、本地 WebSocket。这些都通过"只加字段、只加消息"的方式在以后加入，v1 的契约不为它们预留字段。

目标平台：Linux、macOS、Windows。

## 2. 设计原则

1. **一切皆插件**。任务面板是核心功能，但也是插件，不享有内核特权。
2. **内核只送信**。内核不认识任何具体消息类型，只负责投递、插件生命周期和资源清理。
3. **模块之间只通过总线通信，互不 import**。唯一允许共享的是 `@featherlog/contracts`（纯类型）。
4. **消息是纯 JSON**。同一套协议可以跨进程（IPC）、以后跨程序（WebSocket），不需要改任何插件。
5. **契约只加不改**。
6. **每个插件的数据独立**，只能经由 `ctx.storage` 访问自己的数据。
7. **错误隔离**。一个插件的处理函数出错，不影响其他插件，也不影响内核。

## 3. 仓库结构与分工

```
featherlog/
├─ docs/design.md              本文档
├─ AGENTS.md                   给 Codex 的工作规则
├─ packages/
│  ├─ contracts/               契约（纯类型）          共享，改动需审
│  ├─ kernel/                  内核                    Codex
│  └─ shell/                   Electron 外壳
│     ├─ src/main/             插件宿主、IPC 桥、窗口、存储、设置   Codex
│     ├─ src/preload/          preload 脚本            Codex
│     └─ src/renderer/         全部界面（含窗口入口 app/）  Claude
└─ plugins/
   └─ quest/
      ├─ manifest.json         插件清单                共享，改动需审
      ├─ src/main/             任务逻辑                Codex
      └─ src/ui/               任务界面                Claude
```

- 包名：`@featherlog/contracts`、`@featherlog/kernel`、`@featherlog/shell`、`@featherlog/plugin-quest`。
- 工具链：pnpm workspace、TypeScript（strict）、vitest、electron-vite。
- 代码、标识符、注释用英文；文档和界面文案用中文。

## 4. 总线

### 4.1 信封

见 `contracts/src/envelope.ts`。要点：

| 字段 | 说明 |
|---|---|
| `v` | 信封格式版本，固定为 `1` |
| `kind` | `event` / `request` / `response` |
| `type` | `<模块>/<动作>`；响应沿用请求的 type |
| `id` | UUID |
| `source` | 发送方插件 id，或 `kernel`、`shell`、`external:<名字>` |
| `time` | Unix 毫秒时间戳 |
| `payload` | 纯 JSON |
| `replyTo` | 仅响应：对应请求的 id |
| `causedBy` | 可选：引起这条消息的消息 id，用于追踪和撤销 |

响应的 payload 是 `{ ok: true, data }` 或 `{ ok: false, error: { code, message, data? } }`。

### 4.2 命名

- 格式 `<模块>/<动作>`，全小写 kebab-case。模块名就是插件 id。
- **事件**用完成时：`quest/created`、`quest/period-rolled`。
- **请求**用动词：`quest/get`、`shell/show-popup`。
- **命令**（只需要对方执行、不需要返回数据）也用请求表达，返回 `null`。这样发起方能知道有没有人处理。
- 一个插件**只能发出自己命名空间下的事件、只能应答自己命名空间下的请求**。可以请求任何命名空间。开发模式下违反时同步抛出 `forbidden-namespace`。
- 保留命名空间：`kernel/*`（内核生命周期）、`shell/*`（外壳）、`external/*`（以后给外部程序）。

### 4.3 投递语义

**事件**

- `emit` 立即返回。监听器在微任务中异步调用，绝不会在 `emit` 的调用栈里同步执行。
- 同一发送方发出的事件，按发送顺序调用每个监听器（只保证调用顺序，不等待异步监听器完成）。
- 监听器同步抛错或返回 rejected Promise，都会被捕获并记录日志，不影响其他监听器。
- 事件**不持久化、不重放**。晚注册的监听器收不到之前的事件。需要当前状态时，用请求去问状态的所有者。

**请求**

- 发出请求时查找应答者；没有应答者时，Promise **立即** 以 `no-handler` 拒绝（异步拒绝，不是同步抛出）。
- 应答者在微任务中调用，**绝不在 `request` 的调用栈里同步执行**：`request()` 返回时应答者尚未运行。这与事件的投递方式一致，也与跨 IPC 时请求必然异步的行为一致，避免插件之间的重入问题。应答者同步返回的数据，仍在进入总线的那一刻复制并冻结。
- 默认超时 5000 ms，可通过 `timeoutMs` 调整。超时后以 `timeout` 拒绝，之后到达的响应被丢弃。
- 应答者抛出的 Error 若带有形如 `<模块>/<原因>` 的字符串 `code`（如 `quest/not-found`），则把 `code`、`message`、`data` 原样转给请求方。其他任何错误都变成 `handler-error`，`message` 保留原文。"其他错误"包括 Node 的系统错误（`ENOENT` 等），也包括应答者内部再发请求时收到的 `timeout`、`no-handler`：请求方只应看到"它请求的那个应答者"的结果，不应把下游的超时误认为自己的超时。
- 同一个请求类型注册第二个应答者时，`handle` **同步抛出** `duplicate-handler`。

**复制语义**

- 消息进入总线时，内核把 payload 深拷贝一份（`structuredClone`）并**深度冻结**，所有接收方（监听器、应答者、观察者）拿到的是这份只读副本。响应数据同样如此。
- 因此：发送方之后修改自己的对象，不影响已经发出的消息；接收方也无法通过收到的对象改动发送方的内部状态，接收方之间也互不影响。这与跨 IPC 时的行为一致。
- 开发模式和生产模式行为相同。

**纯 JSON 校验**

- 开发模式下，内核校验每个 payload 和响应数据是否为纯 JSON：只允许 `null`、布尔、字符串、有限数字、数组（非稀疏、无额外属性）、普通对象（原型为 `Object.prototype` 或 `null`，只有可枚举的字符串键数据属性），且无循环引用。`-0` 视为合法（序列化后是 `0`，数值上相等）。
- 不通过时 `emit`/`request` 同步抛出 `not-json`；应答者返回的数据不通过时，请求以 `not-json` 失败。
- 生产模式跳过校验（复制和冻结仍然进行）。

### 4.4 兼容规则

1. 只加字段，不改字段含义、不改类型、不删字段。
2. 新增的字段必须是可选的。
3. 消费方必须忽略不认识的字段；遇到不认识的枚举值要有兜底处理。
4. 真正的破坏性变更：使用新的消息名（如 `quest/completed-v2`），旧消息保留一段时间。

### 4.5 宿主 API（只给可信的宿主代码，插件拿不到）

外壳主进程需要把总线延伸到窗口，总线检查器需要看到全部流量。内核为此提供两个宿主级接口：

- `observe(fn: (envelope) => void): Dispose`：观察经过总线的**每一条**信封，包括请求和响应。
- `inject(envelope): void`：从外部投入一条信封（来自窗口或以后的外部程序），保留其 `source`。若是请求，内核照常查找应答者、处理超时，产生的响应信封（含 `no-handler`、`timeout` 错误响应）通过 `observe` 发出，宿主据 `replyTo` 转回给来源。

## 5. 插件

### 5.1 构成

每个插件是 `plugins/<id>/` 下的一个包，由三部分组成：

- `manifest.json`：清单，类型见 `PluginManifest`。纯 JSON，不执行代码就能读。
- 主进程部分（`main` 入口，导出 `setup(ctx: MainContext)`）：状态、逻辑、存储都在这里。
- 界面部分（`ui` 入口，导出 `setup(ctx: UiContext)`）：只负责渲染。**不保存业务状态**，所有数据通过总线向主进程部分请求。

同一个插件的界面部分可能同时在多个窗口里运行（收起窗口一份、面板窗口一份），每个窗口有独立的 `UiContext`。

### 5.2 清单的用途

- `contributes`：声明插槽贡献（见第 7 节），外壳据此布局。
- `emits` / `listens` / `handles` / `requests`：**内核运行时不强制**。开发模式下用于检查：发出了未声明的消息时警告；请求了没有任何插件声明 `handles` 的消息时，在启动时警告。

### 5.3 生命周期

1. 外壳主进程读取所有清单。
2. 外壳注册自己的 `shell/*` 应答者（外壳不是插件，但先于插件就绪）。
3. 外壳调用一次 `load(整批插件)`。内核**先校验整批清单**：id 为小写 kebab-case、不是保留名（`kernel`、`shell`、`external`）、批内和已加载插件之间不重复。任何一项不合法，就在调用任何 `setup` 之前以 `invalid-plugin` 拒绝整批（这是宿主的编程错误，应当立刻暴露，而不是留下加载了一半的状态）。
4. 依次调用每个插件主进程部分的 `setup(ctx)`，成功后发 `kernel/plugin-loaded`。
   - `setup` 抛错或 rejected：发 `kernel/plugin-failed`，清理它已注册的一切，其他插件照常加载。
   - `setup` 超时（默认 10 秒，可在创建内核时配置）：视为失败，以 `timeout` 发 `kernel/plugin-failed` 并清理，继续加载下一个。之后即使 `setup` 完成也不会"复活"。
   - 插件不得假设其他插件已加载。**跨插件的请求放到 `kernel/ready` 之后再发。**
5. 全部处理完后发 `kernel/ready`。外壳在启动时只调用一次 `load`。
6. 卸载：按注册的逆序执行所有清理，发 `kernel/plugin-unloaded`。

### 5.4 自动清理

凡是通过 `ctx` 注册的东西都由内核记录，卸载时自动释放：

- `bus.on` 的监听器、`bus.handle` 的应答者
- `ctx.clock.setTimeout` 的定时器
- `ctx.onDispose` 登记的回调
- 界面侧：`ctx.slots.provide` 的挂载（先调用 unmount）

卸载时尚未完成的请求：发给该插件的请求以 `disposed` 拒绝；该插件自己发出的请求也以 `disposed` 拒绝。

### 5.5 存储、设置、时钟

- `ctx.storage`：每个插件独立的键值存储，值为 JSON。实现上每个插件一个目录，放在 Electron `userData` 下；写入必须原子化（写临时文件再 rename）。插件自己在一个键里记录 `schemaVersion`，在 `setup` 中做数据迁移。
- `ctx.settings`：只读。值由外壳的设置页写入；默认值来自清单里 settings schema 的 `default`。
- `ctx.clock`：所有和时间有关的逻辑都必须用它，不直接用 `Date.now()` 和全局 `setTimeout`，以便测试时注入模拟时钟。

## 6. 外壳：进程、窗口与 IPC

```
┌────────────────────────── Electron 主进程 ───────────────────────────┐
│  内核（总线 + 生命周期）                                               │
│   ├─ 外壳主进程：shell/* 应答者 · IPC 桥 · 存储 · 设置 · 窗口 · 浮窗(§9)  │
│   └─ 各插件的主进程部分（quest …）                                     │
└───────────────┬───────────────────────────────┬──────────────────────┘
          IPC   │  preload: window.featherlog    │  IPC
     ┌──────────┴──────────┐            ┌────────┴───────────┐
     │ 收起窗口（浮动卷轴）   │            │ 面板窗口（任务日志）  │
     │ 图标 · 悬停便签 · 通知 │            │ 标签页 · 设置        │
     └─────────────────────┘            └────────────────────┘
```

弹窗窗口（`shell/show-popup`）在做八股弹窗时再加，v1 不实现，也不注册对应的应答者（请求会得到 `no-handler`）。

### 6.1 构建与目录

用 electron-vite 构建三个产物，都在 `packages/shell` 里：

| 产物 | 入口 | 负责方 |
|---|---|---|
| 主进程 | `src/main/index.ts` | Codex |
| preload（沙箱，CommonJS） | `src/preload/index.ts` | Codex |
| 渲染层（单页，按 `?window=collapsed\|panel` 渲染不同窗口） | `src/renderer/app/index.html` | Claude |

- 根目录脚本：`pnpm app` 启动开发版（electron-vite dev），`pnpm build:app` 构建。安装包打包在 v1 之后。
- `app.isPackaged` 为 `false` 时，内核以开发模式运行（纯 JSON 校验、命名空间检查）。
- 单实例：`app.requestSingleInstanceLock()`；重复启动时打开面板。

**插件组装（组合根）**：v1 只支持仓库内置插件，构建时静态引入。

- 主进程：`src/main/plugins.ts` 列出每个插件的 `{ manifest, setup }`（引入 `@featherlog/plugin-*/manifest.json` 与 `@featherlog/plugin-*/main`）。
- 渲染层：`src/renderer/app/plugins.ts` 列出每个插件的界面入口（`@featherlog/plugin-*/ui`）。
- 这两个文件是全仓库**唯一**允许引入插件包的地方（AGENTS.md 规则 1 的例外）。

### 6.2 启动与退出

1. 取单实例锁，读取设置（§6.6），选择浮窗实现（§9）。兼容模式要在 `app.whenReady()` 之前加命令行开关。
2. 创建内核：真实时钟（`Date.now` / 全局 `setTimeout`）、日志器、`createServices`（§6.6 的存储与设置）。
3. `kernel.createBus('shell')`，注册外壳的应答者（§6.5）。
4. 创建 IPC 桥（§6.3），再 `kernel.load(内置插件)`。
5. 创建收起窗口并交给浮窗实现；面板窗口在第一次打开时才创建，之后关闭只隐藏、不销毁。
6. 退出（右键菜单"退出"、系统退出）：逆序卸载插件、`dock.detach()`、等待未完成的存储写入，然后退出。

### 6.3 IPC 桥

通道固定为四个：

| 通道 | 方向 | 内容 |
|---|---|---|
| `bus:send` | 窗口 → 主进程 | 事件或请求信封，主进程用 `kernel.inject` 投入总线 |
| `bus:deliver` | 主进程 → 窗口 | 该窗口订阅了的事件；该窗口发出的请求的响应 |
| `bus:subscribe` / `bus:unsubscribe` | 窗口 → 主进程 | 事件类型数组 |

- 主进程只接受形状合法的信封：`kind` 为 `event` 或 `request`，`type` 形如 `<模块>/<动作>`，`id` 与 `source` 为非空字符串；不合法的丢弃并记日志。
- 投递来自 `kernel.observe`：事件按订阅投递，**不做全量广播**；响应按"请求 id → 发出它的窗口"的映射投递，投递后删除映射。
- 窗口销毁或重新加载时，清空它的订阅和未决映射。
- 窗口**不能**注册应答者。窗口里消息的 `source` 是对应插件的 id，外壳自己的界面用 `shell`（v1 不做来源校验）。
- 请求超时由主进程的内核负责，窗口侧只等 `replyTo` 匹配的响应。
- `*` 订阅只在开发模式下允许（总线检查器）。

### 6.4 preload：`window.featherlog`

接口类型是契约的一部分：`packages/contracts/src/preload.ts` 的 `FeatherlogPreload`。要点：

- `window.kind`：`collapsed` 或 `panel`，主进程创建窗口时通过 `additionalArguments` 传给 preload。
- `bus`：§6.3 的原始传输；渲染层用它构造 `UiBus`。
- `settings`：`all()`、`set(scope, key, value)`、`onChange`。`scope` 是 `shell` 或插件 id。
- `dock`（只在收起窗口有效）：`resize({ width, height, expanded })` 按内容调整窗口尺寸，由 §9 的规则决定窗口往哪边变宽；`expanded` 变化时主进程发 `shell/view-changed`（`collapsed` ↔ `preview`）。`menu()` 弹出原生右键菜单：打开任务日志 / 设置 / 退出。
- `panel`（只在面板窗口有效）：`close()` 隐藏面板并发 `shell/view-changed`。
- `platform`：操作系统，以及当前浮窗实现的能力（§9），设置页据此显示提示。

打开面板不经过 preload，任何人都用总线请求 `shell/open-panel`。

### 6.5 外壳的应答与事件

| 请求 | 行为 |
|---|---|
| `shell/state` | 返回 `ShellState`：当前视图、全部角标、面板最近打开的标签页与参数。窗口加载后先取一次 |
| `shell/open-panel` | 创建或显示并聚焦面板窗口，记下标签页与参数，发 `shell/view-changed`（`view: "panel"`，带 `tabId`、`params`） |
| `shell/set-badge` | 记下角标，发 `shell/badge-changed` |
| `shell/notify` | 发 `shell/notified`（带唯一 `id`），由收起窗口显示 |

外壳的界面状态（角标、面板、通知）全部通过总线上的这些事件同步到窗口，不另开私有通道，总线检查器也能看到。

### 6.6 存储、设置、日志的实现

**存储**（`ctx.storage`，§5.5 的语义）：

- 位置：`<userData>/plugins/<插件 id>/<encodeURIComponent(键)>.json`。
- `set`：写 `*.tmp` → `fsync` → `rename`，同一个键的写入串行执行。
- `get`：文件不存在返回 `undefined`；JSON 解析失败抛错（code `shell/storage-corrupt`），**不覆盖、不删除**原文件。
- `keys`：列出该插件目录下的键。

**设置**：

- 全部保存在 `<userData>/settings.json`：`{ "shell": {...}, "plugins": { "<id>": {...} } }`，原子写入。
- 默认值：插件来自清单 `contributes.settings.schema` 的 `default`；外壳来自下表。
- `set` 按 schema 校验（v1 支持 `integer`/`number` 含 `minimum`/`maximum`、`string` 含 `enum`、`boolean`），不合法时以 `shell/invalid-setting` 拒绝。
- 变化同时通知插件的 `ctx.settings.onChange` 和所有窗口的 `settings.onChange`。

外壳自己的设置（scope `shell`）：

| 键 | 值 | 默认 | 说明 |
|---|---|---|---|
| `paper` | `"vellum"` / `"golden"` / `"aged"` | `"vellum"` | 纸张（渲染层读取） |
| `compatMode` | 布尔 | `false` | Linux 兼容模式：强制 XWayland（§9），重启后生效 |

**日志**：主进程与插件日志写到控制台和 `<userData>/logs/main.log`，单个文件超过 1 MB 轮转，保留 3 个。插件日志带 `[插件 id]` 前缀。

### 6.7 窗口

**收起窗口**：

- 无边框、透明背景、始终置顶、不进任务栏、无系统阴影，用 `showInactive()` 显示；`resizable: true`（理由见 §9.3）。
- 标题固定为 `featherlog-dock`（KWin 脚本据此识别，§9）；主进程拦截 `page-title-updated`，不让网页标题覆盖它。
- 尺寸完全由渲染层通过 `dock.resize` 决定，主进程把宽限制在 40–720、高限制在 80–900。它是一个置顶的浮窗，由用户拖动，具体规则见 §9。
- macOS：`setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`，并隐藏 Dock 图标（`app.dock.hide()`）。

**面板窗口**：

- 无边框（标题栏由渲染层绘制，带拖动区域），可调整大小，最小 960×640，默认 1240×800。
- 首次打开时居中于卷轴所在的显示器；记住上次的位置与尺寸（外壳存储）。
- 关闭（×、Esc）只隐藏；背景色设为 `#1f150d`，避免显示时闪白。

**安全**（两个窗口都适用）：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`；`setWindowOpenHandler` 一律拒绝；阻止 `will-navigate`；渲染层 HTML 带 CSP。

## 7. 界面插槽

### 7.1 两种插槽

- **声明式**：插件只提供 JSON，外壳统一渲染。图标、角标、设置项、通知。
- **挂载式**：插件在清单里声明，在界面部分用 `ctx.slots.provide(kind, id, mount)` 提供 `mount(el, host) => unmount`。

### 7.2 插槽清单

| 插槽 | 类型 | 窗口 | 声明位置 | 多个插件时 |
|---|---|---|---|---|
| 收起视图·图标 | 声明式 | 收起窗口 | `contributes.collapsedIcons` | 按 `order` 排列，用户可拖动调整；放不下折叠进"更多" |
| 收起视图·悬停预览 | 挂载式 `collapsed.preview` | 收起窗口 | 图标的 `preview: true` | 每个图标一个预览；默认悬停在第一个图标 |
| 面板·标签页 | 挂载式 `panel.tab` | 面板窗口 | `contributes.panelTabs` | 按 `order` 排列 |
| 弹窗 | 挂载式 `popup` | 弹窗窗口 | `contributes.popups` | 排队，同时只显示一个，高优先级可插队 |
| 通知 | 声明式 | 外壳决定 | 无需声明，发 `shell/notify` | 堆叠，自动消失 |
| 设置页 | 声明式（JSON Schema） | 面板窗口的设置页 | `contributes.settings` | 每个插件一节 |

规则：

- 所有 id 带插件前缀：`quest/today`、`quest/home`。
- 悬停预览挂载一次后常驻，悬停只切换显示；预览**可交互**（例如直接勾选任务）；高度由插件用 `host.setHeight` 申请，外壳限制最大值。
- 标签页切换时不卸载，通过 `onHide` / `onShow` 通知。
- 弹窗**永不抢焦点**（`showInactive`）。
- 插件的样式必须限定在自己的挂载点内（用 CSS Modules），不得写全局选择器；主题只通过外壳提供的 CSS 变量获取。

### 7.3 外壳的消息

见 `contracts/src/shell.ts` 与 §6.5：请求 `shell/state`、`shell/open-panel`、`shell/set-badge`、`shell/notify`；事件 `shell/view-changed`、`shell/badge-changed`、`shell/notified`。弹窗相关的 `shell/show-popup`、`shell/dismiss-popup`、`shell/popup-closed` 已在契约中，但 v1 不实现：`shell/show-popup` 立即返回 `popupId`，关闭时通过 `shell/popup-closed` 带回结果。

## 8. 任务面板插件（quest）

羽记的"任务"是游戏意义上的任务，而不是待办清单：同一时间只追踪一个任务，屏幕上只显示它的**当前目标**；目标按顺序一个个解锁；任务线分章节推进；完成时有仪式感。

### 8.1 分类

| kind | 名称 | 结构 | 例子 |
|---|---|---|---|
| `main` | 主线 | 任务线 → 若干章节 → 每章若干目标 | 「内存之王」：背完 Redis 八股，分数据结构、持久化、高可用、集群四章 |
| `side` | 支线 | 只有一章（无章名），零到多个目标 | 「登录门外的怪物」：修掉登录页 bug |
| `daily` | 每日委托 | 没有章节；每个周期重置；可以有每周期的配额 | 背 10 张卡片 |

- `title` 是真实目标，必填。`name`（任务名）和 `story`（简报）可选，界面缺省时直接显示 `title`。以后由 AI 插件把真实目标改写成任务名和简报。
- 没有目标的支线就是"一件事"，直接 `quest/complete`。

### 8.2 字段校验（不满足时抛 `quest/invalid-input`）

- `title`：去掉首尾空白后非空，最长 200 字符；`name` 最长 40；`story` 最长 2000。
- `main` 至少一章，每章至少一个目标；`side` 最多一章；`daily` 不能有章节。
- 目标 `text` 非空；`count.target` 为正整数。
- `recurrence`：`daily` 必填，其他类型禁止。`weekly` 的 `weekdays` 非空、不重复、取值 0–6。
- `quota`：只有 `daily` 可以有，`target` 为正整数。
- `deadline`、`scheduledFor`：合法的 `YYYY-MM-DD`。
- `kind` 创建后不能修改。

### 8.3 目标与章节的推进

- **顺序解锁**：当前章 = 第一个还有未完成目标的章；当前目标 = 当前章里第一个未完成的目标。只有当前目标能被完成，否则抛 `quest/objective-locked`。
- 计数目标：`quest/count` 累加到 `target` 时自动完成该目标。
- 一章的最后一个目标完成时，该章 `doneAt` 被设置，发 `quest/chapter-completed`。
- 最后一章完成时，任务**自动完成**（`status: completed`），发 `quest/completed`。这是游戏里的"任务完成"时刻，界面据此播放完成仪式。
- `quest/reopen-objective` 用于撤销：该目标及其后所有目标恢复为未完成；受影响的章节和任务一并恢复。撤销**不丢进度**：其中的计数目标，`current` 降为 `min(current, target - 1)`，而不是清零。
- `quest/complete` 对主线和支线表示"直接完成"：剩余目标全部完成，再完成任务。
- `revealed` 为 `false` 时，界面只显示已完成的目标和当前目标，后面的目标显示为"尚未揭晓"；未到达的章节只显示章序号。这只影响显示，不影响数据。

### 8.4 追踪

- 同一时间最多追踪一个任务，且**只有进行中的主线和支线可以被追踪**，每日委托不追踪（否则抛 `quest/invalid-input`）。`quest/track` 追踪一个任务时，自动取消之前的追踪，发一次 `quest/tracked`。
- 被追踪的任务完成、归档或删除时，追踪自动清空（`questId: null`）。
- 收起视图的悬停预览显示：被追踪任务的名字、当前章、当前目标，以及每日委托完成数和进行中的支线数。

### 8.5 周期与每日委托

- **周期键** `periodKey` = 把当前时间减去 `dayStartHour` 小时后，在系统本地时区下的日期。默认 `dayStartHour = 4`。
- 每日委托在某个周期"应做"：`freq: daily` 每天都应做；`freq: weekly` 在 `weekdays` 包含该日期星期几时应做。
- **跨周期**：发现周期键变化时，把所有每日委托的 `cycle` 重置为 `{ periodKey: 新值, current: 0, done: false }`，并发一次 `quest/period-rolled`。检测时机：`setup` 时；用 `ctx.clock.setTimeout` 定到下一个边界；**每次处理请求前**（笔记本睡眠时定时器不可靠）。
- 有 `quota` 的委托：`done` 等价于 `cycle.current >= quota.target`；`quest/count`（不带 `objectiveId`）达到配额时自动完成并发 `quest/completed`。`quest/complete` 把 `current` 设为 `target`；`quest/uncomplete` 把 `current` 设为 `max(0, target - 1)`。
- **连续记录** `derived.streak`：从上一个应做周期往前数连续完成的应做周期数，当前周期已完成再加 1。不应做的日子不中断，早于创建日期的周期不计。只做展示，**没有惩罚**。

### 8.6 列表与排序

`quest/list` 返回按 `kind` 分组后各自按 `order` 升序的任务。界面自行分组显示：主线、支线、每日委托。

`derived.dueToday`：应做的每日委托；或 `scheduledFor ≤ 今天`、`deadline ≤ 今天` 的进行中主线和支线。

**"今天"在整个任务插件里一律指当前周期键**（按 `dayStartHour` 偏移后的日期），包括 `dueToday`、`overdue` 和每日委托。例如一天从 4 点开始时，凌晨 1 点仍然算前一天：前一天到期的支线此时是"今日限期"，还不算逾期。

### 8.7 请求与事件

| 请求 | 成功时发出的事件 |
|---|---|
| `quest/create` | `quest/created` |
| `quest/update` | `quest/updated`（没有变化时不发） |
| `quest/set-chapters` | `quest/updated`（`changed: ["chapters"]`） |
| `quest/complete-objective` | `quest/objective-completed`；必要时再发 `quest/chapter-completed`、`quest/completed`、`quest/tracked` |
| `quest/reopen-objective` | `quest/objective-reopened`；任务因此重新打开时再发 `quest/uncompleted` |
| `quest/count` | `quest/counted`；达到目标时同上 |
| `quest/complete` | `quest/completed`（已完成时幂等，不发事件） |
| `quest/uncomplete` | `quest/uncompleted`（未完成时幂等） |
| `quest/track` | `quest/tracked`（没有变化时不发） |
| `quest/archive` | `quest/updated`（`changed: ["status"]`） |
| `quest/delete` | `quest/deleted` |
| `quest/reorder` | 每个 `order` 变化的任务发一次 `quest/updated` |

- 事件携带完整的 `quest` 快照（包含 `derived`），界面收到后直接替换本地数据。
- 请求处理过程中发出的事件，`causedBy` 设为该请求的 id；同一请求引发的多个事件按上表顺序发出。
- 收起视图图标的角标：`kernel/ready` 之后及每次变化时，按被追踪任务当前章的进度请求 `shell/set-badge`（`{ kind: "progress", value: chapterRatio }`，没有追踪任务时设为 `null`）。请求失败只记日志。

### 8.8 存储

建议的键（实现可调整，但要写在代码注释里）：`schemaVersion`、`quests`（不含 `derived`）、`history`（`{ [dailyId]: LocalDate[] }`）、`meta`（`{ lastPeriodKey }`）。

### 8.9 设置

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dayStartHour` | 0–23 整数 | 4 | 一天从几点开始；修改后按新值重新计算周期 |

## 9. 平台适配：浮动的卷轴

收起窗口是一个**置顶的浮窗**：用户按住卷轴两端的木轴，把它拖到自己想放的地方（通常是屏幕边缘）。外壳不强制贴边，只负责三件事：置顶、记住位置（平台允许时）、悬停展开时卷轴本身不跳动。

> 早先的方案是强制贴边（KWin 脚本按显示器边缘锚定），2026-09-28 改为浮窗：行为在各平台一致，实现也简单得多。

### 9.1 接口

```ts
interface Dock {
  readonly capabilities: DockCapabilities; // 见 contracts/src/preload.ts
  attach(window: BrowserWindow): Promise<void>;
  /** 渲染层要求改变尺寸时调用（§9.3 的规则）。 */
  resize(size: { width: number; height: number }): void;
  detach(): Promise<void>;
}
```

### 9.2 三种实现

| 条件 | 实现 | anchored | keepAbove | focusSafe | 记住位置 |
|---|---|---|---|---|---|
| Windows、macOS；Linux X11；Linux 兼容模式 | `ElectronFloat` | ✗ | ✓ | ✓ | ✓ |
| Linux Wayland，且 `XDG_CURRENT_DESKTOP` 含 `KDE` | `KWinFloat` | ✗ | ✓ | ✗ | ✗ |
| 其他 Linux Wayland（如 GNOME） | `PlainFloat` | ✗ | ✗ | ✗ | ✗ |

- `anchored` 在 v1 一律为 `false`（不再强制贴边），渲染层据此把木轴做成拖动把手。
- 判断 Wayland：`process.platform === 'linux'`、存在 `WAYLAND_DISPLAY`、且没有开启兼容模式。

### 9.3 共同规则

- **窗口属性**：无边框、透明、`resizable: true`、不进任务栏、`showInactive()` 显示。必须 `resizable: true`：实机发现 Wayland 下不可调整大小的窗口 `setSize` 不生效，窗口停留在旧尺寸（用户仍然改不了它的大小，因为它没有边框可拖）。
- **拖动**：由渲染层的 CSS 拖动区域（`-webkit-app-region: drag`）交给窗口系统完成，各平台都可用。
- **首次出现的位置**：最右侧显示器的右边缘、竖直居中。
- **悬停展开时卷轴不动**：便签在卷轴左侧展开，窗口**向左**变宽——保持窗口的右边缘不变；如果这样会超出所在显示器的左边界，就整体右移到刚好留在屏幕内。收起时反过来。这条规则在能定位窗口的平台由主进程实现，在 KDE Wayland 由 KWin 脚本实现。

### 9.4 ElectronFloat（Windows、macOS、X11、兼容模式）

- `setAlwaysOnTop(true, 'floating')`；macOS 另加 `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`。
- `resize`：按 §9.3 算出新位置，`setBounds`。
- **记住位置**：窗口 `moved` 后保存 `{ x, y }`（外壳存储，防抖）；启动时恢复。若保存的位置已不在任何显示器上（显示器被拔掉），退回默认位置。

### 9.5 KWinFloat（KDE Plasma，Wayland）

Wayland 下应用不能置顶、也不能定位自己，交给一个**很小的** KWin 脚本：

- **加载**：生成脚本写到 `<userData>/kwin/featherlog-float.js`，通过 DBus 加载与运行（`org.kde.KWin /Scripting` 的 `loadScript` 与 `/Scripting/Script<id>` 的 `run`），卸载用 `unloadScript("featherlog-float")`；启动时先卸载同名残留。DBus 调用用 `execFile`，依次尝试 `qdbus6`、`qdbus`、`gdbus`，封装为可注入的执行器。
- **脚本只做三件事**：
  1. 按标题 `featherlog-dock` 找到收起窗口（窗口出现时、标题变化时都检查），设置 `keepAbove`、`onAllDesktops`、`skipTaskbar`、`skipPager`、`skipSwitcher`；
  2. 第一次找到它时，放到最右侧 output 的右边缘、竖直居中；
  3. 监听 `frameGeometryChanged`：若只是**尺寸**变了（不是用户拖动造成的位置变化），按 §9.3 保持右边缘并夹在 output 内（加守卫，避免回调里改几何又触发自己）。
- 参考原型 `spike/collapsed-view` 的 `kwin-anchor.js`（已在 KDE Plasma 6.7 上验证过 DBus 加载与 `frameGeometryChanged` 重新定位），但**不要**做边缘锚定。
- 已知限制：重启后回到默认位置（Wayland 下应用读不到自己的位置）；窗口首次出现时 KWin 可能会激活它一次。
- 找不到任何 DBus 工具时退化为 `PlainFloat` 并记日志。

### 9.6 PlainFloat（其他 Wayland）

- 不定位、不保证置顶；窗口向右变宽（左上角不动，卷轴会随展开移动一次）。
- 设置页据 `capabilities` 提示："当前桌面不支持置顶，可开启兼容模式后重启"。

### 9.7 兼容模式

设置 `compatMode = true`（或环境变量 `FEATHERLOG_COMPAT_MODE=1`）时，在 `app.whenReady()` 之前 `app.commandLine.appendSwitch('ozone-platform', 'x11')`，改走 XWayland，从而使用 `ElectronFloat`。代价：XWayland 只有一个全局缩放比例，混合缩放的多块屏上可能发糊。

> 实机注意（2026-09-28，Arch + KDE Plasma 6.7）：兼容模式下 Chromium 的 GPU 进程反复段错误（Mesa 的 `/usr/lib/gbm/dri_gbm.so` 被 GPU 沙箱拒绝），窗口画不出来；原生 Wayland 正常。这是系统更新与 Chromium 的兼容问题，不在本项目内处理。

## 10. 前端

- React + TypeScript，动效用 Motion；组件样式用 CSS Modules；不使用 Tailwind 和成品组件库。
- **视觉方向：羊皮纸任务日志**。完整面板是一本摊开的冒险者日志（左页任务列表、右页任务详情），收起视图是一个置顶的浮动小卷轴。质感来自纸纤维、污渍、毛边、墨迹和火漆，但克制使用，保证每天看很多次也不累。
- 整本日志是"手写"的。字体都是 SIL OFL 开源授权，随应用打包，不依赖网络：
  - **马善政毛笔楷书**：标题、分区名、列表里的任务名，毛笔笔锋。
  - **小赖字体**：其余一切文字，像钢笔写的，松弛但好读。
  - 不使用拉丁装饰字体。
- 纸张是程序生成的羊皮纸：可平铺的纸面（柔和的大面积色差、光照模拟的起伏）加一层拉伸到任意尺寸的边缘焦痕，外加毛边遮罩。默认"淡黄"，另有"金黄""陈旧"两种。纹理在构建时预先生成为静态图片（`packages/shell/scripts/gen-textures.sh`），运行时不使用实时 SVG 滤镜。
- 主题通过外壳提供的 CSS 变量暴露给所有插件（颜色、字体、纸张纹理），插件用它们画出同一种纸。

## 11. 协作流程

- Claude 负责方案设计、`packages/contracts`、全部前端，以及审查 PR。
- Codex 负责内核、插件的主进程部分、Electron 主进程和 preload，每项工作提一个 PR。
- `packages/contracts` 和 `manifest.json` 是双方的接口。需要修改时，在 PR 描述里单独列出"契约变更"一节，说明原因，经审查后合并。
- 每个 PR 必须通过 `pnpm typecheck` 和 `pnpm test`。

## 12. 以后再说

- AI：拆解目标、排今日计划、估算耗时、自然语言录入。AI 将作为普通插件，通过 `quest/*` 请求操作任务，`source` 与 `causedBy` 用于展示和撤销。
- 奖励、钱包、游戏接入。
- 八股弹窗和 Claude Code hooks。
- 本地 WebSocket 桥（需要校验 Origin 或 token）。
- 第三方插件的运行时动态加载（v1 只支持仓库内置插件）。
- 界面国际化（v1 界面文案为中文）。
