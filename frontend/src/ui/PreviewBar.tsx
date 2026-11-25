import { MOCK_STORAGE_KEY, LocalMockBridge } from '../rpc/mock';
import { useAppState, useStore } from '../state/react';

/** Only in a browser tab: says what is running and stands in for the host's global shortcut. */
export function PreviewBar() {
  const store = useStore();
  const { ui } = useAppState();
  const bridge = store.bridge;
  if (!(bridge instanceof LocalMockBridge)) return null;
  return (
    <div className="preview-bar">
      <span className="preview-name">羽记 v2 · 浏览器预览</span>
      <span className="preview-sep">·</span>
      <span>LocalMockBridge（数据存在 localStorage）</span>
      <button type="button" className="text-btn" onClick={() => bridge.toggleDock()}>
        模拟全局快捷键（{ui.expanded ? '收起' : '展开'}）
      </button>
      <button
        type="button"
        className="text-btn"
        onClick={() => {
          localStorage.removeItem(MOCK_STORAGE_KEY);
          location.reload();
        }}
      >
        重置示例数据
      </button>
    </div>
  );
}
