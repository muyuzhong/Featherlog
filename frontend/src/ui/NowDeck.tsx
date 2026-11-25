import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { SPRING } from '../lib/geometry';
import { formatClock, formatElapsed, reminderProgress } from '../lib/time';
import type { WorkSlot, WorkSlotState } from '../rpc/types';
import { useAppState, useNow, useStore, useT } from '../state/react';
import { Elapsed, ReadyTag, Segmented } from './bits';
import { ArrowUpRight, CornerDownRight, Plus, X } from './icons';
import { InlineText, isImeKey } from './InlineText';

const REMIND_STEPS = [10, 20, 45] as const;

/** The upper half: every slot in flight as an index card, the focus one lifted out of the tray. */
export function NowDeck() {
  const { slots, ui } = useAppState();
  const t = useT();
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (ui.newSlotSignal > 0) setAdding(true);
  }, [ui.newSlotSignal]);

  return (
    <section className="deck" aria-label={t.deck.region}>
      <div className="deck-head">
        <span className="section-title">{t.deck.title}</span>
        <span className="deck-count tnum">{t.deck.count(slots.length)}</span>
        <span className="deck-hint">{t.deck.hint}</span>
        <button type="button" className="ghost-btn" onClick={() => setAdding(true)}>
          <Plus />
          {t.deck.newCard}
        </button>
      </div>
      <div className="deck-row">
        <LayoutGroup id="deck">
          <AnimatePresence initial={false}>
            {slots.map((slot, i) => (
              <SlotCard key={slot.id} slot={slot} index={i} highlighted={ui.highlightSlotId === slot.id} />
            ))}
            {adding && <NewSlotCard key="new" onDone={() => setAdding(false)} />}
          </AnimatePresence>
        </LayoutGroup>
        {slots.length === 0 && !adding && (
          <button type="button" className="deck-empty" onClick={() => setAdding(true)}>
            {t.deck.empty}
          </button>
        )}
      </div>
    </section>
  );
}

const STATES: readonly WorkSlotState[] = ['focus', 'running', 'ready'];

function SlotCard({ slot, index, highlighted }: { slot: WorkSlot; index: number; highlighted: boolean }) {
  const store = useStore();
  const { tasks, reminders } = useAppState();
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const task = slot.linkedTaskId ? tasks.find((t) => t.id === slot.linkedTaskId) : undefined;
  const reminder = reminders[slot.id];

  useEffect(() => {
    if (!highlighted) return;
    ref.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    return store.clock.setTimeout(() => store.clearHighlight(), 1800);
  }, [highlighted, store]);

  const complete = () => {
    if (task && task.status !== 'completed') setConfirming(true);
    else void store.completeSlot(slot.id);
  };

  return (
    <motion.article
      ref={ref}
      layout
      className="card"
      data-state={slot.state}
      data-highlight={highlighted || undefined}
      aria-label={`${index + 1}. ${slot.title}`}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.12 } }}
      transition={SPRING}
    >
      {slot.state === 'focus' && <motion.div layoutId="deck-focus-plate" className="card-plate" transition={SPRING} aria-hidden="true" />}
      <div className="card-body">
        <div className="card-head">
          {slot.state === 'focus' && <span className="focus-bar" aria-hidden="true" />}
          <span className="card-index tnum">{String(index + 1).padStart(2, '0')}</span>
          <InlineText
            className="card-tag"
            value={slot.tag ?? ''}
            label={t.slot.tag}
            placeholder={t.slot.tagPlaceholder}
            allowEmpty
            maxLength={24}
            onCommit={(tag) => void store.updateSlot({ id: slot.id, tag })}
          />
          <span className="card-status">
            {slot.state === 'focus' && <span className="status-word">{t.slot.focusing}</span>}
            {slot.state === 'running' && <Elapsed since={slot.stateChangedAt} />}
            {slot.state === 'ready' && <ReadyTag />}
          </span>
        </div>
        <InlineText
          className="card-title"
          value={slot.title}
          label={t.slot.title}
          maxLength={80}
          onCommit={(title) => void store.updateSlot({ id: slot.id, title })}
        />
        <div className="card-crumb">
          <CornerDownRight />
          <InlineText
            value={slot.breadcrumb}
            label={t.slot.crumb}
            placeholder={t.slot.crumbPlaceholder}
            allowEmpty
            maxLength={140}
            onCommit={(breadcrumb) => void store.updateSlot({ id: slot.id, breadcrumb })}
          />
        </div>
        <div className="card-meta">
          <SlotMeta slot={slot} />
          {task && (
            <span className="card-task" title={t.slot.linkedTask(task.title)}>
              <ArrowUpRight />
              {task.title}
            </span>
          )}
        </div>
        <div className="card-actions">
          {confirming ? (
            <span className="confirm" role="group" aria-label={t.slot.wrapUp}>
              <span className="confirm-q">{t.slot.wrapUpQuestion}</span>
              <button
                type="button"
                className="text-btn strong"
                onClick={() => {
                  setConfirming(false);
                  void store.completeSlot(slot.id, true);
                }}
              >
                {t.slot.wrapUpWithTask}
              </button>
              <button
                type="button"
                className="text-btn"
                onClick={() => {
                  setConfirming(false);
                  void store.completeSlot(slot.id, false);
                }}
              >
                {t.slot.wrapUpOnly}
              </button>
              <button type="button" className="icon-btn tiny" aria-label={t.slot.cancel} onClick={() => setConfirming(false)}>
                <X />
              </button>
            </span>
          ) : (
            <>
              <Segmented<WorkSlotState>
                id={`state-${slot.id}`}
                label={t.slot.stateGroup}
                compact
                value={slot.state}
                options={STATES.map((value) => ({ value, label: t.slot.states[value] }))}
                onChange={(state) => void store.setSlotState(slot.id, state)}
              />
              <button type="button" className="text-btn" onClick={complete}>
                {t.slot.wrapUp}
              </button>
            </>
          )}
        </div>
      </div>
      {reminder && <ReminderLine start={reminder.start} remindAt={reminder.remindAt} />}
    </motion.article>
  );
}

