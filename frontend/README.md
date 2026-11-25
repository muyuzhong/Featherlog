# 羽记 v2 前端（frontend/）

屏幕底部的并发工作托盘 + 展开工作台（待办 / 随笔）。React 19 + motion + Vite，跑在 MyGo 窗口里，也能脱离后端在浏览器里独立运行。

## 运行

```sh
cd frontend
pnpm install          # 本目录自成一个 pnpm 根（见 pnpm-workspace.yaml），不碰仓库根的 workspace
pnpm dev              # http://localhost:5173 ，MyGo 的 devUrl 指这里
pnpm typecheck        # tsc --noEmit（TypeScript 7）
pnpm test             # vitest run（jsdom）
pnpm build            # 产物在 frontend/dist，给 MyGo 的 frontendDist
```

## 三种显示模式

URL 的 `?mode=` 优先（`bar` / `panel` / `dock`，区分大小写）；没有合法的 `mode` 时，有 `window.__FEATHERLOG_MYGO__` 或 `window.mygo` 就是 panel，否则是 dock。宿主用同一份 `frontend/dist` 开两个窗口：`/?mode=bar` 和 `/`（或 `/?mode=panel`）。

| 模式 | 什么时候 | 页面 |
|---|---|---|
| **bar** | `?mode=bar` | 独立的 312×40 无边框滚筒常驻条窗口：只有 Tray，铺满 100vw×100vh，实心 `var(--bg-tray)`、直角、1px 内描边。给没有 KDE 插件的系统（Windows、macOS、GNOME…）用 |
| **panel** | 有 MyGo 运行时且没有 `?mode=`，或 `?mode=panel` | 只有展开工作台（Drawer），铺满整个窗口：`html/body/.stage` 用实心 `var(--bg-canvas)`，外框无圆角、只有 1px 内描边，四周不留透明边距 |
| **dock** | 普通浏览器标签页，或 `?mode=dock` | 底部滚筒条 ↔ Drawer 展开，带弹簧动画（浏览器预览用） |

### bar：滚筒常驻条

- 左边是拖拽把手（`--app-region: drag` + `-webkit-app-region: drag`），按钮和滚筒都是 `no-drag`，可以把条拖到任务栏空白处或屏幕任意位置。
- 中间是 3D 圆柱滚筒（`perspective: 520px`），和 KDE 插件同一套几何：
  - 正面只有一张卡：实心卡片、专注时左侧 2px 墨线、加粗标题、后台显示等宽时长、待看显示反白签条。
  - 相邻槽位卷到两侧：`rotateY(±52deg) translateZ(-26px) scale(0.84)`，朝外的一侧压上中性灰渐变。2 张时只有右侧一张（两张互换时都从右侧进出，不跳边），3 张起左右各一张，更远的在 1～1.5 的位置淡出，看不到背面换位。
  - 位置是无界浮点数：从最后一张滚到第一张是向前一步（目标从 2 变 3），不会倒带。动画用 motion 的 `animate` + 同一个 `SPRING`，没有 CSS `@keyframes`；系统开了「减少动态效果」时直接跳到位。
  - 4 张及以上、背面有待看时，右侧显示「待看 N」，点一下转到第一张待看。
- 交互：滚轮上下切焦点（75ms 内只算一格），点两侧卷起的卡片转到正面并专注，点正面已专注的卡片开关工作台，中键在待看 / 后台之间切换（滚筒不动），获得键盘焦点时方向键也能转。
- 右侧：「+ 新并发槽」、等宽的待办计数 `done/total`、展开 / 收起箭头。
- 工作台是宿主的另一个窗口，bar 页面自己**从不改变窗口大小**（不调用 `DockService.Resize`），也**不会因失焦收起**：
  - 箭头、正面已专注卡片：`DockService.Toggle()`（不带参数，由宿主翻转）；
  - 「+」、待办计数、Alt+N、Ctrl+K：`DockService.Toggle({ expanded: true })`，只打开、不会把已开的面板关掉。新卡输入框和搜索框在另一个窗口里，bar 只负责把它打开；
  - 收到 `dock:toggle` 只更新箭头的展开状态（`ui.panelOpen`）。
