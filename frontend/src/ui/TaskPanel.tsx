import { AnimatePresence, motion } from 'motion/react';
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { SPRING } from '../lib/geometry';
import { itemProgress, parseQuickTask, todoView } from '../lib/tasks';
import { formatDeadline } from '../lib/time';
import type { Task } from '../rpc/types';
import { useAppState, useStore, useT } from '../state/react';
import { Checkbox, QuotaStepper } from './bits';
import { ArrowUpRight, ChevronRight, Plus, X } from './icons';
import { InlineText, isImeKey } from './InlineText';

/** The lower left: one flat list of equal todos, edited where they stand. */
export function TaskPanel() {
  const { tasks, ui } = useAppState();
  const t = useT();
  const [showDone, setShowDone] = useState(false);
  const [revealId, setRevealId] = useState<string | null>(null);
  const { open, done } = todoView(tasks);

  // A finished todo picked in Ctrl+K sits in the fold: open it.
  useEffect(() => {
    if (ui.selectedTaskId && done.some((t) => t.id === ui.selectedTaskId)) setShowDone(true);
  }, [ui.selectedTaskId, done]);

  return (
    <section className="panel tasks" aria-label={t.tasks.title}>
      <div className="panel-head">
        <h2 className="section-title">{t.tasks.title}</h2>
        <span className="panel-tally tnum" aria-label={t.tasks.tally(done.length, open.length + done.length)}>
          {done.length}/{open.length + done.length}
        </span>
      </div>
      <QuickAdd onCreated={setRevealId} />
      <ul className="task-list" aria-label={t.tasks.list}>
        <AnimatePresence initial={false}>
          {open.map((task) => (
            <TaskRow key={task.id} task={task} reveal={task.id === revealId} />
          ))}
        </AnimatePresence>
        {open.length === 0 && <li className="empty">{done.length > 0 ? t.tasks.allDone : t.tasks.empty}</li>}
        {done.length > 0 && (
          <li className="done-fold">
            <button type="button" className="text-btn" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
              <ChevronRight className={showDone ? 'turned' : undefined} />
              {t.tasks.doneFold} <span className="tnum">{done.length}</span>
            </button>
          </li>
        )}
        <AnimatePresence initial={false}>
          {showDone && done.map((task) => <TaskRow key={task.id} task={task} reveal={false} />)}
        </AnimatePresence>
      </ul>
    </section>
  );
}

function QuickAdd({ onCreated }: { onCreated: (id: string) => void }) {
  const store = useStore();
  const { periodKey } = useAppState();
  const t = useT();
  const [text, setText] = useState('');
  const composing = useRef(false);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (composing.current) return;
    const { title, target } = parseQuickTask(text);
    if (!title) return;
    // The contract still has kinds; every todo made here is a plain one, due from today.
    const created = await store.createTask({ kind: 'side', title, quotaTarget: target, scheduledFor: periodKey });
    if (created) {
      setText('');
      onCreated(created.id);
    }
  };

  return (
    <form className="quick-add" onSubmit={(e) => void submit(e)}>
      <Plus />
      <input
        aria-label={t.tasks.newLabel}
        placeholder={t.tasks.newPlaceholder}
        value={text}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setText(e.target.value)}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => (composing.current = false)}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (isImeKey(e) && e.key === 'Enter') e.preventDefault();
          if (e.key === 'Escape') {
            e.stopPropagation();
            setText('');
            e.currentTarget.blur();
          }
        }}
      />
    </form>
  );
}

