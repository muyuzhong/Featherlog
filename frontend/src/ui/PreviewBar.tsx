import { MOCK_STORAGE_KEY, LocalMockBridge } from '../rpc/mock';
import { useAppState, useStore, useT } from '../state/react';

/** Only in a browser tab: says what is running and stands in for the host's global shortcut. */
export function PreviewBar() {
  const store = useStore();
  const { ui } = useAppState();
  const t = useT();
  const bridge = store.bridge;
  if (!(bridge instanceof LocalMockBridge)) return null;
  return (
    <div className="preview-bar">
      <span className="preview-name">{t.preview.name}</span>
      <span className="preview-sep">·</span>
      <span>{t.preview.mock}</span>
      <button type="button" className="text-btn" onClick={() => bridge.toggleDock()}>
        {t.preview.shortcut(ui.expanded)}
      </button>
      <button
        type="button"
        className="text-btn"
        onClick={() => {
          localStorage.removeItem(MOCK_STORAGE_KEY);
          location.reload();
        }}
      >
        {t.preview.reset}
      </button>
      <span className="preview-sep">·</span>
      <a className="text-btn" href="?mode=bar" target="_blank" rel="noreferrer">
        {t.preview.bar}
      </a>
      <a className="text-btn" href="?mode=panel" target="_blank" rel="noreferrer">
        {t.preview.panel}
      </a>
    </div>
  );
}
