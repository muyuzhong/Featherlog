import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { SPRING } from '../lib/geometry';
import { todoTally } from '../lib/tasks';
import type { WorkSlot } from '../rpc/types';
import { useAppState, useStore } from '../state/react';
import { Elapsed, ReadyTag } from './bits';
import { ChevronUp, Grip, PenLine, Plus } from './icons';

const HOVER_INTENT_MS = 420;

const STATE_NAME = { focus: '专注中', running: '后台运行', ready: '待看' } as const;

/** The collapsed bar: one row of index cards in a tray along the bottom of the screen. */
export function Tray() {
  const store = useStore();
  const { slots, tasks, ui } = useAppState();
  const tally = todoTally(tasks);

  return (
    <motion.div
      className="tray"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8, transition: { duration: 0.1 } }}
      transition={SPRING}
    >
      <div className="tray-handle">
        <span className="grip" aria-hidden="true">
          <Grip />
        </span>
        <button
          type="button"
          className="icon-btn"
          aria-label="展开工作台"
          aria-expanded={false}
          title="展开工作台"
          onClick={() => store.setExpanded(true)}
        >
          <ChevronUp />
        </button>
      </div>

      <ol className="tray-slots" aria-label="并发工作槽">
        <LayoutGroup id="tray">
          <AnimatePresence initial={false}>
            {slots.map((slot, i) => (
              <TraySlot key={slot.id} slot={slot} index={i} />
            ))}
          </AnimatePresence>
        </LayoutGroup>
        {slots.length === 0 && <li className="tray-empty">手上没有并发 · Alt+N 开一张</li>}
      </ol>

      {ui.notice && (
        <span className="tray-notice" role="status" title={ui.notice}>
          {ui.notice}
        </span>
      )}

      <div className="tray-quick">
        <button type="button" className="icon-btn" aria-label="新并发槽" title="新并发槽 · Alt+N" onClick={() => store.requestNewSlot()}>
          <Plus />
        </button>
        <button type="button" className="icon-btn" aria-label="随手记" title="随手记" onClick={() => store.requestCompose()}>
          <PenLine />
        </button>
        <button
          type="button"
          className="tray-tally tnum"
          aria-label={`待办：完成 ${tally.done}，共 ${tally.total}`}
          title="待办"
          onClick={() => store.openTasks()}
        >
          {tally.done}
          <span className="tally-sep">/</span>
          {tally.total}
        </button>
      </div>
    </motion.div>
  );
}

function TraySlot({ slot, index }: { slot: WorkSlot; index: number }) {
  const store = useStore();
  const [actions, setActions] = useState(false);
  const cancelHover = useRef<(() => void) | null>(null);
  const focus = slot.state === 'focus';

  useEffect(() => () => cancelHover.current?.(), []);

  const onEnter = () => {
    cancelHover.current?.();
    cancelHover.current = store.clock.setTimeout(() => setActions(true), HOVER_INTENT_MS);
  };
  const onLeave = () => {
    cancelHover.current?.();
    cancelHover.current = null;
    setActions(false);
  };
  const act = (fn: () => Promise<void>) => () => {
    setActions(false);
    void fn();
  };

  return (
    <motion.li
      layout="position"
      className="tray-slot"
      data-state={slot.state}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={SPRING}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onContextMenu={(e) => {
        e.preventDefault();
        cancelHover.current?.();
        setActions((v) => !v);
      }}
    >
      {focus && <motion.span layoutId="tray-focus-plate" className="tray-plate" transition={SPRING} aria-hidden="true" />}
      <button
        type="button"
        className="tray-slot-main"
        aria-pressed={focus}
        aria-label={`${index + 1}. ${slot.title}，${STATE_NAME[slot.state]}`}
        title={slot.breadcrumb ? `${slot.title} — ${slot.breadcrumb}` : slot.title}
        onClick={() => {
          if (!focus) void store.setSlotState(slot.id, 'focus');
        }}
        onDoubleClick={() => store.setExpanded(true, { highlightSlotId: slot.id })}
      >
        {focus && <span className="focus-bar" aria-hidden="true" />}
        <span className="tray-index tnum">{index + 1}</span>
        <span className="tray-title">{slot.title}</span>
        {slot.tag && <span className="tray-tag">{slot.tag}</span>}
        {slot.state === 'running' && <Elapsed since={slot.stateChangedAt} />}
        {slot.state === 'ready' && <ReadyTag />}
      </button>
      <AnimatePresence initial={false}>
        {actions && (
          <motion.span
            className="tray-actions"
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: 'auto' }}
            exit={{ opacity: 0, width: 0 }}
            transition={SPRING}
          >
            {slot.state !== 'running' && (
              <button type="button" onClick={act(() => store.setSlotState(slot.id, 'running'))}>
                挂起
              </button>
            )}
            {slot.state !== 'ready' && (
              <button type="button" onClick={act(() => store.setSlotState(slot.id, 'ready'))}>
                待看
              </button>
            )}
            <button type="button" onClick={act(() => store.completeSlot(slot.id))}>
              完成
            </button>
          </motion.span>
        )}
      </AnimatePresence>
    </motion.li>
  );
}
