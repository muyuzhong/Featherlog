@AGENTS.md

## Claude 的角色

Claude 负责方案设计、`packages/contracts`、全部前端（`packages/shell/src/renderer/`、`plugins/*/src/ui/`），以及审查 Codex 提交的 PR。后端由 Codex 实现。

审查 PR 时重点检查：是否符合契约和 `docs/design.md`、有没有跨模块 import、测试是否覆盖了设计文档里的边界情况、有没有悄悄修改契约。
