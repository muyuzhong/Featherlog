import type { Badge, CollapsedIconContribution, UnfoldSide } from '@featherlog/contracts';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { InkIcon } from '../icons';
import { SlotMount } from '../slots/SlotMount';
import type { SlotRegistry } from '../slots/registry';
import styles from './CollapsedView.module.css';

type Props = {
  registry: SlotRegistry;
  icons: CollapsedIconContribution[];
  badges: Record<string, Badge | null>;
  /** Which side the preview unfolds to (design §9.3). */
  unfold?: UnfoldSide;
  /** Where the shell cannot dock the window, the scroll's rods become a drag handle (design §9.5). */
  draggable?: boolean;
  onOpen(icon: CollapsedIconContribution): void;
  onPreviewChange?(iconId: string | null): void;
};

const LEAVE_DELAY_MS = 260;
const PREVIEW_MAX_HEIGHT = 560;

/** The collapsed view: a small floating hanging scroll that unrolls a preview on hover. */
export function CollapsedView({ registry, icons, badges, unfold = 'left', draggable = false, onOpen, onPreviewChange }: Props) {
  const ordered = [...icons].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [height, setHeight] = useState(240);
  const leaveTimer = useRef<number>(undefined);

  useEffect(() => onPreviewChange?.(previewId), [previewId, onPreviewChange]);

  const open = (icon: CollapsedIconContribution) => {
    window.clearTimeout(leaveTimer.current);
    if (icon.preview) setPreviewId(icon.id);
  };
  const leave = () => {
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => setPreviewId(null), LEAVE_DELAY_MS);
  };
  const stay = () => window.clearTimeout(leaveTimer.current);

  const progress = ordered.map((icon) => badges[icon.id]).find((b): b is Extract<Badge, { kind: 'progress' }> => b?.kind === 'progress');

  return (
    <div className={`${styles.root} ${unfold === 'right' ? styles.unfoldRight : ''}`} onMouseLeave={leave} onMouseEnter={stay}>
      <AnimatePresence>
        {previewId && (
          <motion.div
            key="preview"
            className={styles.previewShadow}
            initial={{ clipPath: unfold === 'left' ? 'inset(0 0 0 100%)' : 'inset(0 100% 0 0)', x: unfold === 'left' ? 18 : -18 }}
            animate={{ clipPath: 'inset(0 0 0 0%)', x: 0 }}
            exit={{ clipPath: unfold === 'left' ? 'inset(0 0 0 100%)' : 'inset(0 100% 0 0)', x: unfold === 'left' ? 12 : -12 }}
            transition={{ duration: 0.42, ease: [0.22, 0.8, 0.32, 1] }}
          >
            <div className={`${styles.preview} fl-paper`} style={{ height: Math.min(height, PREVIEW_MAX_HEIGHT) }}>
              <SlotMount
                registry={registry}
                kind="collapsed.preview"
                id={previewId}
                visible
                onSetHeight={setHeight}
                className={styles.previewContent}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className={`${styles.scroll} ${draggable ? styles.draggable : ''}`}>
        <div className={styles.rod} />
        <div className={`${styles.strip} fl-paper`}>
          {ordered.map((icon) => (
            <button
              key={icon.id}
              className={`${styles.icon} ${previewId === icon.id ? styles.on : ''}`}
              title={icon.title}
              onMouseEnter={() => open(icon)}
              onFocus={() => open(icon)}
              onClick={() => onOpen(icon)}
            >
              <InkIcon name={icon.icon} size={21} />
            </button>
          ))}
          {progress && (
            <svg className={styles.ring} viewBox="0 0 36 36" aria-label={`本章进度 ${Math.round(progress.value * 100)}%`}>
              <circle cx="18" cy="18" r="13" className={styles.ringTrack} />
              <circle
                cx="18" cy="18" r="13"
                className={styles.ringInk}
                strokeDasharray={`${progress.value * 81.7} 81.7`}
                transform="rotate(-90 18 18)"
              />
            </svg>
          )}
        </div>
        <div className={styles.rod} />
      </div>
    </div>
  );
}
