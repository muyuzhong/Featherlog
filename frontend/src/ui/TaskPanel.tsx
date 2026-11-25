import { AnimatePresence, motion } from 'motion/react';
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { SPRING } from '../lib/geometry';
import { itemProgress, parseQuickTask, todoView } from '../lib/tasks';
import { formatDeadline } from '../lib/time';
import type { Task } from '../rpc/types';
import { useAppState, useStore } from '../state/react';
import { Checkbox, QuotaStepper } from './bits';
import { ArrowUpRight, ChevronRight, Plus, X } from './icons';
import { InlineText, isImeKey } from './InlineText';

/** The lower left: one flat list of equal todos, edited where they stand. */
export function TaskPanel() {
  const { tasks, ui } = useAppState();
  const [showDone, setShowDone] = useState(false);
  const [revealId, setRevealId] = useState<string | null>(null);
  const { open, done } = todoView(tasks);

  // A finished todo picked in Ctrl+K sits in the fold: open it.
  useEffect(() => {
    if (ui.selectedTaskId && done.some((t) => t.id === ui.selectedTaskId)) setShowDone(true);
  }, [ui.selectedTaskId, done]);

  return (
    <section className="panel tasks" aria-label="待办">
      <div className="panel-head">
        <h2 className="section-title">待办</h2>
        <span className="panel-tally tnum" aria-label={`完成 ${done.length}，共 ${open.length + done.length}`}>
          {done.length}/{open.length + done.length}
        </span>
      </div>
      <QuickAdd onCreated={setRevealId} />
      <ul className="task-list" aria-label="待办列表">
        <AnimatePresence initial={false}>
          {open.map((task) => (
            <TaskRow key={task.id} task={task} reveal={task.id === revealId} />
          ))}
        </AnimatePresence>
        {open.length === 0 && <li className="empty">{done.length > 0 ? '都做完了。' : '没有待办，写一条吧。'}</li>}
        {done.length > 0 && (
          <li className="done-fold">
            <button type="button" className="text-btn" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
              <ChevronRight className={showDone ? 'turned' : undefined} />
              已完成 <span className="tnum">{done.length}</span>
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
        aria-label="新建待办"
        placeholder="新建待办，回车即建（末尾写 ×5 设次数）"
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
  const { ui, periodKey, slots } = useAppState();
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
      <Checkbox checked={completed} label={`完成「${task.title}」`} onChange={(c) => void store.completeTask(task.id, c)} />
      <div className="task-main">
        <InlineText
          className="task-title"
          value={task.title}
          label="待办标题"
          maxLength={120}
          onCommit={(title) => void store.updateTask({ id: task.id, title })}
        />
        {(task.deadline || progress.total > 0 || onStage) && (
          <div className="task-meta">
            {task.deadline && (
              <span className={task.overdue ? 'overdue' : undefined}>{formatDeadline(task.deadline, periodKey)}</span>
            )}
            {progress.total > 0 && (
              <span className="tnum">
                子项 {progress.done}/{progress.total}
              </span>
            )}
            {onStage && <span className="on-stage">在台上</span>}
          </div>
        )}
      </div>
      <div className="task-side">
        {task.quota && (
          <QuotaStepper
            label="次数"
            current={task.quota.current}
            target={task.quota.target}
            onStep={(d) => void store.stepQuota(task.id, d)}
          />
        )}
        {!completed && !onStage && (
          <button type="button" className="promote" title="挂到上面的并发台并专注" onClick={() => void store.promoteTask(task.id)}>
            上台
            <ArrowUpRight />
          </button>
        )}
        <button
          type="button"
          className="icon-btn tiny"
          aria-label={open ? '收起详情' : '展开详情'}
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
                  再点一次删除
                </button>
              ) : (
                <button type="button" className="text-btn" onClick={() => setConfirmDelete(true)}>
                  删除待办
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
        每日重置
      </button>
      <span className="daily-hint tnum">
        {daily
          ? `每天 ${settings.dayStartHour}:00 清零${(task.streak ?? 0) > 0 ? ` · 已连续 ${task.streak} 天` : ''}`
          : '每天清零次数和勾选'}
      </span>
    </span>
  );
}

/** Sub-steps tick off in any order; editing or removing one rewrites the list. */
function Checklist({ task }: { task: Task }) {
  const store = useStore();
  const [text, setText] = useState('');
  const composing = useRef(false);
  const items = task.items;

  const add = () => {
    if (composing.current || !text.trim()) return;
    void store.setItems(task.id, [...items, { text: text.trim() }]);
    setText('');
  };

  return (
    <ul className="checklist" aria-label="子项">
      {items.map((item) => (
        <li key={item.id} className="item" data-done={item.done || undefined}>
          <Checkbox checked={item.done} label={item.text} onChange={(done) => void store.toggleItem(task.id, item.id, done)} />
          <InlineText
            className="item-text"
            value={item.text}
            label="子项"
            onCommit={(next) => void store.setItems(task.id, items.map((i) => (i.id === item.id ? { ...i, text: next } : i)))}
          />
          {item.target != null && (
            <QuotaStepper
              label="子项次数"
              current={item.current ?? 0}
              target={item.target}
              onStep={(d) => void store.stepQuota(task.id, d, item.id)}
            />
          )}
          <button
            type="button"
            className="icon-btn tiny"
            aria-label={`删除子项「${item.text}」`}
            onClick={() => void store.setItems(task.id, items.filter((i) => i.id !== item.id))}
          >
            <X />
          </button>
        </li>
      ))}
      <li className="item item-add">
        <Plus />
        <input
          aria-label="添加子项"
          placeholder="加一个子步骤，回车"
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
