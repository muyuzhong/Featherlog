# 八股：一个插件示例

背八股的小卡片：鼠标移到卷轴上的图标，翻一题，说说记得多少，它按间隔重复安排下次什么时候再来。等 AI 输出、等编译的空档刚好背一题。

它同时是**编写羽记插件的参考**。羽记里一切功能都是插件，这个插件不比任务日志少什么，也不多什么：它只认识 `@featherlog/contracts`，只通过总线和别人说话。想写自己的插件，照着这个目录抄一份最快。

规则和设计见 `docs/design.md` §5（插件）、§7（插槽）、§17（本插件）。

## 启用

八股是**可选插件**（清单里 `"optional": true`），默认不加载。在设置页最下面的"插件"一节勾选它，立即生效，不用重启：卷轴上多一个图标，面板里多一页"八股"，设置里多一节"八股"。取消勾选立即卸下，题库和复习记录都留着，再勾上原样回来。

## 目录

```
examples/flashcards/
├─ manifest.json        清单：我是谁、说哪些消息、往哪些插槽里放东西
├─ package.json         工作区包 @featherlog/plugin-flashcards，导出 ./manifest.json、./main、./ui
├─ src/main/            主进程半边：数据、规则、存储（Node 里运行，没有界面）
│  ├─ index.ts          setup(ctx)：注册应答者，发事件
│  ├─ model.ts          纯函数：校验、间隔重复、Markdown 解析
│  └─ storage.ts        读取并校验存下来的数据
└─ src/ui/              界面半边：只负责画，每个窗口一份（Chromium 里运行）
   ├─ index.tsx         setup(ctx)：往插槽里挂 React 组件
   ├─ store.ts          向主进程半边要数据、听事件，给组件用
   ├─ ReviewCard.tsx    卷轴上的卡片（收起视图的悬停预览）
   └─ DeckBook.tsx      面板里的"八股"页
```

测试和源码放在一起：`model.ts` 对应 `model.test.ts`。

## 清单

`manifest.json` 是纯 JSON，外壳不执行任何代码就能读它，据此排好卷轴图标和面板标签页。

| 字段 | 这里的值 | 说明 |
|---|---|---|
| `id` | `flashcards` | 小写短横线。也是消息的命名空间：只有它能发 `flashcards/*` |
| `main` / `ui` | 两个入口 | 各自导出 `setup(ctx)` |
| `optional` | `true` | 默认不加载，由用户在设置里启用（§17.1） |
| `emits` / `listens` / `handles` / `requests` | 消息清单 | 开发模式下用来检查拼写和遗漏，运行时不强制 |
| `contributes.collapsedIcons` | `flashcards/card` | 卷轴上的图标；`preview: true` 表示悬停时展开一个挂载式预览 |
| `contributes.panelTabs` | `flashcards/deck` | 面板里的一页 |
| `contributes.settings` | `newPerDay` | JSON Schema，外壳据此在设置页画出表单，`default` 就是默认值 |

插槽的 id 必须以插件 id 开头（`flashcards/…`）。

## 主进程半边

`setup(ctx: MainContext)` 在插件加载时调用一次。凡是通过 `ctx` 注册的东西（`bus.on`、`bus.handle`、`clock.setTimeout`、`onDispose`）都由内核记着，插件被停用时自动释放，不用自己收拾。

- **只用 `ctx.storage` 存数据**，不碰文件系统。值必须是纯 JSON。存一个 `schemaVersion`，以后改格式时在 `setup` 里迁移。读到损坏的数据就拒绝加载，不要覆盖它。
- **只用 `ctx.clock` 取时间**，不直接调用 `Date.now()` 或全局 `setTimeout`，测试才能用模拟时钟跨天、跨周。
- **`ctx.settings` 只读**，值由设置页写入。
- **请求失败要带 `code`**：本插件用 `flashcards/invalid-input`、`flashcards/not-found`。
- **先写盘，再发事件**：一个请求的改动在同一份数据上完成并存下以后，才发出 `flashcards/changed` 等事件。写失败就什么都没发生。
- **问别的插件，并且在它不在时降级**：判断"今天"要用任务插件的日界（`quest/period`）。没有任务插件时，请求会得到 `no-handler`，这时退回 4 点；其他错误照常抛出，免得临时故障把今日计数清零。跨插件的请求放在 `kernel/ready` 之后发。

## 界面半边

`setup(ctx: UiContext)` 在每个窗口里各运行一次（卷轴窗口一份、面板窗口一份）。

- **不保存业务状态**。题库和复习进度都在主进程半边；界面用 `ctx.bus.request` 要数据，用 `ctx.bus.on` 听事件保持最新。另一个窗口里评了分，这个窗口通过 `flashcards/reviewed` 知道。
- **用 `ctx.slots.provide(kind, id, mount)` 挂界面**。`mount(el, host)` 把组件画进 `el`，返回卸载函数；`host` 可以申请高度（`setHeight`）、知道自己何时被显示（`onShow`）。
- **样式用 CSS Modules**，只用外壳提供的 CSS 变量（`--fl-ink`、`--fl-rubric`、`--fl-font-hand` 等），画出和别的插件同一种纸。不写全局选择器。
- **声音用 `ctx.sound.play(cue)`**，挂在本窗口发出的请求上，而不是挂在事件上，这样只有动手的那个窗口发声。
- **读文件也在界面里**：导入 Markdown 时，界面用浏览器的 `File.text()` 读出文本，再把文本发给主进程半边。

## 接进应用

插件之间、插件和外壳之间互不 import。全仓库只有两个"组合根"可以引入插件包：

- 主进程：`packages/shell/src/main/plugins.ts`
- 渲染层：`packages/shell/src/renderer/app/plugins.ts`

各加一行 `{ manifest, setup }`，再把包加进 `packages/shell/package.json` 的依赖。浏览器里的开发环境 `packages/playground` 也照样注册一遍。

## 测试

用 vitest，时间一律用模拟时钟。设计文档里写明的每条规则都要有对应的测试，尤其是边界：跨天、`dayStartHour` 前后、笔记本睡眠后恢复、停用再启用、存储损坏。

```sh
pnpm vitest run examples/flashcards
pnpm typecheck
```

## 导入格式

```markdown
# Redis
## RDB 和 AOF 各自的取舍？
RDB 是某一时刻的快照，恢复快、文件小，
但两次快照之间的数据可能丢失……

### 为什么用跳表实现有序集合？
……
```

`##` 或 `###` 标题是问题，到下一个标题之前是答案；`#` 标题是题组。代码块里的 `#` 不算标题，`####` 及更深的标题留在答案里。重复、没有答案、超长（问题 500 字、答案 10000 字以内）的题跳过。
