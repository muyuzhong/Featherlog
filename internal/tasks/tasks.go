package tasks

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/muyuzhong/featherlog/internal/clock"
	"github.com/muyuzhong/featherlog/internal/store"
)

const (
	// FileName is the JSON file used to persist tasks and daily completion history.
	FileName = "tasks.json"

	// DefaultDayStartHour is the default local hour (0..23) at which a new day period begins.
	DefaultDayStartHour = 4

	schemaVersion = 1

	maxTitleRunes     = 200
	maxItemTextRunes  = 500
	errorRetryBackoff = 5 * time.Second

	ErrCodeInvalidInput = "tasks/invalid-input"
	ErrCodeNotFound     = "tasks/not-found"
)

// TaskKind classifies a Featherlog v2 task for storage compatibility.
// In the unified flat task model, non-recurring tasks default to KindSide and
// recurring tasks use KindDaily; KindMain and KindTask remain accepted on input
// for backward compatibility.
type TaskKind string

const (
	KindMain  TaskKind = "main"
	KindSide  TaskKind = "side"
	KindDaily TaskKind = "daily"
	KindTask  TaskKind = "task"
)

// TaskStatus tracks whether a task is active, completed, or archived.
type TaskStatus string

const (
	StatusActive    TaskStatus = "active"
	StatusCompleted TaskStatus = "completed"
	StatusArchived  TaskStatus = "archived"
)

// RecurrenceFreq defines how often a daily task is due.
type RecurrenceFreq string

const (
	FreqDaily  RecurrenceFreq = "daily"
	FreqWeekly RecurrenceFreq = "weekly"
)

// TaskItem is a free-order checklist step on a task.
type TaskItem struct {
	ID      string `json:"id"`
	Text    string `json:"text"`
	Done    bool   `json:"done"`
	Current *int   `json:"current,omitempty"`
	Target  *int   `json:"target,omitempty"`
}

// TaskQuota tracks numeric count progress on a task.
type TaskQuota struct {
	Current int `json:"current"`
	Target  int `json:"target"`
}

// TaskRecurrence defines when a daily task is due.
// Weekdays uses 0 (Sunday) through 6 (Saturday) when Freq is FreqWeekly.
type TaskRecurrence struct {
	Freq     RecurrenceFreq `json:"freq"`
	Weekdays []int          `json:"weekdays,omitempty"`
}

// Task is the full external view of a task including derived fields (dueToday,
// overdue, streak).
type Task struct {
	ID           string          `json:"id"`
	Kind         TaskKind        `json:"kind"`
	Title        string          `json:"title"`
	Status       TaskStatus      `json:"status"`
	Items        []TaskItem      `json:"items"`
	Quota        *TaskQuota      `json:"quota,omitempty"`
	Recurrence   *TaskRecurrence `json:"recurrence,omitempty"`
	PeriodKey    string          `json:"periodKey,omitempty"`
	Streak       *int            `json:"streak,omitempty"`
	Deadline     string          `json:"deadline,omitempty"`
	ScheduledFor string          `json:"scheduledFor,omitempty"`
	DueToday     bool            `json:"dueToday"`
	Overdue      bool            `json:"overdue"`
	Order        int             `json:"order"`
	CreatedAt    int64           `json:"createdAt"`
	CompletedAt  *int64          `json:"completedAt,omitempty"`
}

// ListResult is returned by List and emitted on changes.
type ListResult struct {
	PeriodKey string `json:"periodKey"`
	Tasks     []Task `json:"tasks"`
}

// CreateItemInput defines a checklist item when creating a task.
type CreateItemInput struct {
	Text   string `json:"text"`
	Target *int   `json:"target,omitempty"`
}

// CreateInput defines parameters for creating a new task.
// Kind is optional in the flat task model; omitted or "task" defaults to
// KindSide (or KindDaily when Recurrence is provided).
type CreateInput struct {
	Kind         TaskKind          `json:"kind,omitempty"`
	Title        string            `json:"title"`
	Items        []CreateItemInput `json:"items,omitempty"`
	QuotaTarget  *int              `json:"quotaTarget,omitempty"`
	Recurrence   *TaskRecurrence   `json:"recurrence,omitempty"`
	Deadline     string            `json:"deadline,omitempty"`
	ScheduledFor string            `json:"scheduledFor,omitempty"`
}

// UpdateInput modifies mutable fields of an existing task.
// JSON null for quotaTarget, recurrence, deadline, or scheduledFor sets the corresponding Clear* flag.
type UpdateInput struct {
	ID                string          `json:"id"`
	Title             *string         `json:"title,omitempty"`
	QuotaTarget       *int            `json:"quotaTarget,omitempty"`
	ClearQuota        bool            `json:"-"`
	Recurrence        *TaskRecurrence `json:"recurrence,omitempty"`
	ClearRecurrence   bool            `json:"-"`
	Deadline          *string         `json:"deadline,omitempty"`
	ClearDeadline     bool            `json:"-"`
	ScheduledFor      *string         `json:"scheduledFor,omitempty"`
	ClearScheduledFor bool            `json:"-"`
	Status            *TaskStatus     `json:"status,omitempty"`
}

// UnmarshalJSON distinguishes omitted optional fields from explicit JSON null.
func (in *UpdateInput) UnmarshalJSON(data []byte) error {
	type alias UpdateInput
	var raw alias
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*in = UpdateInput(raw)

	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	if v, ok := fields["quotaTarget"]; ok && bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
		in.ClearQuota = true
		in.QuotaTarget = nil
	}
	if v, ok := fields["recurrence"]; ok && bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
		in.ClearRecurrence = true
		in.Recurrence = nil
	}
	if v, ok := fields["deadline"]; ok && bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
		in.ClearDeadline = true
		in.Deadline = nil
	}
	if v, ok := fields["scheduledFor"]; ok && bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
		in.ClearScheduledFor = true
		in.ScheduledFor = nil
	}
	return nil
}

// ItemDraft describes an item in SetItems. Matching IDs preserve existing progress
// unless Done or Current is explicitly supplied.
type ItemDraft struct {
	ID      string `json:"id,omitempty"`
	Text    string `json:"text"`
	Done    *bool  `json:"done,omitempty"`
	Current *int   `json:"current,omitempty"`
	Target  *int   `json:"target,omitempty"`
}

// SetItemsInput replaces a task's checklist items.
type SetItemsInput struct {
	ID    string      `json:"id"`
	Items []ItemDraft `json:"items"`
}

// ToggleItemInput toggles or explicitly sets an item's completion state.
// Items can be toggled in any order (no sequential lock).
type ToggleItemInput struct {
	TaskID string `json:"taskId"`
	ItemID string `json:"itemId"`
	Done   *bool  `json:"done,omitempty"`
}

// StepQuotaInput increments or decrements a task's or item's quota by Delta.
type StepQuotaInput struct {
	ID     string `json:"id"`
	ItemID string `json:"itemId,omitempty"`
	Delta  int    `json:"delta"`
}

// CompleteInput marks a task completed or reopens it.
type CompleteInput struct {
	ID        string `json:"id"`
	Completed bool   `json:"completed"`
}

// ReorderInput reorders tasks. When Kind is omitted (or "task"), IDs reorder
// across the unified flat task list directly; when Kind is specified, IDs
// reorder all tasks within that kind for backward compatibility.
type ReorderInput struct {
	Kind TaskKind `json:"kind,omitempty"`
	IDs  []string `json:"ids"`
}

type storedTask struct {
	ID           string          `json:"id"`
	Kind         TaskKind        `json:"kind"`
	Title        string          `json:"title"`
	Status       TaskStatus      `json:"status"`
	Items        []TaskItem      `json:"items"`
	Quota        *TaskQuota      `json:"quota,omitempty"`
	Recurrence   *TaskRecurrence `json:"recurrence,omitempty"`
	PeriodKey    string          `json:"periodKey,omitempty"`
	Deadline     string          `json:"deadline,omitempty"`
	ScheduledFor string          `json:"scheduledFor,omitempty"`
	Order        int             `json:"order"`
	CreatedAt    int64           `json:"createdAt"`
	CompletedAt  *int64          `json:"completedAt,omitempty"`
}