function TaskRow({ task, reveal }: { task: Task; reveal: boolean }) {
  const store = useStore();
  const { ui, periodKey, slots, settings } = useAppState();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  const completed = task.status === 'completed';
  const selected = ui.selectedTaskId === task.id;
  const onStage = slots.some((s) => s.linkedTaskId === task.id && s.state === 'focus');
  const progress = itemProgress(task);

  useEffect(() => {
    if (selected || reveal) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected, reveal]);

  useEffect(() => {
    if (!confirmDelete) return;
    return store.clock.setTimeout(() => setConfirmDelete(false), 3000);
  }, [confirmDelete, store]);

  return (
    <motion.li
      ref={ref}
      layout="position"
      className="task"
      data-done={completed || undefined}
      data-selected={selected || undefined}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.1 } }}
      transition={SPRING}
      onFocus={() => store.selectTask(task.id)}
    >
      <Checkbox checked={completed} label={t.tasks.complete(task.title)} onChange={(c) => void store.completeTask(task.id, c)} />
      <div className="task-main">
        <InlineText
          className="task-title"
          value={task.title}
          label={t.tasks.itemTitle}
          maxLength={120}
          onCommit={(title) => void store.updateTask({ id: task.id, title })}
        />
        {(task.deadline || progress.total > 0 || onStage) && (
          <div className="task-meta">
            {task.deadline && (
              <span className={task.overdue ? 'overdue' : undefined}>{formatDeadline(task.deadline, periodKey, settings.language)}</span>
            )}
            {progress.total > 0 && (
              <span className="tnum">{t.tasks.steps(progress.done, progress.total)}</span>
            )}
            {onStage && <span className="on-stage">{t.tasks.onDeck}</span>}
          </div>
        )}
      </div>
      <div className="task-side">
        {task.quota && (
          <QuotaStepper
            label={t.tasks.count}
            current={task.quota.current}
            target={task.quota.target}
            onStep={(d) => void store.stepQuota(task.id, d)}
          />
        )}
        {!completed && !onStage && (
          <button type="button" className="promote" title={t.tasks.promoteHint} onClick={() => void store.promoteTask(task.id)}>
            {t.tasks.promote}
            <ArrowUpRight />
          </button>
        )}
        <button
          type="button"
          className="icon-btn tiny"
          aria-label={open ? t.tasks.hideDetails : t.tasks.showDetails}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRight className={open ? 'turned' : undefined} />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="task-detail"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={SPRING}
          >
            <Checklist task={task} />
            <div className="task-foot">
              <DailyReset task={task} />
              {confirmDelete ? (
                <button type="button" className="text-btn strong" onClick={() => void store.deleteTask(task.id)}>
                  {t.tasks.confirmDelete}
                </button>
              ) : (
                <button type="button" className="text-btn" onClick={() => setConfirmDelete(true)}>
                  {t.tasks.delete}
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

/** The one optional difference between todos, kept inside the details. */
function DailyReset({ task }: { task: Task }) {
  const store = useStore();
  const { settings } = useAppState();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const daily = task.kind === 'daily';
  return (
    <span className="daily-reset">
      <button
        type="button"
        role="switch"
        aria-checked={daily}
        className="switch"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await store.setDailyReset(task.id, !daily);
          setBusy(false);
        }}
      >
        <span className="switch-track" aria-hidden="true">
          <span className="switch-knob" />
        </span>
        {t.tasks.dailyReset}
      </button>
      <span className="daily-hint tnum">
        {daily ? t.tasks.dailyOn(settings.dayStartHour, task.streak ?? 0) : t.tasks.dailyOff}
      </span>
    </span>
  );
}

/** Sub-steps tick off in any order; editing or removing one rewrites the list. */
function Checklist({ task }: { task: Task }) {
  const store = useStore();
  const t = useT();
  const [text, setText] = useState('');
  const composing = useRef(false);
  const items = task.items;

  const add = () => {
    if (composing.current || !text.trim()) return;
    void store.setItems(task.id, [...items, { text: text.trim() }]);
    setText('');
  };

  return (
    <ul className="checklist" aria-label={t.tasks.checklist}>
      {items.map((item) => (
        <li key={item.id} className="item" data-done={item.done || undefined}>
          <Checkbox checked={item.done} label={item.text} onChange={(done) => void store.toggleItem(task.id, item.id, done)} />
          <InlineText
            className="item-text"
            value={item.text}
            label={t.tasks.item}
            onCommit={(next) => void store.setItems(task.id, items.map((i) => (i.id === item.id ? { ...i, text: next } : i)))}
          />
          {item.target != null && (
            <QuotaStepper
              label={t.tasks.stepCount}
              current={item.current ?? 0}
              target={item.target}
              onStep={(d) => void store.stepQuota(task.id, d, item.id)}
            />
          )}
          <button
            type="button"
            className="icon-btn tiny"
            aria-label={t.tasks.deleteItem(item.text)}
            onClick={() => void store.setItems(task.id, items.filter((i) => i.id !== item.id))}
          >
            <X />
          </button>
        </li>
      ))}
      <li className="item item-add">
        <Plus />
        <input
          aria-label={t.tasks.addItem}
          placeholder={t.tasks.addItemPlaceholder}
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          onKeyDown={(e) => {
            if (isImeKey(e)) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
      </li>
    </ul>
  );
}