- 在 dock 模式（浏览器预览的收起态）里用的是同一个滚筒组件，只是「打开工作台」变成展开本页的 Drawer。

### panel：弹出工作台

panel 模式对应现在的宿主分工：收起态由 KDE 底部状态栏插件（Plasmoid）原生显示，MyGo 窗口只负责点插件后弹出的 880×520 面板，并且是**不透明窗口**（`Transparent: false`，规避 WebKitGTK 在混合显卡下透明窗口局部重绘残缺）。

- 点右上角「收起」，或未钉住时按 `Esc` / 窗口失焦：调用 `DockService.Resize({ width: 880, height: 520, expanded: false, pinned })` 让宿主隐藏弹窗。前端视图**仍保持 Drawer**，下次点状态栏插件直接显示，没有 Tray→Drawer 的切换和闪烁。钉住时 `Esc` 和失焦不收，「收起」按钮仍然收。
- 同一次收起里 `Esc` 之后紧跟的失焦只发一次请求（500ms 内去重）。
- panel 模式下前端**不主动发** `expanded: true` 或收起条尺寸；窗口何时显示、多大由宿主决定。收到 `dock:toggle` 也不改视图（宿主已经自己显示或隐藏了）。
- `?mode=panel` 不带 MyGo 时用 mock 后端，可以在浏览器里预览弹窗本身。
- 顶栏新增「常驻条」切换：自动 / 滚筒 / 托盘（`Settings.barMode` 的 `auto` / `standalone` / `tray-only`）。Ctrl+K 里也能切换，并有「重置滚筒条位置」（`SettingsService.Update({ barX: null, barY: null })`）。

### 契约变更（前端已改，Go 与 `docs/design.md` 需要跟进）

这次只改了 `frontend/`，按 AGENTS.md 第 7 条，下面这些需要后端和设计文档同步：

1. `Settings` 新增 `barMode: "auto" | "standalone" | "tray-only"`（默认 `"auto"`），以及可选的 `barX?: number | null`、`barY?: number | null`（滚筒条被拖到的屏幕坐标；`null` 或缺省表示用宿主的默认位置）。前端读到没有 `barMode` 或值不认识时按 `"auto"` 处理，所以旧后端也能用。
2. `DockService` 新增 `Toggle(input?: { expanded?: boolean }) → { expanded: boolean }`：显示或隐藏 880×520 工作台窗口，不带 `expanded` 时翻转；前端调用 `window.mygo.call("DockService.Toggle", input ?? {})`。宿主应在之后向所有窗口（包括 bar 窗口）广播 `dock:toggle { expanded }`。
3. 期望宿主做的事（前端不做）：
   - 按 `barMode` 决定是否开 `?mode=bar` 窗口：312×40、无边框、不透明、置顶、不进任务栏；
   - 用户拖动后把位置写进 `barX/barY`（前端只会写 `null` 来重置），收到 `settings:changed` 里位置被清空时把窗口放回默认位置；
   - bar 窗口不要因失焦隐藏。

浏览器里打开时没有 `window.mygo`，自动使用 `LocalMockBridge`：数据存在 localStorage（`featherlog.mock.v2`），首次打开带 3 个并发槽（专注 / 后台带回看提醒 / 待看）、几条平等的工程待办（两条每日重置、一条今天已完成）和几条随笔。之前打开过预览的浏览器里存的是旧示例数据，点“重置示例数据”即可换成新的。页面左上角可以“模拟全局快捷键”和“重置示例数据”。

## 结构

