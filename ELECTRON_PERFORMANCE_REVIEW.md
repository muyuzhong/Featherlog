# Electron 性能优化与审查说明

## 做了什么

当前主入口静态加载 `electron-updater` 和 KWin 服务间接依赖的 `dbus-next`。即便是开发版、包管理器安装或非 KDE 平台，也承担它们的解析和模块初始化成本；可检查更新的安装还会提前创建更新器。

- 更新器依赖与实例都在首次更新检查时才加载／创建。启动后 30 秒、手动检查、睡眠恢复和失败重试仍使用原有调度；自动更新关闭时不会主动加载。
- KWin 的 DBus 服务只在选中 KWin 并找到可用工具后动态加载。其他浮窗实现与工具缺失的回退不加载 `dbus-next`。
- Linux／Windows 在 Electron ready 前移除无边框窗口不使用的默认应用菜单。保留卷轴原生右键菜单；macOS 保留默认应用菜单及编辑快捷键。
- 第一轮没有增加依赖，也没有修改渲染层、preload、内核、插件、既有审查文件或真实应用数据；第二轮的主进程插件优化见文末。

## 搜索依据与项目对应

Electron 官方建议先测量，再减少无用依赖、延迟非关键功能初始化、避免阻塞主进程、打包代码、移除不使用的默认菜单：[Performance](https://www.electronjs.org/docs/latest/tutorial/performance)。本次针对实际存在的启动依赖问题实施改动。

项目已经使用 electron-vite 打包、异步原子存储、事件按订阅投递、面板首次打开才创建、默认后台节流，以及本地字体／纹理。这些不重复改造。设置的启动同步读取为兼容模式开关在 ready 前生效服务，不能直接换成异步读取。

隐藏窗口可利用页面可见性暂停昂贵工作：[BrowserWindow — Page visibility](https://www.electronjs.org/docs/latest/api/browser-window#page-visibility)。隐藏后的面板仍按设计常驻，本次没有销毁窗口或清空用户编辑状态。

macOS 的应用菜单承担编辑快捷键角色，保留它：[Keyboard Shortcuts](https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts)、[Menus](https://www.electronjs.org/docs/latest/tutorial/menus)。

## 性能对照

环境：同一 Linux 主机、Electron 44.4.5、electron-vite 构建产物、Xvfb `:1`、X11 兼容模式。测试进程的 `--disable-gpu` 仅用于虚拟显示对照，产品没有增加此开关。使用独立空数据目录；每个版本 5 个新进程，取中位数。对照构建先于本次修改保存，重测时没有并行打包。

| 指标 | 修改前 | 修改后 | 变化 |
|---|---:|---:|---:|
| 测量入口开始执行 → 卷轴 show 事件 | 194.86 ms | 148.85 ms | −23.6% |
| 卷轴显示 500 ms 后主进程 JS heapUsed | 7.51 MiB | 4.35 MiB | −42.0% |
| 同时刻主进程 RSS | 171.76 MiB | 163.79 MiB | −4.6% |
| 启动时 electron-updater 的已加载 CommonJS 模块数 | 32 | 0 | 按需加载 |
| 启动时 dbus-next 的已加载 CommonJS 模块数 | 25 | 0 | 按平台加载 |

这些是应用入口阶段和主进程的测量，不包含 Electron 二进制启动时间，不是首次绘制或全部进程的物理内存测量。RSS 受运行环境影响，不能据此承诺所有平台的固定降幅。这个对照为未打包模式加载生产构建产物，更新状态为 unsupported；真实安装包另做启动与按需加载验证。

自动更新启用的可检查安装，在第一次检查后仍会加载更新依赖，因此该部分内存节省主要在启动阶段；开发模式、managed 安装或不检查更新时可以持续省去它。KDE Wayland 仍需加载 DBus 服务，对照里该依赖的节省不适用于它。

测量脚本、逐次原始记录与构建日志保留于本次会话的 `/tmp/featherlog-electron-perf/`：`harness.mjs`、`run.py`、`before.json`、`after.json`、`package-smoke.mjs`。这是临时测量材料，未引入项目级基准框架。

## 契约变更

无。`packages/contracts`、插件 manifest、IPC 通道、消息与存储格式均未修改。仅外壳内部更新器工厂允许异步返回。

## 测试覆盖了哪些规则

- 模块导入时不加载更新依赖或 DBus 服务；找到 KWin 工具后才加载并正确释放服务。
- 首次自动检查前不创建更新器，多个后续检查复用同一实例；自动检查关闭时不创建，手动检查仍可用。
- 异步加载期间重复检查不重复创建；加载完成前退出，不开始检查、不附加监听器。
- 加载失败进入 error，并按现有退避时间重试。
- 既有 30 秒／6 小时调度、睡眠恢复、120 秒停滞超时、旧实例隔离、下载、退出安装、隐私过滤和一次性通知测试继续通过。
- `pnpm typecheck`、`pnpm test` 通过：21 个文件、480 项测试。`pnpm build:app`、`git diff --check` 通过。
- 用 electron-builder 生成 Linux unpacked 安装包，再启动其中的实际可执行文件。验证卷轴可见、默认菜单移除、首次没有加载两类依赖、面板打开／隐藏／复用、手动检查加载打包的更新依赖，以及 app.asar 中 KWin chunk 可加载。数据目录独立；未连接或卸载用户的 KWin 服务。
- Windows／macOS 实机表现和安装包未在本机验证，应由对应平台 CI／审查补充。构建仍有既有 Motion `use client` 指令被忽略的警告。

## 与设计文档不一致或设计文档没写清楚的地方

没有改变设计明确规定的行为。§12 没有规定更新依赖的加载与实例创建时机，本次延后到首次检查；§9.5 的工具选择、DBus 注册和回退语义继续保留。默认应用菜单策略在设计中未写明：Linux／Windows 不创建，macOS 保留编辑快捷键。

## 前端需要配合的地方

按 AGENTS.md 未修改以下代码；这些是候选项，尚未测量实施后的收益：

1. `packages/shell/src/renderer/app/index.tsx` 同时静态引入 `CollapsedApp` 与 `PanelApp`。可按窗口拆分加载，同时检查 UI 插件组合根及运行时是否仍提前加载面板组件，避免只拆入口却保留间接依赖。本次构建 renderer JS 约 1.06 MB。
2. 多个组件从 `motion/react` 引入完整 `motion`。可评估官方 LazyMotion 方案，或只将简单过渡交给 CSS；先测动效成本，再修改。
3. WOFF2 产物合计约 18.50 MB。安装包已排除旧浏览器 WOFF 回退，无需再次处理；后续字体方案必须覆盖用户自由输入的汉字，不能只按固定界面文案裁剪。
4. 检查面板隐藏时是否还在发业务请求／执行昂贵动效。当前 PanelApp 已监听 visibilitychange，应沿用已有可见性机制，不能跳过任务跨周期正确性。

没有加入通用 worker 池、缓存框架、GC 调参或禁用 GPU 的产品配置。Electron／Chromium 自身的多进程基础成本仍然存在；减少应用层启动工作不能把它变成原生工具的体积。

## 第二轮：参考工程分享后的优化

### 做了什么

- `plugins/quest/src/main/storage.ts`：schemaVersion 2 的独立记录从逐个读取改为每批最多 16 个并发读取。仍按索引顺序组装、完整校验后才清理孤立记录；写入、迁移和原子提交协议不变。
- `packages/shell/src/main/dock.ts`：ElectronFloat 同一目标尺寸且当前几何已经满足要求时，省去重复 `setBounds`。仍更新展开状态、保留边界夹取；目标改变时即便原生尺寸尚未更新，也必须发出调整，保证动画反转正确。
- KWinFloat／PlainFloat 的 `setSize` 路径保留原行为。Wayland 的原生尺寸可能异步更新，不用当前尺寸直接判定一个请求是否多余。

### 看了哪些分享，如何取舍

实际通过 BrowserOS 阅读了用户原先打开的 Twitter 搜索及另开的“electron 内存 优化”搜索，没有改变原标签页。

- [Innei 的 Twitter 分享](https://x.com/__oQuery/status/2104963849468457116)与[作者原文](https://innei.in/en/posts/tech/electron-ota-updater)：讨论拆分更新载荷、增量传输和发布流程提速。这解决更新与分发成本，不能直接作为运行时内存优化；本项目的 GitHub Releases／electron-updater 协议按 §12 保留，不引入自研 OTA。
- [Slack：重建桌面客户端](https://slack.engineering/rebuilding-slack-on-the-desktop/)：通过更懒的数据加载和减少重复客户端进程处理扩展成本。羽记已经将业务状态放在主进程，继续沿用现有架构；面板常驻是设计要求，不直接照搬销毁闲置客户端方案。
- [Slack：Making Slack Faster By Being Lazy, Part 2](https://slack.engineering/making-slack-faster-by-being-lazy-part-2/)：减少不必要工作，警惕过度缓存与阻塞 I/O。此次没有额外缓存完整业务状态。
- [Node.js 文件系统 Promises API](https://nodejs.org/api/fs.html#promises-api)：异步文件操作利用线程池。并发上限 16 是本项目的实现选择，收益来自下面的实际文件测试，不是文章承诺。

### 测量与验证

真实 JSON 文件对照：500 个 daily 任务，每个有 2000 字符 story、365 天历史；通过外壳的实际 JsonFiles／pluginStorage 加载相同 schemaVersion 2 数据。预热一次，再交替测修改前后各 20 次，包含读取、JSON 校验、任务校验及记录目录扫描。

| 指标 | 第二轮之前 | 第二轮之后 |
|---|---:|---:|
| openState 中位数 | 65.94 ms | 46.19 ms |
| X11 下 2000 次相同尺寸请求的原生 setBounds 次数（预热后） | 2000 | 0 |
| 上述请求处理耗时中位数 | 14.20 ms | 12.75 ms |

任务加载约快 30%。这是同机文件缓存已预热的合成大数据对照，不是磁盘冷缓存或用户全应用启动测量；任务数较少时收益更小。并发读取会同时保留至多一批读缓冲，不宣称本轮降低常驻内存。

窗口测量使用真实 Electron 44.4.5、Xvfb／X11、独立空数据目录，通过主进程 IPC 入口发送相同尺寸请求；取预热后 5 次中位数。它证明重复工作减少，不代表正常鼠标悬停或 KDE Wayland 的固定提速。

新增回归覆盖：最多 16 个并发读取、跨批次加载、读取逆序完成仍保持索引顺序、损坏引用不清理数据、重复尺寸不触发原生调整、展开状态不丢失、屏幕夹取仍执行，以及原生尺寸滞后时仍能反向调整。全量测试现为 21 个文件、484 项通过。

第二轮测量脚本与原始记录在 `/tmp/featherlog-electron-perf/`：`storage-benchmark.mjs`、`storage-benchmark.json`、`native-bootstrap.mjs`、`native-benchmark.mjs`；修改前源文件和构建位于 `second-before/`。没有新增基准框架或依赖。

### 契约变更

无。类型契约、manifest、IPC、存储格式均未改变。

### 与设计文档不一致或没写清楚的地方

没有改变明确规则。§8.8 规定完整校验后才能清理，但没有要求独立文件必须逐个读取；本轮使用有上限的并发读取。§9.3 的展开方向、中心保持、边界夹取与 §9.4 的拖动保存规则继续保留。

前端候选项仍按上文留给 Claude，前端代码未修改。

## 第三轮：减少任务状态的常驻内存

### 做了什么

- `plugins/quest/src/main/storage.ts`：`openState` 返回当前已提交状态的 getter。原先返回对象的 `state` 属性始终指向启动时的完整状态；虽然内部保存逻辑已经切换到新状态，插件仍持有这个返回对象，启动时的任务及历史无法被回收。现在成功提交后只引用最新状态，提交失败继续引用原状态。
- `plugins/quest/src/main/index.ts`：视图缓存使用浅层包装，共享任务的章节、目标、计数等内部数据，去掉缓存时的第二份深复制。所有写操作仍先复制要修改的任务；§4.3 要求的总线深复制和冻结继续保留，因此外部响应及事件仍是独立、只读快照。
- 未新增依赖、产品 GC 调参或主动 GC 调用；未修改前端、契约、manifest 或存储格式。

### 测量与验证

遵循 [Electron 官方性能指南](https://www.electronjs.org/docs/latest/tutorial/performance)的测量优先原则，本轮比较可回收临时对象清理后的驻留量。临时诊断脚本通过 Inspector 的 [HeapProfiler.collectGarbage](https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/#method-collectGarbage)统一回收，再读取 [Runtime.getHeapUsage](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-getHeapUsage)；没有在产品中强制回收。

环境：同机 Electron 44.4.5、Xvfb／X11、独立测试数据目录、生产构建产物但未打包（内核开发模式开启），仅创建卷轴窗口。每个版本交替启动 5 个新进程，取中位数。数据为 200 个 main 任务，每个 story 2000 字符、10 章 × 10 个计数目标，目标含 80 字符附加文本及 160 字符详情，使用实际 JsonFiles／pluginStorage 读写真实文件。`--disable-gpu` 仅用于虚拟显示测试。请求从主进程 IPC 入口进入；诊断请求的响应在主进程接收并丢弃，避免渲染层额外保留测试列表。未使用用户数据或修改渲染代码。

| 主进程 JS 堆，统一回收后 | 第三轮之前 | 第三轮之后 | 降幅 |
|---|---:|---:|---:|
| 卷轴启动、加载任务后 | 20.13 MiB | 11.75 MiB | 41.6% |
| 完整查询一次任务列表后 | 20.16 MiB | 11.78 MiB | 41.5% |
| 将全部任务倒序重排并再次查询后 | 37.13 MiB | 12.49 MiB | 66.4% |
| 删除全部任务并确认列表为空后 | 20.44 MiB | 4.13 MiB | 79.8% |

重排后的主进程 RSS 中位数也由 202.44 MiB 降到 177.07 MiB。JS 堆与 RSS 是不同指标，以上不是全应用多进程物理内存的降幅，也不是正常使用的固定百分比。数据量、章节数量越少，绝对收益越小；渲染进程和 Electron 自身的基础成本仍存在。删除测试说明旧启动状态与其缓存可以释放，产品中何时实际回收由 V8 决定。

原始数据和可重跑脚本：`/tmp/featherlog-electron-perf/memory-benchmark.mjs`、`memory-benchmark.json`、`memory-benchmark.log`；第三轮前源文件和构建产物位于 `third-before/`。没有新增项目级基准框架。

回归验证覆盖：

- 已提交状态的引用只在索引提交后替换，写入失败保留原引用，重试可成功，提交后清理失败不撤销提交。
- 写操作只深复制正在修改的任务一次，不再为视图缓存复制第二次；未变化任务的缓存继续复用。
- 开发和生产模式下，调用方修改输入或接收快照不会修改实时状态；旧列表、创建事件和响应中的嵌套计数不随后续写入改变；失败写入仍回滚，重试仍正常。
- `pnpm typecheck`、`pnpm test` 通过（21 个文件、485 项测试）；`pnpm build:app`、`git diff --check` 通过。构建保留既有 Motion `use client` 警告。

### 契约变更

无。getter 是插件内部持久化对象的实现；消息与存储格式未改变。

### 与设计文档不一致或没写清楚的地方

没有改变明确规则。§4.3 的复制边界和 §8.8 的提交、回滚语义保持不变；设计没有要求内部缓存也深复制完整任务。前端与隐藏窗口常驻行为继续保留。
