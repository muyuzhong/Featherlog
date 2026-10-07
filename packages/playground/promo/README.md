# 宣传片

README 顶部那段四十秒的演示，就是从演示台录下来的。界面一有变化，重录一遍即可：

```sh
pnpm --filter @featherlog/playground promo          # 加 --keep 保留中间帧
```

产物直接写到 `docs/images/promo.mp4`（1920×1200，无声）和 `docs/images/promo.webp`（README 里循环播放的动图，1280 宽、20 帧/秒）。需要本机装有 Chrome（或用 `CHROME` 指定）、带 libx264 与 libwebp 的 ffmpeg，以及 ImageMagick 7。整个过程约十分钟，中间帧写在 `promo/out/`（已被忽略），结束后删除。

| 文件 | 做什么 |
|---|---|
| `record.mjs` | 入口：起一个演示台的 Vite 服务，开无头 Chrome，拍摄，后期 |
| `scenes.mjs` | 分镜：每一步都是在真实界面上点出来的，字幕和镜头也写在这里 |
| `overlay.mjs` | 注入页面的东西：鼠标指针、点击涟漪、跟着镜头走的字幕、片头片尾 |
| `browser.mjs` | 用 DevTools 协议驱动 Chrome，screencast 录帧 |
| `render.mjs` | 按镜头标记逐帧裁切推拉，再编码成 mp4 和动图 |

两点做法：

- **慢放录制。** 2 倍像素下，翻开的日志渲染得比实时慢很多，直接录会掉帧。录制期间把页面的时钟放慢 6 倍（计时器、`requestAnimationFrame`、`performance.now` 和动画时间轴一起放慢），后期再按比例还原，所以每个动作都是流畅的。
- **镜头在后期。** 推拉不是用 CSS 缩放页面（那会改变命中位置），而是在 2 倍像素的原始帧上裁切。分镜里每次调用 `camera()` 记下一个标记，`render.mjs` 照着它在 0.9 秒内缓动过去，字幕带在页面里同步移动，屏幕上的大小保持不变。

改分镜时，演示台的种子数据（`src/host/seed.ts`）和假的翎（`src/host/scribe.ts`）决定了画面里的任务和翎说的话。