type persistedState struct {
	SchemaVersion int                 `json:"schemaVersion"`
	LastPeriodKey string              `json:"lastPeriodKey"`
	Tasks         []storedTask        `json:"tasks"`
	History       map[string][]string `json:"history"`
}

// Option customizes Service creation.
type Option func(*options)

type options struct {
	dayStartHour int
	idGen        func() string
}

// WithDayStartHour sets the initial dayStartHour (0..23, default 4).
func WithDayStartHour(hour int) Option {
	return func(o *options) {
		o.dayStartHour = hour
	}
}

// WithIDGenerator overrides UUID generation for deterministic tests.
func WithIDGenerator(fn func() string) Option {
	return func(o *options) {
		if fn != nil {
			o.idGen = fn
		}
	}
}

type listenerEntry struct {
	id uint64
	fn func(ListResult)
}

// Service manages tasks, free-order items, quotas, streaks, and dayStartHour
// period rollovers with monotonic rollback protection and sleep recovery.
type Service struct {
	mu            sync.Mutex
	store         *store.Store
	clk           clock.Clock
	idGen         func() string
	dayStartHour  int
	lastPeriodKey string
	tasks         []storedTask
	history       map[string][]string
	closed        bool
	timerGen      uint64
	stopTimer     clock.StopFunc
	nextListener  uint64
	listeners     []listenerEntry
}

// PeriodKey computes the YYYY-MM-DD period key by shifting t backward by
// dayStartHour hours in t's timezone.
func PeriodKey(t time.Time, dayStartHour int) string {
	shifted := t.Add(-time.Duration(dayStartHour) * time.Hour)
	return shifted.Format("2006-01-02")
}

// NextBoundary returns the next wall-clock instant strictly after t where
// PeriodKey transitions to the following calendar day.
func NextBoundary(t time.Time, dayStartHour int) time.Time {
	shift := time.Duration(dayStartHour) * time.Hour
	shifted := t.Add(-shift)
	y, m, d := shifted.Date()
	nextMidnight := time.Date(y, m, d+1, 0, 0, 0, 0, t.Location())
	boundary := nextMidnight.Add(shift)
	if !boundary.After(t) {
		boundary = time.Date(y, m, d+2, 0, 0, 0, 0, t.Location()).Add(shift)
	}
	return boundary
}

// PreviousDay returns the YYYY-MM-DD calendar date immediately preceding key.
func PreviousDay(key string) string {
	t, err := time.ParseInLocation("2006-01-02", key, time.UTC)
	if err != nil {
		return ""
	}
	return t.AddDate(0, 0, -1).Format("2006-01-02")
}

// WeekdayOf returns the day of week (0=Sunday .. 6=Saturday) for a YYYY-MM-DD date.
func WeekdayOf(key string) int {
	t, err := time.ParseInLocation("2006-01-02", key, time.UTC)
	if err != nil {
		return -1
	}
	return int(t.Weekday())
}

// Open loads tasks from st, runs startup period rollover if needed, and
// schedules the next dayStartHour rollover timer via clk.
// Corrupt storage files return store/corrupt without modifying disk.
func Open(st *store.Store, clk clock.Clock, opts ...Option) (*Service, error) {
	if st == nil {
		return nil, store.NewError(ErrCodeInvalidInput, "store is required", nil)
	}
	if clk == nil {
		clk = clock.NewReal()
	}
	cfg := options{
		dayStartHour: DefaultDayStartHour,
		idGen:        store.NewID,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	if cfg.dayStartHour < 0 || cfg.dayStartHour > 23 {
		return nil, store.NewError(ErrCodeInvalidInput, fmt.Sprintf("invalid dayStartHour %d: must be in 0..23", cfg.dayStartHour), nil)
	}

	svc := &Service{
		store:         st,
		clk:           clk,
		idGen:         cfg.idGen,
		dayStartHour:  cfg.dayStartHour,
		lastPeriodKey: PeriodKey(clk.Now(), cfg.dayStartHour),
		tasks:         []storedTask{},
		history:       make(map[string][]string),
	}

	var doc persistedState
	found, err := st.ReadJSON(FileName, &doc)
	if err != nil {
		return nil, err
	}
	if found {
		lastKey, loadedTasks, loadedHistory, err := validatePersisted(doc)
		if err != nil {
			return nil, err
		}
		svc.lastPeriodKey = lastKey
		svc.tasks = loadedTasks
		svc.history = loadedHistory
	}

	if _, err := svc.rolloverLocked(); err != nil {
		return nil, err
	}
	svc.scheduleRolloverLocked()
	return svc, nil
}

// Close cancels any scheduled rollover timer and marks the service closed.
func (s *Service) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	s.timerGen++
	if s.stopTimer != nil {
		s.stopTimer()
		s.stopTimer = nil
	}
}

// OnChange subscribes to task mutations and period rollovers.
func (s *Service) OnChange(fn func(ListResult)) func() {
	if fn == nil {
		return func() {}
	}
	s.mu.Lock()
	s.nextListener++
	id := s.nextListener
	s.listeners = append(s.listeners, listenerEntry{id: id, fn: fn})
	s.mu.Unlock()

	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		for i, entry := range s.listeners {
			if entry.id == id {
				s.listeners = append(s.listeners[:i], s.listeners[i+1:]...)
				return
			}
		}
	}
}

// SetDayStartHour updates the dayStartHour (0..23), checks monotonic rollover,
// reschedules the boundary timer, and notifies listeners.
// If the new hour moves the period backwards, daily progress and lastPeriodKey
// are preserved (monotonic rollback protection).
func (s *Service) SetDayStartHour(hour int) error {
	if hour < 0 || hour > 23 {
		return store.NewError(ErrCodeInvalidInput, fmt.Sprintf("invalid dayStartHour %d: must be in 0..23", hour), nil)
	}
	s.mu.Lock()
	prev := s.dayStartHour
	s.dayStartHour = hour
	rolled, err := s.rolloverLocked()
	if err != nil {
		s.dayStartHour = prev
		s.mu.Unlock()
		return err
	}
	s.scheduleRolloverLocked()
	var res ListResult
	var listeners []func(ListResult)
	if rolled || prev != hour {
		res = s.buildListResultLocked()
		listeners = s.snapshotListenersLocked()
	}
	s.mu.Unlock()

	notifyListeners(listeners, res)
	return nil
}

// List checks for sleep-missed rollover and returns the current periodKey along
// with all tasks sorted by Order ascending.
func (s *Service) List() (ListResult, error) {
	s.mu.Lock()
	rolled, err := s.rolloverLocked()
	if err != nil {
		s.mu.Unlock()
		return ListResult{}, err
	}
	res := s.buildListResultLocked()
	var listeners []func(ListResult)
	if rolled {
		listeners = s.snapshotListenersLocked()
	}
	s.mu.Unlock()

	notifyListeners(listeners, res)
	return cloneListResult(res), nil
}

// Get checks for sleep-missed rollover and returns a single task by ID.
func (s *Service) Get(id string) (Task, error) {
	s.mu.Lock()
	rolled, err := s.rolloverLocked()
	if err != nil {
		s.mu.Unlock()
		return Task{}, err
	}
	res, listeners := s.rolledNotifyLocked(rolled)

	idx := s.indexOfLocked(strings.TrimSpace(id))
	if idx < 0 {
		s.mu.Unlock()
		notifyListeners(listeners, res)
		return Task{}, store.NewError(ErrCodeNotFound, fmt.Sprintf("task %q not found", id), nil)
	}
	view := s.deriveTaskLocked(s.tasks[idx], s.clk.Now())
	s.mu.Unlock()

	notifyListeners(listeners, res)
	return view, nil
}