```
src/
  rpc/types.ts      契约类型（说明书 §4.1–4.3 原样）+ 各方法的输入类型 + 事件表
  rpc/bridge.ts     Bridge 接口；MyGoBridge（window.__FEATHERLOG_MYGO__ / window.mygo）；createBridge()
  rpc/mock.ts       LocalMockBridge：同一套服务和事件，localStorage 持久化，注入时钟
  lib/              纯逻辑：槽位状态规则、任务/配额/周期、时间格式、窗口尺寸、按键映射、合成音效、Clock
  state/store.ts    AppStore：唯一状态源，乐观更新 + 以后端返回为准，事件订阅，窗口尺寸同步
  state/react.tsx   useSyncExternalStore 绑定、useNow()
  ui/               Tray（收起条）、Drawer（展开态顶栏 + 搜索）、NowDeck、TaskPanel、NotesPanel
  styles/           tokens.css（纸石 / 石墨两套色阶、同心圆角）、app.css
```

## 待办：所有任务都是平等的普通待办

界面上不再有「主线 / 支线 / 日常」或「今日」之分：

- 左下栏标题「待办」，右侧 `已完成/总数`。未完成的按添加顺序平铺，本周期内完成的折叠在「已完成」里；更早完成的不再出现在列表里。每日重置的待办只在它该做的日子出现。
- 新建框：「新建待办，回车即建（末尾写 ×5 设次数）」。调用 `TaskService.Create({ kind: "side", title, quotaTarget?, scheduledFor: <今天的 periodKey> })`（后端也支持省略 `kind` 或传 `"task"`），`barhttp` 的 `todayDone/todayTotal` 与前端统计完全对齐。
- 任务行下面只剩截止日、子项进度、「在台上」，不显示类型；Ctrl+K 的待办结果也不带类型标签，只在已完成的条目旁写「已完成」。
- 后端已有的 `main` 任务照常显示，和其它待办没有区别。
- **每日重置**：在任务的展开详情里，是唯一能看出区别的地方。切换时直接原地调用一次 `TaskService.Update`（开启传 `recurrence: { freq: "daily" }`，关闭传 `recurrence: null`），保留原任务 ID、子项、次数、关联槽位与手记。详情里显示「每天 4:00 清零 · 已连续 N 天」。

## 与 Go 后端对接

- 调用名：`WorkbenchService.List`、`WorkbenchService.SetState`、`TaskService.StepQuota`、`NoteService.List`、`SettingsService.Update`、`DockService.Resize` ……（`rpc/bridge.ts` 的 `GO_METHODS`）。每个方法**一个 JSON 对象参数**，无参方法不传参；`NoteService.List` 不过滤时传 `{}`。
- 订阅事件：`workbench:changed`、`tasks:changed`、`notes:changed`、`settings:changed`、`dock:toggle`。前端对“调用返回值”和“事件”都会应用，两者重复到达没有副作用。
- 窗口：在 MyGo 里（panel 模式）只发一种请求，隐藏弹窗 `{width: 880, height: 520, expanded: false, pinned}`，见上文。
- dock 模式（浏览器预览）仍按原方案计算：收起 `{width: 460–900, height: 44, expanded: false}`，展开 `{width: 880, height: 520, expanded: true}`，变大时先 Resize 再播动画，变小时等动画收完（280ms）再 Resize。
- 失焦收回：只在 MyGo 里生效（监听 `window` 的 `blur`），钉住时不收；`Esc` 同理。`Ctrl+P` 在页面里 `preventDefault`。
- 拖拽区：收起条左侧把手、展开态顶栏，`--app-region: drag`。

## 需要 Go 侧确认 / 说明书没写清楚的地方

以下按“不猜着实现”的原则处理：前端照下面的做法写了，mock 也照此实现；后端若不同，告诉我改前端。

