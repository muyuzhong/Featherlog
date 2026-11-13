# 中英文混排字体修复

## 做了什么

- 用户明确允许本次仅修改字体样式，作为 AGENTS.md 前端禁改规则的例外。
- 新增 `Featherlog Latin` 本地字体别名，覆盖拉丁字母、数字及通用标点；标题、正文的字体栈优先使用该别名。
- 英文优先使用系统已有的 Segoe UI、Helvetica Neue、Arial、Liberation Sans、Noto Sans 或 DejaVu Sans；中文仍使用原有马善政、小赖及楷体回退。
- 不增加字体依赖、下载或安装包资产；不修改其他前端逻辑。

## 契约变更

无。既有 CSS 字体变量名称及用途保留。

## 验证

- `pnpm typecheck`、`pnpm test --coverage`、`pnpm build:app` 通过。
- 使用隔离数据目录和隐藏 Electron 窗口加载构建后的样式，通过 Chromium 字体检查接口确认英文、中文标题、中文正文分别使用普通字体、马善政和小赖字体。
- 当前运行的安装包没有被替换；字体样式随包含源码变更的新版本生效。

## 与设计文档不一致或设计文档没写清楚的地方

- §10 要求手写视觉风格，但没有区分中文和拉丁字母。此次按用户确认的方案，仅让拉丁字符及数字改用普通字体。
- 用户安装的系统字体不同，拉丁字体的具体外观可能不同；如所有列出的字体都缺失，仍使用原有字体栈回退。
- 字符范围按 CSS `unicode-range` 限制，参见 [MDN 字体规则](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face)。

## 发布状态

已通过独立 PR #73 合入 main，包含在正式发布的 v0.1.3；三个平台构建、测试及完整资产校验通过。

- PR：https://github.com/muyuzhong/Featherlog/pull/73
- Release：https://github.com/muyuzhong/Featherlog/releases/tag/v0.1.3