// Create validates and creates a new task. In the flat task model, omitting
// Kind (or passing "task") defaults to KindSide, or KindDaily when Recurrence
// is provided. Legacy kinds ("main", "side", "daily") remain accepted.
func (s *Service) Create(in CreateInput) (Task, error) {
	s.mu.Lock()
	rolled, err := s.rolloverLocked()
	if err != nil {
		s.mu.Unlock()
		return Task{}, err
	}

	fail := func(err error) (Task, error) {
		res, listeners := s.rolledNotifyLocked(rolled)
		s.mu.Unlock()
		notifyListeners(listeners, res)
		return Task{}, err
	}

	kind := TaskKind(strings.TrimSpace(string(in.Kind)))
	switch {
	case kind == "" || kind == KindTask:
		if in.Recurrence != nil {
			kind = KindDaily
		} else {
			kind = KindSide
		}
	case isValidKind(kind):
		if in.Recurrence != nil {
			kind = KindDaily
		}
	default:
		return fail(store.NewError(ErrCodeInvalidInput, fmt.Sprintf("invalid task kind %q", in.Kind), nil))
	}
	title, err := validateTitle(in.Title)
	if err != nil {
		return fail(err)
	}

	var deadline string
	if strings.TrimSpace(in.Deadline) != "" {
		deadline, err = validateDateKey(in.Deadline)
		if err != nil {
			return fail(err)
		}
	}
	var scheduledFor string
	if strings.TrimSpace(in.ScheduledFor) != "" {
		scheduledFor, err = validateDateKey(in.ScheduledFor)
		if err != nil {
			return fail(err)
		}
	}

	var quota *TaskQuota
	if in.QuotaTarget != nil {
		if *in.QuotaTarget < 1 {
			return fail(store.NewError(ErrCodeInvalidInput, "quotaTarget must be a positive integer", nil))
		}
		quota = &TaskQuota{Current: 0, Target: *in.QuotaTarget}
	}

	var rec *TaskRecurrence
	var periodKey string
	items := make([]TaskItem, 0, len(in.Items))

	if kind == KindDaily {
		if in.Recurrence == nil {
			rec = &TaskRecurrence{Freq: FreqDaily}
		} else {
			rec, err = validateRecurrence(*in.Recurrence)
			if err != nil {
				return fail(err)
			}
		}
		// Use lastPeriodKey so daily creation honors monotonic rollback protection.
		periodKey = s.lastPeriodKey
	}

	for _, itemIn := range in.Items {
		text, err := validateItemText(itemIn.Text)
		if err != nil {
			return fail(err)
		}
		item := TaskItem{
			ID:   s.idGen(),
			Text: text,
			Done: false,
		}
		if itemIn.Target != nil {
			if *itemIn.Target < 1 {
				return fail(store.NewError(ErrCodeInvalidInput, "item target must be a positive integer", nil))
			}
			zero := 0
			tgt := *itemIn.Target
			item.Current = &zero
			item.Target = &tgt
		}
		items = append(items, item)
	}

	now := s.clk.Now()
	nowMs := now.UnixMilli()

	// Append at the end of the flat task list so newly created tasks do not
	// collide in Order regardless of recurrence state.
	order := 0
	for _, existing := range s.tasks {
		if existing.Order >= order {
			order = existing.Order + 1
		}
	}

	task := storedTask{
		ID:           s.idGen(),
		Kind:         kind,
		Title:        title,
		Status:       StatusActive,
		Items:        items,
		Quota:        quota,
		Recurrence:   rec,
		PeriodKey:    periodKey,
		Deadline:     deadline,
		ScheduledFor: scheduledFor,
		Order:        order,
		CreatedAt:    nowMs,
	}

	draftTasks := cloneStoredTasks(s.tasks)
	draftTasks = append(draftTasks, task)
	if err := s.persistLocked(s.lastPeriodKey, draftTasks, s.history); err != nil {
		return fail(err)
	}
	s.tasks = draftTasks
	res := s.buildListResultLocked()
	listeners := s.snapshotListenersLocked()
	view := s.deriveTaskLocked(task, now)
	s.mu.Unlock()

	notifyListeners(listeners, res)
	return view, nil
}

// Update modifies a task's title, quotaTarget, recurrence, deadline, scheduledFor,
// or status.
func (s *Service) Update(in UpdateInput) (Task, error) {
	s.mu.Lock()
	rolled, err := s.rolloverLocked()
	if err != nil {
		s.mu.Unlock()
		return Task{}, err
	}

	fail := func(err error) (Task, error) {
		res, listeners := s.rolledNotifyLocked(rolled)
		s.mu.Unlock()
		notifyListeners(listeners, res)
		return Task{}, err
	}

	idx := s.indexOfLocked(strings.TrimSpace(in.ID))
	if idx < 0 {
		return fail(store.NewError(ErrCodeNotFound, fmt.Sprintf("task %q not found", in.ID), nil))
	}

	now := s.clk.Now()
	nowMs := now.UnixMilli()
	draftTasks := cloneStoredTasks(s.tasks)
	draftHistory := cloneHistory(s.history)
	t := &draftTasks[idx]
	changed := false

	if in.Title != nil {
		title, err := validateTitle(*in.Title)
		if err != nil {
			return fail(err)
		}
		if title != t.Title {
			t.Title = title
			changed = true
		}
	}

	if in.ClearRecurrence {
		if t.Kind == KindDaily || t.Recurrence != nil || t.PeriodKey != "" {
			t.Recurrence = nil
			t.PeriodKey = ""
			t.Kind = KindSide
			changed = true
		}
	} else if in.Recurrence != nil {
		rec, err := validateRecurrence(*in.Recurrence)
		if err != nil {
			return fail(err)
		}
		if t.Kind != KindDaily {
			t.Kind = KindDaily
			t.Recurrence = rec
			t.PeriodKey = s.lastPeriodKey
			// Sync today's daily history with the task's current completion state so
			// streak stays accurate immediately after enabling recurrence.
			if t.Status == StatusCompleted && t.CompletedAt != nil &&
				PeriodKey(time.UnixMilli(*t.CompletedAt).In(now.Location()), s.dayStartHour) == s.lastPeriodKey {
				setHistoryDay(draftHistory, t.ID, s.lastPeriodKey, true)
			} else if t.Status != StatusCompleted {
				setHistoryDay(draftHistory, t.ID, s.lastPeriodKey, false)
			}
			changed = true
		} else if !recurrenceEqual(t.Recurrence, rec) {
			t.Recurrence = rec
			changed = true
		}
	}

	if in.ClearQuota {
		if t.Quota != nil {
			t.Quota = nil
			changed = true
		}
	} else if in.QuotaTarget != nil {
		if *in.QuotaTarget < 1 {
			return fail(store.NewError(ErrCodeInvalidInput, "quotaTarget must be a positive integer", nil))
		}
		if t.Quota == nil {
			t.Quota = &TaskQuota{Current: 0, Target: *in.QuotaTarget}
			changed = true
		} else if t.Quota.Target != *in.QuotaTarget {
			t.Quota.Target = *in.QuotaTarget
			changed = true
		}
		if t.Status != StatusArchived {
			reconcileCompletionFromProgress(t, draftHistory, s.lastPeriodKey, nowMs)
		}
	}

	if in.ClearDeadline {
		if t.Deadline != "" {
			t.Deadline = ""
			changed = true
		}
	} else if in.Deadline != nil {
		if strings.TrimSpace(*in.Deadline) == "" {
			if t.Deadline != "" {
				t.Deadline = ""
				changed = true
			}
		} else {
			d, err := validateDateKey(*in.Deadline)
			if err != nil {
				return fail(err)
			}
			if d != t.Deadline {
				t.Deadline = d
				changed = true
			}
		}
	}

	if in.ClearScheduledFor {
		if t.ScheduledFor != "" {
			t.ScheduledFor = ""
			changed = true
		}
	} else if in.ScheduledFor != nil {
		if strings.TrimSpace(*in.ScheduledFor) == "" {
			if t.ScheduledFor != "" {
				t.ScheduledFor = ""
				changed = true
			}
		} else {
			d, err := validateDateKey(*in.ScheduledFor)
			if err != nil {
				return fail(err)
			}
			if d != t.ScheduledFor {
				t.ScheduledFor = d
				changed = true
			}
		}
	}

	if in.Status != nil {
		if !isValidStatus(*in.Status) {
			return fail(store.NewError(ErrCodeInvalidInput, fmt.Sprintf("invalid status %q", *in.Status), nil))
		}
		if *in.Status != t.Status {
			applyStatusChange(t, *in.Status, draftHistory, s.lastPeriodKey, nowMs)
			changed = true
		}
	}

	if !changed {
		view := s.deriveTaskLocked(s.tasks[idx], now)
		res, listeners := s.rolledNotifyLocked(rolled)
		s.mu.Unlock()
		notifyListeners(listeners, res)
		return view, nil
	}

	if err := s.persistLocked(s.lastPeriodKey, draftTasks, draftHistory); err != nil {
		return fail(err)
	}
	s.tasks = draftTasks
	s.history = draftHistory
	res := s.buildListResultLocked()
	listeners := s.snapshotListenersLocked()
	view := s.deriveTaskLocked(s.tasks[idx], now)
	s.mu.Unlock()

	notifyListeners(listeners, res)
	return view, nil
}

