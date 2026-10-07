/*
 * What the film needs that the app doesn't draw: a pointer (headless Chrome shows none),
 * click ripples, captions that stay put on screen while post-production zooms, and the
 * title and end cards. Injected into the playground page as one script.
 */

export function overlayScript({ width, height, cameraMs }) {
  return `(() => {
  const style = document.createElement('style');
  style.textContent = \`
    .devtools, .hint { display: none !important; }
    #promo-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;
      transform: translate(-200px, -200px); transition: opacity .3s ease; }
    #promo-cursor svg { display: block; filter: drop-shadow(0 2px 3px rgba(0,0,0,.5)); }
    .promo-ripple { position: fixed; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%;
      border: 2px solid rgba(214, 120, 96, .95); pointer-events: none; z-index: 2147483646;
      animation: promo-ripple .55s ease-out forwards; }
    @keyframes promo-ripple { from { transform: scale(.25); opacity: 1 } to { transform: scale(1.35); opacity: 0 } }
    #promo-band { position: fixed; left: 0; top: 0; width: ${width}px; height: 58px; z-index: 2147483640; pointer-events: none;
      transform-origin: 0 0; transform: translate(0px, ${height - 58}px) scale(1);
      transition: transform ${cameraMs}ms cubic-bezier(.65,0,.35,1);
      display: flex; align-items: center; justify-content: center; }
    #promo-caption { font-family: var(--fl-font-hand); font-size: 22px; letter-spacing: .14em; color: #f3e6c8;
      padding: 4px 20px; border-radius: 999px; background: rgba(24, 20, 26, .55);
      text-shadow: 0 1px 6px rgba(0,0,0,.6); opacity: 0; transition: opacity .4s ease; }
    #promo-caption.on { opacity: 1; }
    #promo-card { position: fixed; inset: 0; z-index: 2147483645; display: flex; align-items: center; justify-content: center;
      pointer-events: none; opacity: 0; transition: opacity .6s ease;
      background: radial-gradient(70% 60% at 22% 18%, rgba(120,150,190,.28), transparent 60%),
        radial-gradient(60% 55% at 80% 90%, rgba(190,140,110,.22), transparent 60%),
        linear-gradient(165deg, #2a3446 0%, #2c2833 55%, #1c1b21 100%); }
    #promo-card.on { opacity: 1; }
    #promo-card .sheet { width: 760px; height: 440px; display: flex; flex-direction: column; align-items: center;
      justify-content: center; transform: scale(.965); transition: transform 2.6s cubic-bezier(.2,.7,.2,1);
      filter: drop-shadow(0 30px 40px rgba(0,0,0,.55)); }
    #promo-card.on .sheet { transform: scale(1); }
    #promo-card img { width: 112px; height: 112px; margin-bottom: 14px; }
    #promo-card h1 { margin: 0; font-family: var(--fl-font-title); font-weight: 400; font-size: 64px;
      letter-spacing: .12em; color: #2a1c11; }
    #promo-card h1 span { font-family: var(--fl-font-hand); font-size: 34px; letter-spacing: .04em; color: #5b4430; margin-left: .3em; }
    #promo-card p { margin: 18px 0 0; font-family: var(--fl-font-hand); font-size: 26px; letter-spacing: .18em; color: #5b4430; }
    #promo-card p.small { margin-top: 12px; font-size: 19px; letter-spacing: .1em; }
    #promo-card p.link { margin-top: 22px; font-size: 22px; letter-spacing: .06em; color: #8a2b1d; }
  \`;
  document.head.appendChild(style);

  // Keep a preview open while the camera is on it: the scripted pointer jumps where a hand
  // would glide, and the playground re-centres the dock whenever the note changes height.
  const later = window.setTimeout;
  window.__holdPreview = false;
  window.setTimeout = function (fn, ms, ...rest) {
    if (ms === 400 && window.__holdPreview && typeof fn === 'function' && /setPreviewId/.test(String(fn))) return 0;
    return later.call(this, fn, ms, ...rest);
  };

  const cursor = document.createElement('div');
  cursor.id = 'promo-cursor';
  cursor.innerHTML = '<svg width="26" height="30" viewBox="0 0 26 30"><path d="M3 2 L3 24 L8.5 18.8 L12.6 27.6 L16.4 25.9 L12.4 17.3 L20 17.3 Z" fill="#fbf3e2" stroke="#2a1c11" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.body.appendChild(cursor);
  window.addEventListener('mousemove', (e) => {
    cursor.style.transform = 'translate(' + (e.clientX - 3) + 'px,' + (e.clientY - 2) + 'px)';
  }, true);
  window.addEventListener('mousedown', (e) => {
    const ripple = document.createElement('div');
    ripple.className = 'promo-ripple';
    ripple.style.left = e.clientX + 'px';
    ripple.style.top = e.clientY + 'px';
    document.body.appendChild(ripple);
    later(() => ripple.remove(), 700);
  }, true);

  const band = document.createElement('div');
  band.id = 'promo-band';
  band.innerHTML = '<div id="promo-caption"></div>';
  document.body.appendChild(band);
  const caption = band.firstChild;
  const card = document.createElement('div');
  card.id = 'promo-card';
  card.innerHTML = '<div class="sheet fl-paper"></div>';
  document.body.appendChild(card);

  window.__promo = {
    caption(text) {
      if (!text) return caption.classList.remove('on');
      if (!caption.classList.contains('on')) {
        caption.textContent = text;
        return caption.classList.add('on');
      }
      caption.classList.remove('on');
      later(() => { caption.textContent = text; caption.classList.add('on'); }, 380);
    },
    // The caption rides at the bottom of what the camera sees, at the same size on screen.
    frame(c) {
      const z = ${width} / c.w;
      band.style.transform = 'translate(' + c.x + 'px,' + (c.y + c.h - 58 / z) + 'px) scale(' + (1 / z) + ')';
    },
    // A card shown before recording starts is already there on the first frame.
    card(html, { instant = false } = {}) {
      cursor.style.opacity = '0';
      card.querySelector('.sheet').innerHTML = html;
      if (instant) {
        card.style.transition = 'none';
        card.style.opacity = '1';
      } else {
        card.style.transition = '';
        card.style.opacity = '';
        card.classList.add('on');
      }
    },
    hideCard() {
      card.style.opacity = '';
      card.style.transition = '';
      card.classList.remove('on');
      later(() => { cursor.style.opacity = '1'; }, 300);
    },
  };
})()`;
}

export const titleCard = (icon) =>
  `<img src="${icon}" alt=""><h1>羽记<span>Featherlog</span></h1><p>把日子过成一场冒险</p>`;

export const endCard = (icon) =>
  `<img src="${icon}" alt=""><h1>羽记<span>Featherlog</span></h1>` +
  `<p class="small">Linux · Windows · macOS　免费开源</p><p class="link">github.com/muyuzhong/Featherlog</p>`;
