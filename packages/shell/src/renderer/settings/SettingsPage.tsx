import type { Json } from '@featherlog/contracts';
import { motion } from 'motion/react';
import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { WindowRuntime } from '../app/runtime';
import { useSetting } from '../app/use-setting';
import { PAPERS, type Paper } from '../theme';
import { readFields, type Field } from './schema';
import styles from './SettingsPage.module.css';
import { UpdateNotes } from './Updates';

/**
 * The shell's settings page (design §7.2): the shell's own settings drawn by
 * hand, then one section per plugin rendered from its settings schema.
 */
export function SettingsPage({ runtime }: { runtime: WindowRuntime }) {
  const sections = runtime.manifests.flatMap((manifest) => {
    const settings = manifest.contributes?.settings;
    const fields = settings ? readFields(settings.schema) : [];
    return fields.length ? [{ scope: manifest.id, title: settings?.title ?? manifest.name, fields }] : [];
  });

  return (
    <div className={styles.desk}>
      <div className={styles.sheetWrap}>
        <div className={`${styles.sheet} fl-paper`}>
          <div className={styles.scroll}>
            <header className={styles.head}>
              <h1>设置</h1>
              <p>随手改动，即刻生效</p>
              <InkRule />
            </header>

            <Section title="纸张">
              <PaperPicker runtime={runtime} />
            </Section>

            <Section title="卷轴">
              <DockNotes runtime={runtime} />
            </Section>

            {sections.map((section) => (
              <Section key={section.scope} title={section.title}>
                {section.fields.map((field) => (
                  <FieldRow key={field.key} runtime={runtime} scope={section.scope} field={field} />
                ))}
              </Section>
            ))}

            <UpdateNotes
              bus={runtime.shellBus}
              toggle={
                <FieldRow
                  runtime={runtime}
                  scope="shell"
                  field={{
                    key: 'autoUpdate',
                    kind: 'boolean',
                    title: '自动检查并下载更新',
                    description: '只访问 GitHub，不收集任何信息。关闭后只在这里手动检查。',
                  }}
                />
              }
            />

            <Section title="插件">
              <ul className={styles.plugins}>
                {runtime.manifests.map((manifest) => (
                  <li key={manifest.id}>
                    <span className={styles.pluginName}>{manifest.name}</span>
                    <small>v{manifest.version}</small>
                    {manifest.description && <p>{manifest.description}</p>}
                  </li>
                ))}
              </ul>
            </Section>

            <footer className={styles.colophon}>羽记 · 一切皆插件</footer>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {children}
    </section>
  );
}

/** Saves one setting; the page redraws from settings.onChange, so a rejected value simply never shows. */
function useSave(runtime: WindowRuntime, scope: string, key: string): [(value: Json) => void, string | undefined] {
  const [error, setError] = useState<string>();
  const save = (value: Json) => {
    setError(undefined);
    runtime.preload.settings.set(scope, key, value).catch((cause: unknown) => {
      console.error(cause);
      const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
      setError(code === 'shell/invalid-setting' ? '这个值不合规矩，没有记下' : '没能记下，请再试一次');
    });
  };
  return [save, error];
}

// ---------------------------------------------------------------- the shell's own

function PaperPicker({ runtime }: { runtime: WindowRuntime }) {
  const current = useSetting<Paper>(runtime, 'shell', 'paper') ?? 'vellum';
  const [save, error] = useSave(runtime, 'shell', 'paper');
  return (
    <>
      <div className={styles.papers} role="radiogroup" aria-label="纸张">
        {(Object.keys(PAPERS) as Paper[]).map((paper) => (
          <button
            key={paper}
            role="radio"
            aria-checked={paper === current}
            className={styles.swatch}
            onClick={() => paper !== current && save(paper)}
          >
            <span className={styles.swatchWrap}>
              <span
                className={`${styles.swatchSheet} fl-paper`}
                style={{ backgroundColor: PAPERS[paper].base, backgroundImage: `var(--fl-tex-burn), url("${PAPERS[paper].url}")` }}
              />
            </span>
            <span className={styles.swatchLabel}>{PAPERS[paper].label}</span>
            {paper === current && <InkCircle />}
          </button>
        ))}
      </div>
      {error && <p className={styles.note}>{error}</p>}
    </>
  );
}