// SetItems replaces the free-order checklist items on a task (main, side, or
// daily) while preserving progress for items with matching IDs.
func (s *Service) SetItems(in SetItemsInput) (Task, error) {
	s.mu.Lock()
	rolled, err := s.rolloverLocked()
	if err != nil {
		s.mu.Unlock()
		return Task{}, err
	}

	fail := func(err error) (Task, error) {
		res, listeners := s.rolledNotifyLocked(rolled)
		s.mu.Unlock()
		notifyListeners(listeners, res)
		return Task{}, err
	}

	idx := s.indexOfLocked(strings.TrimSpace(in.ID))
	if idx < 0 {
		return fail(store.NewError(ErrCodeNotFound, fmt.Sprintf("task %q not found", in.ID), nil))
	}
	existing := s.tasks[idx]
	if existing.Status == StatusArchived {
		return fail(store.NewError(ErrCodeInvalidInput, "archived tasks cannot be modified", nil))
	}

	prevByID := make(map[string]TaskItem, len(existing.Items))
	for _, it := range existing.Items {
		prevByID[it.ID] = it
	}
	seenIDs := make(map[string]struct{}, len(in.Items))
	nextItems := make([]TaskItem, 0, len(in.Items))

	for _, draft := range in.Items {
		text, err := validateItemText(draft.Text)
		if err != nil {
			return fail(err)
		}
		itemID := strings.TrimSpace(draft.ID)
		if itemID == "" {
			itemID = s.idGen()
		}
		if _, dup := seenIDs[itemID]; dup {
			return fail(store.NewError(ErrCodeInvalidInput, fmt.Sprintf("duplicate item id %q", itemID), nil))
		}
		seenIDs[itemID] = struct{}{}

		prev, hadPrev := prevByID[itemID]
		item := TaskItem{
			ID:   itemID,
			Text: text,
		}

		if draft.Target != nil {
			if *draft.Target < 1 {
				return fail(store.NewError(ErrCodeInvalidInput, "item target must be a positive integer", nil))
			}
			tgt := *draft.Target
			cur := 0
			if draft.Current != nil {
				if *draft.Current < 0 {
					return fail(store.NewError(ErrCodeInvalidInput, "item current must be non-negative", nil))
				}
				cur = *draft.Current
			} else if hadPrev && prev.Current != nil {
				cur = *prev.Current
			}
			done := cur >= tgt
			if draft.Done != nil {
				done = *draft.Done
				if done && cur < tgt {
					cur = tgt
				}
				if !done && cur >= tgt {
					cur = maxInt(0, tgt-1)
				}
			}
			item.Current = &cur
			item.Target = &tgt
			item.Done = done
		} else {
			if draft.Current != nil {
				return fail(store.NewError(ErrCodeInvalidInput, "item current requires target", nil))
			}
			if draft.Done != nil {
				item.Done = *draft.Done
			} else if hadPrev {
				item.Done = prev.Done
			}
		}
		nextItems = append(nextItems, item)
	}

	now := s.clk.Now()
	nowMs := now.UnixMilli()
	draftTasks := cloneStoredTasks(s.tasks)
	draftHistory := cloneHistory(s.history)
	draftTasks[idx].Items = nextItems
	reconcileCompletionFromProgress(&draftTasks[idx], draftHistory, s.lastPeriodKey, nowMs)

	if err := s.persistLocked(s.lastPeriodKey, draftTasks, draftHistory); err != nil {
		return fail(err)
	}
	s.tasks = draftTasks
	s.history = draftHistory
	res := s.buildListResultLocked()
	listeners := s.snapshotListenersLocked()
	view := s.deriveTaskLocked(s.tasks[idx], now)
	s.mu.Unlock()

	notifyListeners(listeners, res)
	return view, nil
}

// ToggleItem toggles (or sets) any checklist item on a task in any order —
// there is NO sequential objective lock.
func (s *Service) ToggleItem(in ToggleItemInput) (Task, error) {
	s.mu.Lock()
	rolled, err := s.rolloverLocked()
	if err != nil {
		s.mu.Unlock()
		return Task{}, err
	}

	fail := func(err error) (Task, error) {
		res, listeners := s.rolledNotifyLocked(rolled)
		s.mu.Unlock()
		notifyListeners(listeners, res)
		return Task{}, err
	}

	idx := s.indexOfLocked(strings.TrimSpace(in.TaskID))
	if idx < 0 {
		return fail(store.NewError(ErrCodeNotFound, fmt.Sprintf("task %q not found", in.TaskID), nil))
	}
	if s.tasks[idx].Status == StatusArchived {
		return fail(store.NewError(ErrCodeInvalidInput, "archived tasks cannot be progressed", nil))
	}

	itemID := strings.TrimSpace(in.ItemID)
	itemIdx := -1
	for i, it := range s.tasks[idx].Items {
		if it.ID == itemID {
			itemIdx = i
			break
		}
	}
	if itemIdx < 0 {
		return fail(store.NewError(ErrCodeNotFound, fmt.Sprintf("item %q not found", in.ItemID), nil))
	}

	now := s.clk.Now()
	nowMs := now.UnixMilli()
	draftTasks := cloneStoredTasks(s.tasks)
	draftHistory := cloneHistory(s.history)
	t := &draftTasks[idx]
	it := &t.Items[itemIdx]

	nextDone := !it.Done
	if in.Done != nil {
		nextDone = *in.Done
	}
	if it.Done == nextDone {
		view := s.deriveTaskLocked(s.tasks[idx], now)
		res, listeners := s.rolledNotifyLocked(rolled)
		s.mu.Unlock()
		notifyListeners(listeners, res)
		return view, nil
	}

	it.Done = nextDone
	if it.Target != nil {
		cur := 0
		if it.Current != nil {
			cur = *it.Current
		}
		if nextDone && cur < *it.Target {
			cur = *it.Target
		} else if !nextDone && cur >= *it.Target {
			// Preserve accumulated progress instead of resetting to 0.
			cur = maxInt(0, *it.Target-1)
		}
		it.Current = &cur
	}

	reconcileCompletionFromProgress(t, draftHistory, s.lastPeriodKey, nowMs)

	if err := s.persistLocked(s.lastPeriodKey, draftTasks, draftHistory); err != nil {
		return fail(err)
	}
	s.tasks = draftTasks
	s.history = draftHistory
	res := s.buildListResultLocked()
	listeners := s.snapshotListenersLocked()
	view := s.deriveTaskLocked(s.tasks[idx], now)
	s.mu.Unlock()

	notifyListeners(listeners, res)
	return view, nil
}