1. **`create` 不传 `state` 时的默认值**：mock 取 `running`（不抢焦点）。前端自己总是显式传：新卡和「上台」传 `focus`。
2. **`WorkbenchService.create` 只返回新槽位**，看不到被挤下去的旧焦点。前端在 create 之后会再 `List` 一次；后端如果同时广播 `workbench:changed`，这次 List 就是多余但无害的。
3. **回看倒计时的起点**：契约只有 `remindAt`，没有“什么时候设的”。前端本地记录第一次看到这个 `remindAt` 的时刻（启动时则用 `stateChangedAt`）来画 1px 进度线。建议加可选字段 `remindSetAt`（只加不改）。
4. **到点转 `ready`** 由后端负责并推 `workbench:changed`；前端不自己改状态，只在收到 running→ready 时播一声提示音。mock 把 `stateChangedAt` 设为 `remindAt`（即“从什么时候开始等你”）。
5. **“跟随系统”主题**：`ThemeMode` 只有 `stone | graphite`。前端把“跟随系统”存在 localStorage，选具体主题时才写 `SettingsService.Update({theme})`。若希望后端也认得，给 `ThemeMode` 加 `'system'`。
6. **焦点手记**：`Note` 只有 `taskId`。焦点槽位没关联任务时没有地方挂手记，界面会提示“在左边点一个任务，或把任务上台”。左栏点过的任务优先于焦点槽位的任务。若要给槽位直接记手记，需要 `Note.slotId`。
7. **隐藏弹窗靠 `Resize` 的 `expanded: false`**：前端约定宿主收到它就隐藏窗口（尺寸仍是 880×520）。仓库里 `internal/dock` 的 `Resize` 目前只改尺寸、`WindowOptions` 仍是 `Transparent: true`，`docs/design.md` §5.1 也还写着透明窗口——以宿主团队那边的新实现为准，文档需要跟上。
8. **子项全部勾完不自动完成任务**（只有配额达到目标才自动完成），说明书只对配额写了“达到目标自动完成”。
9. **每日重置的连续天数**：mock 在错过一个“该做”的周期后归零，非该做的日子（weekly 的其他天）不影响。“无断签惩罚”理解为除了归零不做别的。以后端为准。
10. **删除任务**：mock 把挂在它下面的随笔变成独立随笔（`taskId: null`），并解除槽位的 `linkedTaskId`。
11. **`stepQuota` 越界**：mock 把计数夹在 `0..target`，到顶后再 +1 不变；`delta` 只看正负。
12. **`dock:toggle` 的 `{}`** 视为切换；`{expanded: true/false}` 视为设定。
13. mock 的错误码按 `<服务>/<原因>`，如 `workbench/not-found`、`task/no-quota`、`notes/content-required`；前端把错误原文显示在一条单色提示里。

## 测试覆盖

`pnpm test` 共 154 条，主要规则：

- 并发槽三态：至多一个 focus、切 focus 时旧 focus 退回 running、提醒到点转 ready、`+10m` 后 1px 进度线推进、完成下台可连带完成任务、上台复用已有槽位；收起条单击切专注、双击展开定位、右键原位挂起/待看/完成。
- 断点备忘原位编辑：回车保存、Esc 还原且不收起面板、输入法组字时回车不保存。
- 待办：平铺列表与完成数（没有任何主线 / 支线 / 日常字样）、已完成折叠、一行新建（支持省略或传 `kind: side`、`×N` 设次数）、子项任意顺序勾选、增删子项、配额左键 +1 / 右键 −1 / 到目标自动完成 / 回退重开、每日重置开关原地 `TaskService.Update` 双向切换（保留原 ID、子项、次数、完成状态、槽位关联与手记）、扁平 `Reorder`、Ctrl+K 不带类型标签、跨 `dayStartHour` 换周期（03:59 仍属前一天）、weekly 只在指定星期到期、逾期。
- 随笔：全部 / 焦点手记过滤、关键词搜索（经时钟防抖）、Ctrl+Enter 新建、原位编辑停笔自动保存、二次确认删除。
- 键盘：Alt+1…9（按物理键）、Alt+N、Ctrl+P 钉住、Ctrl+K 搜索、Esc 只在未钉住时收起。
- 窗口：先长后缩的 Resize 顺序、收起宽度 460–900。
- bridge：Go 方法名、只传一个 JSON 对象、不发送 `undefined`、Go 的 `null` / nil slice 归一化、事件归一化、无运行时自动用 mock。
- 样式守卫：样式表里不得出现带色相的颜色（通道差 > 16）、色名或 `@keyframes`；“待看”必须是两套主题下的反白签条；同心圆角由 `calc()` 推出。