function SlotMeta({ slot }: { slot: WorkSlot }) {
  const store = useStore();
  const t = useT();
  const now = useNow(1000);
  if (slot.state !== 'running') {
    return (
      <span className="meta-text">
        {slot.state === 'focus' ? t.slot.focusedFor : t.slot.waitingFor}
        <span className="tnum">{formatElapsed(now - slot.stateChangedAt)}</span>
      </span>
    );
  }
  return (
    <span className="remind" role="group" aria-label={t.slot.reminderGroup}>
      {slot.remindAt != null ? (
        <span className="meta-text" title={t.slot.checkBackAt(formatClock(slot.remindAt))}>
          {t.slot.leftBefore}
          <span className="tnum">{formatElapsed(Math.max(0, slot.remindAt - now))}</span>
          {t.slot.leftAfter}
        </span>
      ) : (
        <span className="meta-text">{t.slot.checkBack}</span>
      )}
      {REMIND_STEPS.map((m) => (
        <button
          key={m}
          type="button"
          className="remind-step tnum"
          aria-label={t.slot.remindIn(m)}
          onClick={() => void store.setSlotState(slot.id, 'running', m)}
        >
          +{m}m
        </button>
      ))}
      {slot.remindAt != null && (
        <button type="button" className="icon-btn tiny" aria-label={t.slot.cancelReminder} onClick={() => void store.setSlotState(slot.id, 'running', null)}>
          <X />
        </button>
      )}
    </span>
  );
}

/** A 1px ink rule along the card's foot: how much of the wait has passed. */
function ReminderLine({ start, remindAt }: { start: number; remindAt: number }) {
  const t = useT();
  const now = useNow(1000);
  const progress = reminderProgress({ start, remindAt }, now);
  return (
    <div className="card-progress" role="progressbar" aria-label={t.slot.countdown} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
      <span style={{ transform: `scaleX(${progress})` }} />
    </div>
  );
}

function NewSlotCard({ onDone }: { onDone: () => void }) {
  const store = useStore();
  const t = useT();
  const [title, setTitle] = useState('');
  const [tag, setTag] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const submit = async () => {
    if (!title.trim()) {
      onDone();
      return;
    }
    const created = await store.createSlot({ title, tag: tag.trim() || undefined, state: 'focus' });
    if (created) onDone();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKey(e)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onDone();
    }
  };

  return (
    <motion.article
      layout
      className="card card-new"
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.1 } }}
      transition={SPRING}
    >
      <div className="card-body">
        <div className="card-head">
          <span className="card-index">{t.slot.newIndex}</span>
          <input
            className="inline card-tag"
            aria-label={t.slot.newTag}
            placeholder={t.slot.newTagPlaceholder}
            value={tag}
            maxLength={24}
            onChange={(e) => setTag(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <input
          ref={titleRef}
          className="inline card-title"
          aria-label={t.slot.newTitle}
          placeholder={t.slot.newTitlePlaceholder}
          value={title}
          maxLength={80}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <p className="card-new-hint">{t.slot.newHint}</p>
      </div>
    </motion.article>
  );
}