// StepQuota adjusts a task's or item's quota by delta (e.g. +1 or -1),
// clamping at 0 on the low end and target when incrementing, and automatically
// completing or reopening the item/task as thresholds are crossed.
func (s *Service) StepQuota(in StepQuotaInput) (Task, error) {
	s.mu.Lock()
	rolled, err := s.rolloverLocked()
	if err != nil {
		s.mu.Unlock()
		return Task{}, err
	}

	fail := func(err error) (Task, error) {
		res, listeners := s.rolledNotifyLocked(rolled)
		s.mu.Unlock()
		notifyListeners(listeners, res)
		return Task{}, err
	}

	if in.Delta == 0 {
		return fail(store.NewError(ErrCodeInvalidInput, "delta must be non-zero", nil))
	}

	idx := s.indexOfLocked(strings.TrimSpace(in.ID))
	if idx < 0 {
		return fail(store.NewError(ErrCodeNotFound, fmt.Sprintf("task %q not found", in.ID), nil))
	}
	if s.tasks[idx].Status == StatusArchived {
		return fail(store.NewError(ErrCodeInvalidInput, "archived tasks cannot be progressed", nil))
	}

	now := s.clk.Now()
	nowMs := now.UnixMilli()
	draftTasks := cloneStoredTasks(s.tasks)
	draftHistory := cloneHistory(s.history)
	t := &draftTasks[idx]
	changed := false

	itemID := strings.TrimSpace(in.ItemID)
	if itemID != "" {
		itemIdx := -1
		for i, it := range t.Items {
			if it.ID == itemID {
				itemIdx = i
				break
			}
		}
		if itemIdx < 0 {
			return fail(store.NewError(ErrCodeNotFound, fmt.Sprintf("item %q not found", in.ItemID), nil))
		}
		it := &t.Items[itemIdx]
		if it.Target == nil {
			return fail(store.NewError(ErrCodeInvalidInput, "item does not have a quota", nil))
		}
		cur := 0
		if it.Current != nil {
			cur = *it.Current
		}
		next := stepValue(cur, *it.Target, in.Delta)
		if next != cur || it.Done != (next >= *it.Target) {
			it.Current = &next
			it.Done = next >= *it.Target
			changed = true
		}
	} else {
		if t.Quota == nil {
			return fail(store.NewError(ErrCodeInvalidInput, "task does not have a quota", nil))
		}
		next := stepValue(t.Quota.Current, t.Quota.Target, in.Delta)
		if next != t.Quota.Current {
			t.Quota.Current = next
			changed = true
		}
	}

	prevStatus := t.Status
	reconcileCompletionFromProgress(t, draftHistory, s.lastPeriodKey, nowMs)
	if t.Status != prevStatus {
		changed = true
	}

	if !changed {
		view := s.deriveTaskLocked(s.tasks[idx], now)
		res, listeners := s.rolledNotifyLocked(rolled)
		s.mu.Unlock()
		notifyListeners(listeners, res)
		return view, nil
	}

	if err := s.persistLocked(s.lastPeriodKey, draftTasks, draftHistory); err != nil {
		return fail(err)
	}
	s.tasks = draftTasks
	s.history = draftHistory
	res := s.buildListResultLocked()
	listeners := s.snapshotListenersLocked()
	view := s.deriveTaskLocked(s.tasks[idx], now)
	s.mu.Unlock()

	notifyListeners(listeners, res)
	return view, nil
}

// Complete marks a task completed (or reopens it when Completed is false).
func (s *Service) Complete(in CompleteInput) (Task, error) {
	s.mu.Lock()
	rolled, err := s.rolloverLocked()
	if err != nil {
		s.mu.Unlock()
		return Task{}, err
	}

	fail := func(err error) (Task, error) {
		res, listeners := s.rolledNotifyLocked(rolled)
		s.mu.Unlock()
		notifyListeners(listeners, res)
		return Task{}, err
	}

	idx := s.indexOfLocked(strings.TrimSpace(in.ID))
	if idx < 0 {
		return fail(store.NewError(ErrCodeNotFound, fmt.Sprintf("task %q not found", in.ID), nil))
	}
	if s.tasks[idx].Status == StatusArchived {
		return fail(store.NewError(ErrCodeInvalidInput, "archived tasks cannot be progressed", nil))
	}

	now := s.clk.Now()
	nowMs := now.UnixMilli()

	wantStatus := StatusActive
	if in.Completed {
		wantStatus = StatusCompleted
	}
	if s.tasks[idx].Status == wantStatus {
		view := s.deriveTaskLocked(s.tasks[idx], now)
		res, listeners := s.rolledNotifyLocked(rolled)
		s.mu.Unlock()
		notifyListeners(listeners, res)
		return view, nil
	}

	draftTasks := cloneStoredTasks(s.tasks)
	draftHistory := cloneHistory(s.history)
	applyStatusChange(&draftTasks[idx], wantStatus, draftHistory, s.lastPeriodKey, nowMs)

	if err := s.persistLocked(s.lastPeriodKey, draftTasks, draftHistory); err != nil {
		return fail(err)
	}
	s.tasks = draftTasks
	s.history = draftHistory
	res := s.buildListResultLocked()
	listeners := s.snapshotListenersLocked()
	view := s.deriveTaskLocked(s.tasks[idx], now)
	s.mu.Unlock()

	notifyListeners(listeners, res)
	return view, nil
}

// Delete permanently removes a task and its completion history.
// Callers coordinating cross-domain hooks should invoke notes.DetachTask(id).
func (s *Service) Delete(id string) error {
	s.mu.Lock()
	rolled, err := s.rolloverLocked()
	if err != nil {
		s.mu.Unlock()
		return err
	}

	idx := s.indexOfLocked(strings.TrimSpace(id))
	if idx < 0 {
		res, listeners := s.rolledNotifyLocked(rolled)
		s.mu.Unlock()
		notifyListeners(listeners, res)
		return store.NewError(ErrCodeNotFound, fmt.Sprintf("task %q not found", id), nil)
	}

	draftTasks := cloneStoredTasks(s.tasks)
	removedID := draftTasks[idx].ID
	draftTasks = append(draftTasks[:idx], draftTasks[idx+1:]...)

	// Compact orders stably across all remaining tasks.
	indices := make([]int, len(draftTasks))
	for i := range draftTasks {
		indices[i] = i
	}
	sort.SliceStable(indices, func(a, b int) bool {
		return lessStoredTask(draftTasks[indices[a]], draftTasks[indices[b]])
	})
	for ord, i := range indices {
		draftTasks[i].Order = ord
	}

	draftHistory := cloneHistory(s.history)
	delete(draftHistory, removedID)

	if err := s.persistLocked(s.lastPeriodKey, draftTasks, draftHistory); err != nil {
		res, listeners := s.rolledNotifyLocked(rolled)
		s.mu.Unlock()
		notifyListeners(listeners, res)
		return err
	}
	s.tasks = draftTasks
	s.history = draftHistory
	res := s.buildListResultLocked()
	listeners := s.snapshotListenersLocked()
	s.mu.Unlock()

	notifyListeners(listeners, res)
	return nil
}

// Reorder updates task order and returns all tasks in canonical display order.
// When in.Kind is omitted (or "task"), tasks in in.IDs are reordered directly
// across the flat task list (any unlisted tasks keep their relative order after
// them). When in.Kind is "main", "side", or "daily", in.IDs must match all
// tasks of that kind for backward compatibility.
func (s *Service) Reorder(in ReorderInput) ([]Task, error) {
	s.mu.Lock()
	rolled, err := s.rolloverLocked()
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}

	fail := func(err error) ([]Task, error) {
		res, listeners := s.rolledNotifyLocked(rolled)
		s.mu.Unlock()
		notifyListeners(listeners, res)
		return nil, err
	}

	kind := TaskKind(strings.TrimSpace(string(in.Kind)))
	draftTasks := cloneStoredTasks(s.tasks)
	changed := false

	if kind == "" || kind == KindTask {
		byID := make(map[string]int, len(s.tasks))
		for i, t := range s.tasks {
			byID[t.ID] = i
		}
		seen := make(map[string]struct{}, len(in.IDs))
		orderedIndices := make([]int, 0, len(s.tasks))

		for _, rawID := range in.IDs {
			id := strings.TrimSpace(rawID)
			if _, dup := seen[id]; dup {
				return fail(store.NewError(ErrCodeInvalidInput, fmt.Sprintf("duplicate task id %q", id), nil))
			}
			idx, ok := byID[id]
			if !ok {
				return fail(store.NewError(ErrCodeNotFound, fmt.Sprintf("task %q not found", rawID), nil))
			}
			seen[id] = struct{}{}
			orderedIndices = append(orderedIndices, idx)
		}

		var rest []int
		for i, t := range s.tasks {
			if _, ok := seen[t.ID]; !ok {
				rest = append(rest, i)
			}
		}
		sort.SliceStable(rest, func(a, b int) bool {
			return lessStoredTask(s.tasks[rest[a]], s.tasks[rest[b]])
		})
		orderedIndices = append(orderedIndices, rest...)

		for newOrder, idx := range orderedIndices {
			if draftTasks[idx].Order != newOrder {
				draftTasks[idx].Order = newOrder
				changed = true
			}
		}
	} else {
		if !isValidKind(kind) {
			return fail(store.NewError(ErrCodeInvalidInput, fmt.Sprintf("invalid task kind %q", in.Kind), nil))
		}

		kindTasks := make(map[string]int)
		existingOrders := make([]int, 0)
		for i, t := range s.tasks {
			if t.Kind == kind {
				kindTasks[t.ID] = i
				existingOrders = append(existingOrders, t.Order)
			}
		}
		if len(in.IDs) != len(kindTasks) {
			return fail(store.NewError(ErrCodeInvalidInput, "reorder ids must match all tasks of the specified kind", nil))
		}

		sort.Ints(existingOrders)
		useExistingSlots := len(existingOrders) > 0
		for i := 1; i < len(existingOrders); i++ {
			if existingOrders[i] <= existingOrders[i-1] {
				useExistingSlots = false
				break
			}
		}

		seen := make(map[string]struct{}, len(in.IDs))
		for pos, rawID := range in.IDs {
			id := strings.TrimSpace(rawID)
			if _, dup := seen[id]; dup {
				return fail(store.NewError(ErrCodeInvalidInput, fmt.Sprintf("duplicate task id %q", id), nil))
			}
			idx, ok := kindTasks[id]
			if !ok {
				return fail(store.NewError(ErrCodeNotFound, fmt.Sprintf("task %q not found in kind %q", rawID, kind), nil))
			}
			seen[id] = struct{}{}
			newOrder := pos
			if useExistingSlots {
				newOrder = existingOrders[pos]
			}
			if draftTasks[idx].Order != newOrder {
				draftTasks[idx].Order = newOrder
				changed = true
			}
		}
	}

	if !changed {
		res := s.buildListResultLocked()
		var listeners []func(ListResult)
		if rolled {
			listeners = s.snapshotListenersLocked()
		}
		s.mu.Unlock()
		notifyListeners(listeners, res)
		return cloneTasks(res.Tasks), nil
	}

	if err := s.persistLocked(s.lastPeriodKey, draftTasks, s.history); err != nil {
		return fail(err)
	}
	s.tasks = draftTasks
	res := s.buildListResultLocked()
	listeners := s.snapshotListenersLocked()
	s.mu.Unlock()

	notifyListeners(listeners, res)
	return cloneTasks(res.Tasks), nil
}

