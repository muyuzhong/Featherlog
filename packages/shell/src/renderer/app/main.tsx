// Placeholder window entry so the Electron shell can run end to end before the
// real window UI lands. Replaced by the collapsed/panel apps (design §6.1).
const kind = window.featherlog?.window.kind ?? 'panel';
document.title = kind === 'collapsed' ? 'featherlog-dock' : '羽记';
document.body.style.cssText = 'margin:0;background:#1f150d;color:#efdfb9;font:16px serif';
document.getElementById('root')!.textContent = kind === 'collapsed' ? '卷' : '羽记 · 外壳已启动';
