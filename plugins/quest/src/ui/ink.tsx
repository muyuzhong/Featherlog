import { motion } from 'motion/react';
import styles from './ink.module.css';

/*
 * Hand-drawn marks. Every path wobbles a little on purpose: crisp vector
 * geometry is what made the first parchment mockup feel pasted-on.
 */

const draw = (delay = 0, duration = 0.45) => ({
  initial: { pathLength: 0, opacity: 0 },
  animate: { pathLength: 1, opacity: 1 },
  transition: { pathLength: { delay, duration, ease: [0.4, 0, 0.2, 1] as const }, opacity: { delay, duration: 0.01 } },
});

/** A tapered, slightly wavy rule, like a quill stroke. */
export function InkRule({ className = '' }: { className?: string }) {
  return (
    <svg className={`${styles.rule} ${className}`} viewBox="0 0 400 8" preserveAspectRatio="none" aria-hidden>
      <path d="M2 4.3 C 60 3.1, 140 5.4, 210 4 S 350 3.2, 398 4.4 C 340 4.9, 250 4.6, 200 4.9 S 70 5.1, 2 4.3 Z" />
    </svg>
  );
}

export function InkCheck({ animate = false, className = '' }: { animate?: boolean; className?: string }) {
  return (
    <svg className={`${styles.check} ${className}`} viewBox="0 0 22 22" aria-hidden>
      <motion.path d="M4 11.8 C 5.6 13, 7 14.8, 8.3 16.8 C 10.9 11.4, 14.3 7.1, 18.8 3.4" {...(animate ? draw(0.28, 0.35) : {})} />
    </svg>
  );
}

/** A strike through a line of text; sits absolutely over its parent. */
export function InkStrike({ animate = false }: { animate?: boolean }) {
  return (
    <svg className={styles.strike} viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden>
      <motion.path d="M1 6.2 C 18 4.4, 40 7.2, 62 5.2 S 90 4.4, 99 5.6" {...(animate ? draw(0, 0.4) : {})} />
    </svg>
  );
}

export function InkBox({ checked, animate = false }: { checked: boolean; animate?: boolean }) {
  return (
    <svg className={styles.box} viewBox="0 0 22 22" aria-hidden>
      <path className={styles.boxFrame} d="M3.4 4.3 C 8.2 3.7, 12.8 3.6, 17.4 4 C 17.8 8.5, 17.7 13, 17.3 17.6 C 12.6 17.9, 8.1 18, 3.7 17.5 C 3.3 13, 3.2 8.6, 3.6 3.6" />
      {checked && (
        <motion.path className={styles.boxTick} d="M5.6 10.6 C 7.4 12, 8.6 13.8, 9.6 15.8 C 12.4 10, 15.6 5.6, 20.4 1.6" {...(animate ? draw(0, 0.35) : {})} />
      )}
    </svg>
  );
}

/** A rough circle, open where the pen lifted. */
export function InkCircle({ className = '', dashed = false }: { className?: string; dashed?: boolean }) {
  return (
    <svg className={`${styles.circle} ${dashed ? styles.dashed : ''} ${className}`} viewBox="0 0 36 36" aria-hidden>
      <path d="M18.6 3.6 C 27 3.4, 32.7 9.8, 32.4 18.3 C 32.1 26.6, 25.7 32.7, 17.6 32.5 C 9.3 32.2, 3.4 25.9, 3.7 17.7 C 4 10, 9.9 4.3, 20.2 4.4" />
    </svg>
  );
}

const FEATHER =
  'M12.67 19a2 2 0 0 0 1.416-.588l6.154-6.172a6 6 0 0 0-8.49-8.49L5.586 9.914A2 2 0 0 0 5 11.328V18a1 1 0 0 0 1 1z M16 8 2 22 M17.5 15H9';

export function Quill({ className = '' }: { className?: string }) {
  return (
    <svg className={`${styles.quill} ${className}`} viewBox="0 0 24 24" aria-hidden>
      <path d={FEATHER} />
    </svg>
  );
}

/** The wax seal pressed onto a tracked quest. */
export function WaxSeal({ size = 68, press = false }: { size?: number; press?: boolean }) {
  return (
    <motion.div
      className={styles.wax}
      style={{ width: size, height: size }}
      initial={press ? { scale: 1.45, rotate: -24, opacity: 0 } : false}
      animate={{ scale: 1, rotate: -9, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 320, damping: 17 }}
    >
      <span className={styles.waxRing} />
      <svg viewBox="0 0 24 24" className={styles.waxEmblem} aria-hidden>
        <path d={FEATHER} />
      </svg>
    </motion.div>
  );
}

/** A square vermilion seal (朱印), stamped when a quest is done. */
export function Stamp({ text = '功成', press = false, size = 70 }: { text?: string; press?: boolean; size?: number }) {
  return (
    <motion.div
      className={styles.stamp}
      style={{ width: size, height: size * 1.12 }}
      initial={press ? { scale: 2.1, rotate: -2, opacity: 0 } : false}
      animate={{ scale: 1, rotate: -7, opacity: 0.88 }}
      transition={{ type: 'spring', stiffness: 380, damping: 20, delay: press ? 0.15 : 0 }}
    >
      {[...text].map((char) => (
        <span key={char}>{char}</span>
      ))}
    </motion.div>
  );
}
