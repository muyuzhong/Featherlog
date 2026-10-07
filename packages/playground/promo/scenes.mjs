import { endCard, overlayScript, titleCard } from './overlay.mjs';

/*
 * The storyboard. Everything happens through the real UI of the playground, the way a
 * person would do it; only the camera moves (post-production zooms into marked crops).
 * Waits are in page time.
 */

export const CAMERA_MS = 900;

const CARDS = `# Redis
## RDB 和 AOF 怎么取舍？
RDB 是某一时刻的快照，恢复快、文件小，但可能丢掉最后几分钟的数据。
AOF 记下每一条写命令，everysec 下最多丢一秒，文件更大，需要定期重写。
## 为什么有序集合用跳表而不用红黑树？
范围查询只要找到起点再顺着链表走；实现简单，改起来也容易。
## 缓存穿透、击穿、雪崩分别怎么防？
穿透：缓存空值或布隆过滤器。击穿：热点 key 加互斥锁。雪崩：过期时间加随机值。
`;

export async function shoot(page, { url, width, height, icon, slowdown }) {
  const S = JSON.stringify;
  const rectOf = (js) =>
    page.eval(`(() => { const e = ${js}; if (!e) return null; const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`);
  const button = (text, scope, mode = 'exact') =>
    rectOf(`[...document.querySelectorAll(${S(scope + ' button')})].find((b) => b.offsetParent !== null
      && getComputedStyle(b).visibility !== 'hidden'
      && (${S(mode)} === 'exact' ? b.textContent.trim() === ${S(text)} : b.textContent.trim().startsWith(${S(text)})))`);
  const need = async (found, what) => {
    const r = await found;
    if (!r) throw new Error(`Not on the page: ${what}`);
    return r;
  };

  let pointer = { x: width / 2, y: height / 2 };
  const ease = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
  const glide = async (x, y, ms = 700) => {
    const from = pointer;
    const steps = Math.max(1, Math.round(ms / 16));
    for (let i = 1; i <= steps; i++) {
      const k = ease(i / steps);
      pointer = { x: from.x + (x - from.x) * k, y: from.y + (y - from.y) * k };
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pointer.x, y: pointer.y });
      await page.sleep(15);
    }
  };
  const click = async () => {
    const at = { x: pointer.x, y: pointer.y, button: 'left', clickCount: 1 };
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at });
    await page.sleep(70);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at });
  };
  const press = async (found, what, ms = 700, { dx = 0, dy = 0 } = {}) => {
    const r = await need(found, what);
    await glide(r.cx + dx, r.cy + dy, ms);
    await page.sleep(110);
    await click();
  };
  const key = async (name, code, keyCode, text) => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: keyCode });
  };
  const escape = () => key('Escape', 'Escape', 27);
  const caption = (text) => page.eval(`window.__promo.caption(${S(text)})`);
  const holdPreview = (on) => page.eval(`window.__holdPreview = ${on}`);
  const scrollIcons = () =>
    page.eval(`[...document.querySelectorAll('.dock [class*="_scroll_"] button')].map((b) => {
      const r = b.getBoundingClientRect();
      return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, label: b.getAttribute('aria-label') ?? '' };
    })`);
  const trackerIcon = async () => (await scrollIcons())[0];
  const cardIcon = async () => (await scrollIcons()).find((i) => i.label === '背一题');
  // The scroll and its unrolled note together.
  const scrollAndNote = () =>
    rectOf(`(() => {
      const rs = ['[class*="_preview_"]', '[class*="_scroll_"]'].map((s) => document.querySelector('.dock ' + s)).filter(Boolean).map((e) => e.getBoundingClientRect());
      const x = Math.min(...rs.map((r) => r.left)), y = Math.min(...rs.map((r) => r.top));
      const right = Math.max(...rs.map((r) => r.right)), bottom = Math.max(...rs.map((r) => r.bottom));
      return { getBoundingClientRect: () => ({ x, y, width: right - x, height: bottom - y }) };
    })()`);

  // A camera crop in CSS pixels, with the film's aspect ratio, around a rect.
  const FULL = { x: 0, y: 0, w: width, h: height };
  const around = (r, pad = 70, maxZoom = 1.6) => {
    const w = Math.min(width, Math.max(r.w + 2 * pad, (r.h + 2 * pad) * (width / height), width / maxZoom));
    const h = w * (height / width);
    return { x: Math.min(Math.max(r.cx - w / 2, 0), width - w), y: Math.min(Math.max(r.cy - h / 2, 0), height - h), w, h };
  };
  const camera = async (crop) => {
    page.mark('camera', crop);
    await page.eval(`window.__promo.frame(${S(crop)})`);
  };

  // ---------- Off camera: 翎 consented, 八股 enabled with a few cards, the note measured ----------
  await page.goto(url);
  await page.sleep(1500);
  await page.eval(overlayScript({ width, height, cameraMs: CAMERA_MS }));
  let icon0 = await trackerIcon();
  await glide(icon0.cx, icon0.cy, 100);
  await page.sleep(1500);
  await click();
  await page.sleep(1600);
  await glide(700, 450, 50);
  await press(button('札记', '.window'), '札记 tab', 50);
  await page.sleep(800);
  await press(button('同意，请翎执笔', '.window'), 'scribe consent', 50);
  await page.sleep(800);
  await press(button('设置', '.window'), 'settings', 50);
  await page.sleep(900);
  await press(
    rectOf(`(() => { const e = [...document.querySelectorAll('.window button, .window label')].find((e) => e.offsetParent !== null && e.textContent.trim().startsWith('八股背八股'));
      e?.scrollIntoView({ block: 'center' }); return e; })()`),
    '八股 plugin toggle', 50,
  );
  await page.sleep(1200);
  await press(button('八股', '.window'), '八股 tab', 50);
  await page.sleep(900);
  await press(button('粘贴导入', '.window'), 'paste import', 50);
  await page.sleep(800);
  await page.eval(`[...document.querySelectorAll('.window textarea')].find((t) => t.offsetParent !== null).focus()`);
  await page.send('Input.insertText', { text: CARDS });
  await page.sleep(400);
  await press(button('导入', '.window'), 'import', 50);
  await page.sleep(1200);
  await press(button('任务日志', '.window'), 'journal tab', 50);
  await page.sleep(800);
  await escape();
  await page.sleep(1200);
  await glide(700, 450, 50);
  await page.sleep(1200);
  icon0 = await trackerIcon();
  await glide(icon0.cx, icon0.cy, 50);
  await page.sleep(2000);
  const note = await need(scrollAndNote(), 'the note');
  // Room below for 翎's line, which comes later.
  const noteCrop = around({ ...note, y: note.y - 20, h: note.h + 70, cy: note.cy + 15 });
  await glide(700, 450, 50);
  await page.sleep(1500);
  await glide(860, 600, 50);
  await page.eval(`window.__promo.card(${S(titleCard(icon))}, { instant: true })`);
  await page.sleep(600);

  // ---------- On camera ----------
  await page.slowDown(slowdown);
  await page.startRecording();
  await camera(FULL);
  await page.sleep(250);
  await page.eval(`window.__promo.card(${S(titleCard(icon))})`);
  await page.sleep(2300);
  await page.eval('window.__promo.hideCard()');
  await page.sleep(450);

  // The scroll on the desktop's edge.
  await caption('一只浮在桌面边上的卷轴');
  await holdPreview(true);
  await camera(noteCrop);
  await page.sleep(CAMERA_MS + 100);
  icon0 = await trackerIcon();
  await glide(icon0.cx, icon0.cy, 900);
  await page.sleep(1200);

  // One quest at a time; 翎 answers.
  await caption('同一时间只追踪一件事，眼前只有下一步');
  await page.sleep(300);
  await press(button('对比 RDB 与 AOF 的取舍', '.dock', 'starts'), 'current objective', 750, { dx: -40 });
  await page.sleep(80);
  await glide(pointer.x + 20, pointer.y + 60, 1000);
  await caption('落笔之后，翎在页边回你一句');
  await page.sleep(2300);

  // The journal.
  await caption('点一下，翻开羊皮纸任务日志');
  await holdPreview(false);
  await camera(FULL);
  icon0 = await trackerIcon();
  await glide(icon0.cx, icon0.cy, 700);
  await page.sleep(350);
  await click();
  await page.sleep(120);
  await glide(900, 520, 650);
  await page.sleep(700);

  // A deed done: the vermilion seal.
  await caption('了结一件事，盖下朱印「功成」');
  await press(button('一封来自房东的信', '.window', 'starts'), 'landlord quest', 800, { dx: -60 });
  await page.sleep(800);
  await press(button('了结此事', '.window', 'starts'), 'single deed', 700, { dx: -40 });
  await page.sleep(1900);

  // Ask 翎 for a draft.
  await caption('对翎说一句话，它替你起草任务');
  const askInput = `[...document.querySelectorAll('.window input[aria-label="对翎说"]')].find((e) => e.offsetParent !== null)`;
  const ask = await need(rectOf(askInput), 'ask 翎');
  await glide(ask.x + 60, ask.cy, 800);
  await page.sleep(110);
  await click();
  await page.eval(`${askInput}.focus()`);
  await page.sleep(250);
  for (const ch of '这个月读完《人月神话》') {
    await page.send('Input.insertText', { text: ch });
    await page.sleep(80);
  }
  await page.sleep(300);
  await key('Enter', 'Enter', 13, '\r');
  await glide(1080, 470, 900);
  await page.sleep(2500);

  // The character sheet.
  await caption('做完的事，变成一个人的样子');
  await press(button('角色', '.window'), 'character tab', 800);
  await page.sleep(800);
  await glide(560, 330, 900);
  await page.sleep(1500);

  // A flashcard in the gaps.
  await caption('等编译的空档，在卷轴上背一题八股');
  await escape();
  await page.sleep(500);
  await holdPreview(true);
  await camera(noteCrop);
  const cards = await need(cardIcon(), '八股 icon');
  // From the side, so the pointer doesn't brush the tracker on its way.
  await glide(cards.cx - 160, cards.cy, 650);
  await glide(cards.cx, cards.cy, 350);
  await page.sleep(1100);
  await press(button('翻看答案', '.dock', 'starts'), 'flip the card', 650);
  await page.sleep(80);
  await glide(pointer.x - 30, pointer.y - 30, 600);
  await page.sleep(700);
  await press(button('记得', '.dock', 'starts'), 'grade the card', 900);
  await page.sleep(1300);

  // End card.
  await caption('');
  await camera(FULL);
  await page.eval(`window.__promo.card(${S(endCard(icon))})`);
  await page.sleep(3300);
  await page.stopRecording();
}
