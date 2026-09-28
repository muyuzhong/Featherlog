import { AnimatePresence, motion } from 'motion/react';
import { InkIcon } from '../icons';
import type { Toast } from './shell-state';
import styles from './Toasts.module.css';

/** "shell/notify" notes, pinned beside the scroll for a few seconds. */
export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss(id: string): void }) {
  return (
    <div className={styles.stack} aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map(({ id, notification }) => (
          <motion.div
            key={id}
            layout
            className={styles.shadow}
            initial={{ opacity: 0, x: 14, filter: 'blur(3px)' }}
            animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, x: 10, filter: 'blur(2px)' }}
            transition={{ duration: 0.45, ease: [0.22, 0.8, 0.32, 1] }}
          >
            <button className={`${styles.slip} fl-paper`} onClick={() => onDismiss(id)} data-variant={notification.variant ?? 'info'}>
              <span className={styles.mark}>
                <InkIcon name={notification.icon ?? 'feather'} size={16} />
              </span>
              <span className={styles.body}>
                <span className={styles.title}>{notification.title}</span>
                {notification.body && <span className={styles.text}>{notification.body}</span>}
              </span>
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
