import type { UiBus, UpdateState } from '@featherlog/contracts';
import { motion } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';
import styles from './SettingsPage.module.css';

/** The updater's state (design §12.3); `null` while unknown or when the shell has no updater. */
function useUpdateState(bus: UiBus): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let alive = true;
    bus.request('shell/update-state', {}).then(
      (initial) => alive && setState(initial),
      // A shell without an updater (an older build, the playground's default): no section.
      (cause) => console.debug('shell/update-state unavailable', cause),
    );
    const stop = bus.on('shell/update-changed', setState);
    return () => {
      alive = false;
      stop();
    };
  }, [bus]);
  return state;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * The "更新" section: what version this is, what the updater is doing, and what
 * the user can do about it. Absent altogether when the shell has no updater.
 */
export function UpdateNotes({ bus, toggle }: { bus: UiBus; toggle: ReactNode }) {
  const state = useUpdateState(bus);
  const [failure, setFailure] = useState<string>();
  const [showNotes, setShowNotes] = useState(false);
  if (!state) return null;

  const ask = (type: 'shell/check-update' | 'shell/apply-update') => {
    setFailure(undefined);
    bus.request(type, {}).catch((cause: unknown) => {
      console.error(cause);
      setFailure('没能办到，请稍后再试');
    });
  };
  const busy = state.status === 'checking' || state.status === 'downloading';
  const notes = state.status === 'ready' || state.status === 'manual' ? state.notes : undefined;

  let line: ReactNode;
  let action: ReactNode = null;
  switch (state.status) {
    case 'idle':
      line = '这次启动后还没检查过';
      break;
    case 'checking':
      line = '正在询问 GitHub……';
      break;
    case 'latest':
      line = `已是最新 · ${when(state.checkedAt)} 检查`;
      break;
    case 'downloading':
      line = (
        <>
          正在取回 v{state.version} · {Math.round(state.percent)}%
          <span className={styles.progress}>
            <motion.span initial={false} animate={{ width: `${state.percent}%` }} transition={{ duration: 0.4 }} />
          </span>
        </>
      );
      break;
    case 'ready':
      line = <em className={styles.fresh}>v{state.version} 已备好，退出时自动安装</em>;
      action = (
        <button className={styles.inkButton} onClick={() => ask('shell/apply-update')}>
          立即重启
        </button>
      );
      break;
    case 'manual':
      line = <em className={styles.fresh}>有新版本 v{state.version}，这台电脑上需要手动下载</em>;
      action = (
        <button className={styles.inkButton} onClick={() => ask('shell/apply-update')}>
          前往下载
        </button>
      );
      break;
    case 'error':
      line = <span className={styles.warn}>没能检查更新：{state.message}</span>;
      break;
    case 'unsupported':
      line = '开发版本，不检查更新';
      break;
    case 'managed':
      line = '由系统的包管理器更新（例如 paru -Syu），这里不检查';
      break;
  }
  // Neither a development build nor a package-manager install checks for itself.
  const checks = state.status !== 'unsupported' && state.status !== 'managed';
  if (!action && checks) {
    action = (
      <button className={styles.inkButton} disabled={busy} onClick={() => ask('shell/check-update')}>
        检查更新
      </button>
    );
  }

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>更新</h2>
      <div className={styles.update}>
        <div className={styles.label}>
          <span className={styles.fieldTitle}>当前版本 v{state.current}</span>
          <span className={styles.desc}>{line}</span>
          {failure && <span className={`${styles.hint} ${styles.warn}`}>{failure}</span>}
          {notes && (
            <button className={styles.notesToggle} onClick={() => setShowNotes(!showNotes)}>
              {showNotes ? '收起更新说明' : '看看更新了什么'}
            </button>
          )}
        </div>
        {action}
      </div>
      {notes && showNotes && <p className={styles.notes}>{notes}</p>}
      {checks && toggle}
    </section>
  );
}