function DockNotes({ runtime }: { runtime: WindowRuntime }) {
  const { os, dock } = runtime.preload.platform;
  // compatMode only applies at the next launch (design §9.7), so remember what this run started with.
  const [startedWith] = useState(() => runtime.setting<boolean>('shell', 'compatMode') ?? false);
  const compat = useSetting<boolean>(runtime, 'shell', 'compatMode') ?? false;
  return (
    <>
      {dock.keepAbove ? (
        <p className={styles.prose}>卷轴浮在所有窗口之上。按住两端的木轴，把它拖到顺手的地方；悬停时，便签朝屏幕中间展开。</p>
      ) : (
        <p className={`${styles.prose} ${styles.warn}`}>
          当前桌面不支持置顶，卷轴可能被别的窗口盖住。{os === 'linux' && '可开启兼容模式后重启。'}
        </p>
      )}
      {os === 'linux' && (
        <FieldRow
          runtime={runtime}
          scope="shell"
          field={{
            key: 'compatMode',
            kind: 'boolean',
            title: '兼容模式',
            description: '改走 XWayland，让卷轴能够置顶。代价是混合缩放的多块屏上可能发糊。',
          }}
          note={compat !== startedWith ? '已记下，重启羽记后生效' : '重启后生效'}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- schema fields

function FieldRow({ runtime, scope, field, note }: { runtime: WindowRuntime; scope: string; field: Field; note?: string }) {
  const value = useSetting<Json>(runtime, scope, field.key);
  const [save, error] = useSave(runtime, scope, field.key);
  const hint = error ?? note;
  const label = (
    <span className={styles.label}>
      <span className={styles.fieldTitle}>{field.title}</span>
      {field.description && <span className={styles.desc}>{field.description}</span>}
      {hint && <span className={`${styles.hint} ${error ? styles.warn : ''}`}>{hint}</span>}
    </span>
  );

  if (field.kind === 'boolean') {
    const on = value === true;
    return (
      <button className={`${styles.row} ${styles.check}`} role="switch" aria-checked={on} onClick={() => save(!on)}>
        <InkBox on={on} />
        {label}
      </button>
    );
  }
  return (
    <div className={styles.row}>
      {label}
      <div className={styles.control}>
        <Control field={field} value={value} onChange={save} />
      </div>
    </div>
  );
}

function Control({ field, value, onChange }: { field: Field; value: Json | undefined; onChange(value: Json): void }) {
  switch (field.kind) {
    case 'number':
      return field.integer && field.min !== undefined && field.max !== undefined && field.max - field.min <= 30 ? (
        <Ruler label={field.title} min={field.min} max={field.max} value={typeof value === 'number' ? value : field.min} onChange={onChange} />
      ) : (
        <Stepper field={field} value={typeof value === 'number' ? value : (field.min ?? 0)} onChange={onChange} />
      );
    case 'choice':
      return (
        <div className={styles.choices} role="radiogroup" aria-label={field.title}>
          {field.options.map((option) => (
            <button
              key={option.value}
              role="radio"
              aria-checked={option.value === value}
              className={option.value === value ? styles.chosen : ''}
              onClick={() => option.value !== value && onChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      );
    case 'text':
      return <TextInput label={field.title} value={typeof value === 'string' ? value : ''} onChange={onChange} />;
    case 'boolean':
      return null;
  }
}

/** A small range as a hand-ruled scale: one click (or drag) instead of twenty presses of "+". */
function Ruler({ label, min, max, value, onChange }: { label: string; min: number; max: number; value: number; onChange(value: number): void }) {
  const track = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? value;
  const span = max - min;
  const every = span > 12 ? 6 : span > 6 ? 2 : 1;
  const ticks = Array.from({ length: span + 1 }, (_, i) => min + i);
  const at = (clientX: number) => {
    const box = track.current!.getBoundingClientRect();
    return min + Math.round(Math.min(1, Math.max(0, (clientX - box.left) / box.width)) * span);
  };
  const commit = (next: number) => next !== value && onChange(next);
  const onKey = (event: KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
    const jump = event.key === 'Home' ? min : event.key === 'End' ? max : undefined;
    if (step === undefined && jump === undefined) return;
    event.preventDefault();
    commit(jump ?? Math.min(max, Math.max(min, value + step!)));
  };
  const move = (event: PointerEvent) => dragging !== null && setDragging(at(event.clientX));
  const end = () => {
    if (dragging !== null) commit(dragging);
    setDragging(null);
  };

  return (
    <div className={styles.ruler}>
      <div
        ref={track}
        className={styles.track}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={shown}
        onKeyDown={onKey}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(at(event.clientX));
        }}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={() => setDragging(null)}
      >
        <svg className={styles.scale} viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden>
          <path d="M0 12.5 Q 25 11.6 50 12.6 T 100 12.2" />
          {ticks.map((tick) => {
            const x = ((tick - min) / span) * 100;
            const major = (tick - min) % every === 0 || tick === max;
            return <line key={tick} x1={x} x2={x} y1={major ? 5 : 8.5} y2={12.5} className={major ? styles.major : ''} />;
          })}
        </svg>
        <motion.span
          className={styles.marker}
          initial={false}
          animate={{ left: `${((shown - min) / span) * 100}%` }}
          transition={dragging !== null ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 32 }}
        >
          <span className={styles.markerValue}>{shown}</span>
          <svg viewBox="0 0 12 10" aria-hidden>
            <path d="M1.2 1.4 Q 6 0.6 10.8 1.2 L 6.2 9 Z" />
          </svg>
        </motion.span>
      </div>
      <div className={styles.rulerLabels} aria-hidden>
        {ticks
          .filter((tick) => (tick - min) % every === 0 || tick === max)
          .map((tick) => (
            <span key={tick} style={{ left: `${((tick - min) / span) * 100}%` }}>
              {tick}
            </span>
          ))}
      </div>
    </div>
  );
}

function Stepper({ field, value, onChange }: { field: Field & { kind: 'number' }; value: number; onChange(value: number): void }) {
  const step = field.integer ? 1 : 0.1;
  const clamp = (n: number) => Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, Math.round(n * 100) / 100));
  const nudge = (direction: number) => {
    const next = clamp(value + direction * step);
    if (next !== value) onChange(next);
  };
  return (
    <div
      className={styles.stepper}
      role="spinbutton"
      tabIndex={0}
      aria-label={field.title}
      aria-valuenow={value}
      {...(field.min !== undefined ? { 'aria-valuemin': field.min } : {})}
      {...(field.max !== undefined ? { 'aria-valuemax': field.max } : {})}
      onKeyDown={(event) => {
        const direction = { ArrowDown: -1, ArrowLeft: -1, ArrowUp: 1, ArrowRight: 1 }[event.key];
        if (direction === undefined) return;
        event.preventDefault();
        nudge(direction);
      }}
    >
      <button tabIndex={-1} aria-label="少一些" disabled={field.min !== undefined && value <= field.min} onClick={() => nudge(-1)}>
        −
      </button>
      <span className={styles.numeral}>{value}</span>
      <button tabIndex={-1} aria-label="多一些" disabled={field.max !== undefined && value >= field.max} onClick={() => nudge(1)}>
        +
      </button>
    </div>
  );
}

/** Written on a ruled line; saved when the pen lifts (blur or Enter), not on every keystroke. */
function TextInput({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onChange(draft);
    setDraft(null);
  };
  return (
    <input
      className={styles.text}
      aria-label={label}
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
        if (event.key === 'Escape') {
          event.stopPropagation();
          setDraft(null);
        }
      }}
    />
  );
}

// ---------------------------------------------------------------- ink

function InkRule() {
  return (
    <svg className={styles.rule} viewBox="0 0 300 12" preserveAspectRatio="none" aria-hidden>
      <path d="M2 7 C 60 4.5, 120 8.5, 150 6 S 250 4.2, 298 6.6" />
      <path className={styles.ruleDot} d="M150 6 m-2.2 0 a2.2 2.2 0 1 0 4.4 0 a2.2 2.2 0 1 0 -4.4 0" />
    </svg>
  );
}

/** A rubric circle, drawn around the chosen paper as if by hand. */
function InkCircle() {
  return (
    <svg className={styles.circle} viewBox="0 0 140 112" preserveAspectRatio="none" aria-hidden>
      <motion.path
        d="M34 10 C 76 -1, 128 6, 134 44 C 140 82, 104 106, 64 104 C 22 102, 2 78, 6 50 C 9 26, 30 12, 58 8"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.55, ease: [0.3, 0.6, 0.3, 1] }}
      />
    </svg>
  );
}

function InkBox({ on }: { on: boolean }) {
  return (
    <svg className={styles.box} viewBox="0 0 24 24" aria-hidden>
      <path className={styles.boxFrame} d="M4.2 5.1 Q 12 3.9 19.6 4.6 Q 20.3 12 19.8 19.5 Q 12 20.4 4.6 19.8 Q 3.8 12.4 4.2 5.1 Z" />
      {on && (
        <motion.path
          className={styles.boxTick}
          d="M6.8 12.6 L 10.6 16.6 L 21.5 3"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.32, ease: 'easeOut' }}
        />
      )}
    </svg>
  );
}