// rolloverLocked checks whether the current clock period has moved strictly past
// lastPeriodKey. If current <= lastPeriodKey (monotonic rollback protection),
// daily tasks and lastPeriodKey are preserved untouched.
func (s *Service) rolloverLocked() (bool, error) {
	current := PeriodKey(s.clk.Now(), s.dayStartHour)
	if current <= s.lastPeriodKey {
		return false, nil
	}

	draftTasks := cloneStoredTasks(s.tasks)
	for i := range draftTasks {
		if draftTasks[i].Kind != KindDaily {
			continue
		}
		draftTasks[i].PeriodKey = current
		if draftTasks[i].Status != StatusArchived {
			draftTasks[i].Status = StatusActive
			draftTasks[i].CompletedAt = nil
		}
		if draftTasks[i].Quota != nil {
			draftTasks[i].Quota.Current = 0
		}
		for j := range draftTasks[i].Items {
			draftTasks[i].Items[j].Done = false
			if draftTasks[i].Items[j].Target != nil {
				zero := 0
				draftTasks[i].Items[j].Current = &zero
			}
		}
	}

	if err := s.persistLocked(current, draftTasks, s.history); err != nil {
		return false, err
	}
	s.tasks = draftTasks
	s.lastPeriodKey = current
	s.scheduleRolloverLocked()
	return true, nil
}

func (s *Service) scheduleRolloverLocked() {
	now := s.clk.Now()
	delay := NextBoundary(now, s.dayStartHour).Sub(now)
	if delay < 0 {
		delay = 0
	}
	s.scheduleRolloverAfterLocked(delay)
}

func (s *Service) scheduleRolloverAfterLocked(delay time.Duration) {
	s.timerGen++
	if s.stopTimer != nil {
		s.stopTimer()
		s.stopTimer = nil
	}
	if s.closed {
		return
	}
	gen := s.timerGen
	s.stopTimer = s.clk.AfterFunc(delay, func() {
		s.onRolloverTimer(gen)
	})
}

func (s *Service) onRolloverTimer(gen uint64) {
	s.mu.Lock()
	if s.closed || gen != s.timerGen {
		s.mu.Unlock()
		return
	}
	rolled, err := s.rolloverLocked()
	if err != nil {
		// Retry after a non-zero backoff so transient disk errors recover cleanly without spinning.
		s.scheduleRolloverAfterLocked(errorRetryBackoff)
		s.mu.Unlock()
		return
	}
	if !rolled {
		// Always reschedule so clock rollback or DST shift doesn't leave timer stopped.
		s.scheduleRolloverLocked()
		s.mu.Unlock()
		return
	}
	res := s.buildListResultLocked()
	listeners := s.snapshotListenersLocked()
	s.mu.Unlock()

	notifyListeners(listeners, res)
}

func (s *Service) buildListResultLocked() ListResult {
	now := s.clk.Now()
	current := PeriodKey(now, s.dayStartHour)

	ordered := cloneStoredTasks(s.tasks)
	sort.SliceStable(ordered, func(i, j int) bool {
		return lessStoredTask(ordered[i], ordered[j])
	})

	views := make([]Task, len(ordered))
	for i, st := range ordered {
		views[i] = s.deriveTaskLocked(st, now)
	}
	return ListResult{
		PeriodKey: current,
		Tasks:     views,
	}
}

func (s *Service) deriveTaskLocked(st storedTask, now time.Time) Task {
	currentPeriod := PeriodKey(now, s.dayStartHour)
	out := Task{
		ID:           st.ID,
		Kind:         st.Kind,
		Title:        st.Title,
		Status:       st.Status,
		Items:        cloneItems(st.Items),
		Quota:        cloneQuota(st.Quota),
		Recurrence:   cloneRecurrence(st.Recurrence),
		Deadline:     st.Deadline,
		ScheduledFor: st.ScheduledFor,
		Order:        st.Order,
		CreatedAt:    st.CreatedAt,
		CompletedAt:  cloneInt64Ptr(st.CompletedAt),
	}

	if st.Kind == KindDaily {
		effKey := s.lastPeriodKey
		out.PeriodKey = effKey
		streak := computeStreak(st, s.history[st.ID], effKey, s.dayStartHour, now.Location())
		out.Streak = &streak
		out.DueToday = st.Status != StatusArchived && isDailyDueOn(st.Recurrence, effKey)
		out.Overdue = false
	} else {
		switch st.Status {
		case StatusActive:
			out.DueToday = (st.ScheduledFor != "" && st.ScheduledFor <= currentPeriod) ||
				(st.Deadline != "" && st.Deadline <= currentPeriod)
			out.Overdue = st.Deadline != "" && st.Deadline < currentPeriod
		case StatusCompleted:
			out.DueToday = st.CompletedAt != nil &&
				PeriodKey(time.UnixMilli(*st.CompletedAt).In(now.Location()), s.dayStartHour) == currentPeriod
			out.Overdue = false
		default:
			out.DueToday = false
			out.Overdue = false
		}
	}
	return out
}

func computeStreak(st storedTask, history []string, effKey string, dayStartHour int, loc *time.Location) int {
	doneDays := make(map[string]struct{}, len(history))
	for _, day := range history {
		doneDays[day] = struct{}{}
	}
	streak := 0
	if isDailyDueOn(st.Recurrence, effKey) {
		if _, ok := doneDays[effKey]; ok {
			streak++
		}
	}

	createdKey := PeriodKey(time.UnixMilli(st.CreatedAt).In(loc), dayStartHour)
	earliest := createdKey
	if len(history) > 0 && history[0] < earliest {
		earliest = history[0]
	}

	for day := PreviousDay(effKey); day != "" && day >= earliest; day = PreviousDay(day) {
		if !isDailyDueOn(st.Recurrence, day) {
			continue
		}
		if _, ok := doneDays[day]; !ok {
			break
		}
		streak++
	}
	return streak
}

func isDailyDueOn(rec *TaskRecurrence, key string) bool {
	if rec == nil {
		return false
	}
	if rec.Freq == FreqDaily {
		return true
	}
	if rec.Freq == FreqWeekly {
		wd := WeekdayOf(key)
		for _, allowed := range rec.Weekdays {
			if allowed == wd {
				return true
			}
		}
	}
	return false
}

