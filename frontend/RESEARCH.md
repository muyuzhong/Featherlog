# 羽记 v2 前端：参考项目调研

动手之前读了说明书列出的六个参考，下面只记从每个项目里**拿了什么**、**没拿什么**。源码浅克隆在 `/tmp/featherlog-refs/`。

## egoist/mygo

- **前端怎么接 Go**：页面里注入 `window.mygo`，`mygo.call("Service.Method", ...args)` 调绑定方法（Go 名字，`Service.Method`），`mygo.on(name, listener)` 订阅事件、返回取消函数。浏览器里打开 dev server 时没有运行时，调用会失败。
  → `src/rpc/bridge.ts` 只依赖这两个函数：有 `window.__FEATHERLOG_MYGO__` 或 `window.mygo` 就走 Go，否则自动换成 `LocalMockBridge`。不引入 `mygo-runtime` 包，等 Go 侧 `mygo generate` 出了客户端再换也只改 bridge 一个文件。
- **类型规则**：Go 的 nil slice 到前端是 `[]`，`*T` 是 `T | null`。→ bridge 把可选字段上的 `null` 当作“没有”，`items: null` 当 `[]`。
- **无边框拖拽**：CSS 自定义属性 `--app-region: drag`，可继承，里面的按钮、输入框照常可点。→ 收起条的把手、展开态顶栏用它（顺手加 `-webkit-app-region`）。
- **dev/build**：`devUrl` 指 `http://localhost:5173`，打包产物给 `frontendDist`。→ vite 固定 5173、`strictPort`，产物在 `frontend/dist`，`base: './'`。
- **localStorage 属于 origin**：`mygo dev` 和打包后的 origin 不同。→ 业务数据一律走 Go；前端只在 localStorage 里放“跟随系统”这种纯界面偏好，mock 数据也只在浏览器预览里用。
- 示例 `menubar-flyout` / `flyout`：面板失焦、按 Esc 即收起；面板自己画边框和圆角，窗口不画。→ 未钉住时 Esc / 失焦收回底条；外壳自己画 1px 发丝线和圆角。

## echoVic/liubai（留白）

- **纸面层级**：地面 → 纸 → 浮起的纸，相邻表面只靠 **1px 发丝线 + 至多一级色阶** 分开；**只有真正浮起来的层才有投影**，阴影色取墨色、柔和、从不发光。→ 卡槽（well）下沉、后台卡与之齐平、待看卡一级、焦点卡唯一投影；搜索弹层、提示条是仅有的另外两个浮层。
- **颜色有分工**：正文永远是墨色，状态不靠颜色。逾期这类强调用字重 + 下划线，不用红。
- **选中 = 1px 内描边**，不是抬高。→ 分段控件、钉住按钮、任务选中行都用内描边；“抬高”只留给焦点卡。
- **IME**：`compositionstart/end` 期间不处理回车。中文输入下“回车即存”必须有这一层。→ `InlineText`、快速新建、子项、随笔输入都判断 `isComposing` / `keyCode 229`。
- **随手记**：打开就写，`Ctrl/⌘+Enter` 存，存完清空、留在原地。→ 随笔栏的输入框。
- 交互：hover 即时，浮层 200ms 内进场，尊重“减少动态效果”；按下 96% 缩放。

## echoVic/clipnest

- **按键规则做成纯函数**（`keyAction(event, ctx)`），组件只执行动作，规则单独测。→ `src/lib/keys.ts` + `keys.test.ts`。
- **⌘P / Ctrl+P 钉住**：钉住后失焦不收；Esc 收起。还要 `preventDefault` 防止 WebView 弹打印。→ 同样处理。
- **数字直达**：1–9 直达条目，但焦点在输入框时数字是字。→ 这里用 `Alt+1…9`，并按物理键 `code` 识别（macOS 上 Alt+1 打出的是 “¡”）。
- 反例：它的状态点（绿 `#68a68c` / 黄 `#c69b57`）正是本项目要去掉的东西。

## kero.sh

- 侧栏回答“现在谁需要你”：被选中的会话是**一张实心白卡 + 轻投影**；需要你的会话**标题加粗**；时间用小号浅色字放右边。→ 收起条和 Now Deck 都按这个分层：焦点 = 抬起的实心卡，待看 = 加粗墨色标题 + 反白签条，后台 = 常规字重中灰 + 等宽时长。
- 它仍用琥珀色 “needs you” 和转圈动画；这两处换成了单色反白签条和静止的 1px 墨线进度。

## egoist/gorex

- 每个窗格是一张卡：**聚焦的卡更不透明（0.95 vs 0.66）、边更亮、阴影两层（贴地 1px + 远处 22px）**，其余卡半透明退后。→ 焦点卡 `--lift` 两层阴影 + 顶部 1px 受光内高光；后台卡哑光、无阴影。
- 标题 600、细节 500 + 透明度：用字重而不是颜色分主次。
- 反例：绿点表示正在输出、橙点表示需要注意。

## kotuke/lumilo

- 数字一律 `tnum` 等宽：速度、内存、计数跳动时宽度不抖。→ 所有时长、计数、序号 `font-variant-numeric: tabular-nums`，跳秒不跳宽。
- `fillBg #1D1D1F / fillText #F5F6F8`：单色反白填充做强调。→ “待看”签条（浅色主题 `#18181B` 底 `#FAFAF9` 字，深色主题反过来），右端切一个书签缺口。
- 标题 12.5/600、标签 11.5、大数字 17/650 的字号阶梯，和这里 12/12.5/14 的阶梯同一思路。

## 落到这个前端的规则

1. 状态只用三种手段表达：**表面高度**（下沉 / 齐平 / 抬起 3px）、**墨色字重**（450 / 650）、**唯一的反白签条**。没有任何彩色圆点、彩色边框或呼吸动画；`src/styles/palette.test.ts` 会在样式里出现带色相的颜色或 `@keyframes` 时失败。
2. 同心圆角：`--r-section = --r-shell − --pad-shell`、`--r-card = --r-section − --pad-section`、`--r-chip = --r-bar − --pad-bar`，在 `tokens.css` 里用 `calc()` 写死。
3. 所有移动用同一个弹簧 `stiffness 440 / damping 34`；焦点切换用 `layoutId` 让同一块“抬起的卡板”滑到新卡下面。
