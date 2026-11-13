# Issues 处理记录（2026-09-29）

按用户要求逐项修复、独立提交 PR、依次合并并关闭完成的 issue。前一批 PR #51–#58 已合并；本轮继续补齐剩余 9 个问题。没有改动任何渲染进程代码、contracts 或 manifest，原有 `PR_DESCRIPTION.md` 和 `PERFORMANCE_REVIEW.md` 保持原样。

## 本轮补齐的修复

| Issue | 结果 | PR |
|---|---|---|
| #18 | 固定静态 AppImage runtime，消除 libfuse.so.2 运行时依赖；当前版本实际打包并启动成功 | [#26](https://github.com/muyuzhong/Featherlog/pull/26) |
| #36 | 不可变任务/历史记录 + 原子索引；保留落盘确认，启动迁移旧数据，提交失败回滚，崩溃遗留记录回收 | [#59](https://github.com/muyuzhong/Featherlog/pull/59) |
| #42 | 类型检查集中到发布准备阶段；保留各系统测试 | [#60](https://github.com/muyuzhong/Featherlog/pull/60) |
| #43 | 未签名 macOS 只构建 arm64/x64 dmg；完整性校验改为 10 个产物，保留更新元数据 | [#61](https://github.com/muyuzhong/Featherlog/pull/61) |
| #44 | 无观察者的无应答请求减少信封与投递工作；注入请求省去无人消费的 Error；保留独立错误及调用栈 | [#62](https://github.com/muyuzhong/Featherlog/pull/62) |
| #30 | 按用户确认保留字体设计，只排除 87 个旧 WOFF；446 个 WOFF2 全部保留，字体资源减少 3,834,104 字节 | [#63](https://github.com/muyuzhong/Featherlog/pull/63) |
| #46 | 测量后保留测试隔离、启用转换缓存；增加覆盖率门禁，覆盖率插件仅为开发依赖 | [#64](https://github.com/muyuzhong/Featherlog/pull/64) |
| #34 | 数组 JSON 校验按下标检查自有描述符，减少重复字符串转换，保留全部拒绝边界 | [#65](https://github.com/muyuzhong/Featherlog/pull/65) |
| #27 | 修复预览高度变化时的竖直锚定；实机悬停的竖直中心变化由 20 个逻辑像素降为浮点误差 | [#66](https://github.com/muyuzhong/Featherlog/pull/66) |

#26、#59–#66 已全部合并，剩余 9 个 issue 已全部关闭。当前没有开放 issue 或 PR。本地 main 已同步至 `aceb5815d62a956860f0a928452b489de7824cd0`，与最终验证分支的代码树完全一致。

## 前一批已合并的修复

| Issue | 结果 | PR |
|---|---|---|
| #39 | 损坏设置先备份原字节，再用默认值启动；备份失败不覆盖原文件 | [#51](https://github.com/muyuzhong/Featherlog/pull/51) |
| #29、#38 | 更新检查/下载停滞超时、取消、实例替换、退避重试、唤醒补查和迟到结果隔离 | [#52](https://github.com/muyuzhong/Featherlog/pull/52) |
| #37 | 每日委托周期只前进；周期倒退保留进度与历史 | [#53](https://github.com/muyuzhong/Featherlog/pull/53) |
| #40 | 增加窗口尺寸、安全、加载、关闭、持久化及退出测试 | [#54](https://github.com/muyuzhong/Featherlog/pull/54) |
| #41、#46 部分 | 更新 Actions 与 Dependabot | [#55](https://github.com/muyuzhong/Featherlog/pull/55) |
| #46 部分 | 开启未使用声明、switch 穿透检查 | [#56](https://github.com/muyuzhong/Featherlog/pull/56) |
| #45、#34 文档 | 修正设计文档漂移，说明 dev 校验成本和生产 JSON 边界 | [#57](https://github.com/muyuzhong/Featherlog/pull/57) |
| #18 旧版说明 | 旧 AppImage 的 FUSE 兼容办法 | [#58](https://github.com/muyuzhong/Featherlog/pull/58) |

## 最终验证与取舍

全部 PR 及合并后 main 的 Linux/Windows CI 均已通过，最终检查提交为 `aceb5815d62a956860f0a928452b489de7824cd0`：
https://github.com/muyuzhong/Featherlog/actions/runs/36592384014

- 合并前均执行 `pnpm typecheck`、`pnpm test`；组合代码为 21 个文件、474 项测试。
- `pnpm test --coverage` 通过：语句 89.61%、分支 87.86%、函数 86.07%、行 91.33%；门禁分别为 85%、85%、85%、90%。将行门禁临时调至 100% 的反向检查按预期失败。
- 实际构建 Linux AppImage；静态 runtime 为 static PIE，无 NEEDED 动态库项。当前产物用隔离数据目录直接启动成功。本次宿主同时装有 fuse2/fuse3，不能把这次启动当作“仅 FUSE 3”测试；PR #26 保留了此前仅 FUSE 3 环境验证记录。
- 最终 main 重新打包并启动验证成功，日志确认 `kernel/ready` 和 `Collapsed window ready`，新数据目录正确初始化为 schemaVersion 2。产物为 `packages/shell/dist/Featherlog-0.1.1-x86_64.AppImage`（138,557,458 字节）；更新元数据的 SHA-512 和大小校验通过，asar 中主进程代码与最终构建输出一致。
- 字体包检查：每个被排除的 WOFF 在同一 font-face 中均有优先 WOFF2 来源；最终 app.asar 中没有 WOFF，446 个 WOFF2 完整保留。本次测得 app.asar 约从 33.56 MB 降为 29.70 MB；没有声称达到取消字体才能接近的 10 MB。
- #36 的 200 任务回归用例：单任务修改只写一个记录和索引，序列化量小于旧完整状态的 10%。旧格式每个迁移写入点、多个任务的每个提交点均注入失败并验证恢复。
- #44 本机无观察者 no-handler 基准约 5.72µs → 3.45µs；#34 的 25000 项数组 dev snapshot 约 4.25ms → 4.07ms，收益有限，不削弱深度检查换数字。
- Vitest doctor：基线与关闭隔离均约 0.76s，转换缓存约 0.67s（每种配置 3 次取最小值）。保留隔离，不把本机 CPU 数硬编码为 CI worker 数。
- #27 在 Arch/KDE Wayland、兼容模式关闭的真实 Electron 窗口验证。旧版稳定帧中心为 576→596→576；修复后为 576，浮点误差 < 1e-9。输入由 CDP 触发，同时记录 KWin 几何信号并检查预览帧。所有数据在临时目录，临时 KWin 观测脚本已卸载。
- macOS dmg 元数据用已安装 electron-builder 的真实生成函数验证，两个架构正确合并为 latest-mac.yml；Linux 本机没有制作/运行 macOS dmg。
- 存储格式升级、发布策略、字体修复范围均按用户明确选择实施。schemaVersion 2 不能被只支持版本 1 的旧应用读取。
- 未发布新版本，也未执行真实跨版本更新安装；修复合入 main 后不会改变已安装的旧程序。