func applyStatusChange(t *storedTask, nextStatus TaskStatus, history map[string][]string, lastPeriodKey string, nowMs int64) {
	switch nextStatus {
	case StatusCompleted:
		for i := range t.Items {
			t.Items[i].Done = true
			if t.Items[i].Target != nil {
				cur := 0
				if t.Items[i].Current != nil {
					cur = *t.Items[i].Current
				}
				if cur < *t.Items[i].Target {
					cur = *t.Items[i].Target
				}
				t.Items[i].Current = &cur
			}
		}
		if t.Quota != nil && t.Quota.Current < t.Quota.Target {
			t.Quota.Current = t.Quota.Target
		}
		t.Status = StatusCompleted
		ts := nowMs
		t.CompletedAt = &ts
		if t.Kind == KindDaily {
			t.PeriodKey = lastPeriodKey
			setHistoryDay(history, t.ID, lastPeriodKey, true)
		}
	case StatusActive:
		wasCompleted := t.Status == StatusCompleted
		t.Status = StatusActive
		t.CompletedAt = nil
		if t.Kind == KindDaily {
			t.PeriodKey = lastPeriodKey
			if wasCompleted {
				if t.Quota != nil && t.Quota.Current >= t.Quota.Target {
					t.Quota.Current = maxInt(0, t.Quota.Target-1)
				}
				setHistoryDay(history, t.ID, lastPeriodKey, false)
			} else if hasHistoryDay(history, t.ID, lastPeriodKey) {
				// Restoring an archived daily that was already done in this period.
				t.Status = StatusCompleted
				ts := nowMs
				t.CompletedAt = &ts
			}
		} else if wasCompleted {
			if t.Quota != nil && t.Quota.Current >= t.Quota.Target {
				t.Quota.Current = maxInt(0, t.Quota.Target-1)
			}
		}
	case StatusArchived:
		t.Status = StatusArchived
	}
}

func reconcileCompletionFromProgress(t *storedTask, history map[string][]string, lastPeriodKey string, nowMs int64) {
	if t.Status == StatusArchived {
		return
	}

	hasItems := len(t.Items) > 0
	hasQuota := t.Quota != nil
	if !hasItems && !hasQuota {
		return
	}

	itemsDone := true
	for _, it := range t.Items {
		if !it.Done {
			itemsDone = false
			break
		}
	}
	quotaDone := !hasQuota || t.Quota.Current >= t.Quota.Target

	if itemsDone && quotaDone {
		if t.Status != StatusCompleted {
			t.Status = StatusCompleted
			ts := nowMs
			t.CompletedAt = &ts
		}
		if t.Kind == KindDaily {
			t.PeriodKey = lastPeriodKey
			setHistoryDay(history, t.ID, lastPeriodKey, true)
		}
	} else {
		if t.Status == StatusCompleted {
			t.Status = StatusActive
			t.CompletedAt = nil
		}
		if t.Kind == KindDaily {
			t.PeriodKey = lastPeriodKey
			setHistoryDay(history, t.ID, lastPeriodKey, false)
		}
	}
}

func stepValue(current, target, delta int) int {
	next := current + delta
	if next < 0 {
		return 0
	}
	if delta > 0 && next > target {
		if current >= target {
			return current
		}
		return target
	}
	return next
}

func setHistoryDay(history map[string][]string, taskID, day string, present bool) {
	days := history[taskID]
	exists := false
	filtered := make([]string, 0, len(days)+1)
	for _, d := range days {
		if d == day {
			exists = true
			if !present {
				continue
			}
		}
		filtered = append(filtered, d)
	}
	if present && !exists {
		filtered = append(filtered, day)
	}
	if len(filtered) == 0 {
		delete(history, taskID)
		return
	}
	sort.Strings(filtered)
	history[taskID] = filtered
}

func hasHistoryDay(history map[string][]string, taskID, day string) bool {
	for _, d := range history[taskID] {
		if d == day {
			return true
		}
	}
	return false
}

func (s *Service) persistLocked(lastPeriodKey string, tasks []storedTask, history map[string][]string) error {
	doc := persistedState{
		SchemaVersion: schemaVersion,
		LastPeriodKey: lastPeriodKey,
		Tasks:         tasks,
		History:       history,
	}
	return s.store.WriteJSON(FileName, doc)
}

func (s *Service) indexOfLocked(id string) int {
	for i := range s.tasks {
		if s.tasks[i].ID == id {
			return i
		}
	}
	return -1
}

func (s *Service) snapshotListenersLocked() []func(ListResult) {
	if len(s.listeners) == 0 {
		return nil
	}
	out := make([]func(ListResult), len(s.listeners))
	for i, l := range s.listeners {
		out[i] = l.fn
	}
	return out
}

func (s *Service) rolledNotifyLocked(rolled bool) (ListResult, []func(ListResult)) {
	if !rolled {
		return ListResult{}, nil
	}
	return s.buildListResultLocked(), s.snapshotListenersLocked()
}

func notifyListeners(listeners []func(ListResult), res ListResult) {
	for _, fn := range listeners {
		fn(cloneListResult(res))
	}
}

func validatePersisted(doc persistedState) (string, []storedTask, map[string][]string, error) {
	if doc.SchemaVersion != schemaVersion {
		return "", nil, nil, store.NewError(store.ErrCodeCorrupt, fmt.Sprintf("unsupported tasks schemaVersion %d", doc.SchemaVersion), nil)
	}
	lastKey, err := validateDateKey(doc.LastPeriodKey)
	if err != nil {
		return "", nil, nil, store.NewError(store.ErrCodeCorrupt, "invalid stored lastPeriodKey", err)
	}

	seen := make(map[string]struct{}, len(doc.Tasks))
	tasks := make([]storedTask, 0, len(doc.Tasks))
	for _, t := range doc.Tasks {
		if strings.TrimSpace(t.ID) == "" {
			return "", nil, nil, store.NewError(store.ErrCodeCorrupt, "stored task missing id", nil)
		}
		if _, dup := seen[t.ID]; dup {
			return "", nil, nil, store.NewError(store.ErrCodeCorrupt, fmt.Sprintf("duplicate task id %q", t.ID), nil)
		}
		seen[t.ID] = struct{}{}
		if !isValidKind(t.Kind) {
			return "", nil, nil, store.NewError(store.ErrCodeCorrupt, fmt.Sprintf("invalid stored task kind %q", t.Kind), nil)
		}
		if !isValidStatus(t.Status) {
			return "", nil, nil, store.NewError(store.ErrCodeCorrupt, fmt.Sprintf("invalid stored task status %q", t.Status), nil)
		}
		if _, err := validateTitle(t.Title); err != nil {
			return "", nil, nil, store.NewError(store.ErrCodeCorrupt, "invalid stored task title", err)
		}
		if t.Kind == KindDaily {
			if t.Recurrence == nil {
				return "", nil, nil, store.NewError(store.ErrCodeCorrupt, "stored daily task missing recurrence", nil)
			}
			if _, err := validateRecurrence(*t.Recurrence); err != nil {
				return "", nil, nil, store.NewError(store.ErrCodeCorrupt, "invalid stored daily recurrence", err)
			}
		} else if t.Recurrence != nil {
			return "", nil, nil, store.NewError(store.ErrCodeCorrupt, "stored non-daily task cannot have recurrence", nil)
		}
		seenItems := make(map[string]struct{}, len(t.Items))
		for _, it := range t.Items {
			if strings.TrimSpace(it.ID) == "" {
				return "", nil, nil, store.NewError(store.ErrCodeCorrupt, "stored task item missing id", nil)
			}
			if _, dup := seenItems[it.ID]; dup {
				return "", nil, nil, store.NewError(store.ErrCodeCorrupt, fmt.Sprintf("duplicate stored task item id %q", it.ID), nil)
			}
			seenItems[it.ID] = struct{}{}
			if _, err := validateItemText(it.Text); err != nil {
				return "", nil, nil, store.NewError(store.ErrCodeCorrupt, "invalid stored task item text", err)
			}
			if it.Target != nil && *it.Target < 1 {
				return "", nil, nil, store.NewError(store.ErrCodeCorrupt, "invalid stored task item target", nil)
			}
			if it.Current != nil && (it.Target == nil || *it.Current < 0) {
				return "", nil, nil, store.NewError(store.ErrCodeCorrupt, "invalid stored task item current", nil)
			}
		}
		if t.Quota != nil && (t.Quota.Target < 1 || t.Quota.Current < 0) {
			return "", nil, nil, store.NewError(store.ErrCodeCorrupt, "invalid stored task quota", nil)
		}
		if t.Deadline != "" {
			if _, err := validateDateKey(t.Deadline); err != nil {
				return "", nil, nil, store.NewError(store.ErrCodeCorrupt, "invalid stored deadline", err)
			}
		}
		if t.ScheduledFor != "" {
			if _, err := validateDateKey(t.ScheduledFor); err != nil {
				return "", nil, nil, store.NewError(store.ErrCodeCorrupt, "invalid stored scheduledFor", err)
			}
		}
		cloned := cloneStoredTask(t)
		if cloned.Items == nil {
			cloned.Items = []TaskItem{}
		}
		tasks = append(tasks, cloned)
	}

	history := make(map[string][]string, len(doc.History))
	for id, days := range doc.History {
		daySet := make(map[string]struct{}, len(days))
		clean := make([]string, 0, len(days))
		for _, d := range days {
			validDay, err := validateDateKey(d)
			if err != nil {
				return "", nil, nil, store.NewError(store.ErrCodeCorrupt, "invalid stored history date", err)
			}
			if _, dup := daySet[validDay]; !dup {
				daySet[validDay] = struct{}{}
				clean = append(clean, validDay)
			}
		}
		sort.Strings(clean)
		if len(clean) > 0 {
			history[id] = clean
		}
	}

	return lastKey, tasks, history, nil
}

