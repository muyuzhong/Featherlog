## 做了什么

修复草稿创建成功后，GitHub Release 列表尚未同步而导致 prepare 误报不存在的问题。

- 创建前保留 `find()`，继续复用唯一草稿并拒绝重复或已发布的 Release。
- 不存在草稿时改用 `gh api -X POST repos/{repo}/releases`，传入 `tag_name`、`name` 和布尔值 `draft=true`。
- 直接解析创建响应并返回其 ID，沿用现有 `GITHUB_OUTPUT` 输出路径；不再在创建后立即查询列表。
- 上传与最终资产校验流程不变。

## 契约变更

无。

## 测试覆盖了哪些规则

- 新增回归测试：模拟列表接口始终返回空列表，创建接口返回 ID 398129844；prepare 成功返回该 ID，并确认只查询一次列表。
- 更新创建与重跑复用测试，核对 POST 参数和草稿创建次数。
- 新增创建接口失败测试，确认错误直接传播，不再次查询或重复创建。
- `pnpm typecheck`、`pnpm test` 均通过：18 个测试文件、417 项测试。
- 本地复现：`pnpm exec vitest run .github/scripts/release.test.ts`。GitHub 调用均模拟，未修改现有草稿、资产、标签或正在重跑的工作流。

## 与设计文档不一致或设计文档没写清楚的地方

无。本次仅按任务要求调整创建 API 与 ID 获取方式，发布仍由标签触发并保持草稿状态。
