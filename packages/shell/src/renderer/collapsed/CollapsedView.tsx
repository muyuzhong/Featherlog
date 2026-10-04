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

const LEAVE_DELAY_MS = 400;
const PREVIEW_MAX_HEIGHT = 560;

/** The collapsed view: a small floating hanging scroll that unrolls a preview on hover. */
export function CollapsedView({ registry, icons, badges, unfold = 'left', draggable = false, onOpen, onPreviewChange }: Props) {
  const ordered = [...icons].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [height, setHeight] = useState(240);
  const leaveTimer = useRef<number>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const hovering = useRef(false);

  useEffect(() => onPreviewChange?.(previewId), [previewId, onPreviewChange]);

  // A note being written in stays open: the pointer drifting off it (or the window
  // resizing under it) must not fold it away mid-sentence. Focus leaving closes it.
  const writing = () => {
    const active = document.activeElement;
    return !!active && !!root.current?.contains(active) && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement);
  };
  const open = (icon: CollapsedIconContribution) => {
    window.clearTimeout(leaveTimer.current);
    if (icon.preview && !(writing() && previewId)) setPreviewId(icon.id);
  };
  const close = () => {
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => {
      if (!writing()) setPreviewId(null);
    }, LEAVE_DELAY_MS);
  };
  const leave = () => {
    hovering.current = false;
    close();
  };
  const stay = () => {
    hovering.current = true;
    window.clearTimeout(leaveTimer.current);
  };
  // Clicking away (inside the window, or another window taking focus) ends the writing.
  useEffect(() => {
    const blurred = () => !hovering.current && close();
    window.addEventListener('blur', blurred);
    return () => window.removeEventListener('blur', blurred);
  });

  const progress = ordered.map((icon) => badges[icon.id]).find((b): b is Extract<Badge, { kind: 'progress' }> => b?.kind === 'progress');
  const pulse = useProgressPulse(progress?.value);

  return (
    <div
      ref={root}
      className={`${styles.root} ${unfold === 'right' ? styles.unfoldRight : ''}`}
      onMouseLeave={leave}
      onMouseEnter={stay}
      onBlur={(event) => {
        if (!hovering.current && !event.currentTarget.contains(event.relatedTarget as Node | null)) close();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !previewId) return;
        (document.activeElement as HTMLElement | null)?.blur();
        window.clearTimeout(leaveTimer.current);
        setPreviewId(null);
      }}
    >
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
              {/* A fresh container per icon: the previous plugin's root unmounts a moment later. */}
              <SlotMount
                key={previewId}
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
              aria-label={icon.title}
              onMouseEnter={() => open(icon)}
              onFocus={() => open(icon)}
              onClick={() => onOpen(icon)}
            >
              <InkIcon name={icon.icon} size={21} />
            </button>
          ))}
          {progress && (
            <svg className={styles.ring} viewBox="0 0 36 36" overflow="visible" aria-label={`本章进度 ${Math.round(progress.value * 100)}%`}>
              <AnimatePresence>
                {pulse && (
                  <motion.g key={pulse.id} exit={{ opacity: 0 }}>
                    {(pulse.kind === 'turn' ? [0, 0.28] : [0]).map((delay) => (
                      <motion.circle
                        key={delay}
                        cx="18" cy="18" r="13"
                        className={styles.ringPulse}
                        initial={{ scale: 1, opacity: 0.85 }}
                        animate={{ scale: pulse.kind === 'turn' ? 1.9 : 1.45, opacity: 0 }}
                        transition={{ duration: pulse.kind === 'turn' ? 1.1 : 0.8, delay, ease: 'easeOut' }}
                        style={{ transformOrigin: '18px 18px' }}
                      />
                    ))}
                  </motion.g>
                )}
              </AnimatePresence>
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

type Pulse = { id: number; kind: 'step' | 'turn' };

/**
 * The ring answers progress: a ripple when it grows, a wider double ripple when
 * it falls back to the start of a new chapter (so the drop reads as a turn, not a loss).
 */
function useProgressPulse(value: number | undefined): Pulse | null {
  const previous = useRef(value);
  const [pulse, setPulse] = useState<Pulse | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = value;
    if (before === undefined || value === undefined || value === before) return;
    setPulse({ id: Date.now(), kind: value > before ? 'step' : 'turn' });
    const timer = window.setTimeout(() => setPulse(null), 1500);
    return () => window.clearTimeout(timer);
  }, [value]);
  return pulse;
}