func isValidKind(k TaskKind) bool {
	return k == KindMain || k == KindSide || k == KindDaily
}

func isValidStatus(s TaskStatus) bool {
	return s == StatusActive || s == StatusCompleted || s == StatusArchived
}

func kindRank(k TaskKind) int {
	switch k {
	case KindMain:
		return 0
	case KindSide:
		return 1
	default:
		return 2
	}
}

func lessStoredTask(a, b storedTask) bool {
	if a.Order != b.Order {
		return a.Order < b.Order
	}
	ri, rj := kindRank(a.Kind), kindRank(b.Kind)
	if ri != rj {
		return ri < rj
	}
	return a.CreatedAt < b.CreatedAt
}

func validateTitle(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	n := utf8.RuneCountInString(trimmed)
	if n < 1 || n > maxTitleRunes {
		return "", store.NewError(ErrCodeInvalidInput, fmt.Sprintf("title must be 1..%d characters", maxTitleRunes), nil)
	}
	return trimmed, nil
}

func validateItemText(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	n := utf8.RuneCountInString(trimmed)
	if n < 1 || n > maxItemTextRunes {
		return "", store.NewError(ErrCodeInvalidInput, fmt.Sprintf("item text must be 1..%d characters", maxItemTextRunes), nil)
	}
	return trimmed, nil
}

func validateDateKey(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if len(s) != 10 {
		return "", store.NewError(ErrCodeInvalidInput, fmt.Sprintf("invalid date %q: expected YYYY-MM-DD", raw), nil)
	}
	parsed, err := time.ParseInLocation("2006-01-02", s, time.UTC)
	if err != nil || parsed.Format("2006-01-02") != s {
		return "", store.NewError(ErrCodeInvalidInput, fmt.Sprintf("invalid date %q: expected valid YYYY-MM-DD", raw), nil)
	}
	return s, nil
}

func validateRecurrence(r TaskRecurrence) (*TaskRecurrence, error) {
	switch r.Freq {
	case FreqDaily:
		return &TaskRecurrence{Freq: FreqDaily}, nil
	case FreqWeekly:
		if len(r.Weekdays) == 0 {
			return nil, store.NewError(ErrCodeInvalidInput, "weekly recurrence requires non-empty weekdays", nil)
		}
		seen := make(map[int]struct{}, len(r.Weekdays))
		days := make([]int, 0, len(r.Weekdays))
		for _, wd := range r.Weekdays {
			if wd < 0 || wd > 6 {
				return nil, store.NewError(ErrCodeInvalidInput, fmt.Sprintf("invalid weekday %d: must be in 0..6", wd), nil)
			}
			if _, dup := seen[wd]; dup {
				return nil, store.NewError(ErrCodeInvalidInput, fmt.Sprintf("duplicate weekday %d", wd), nil)
			}
			seen[wd] = struct{}{}
			days = append(days, wd)
		}
		return &TaskRecurrence{Freq: FreqWeekly, Weekdays: days}, nil
	default:
		return nil, store.NewError(ErrCodeInvalidInput, fmt.Sprintf("invalid recurrence freq %q", r.Freq), nil)
	}
}

func recurrenceEqual(a, b *TaskRecurrence) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil || a.Freq != b.Freq || len(a.Weekdays) != len(b.Weekdays) {
		return false
	}
	for i := range a.Weekdays {
		if a.Weekdays[i] != b.Weekdays[i] {
			return false
		}
	}
	return true
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func cloneIntPtr(p *int) *int {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

func cloneInt64Ptr(p *int64) *int64 {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

func cloneItems(items []TaskItem) []TaskItem {
	out := make([]TaskItem, len(items))
	for i, it := range items {
		out[i] = TaskItem{
			ID:      it.ID,
			Text:    it.Text,
			Done:    it.Done,
			Current: cloneIntPtr(it.Current),
			Target:  cloneIntPtr(it.Target),
		}
	}
	return out
}

func cloneQuota(q *TaskQuota) *TaskQuota {
	if q == nil {
		return nil
	}
	c := *q
	return &c
}

func cloneRecurrence(r *TaskRecurrence) *TaskRecurrence {
	if r == nil {
		return nil
	}
	c := TaskRecurrence{Freq: r.Freq}
	if len(r.Weekdays) > 0 {
		c.Weekdays = append([]int(nil), r.Weekdays...)
	}
	return &c
}

func cloneStoredTask(t storedTask) storedTask {
	return storedTask{
		ID:           t.ID,
		Kind:         t.Kind,
		Title:        t.Title,
		Status:       t.Status,
		Items:        cloneItems(t.Items),
		Quota:        cloneQuota(t.Quota),
		Recurrence:   cloneRecurrence(t.Recurrence),
		PeriodKey:    t.PeriodKey,
		Deadline:     t.Deadline,
		ScheduledFor: t.ScheduledFor,
		Order:        t.Order,
		CreatedAt:    t.CreatedAt,
		CompletedAt:  cloneInt64Ptr(t.CompletedAt),
	}
}

func cloneStoredTasks(tasks []storedTask) []storedTask {
	out := make([]storedTask, len(tasks))
	for i, t := range tasks {
		out[i] = cloneStoredTask(t)
	}
	return out
}

func cloneHistory(h map[string][]string) map[string][]string {
	out := make(map[string][]string, len(h))
	for k, v := range h {
		out[k] = append([]string(nil), v...)
	}
	return out
}

func cloneTask(t Task) Task {
	return Task{
		ID:           t.ID,
		Kind:         t.Kind,
		Title:        t.Title,
		Status:       t.Status,
		Items:        cloneItems(t.Items),
		Quota:        cloneQuota(t.Quota),
		Recurrence:   cloneRecurrence(t.Recurrence),
		PeriodKey:    t.PeriodKey,
		Streak:       cloneIntPtr(t.Streak),
		Deadline:     t.Deadline,
		ScheduledFor: t.ScheduledFor,
		DueToday:     t.DueToday,
		Overdue:      t.Overdue,
		Order:        t.Order,
		CreatedAt:    t.CreatedAt,
		CompletedAt:  cloneInt64Ptr(t.CompletedAt),
	}
}

func cloneTasks(tasks []Task) []Task {
	out := make([]Task, len(tasks))
	for i, t := range tasks {
		out[i] = cloneTask(t)
	}
	return out
}

func cloneListResult(r ListResult) ListResult {
	return ListResult{
		PeriodKey: r.PeriodKey,
		Tasks:     cloneTasks(r.Tasks),
	}
}
