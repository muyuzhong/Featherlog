@AGENTS.md

## Claude 的角色

Claude 负责 `frontend/` 目录下的全新 Web 前端（React + TypeScript + Vite）与视觉交互实现；Go 宿主、领域服务、存储、底部停靠与 CLI 由 Go 后端团队负责。

前后端通过 `docs/design.md` 定义的 5 个 `mygo.Bind` 服务与 5 类实时推送事件对齐。
