package workbench

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
	// FileName is the JSON file used to persist active workbench slots.
	FileName = "workbench.json"

	schemaVersion = 1

	maxTitleRunes      = 200
	maxBreadcrumbRunes = 500
	maxTagRunes        = 40
	maxRemindMinutes   = 365 * 24 * 60 // 1 year cap prevents duration overflow
	errorRetryBackoff  = 5 * time.Second

	ErrCodeInvalidInput = "workbench/invalid-input"
	ErrCodeNotFound     = "workbench/not-found"
	ErrCodeAmbiguous    = "workbench/ambiguous"
)

// WorkSlotState represents the non-LED three-state lifecycle of a concurrent work slot.
type WorkSlotState string

const (
	StateFocus   WorkSlotState = "focus"
	StateRunning WorkSlotState = "running"
	StateReady   WorkSlotState = "ready"
)

// WorkSlot is an active concurrent work item displayed in the bottom card tray
// and expanded workbench deck.
type WorkSlot struct {
	ID             string        `json:"id"`
	Title          string        `json:"title"`
	State          WorkSlotState `json:"state"`
	Breadcrumb     string        `json:"breadcrumb"`
	Tag            string        `json:"tag,omitempty"`
	LinkedTaskID   string        `json:"linkedTaskId,omitempty"`
	StateChangedAt int64         `json:"stateChangedAt"`
	RemindAt       *int64        `json:"remindAt,omitempty"`
	Order          int           `json:"order"`
	CreatedAt      int64         `json:"createdAt"`
	UpdatedAt      int64         `json:"updatedAt"`
}

// CreateInput configures a new concurrent work slot.
type CreateInput struct {
	Title           string        `json:"title"`
	Tag             string        `json:"tag,omitempty"`
	Breadcrumb      string        `json:"breadcrumb,omitempty"`
	State           WorkSlotState `json:"state,omitempty"`
	LinkedTaskID    string        `json:"linkedTaskId,omitempty"`
	RemindInMinutes *int          `json:"remindInMinutes,omitempty"`
}

// UpdateInput modifies metadata of an existing work slot.
// Passing JSON `"linkedTaskId": null` or setting ClearLinkedTaskID clears LinkedTaskID.
type UpdateInput struct {
	ID                string  `json:"id"`
	Title             *string `json:"title,omitempty"`
	Tag               *string `json:"tag,omitempty"`
	Breadcrumb        *string `json:"breadcrumb,omitempty"`
	LinkedTaskID      *string `json:"linkedTaskId,omitempty"`
	ClearLinkedTaskID bool    `json:"-"`
}

// UnmarshalJSON distinguishes omitted "linkedTaskId" from explicit JSON null.
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
	if v, ok := fields["linkedTaskId"]; ok && bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
		in.ClearLinkedTaskID = true
		in.LinkedTaskID = nil
	}
	return nil
}

// SetStateInput transitions a work slot's state and optionally configures or
// clears its running reminder timer.
// Passing JSON `"remindInMinutes": null` or setting ClearRemind cancels an existing reminder.
type SetStateInput struct {
	ID              string        `json:"id"`
	State           WorkSlotState `json:"state"`
	RemindInMinutes *int          `json:"remindInMinutes,omitempty"`
	ClearRemind     bool          `json:"-"`
}

// UnmarshalJSON distinguishes omitted "remindInMinutes" from explicit JSON null.
func (in *SetStateInput) UnmarshalJSON(data []byte) error {
	type alias SetStateInput
	var raw alias
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*in = SetStateInput(raw)

	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	if v, ok := fields["remindInMinutes"]; ok && bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
		in.ClearRemind = true
		in.RemindInMinutes = nil
	}
	return nil
}

type persistedState struct {
	SchemaVersion int        `json:"schemaVersion"`
	Slots         []WorkSlot `json:"slots"`
}

// Option customizes Service creation.
type Option func(*options)

type options struct {
	idGen func() string
}

// WithIDGenerator overrides the UUID generator for deterministic tests.
func WithIDGenerator(fn func() string) Option {
	return func(o *options) {
		if fn != nil {
			o.idGen = fn
		}
	}
}

type listenerEntry struct {
	id uint64
	fn func([]WorkSlot)
}

// Service manages concurrent work slots, the single-focus invariant, and
// clock-driven running->ready reminders with sleep recovery.
type Service struct {
	mu           sync.Mutex
	store        *store.Store
	clk          clock.Clock
	idGen        func() string
	slots        []WorkSlot
	closed       bool
	timerGen     uint64
	stopTimer    clock.StopFunc
	nextListener uint64
	listeners    []listenerEntry
}

// Open loads workbench state from st, reconciles any reminders that expired
// while the app was closed, and schedules the next reminder timer.
// Corrupt storage files return store/corrupt without modifying disk.
func Open(st *store.Store, clk clock.Clock, opts ...Option) (*Service, error) {
	if st == nil {
		return nil, store.NewError(ErrCodeInvalidInput, "store is required", nil)
	}
	if clk == nil {
		clk = clock.NewReal()
	}
	cfg := options{idGen: store.NewID}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}

	svc := &Service{
		store: st,
		clk:   clk,
		idGen: cfg.idGen,
		slots: []WorkSlot{},
	}

	var doc persistedState
	found, err := st.ReadJSON(FileName, &doc)
	if err != nil {
		return nil, err
	}
	if found {
		validated, err := validatePersisted(doc)
		if err != nil {
			return nil, err
		}
		svc.slots = validated
	}

	if _, err := svc.reconcileRemindersLocked(); err != nil {
		return nil, err
	}
	svc.scheduleNextReminderLocked()
	return svc, nil
}

// Close stops any pending reminder timer and marks the service closed.
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

// OnChange registers a listener invoked whenever slots change (including when
// a reminder timer automatically transitions a running slot to ready).
func (s *Service) OnChange(fn func([]WorkSlot)) func() {
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

// List returns all active work slots ordered by Order ascending.
// Overdue reminders are reconciled first (sleep recovery).
func (s *Service) List() ([]WorkSlot, error) {
	s.mu.Lock()
	reconciled, err := s.reconcileRemindersLocked()
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	snap := cloneSlots(s.slots)
	var listeners []func([]WorkSlot)
	if reconciled {
		listeners = s.snapshotListenersLocked()
	}
	s.mu.Unlock()

	notifyListeners(listeners, snap)
	return snap, nil
}

// Get returns a single work slot by ID. Overdue reminders are reconciled first.
func (s *Service) Get(id string) (WorkSlot, error) {
	s.mu.Lock()
	reconciled, err := s.reconcileRemindersLocked()
	if err != nil {
		s.mu.Unlock()
		return WorkSlot{}, err
	}
	var listeners []func([]WorkSlot)
	var snap []WorkSlot
	if reconciled {
		listeners = s.snapshotListenersLocked()
		snap = cloneSlots(s.slots)
	}

	idx := s.indexOfLocked(strings.TrimSpace(id))
	if idx < 0 {
		s.mu.Unlock()
		notifyListeners(listeners, snap)
		return WorkSlot{}, store.NewError(ErrCodeNotFound, fmt.Sprintf("work slot %q not found", id), nil)
	}
	slot := cloneSlot(s.slots[idx])
	s.mu.Unlock()

	notifyListeners(listeners, snap)
	return slot, nil
}

// Find resolves a work slot by exact ID, exact case-insensitive title, or
// unique case-insensitive title substring. Overdue reminders are reconciled first.
func (s *Service) Find(idOrQuery string) (WorkSlot, error) {
	s.mu.Lock()
	reconciled, err := s.reconcileRemindersLocked()
	if err != nil {
		s.mu.Unlock()
		return WorkSlot{}, err
	}
	var listeners []func([]WorkSlot)
	var snap []WorkSlot
	if reconciled {
		listeners = s.snapshotListenersLocked()
		snap = cloneSlots(s.slots)
	}

	q := strings.TrimSpace(idOrQuery)
	if q == "" {
		s.mu.Unlock()
		notifyListeners(listeners, snap)
		return WorkSlot{}, store.NewError(ErrCodeInvalidInput, "slot query must not be empty", nil)
	}

	// 1. Exact ID match.
	if idx := s.indexOfLocked(q); idx >= 0 {
		slot := cloneSlot(s.slots[idx])
		s.mu.Unlock()
		notifyListeners(listeners, snap)
		return slot, nil
	}

	// 2. Case-insensitive exact title match.
	qLower := strings.ToLower(q)
	var exactMatches []WorkSlot
	var subMatches []WorkSlot
	for _, slot := range s.slots {
		tLower := strings.ToLower(slot.Title)
		if tLower == qLower {
			exactMatches = append(exactMatches, cloneSlot(slot))
		}
		if strings.Contains(tLower, qLower) {
			subMatches = append(subMatches, cloneSlot(slot))
		}
	}
	s.mu.Unlock()
	notifyListeners(listeners, snap)

	if len(exactMatches) == 1 {
		return exactMatches[0], nil
	}
	if len(subMatches) == 1 {
		return subMatches[0], nil
	}
	if len(subMatches) > 1 {
		return WorkSlot{}, store.NewError(ErrCodeAmbiguous, fmt.Sprintf("multiple work slots match %q", q), nil)
	}
	return WorkSlot{}, store.NewError(ErrCodeNotFound, fmt.Sprintf("no work slot matches %q", q), nil)
}

// Create adds a new work slot. If the new slot enters StateFocus (the default
// when State is omitted), any previously focused slot is demoted to StateRunning.
func (s *Service) Create(in CreateInput) (WorkSlot, error) {
	s.mu.Lock()
	reconciled, err := s.reconcileRemindersLocked()
	if err != nil {
		s.mu.Unlock()
		return WorkSlot{}, err
	}

	title, err := validateTitle(in.Title)
	if err != nil {
		snap, listeners := s.reconciledNotifyLocked(reconciled)
		s.mu.Unlock()
		notifyListeners(listeners, snap)
		return WorkSlot{}, err
	}
	breadcrumb, err := validateBreadcrumb(in.Breadcrumb)
	if err != nil {
		snap, listeners := s.reconciledNotifyLocked(reconciled)
		s.mu.Unlock()
		notifyListeners(listeners, snap)
		return WorkSlot{}, err
	}
	tag, err := validateTag(in.Tag)
	if err != nil {
		snap, listeners := s.reconciledNotifyLocked(reconciled)
		s.mu.Unlock()
		notifyListeners(listeners, snap)
		return WorkSlot{}, err
	}

	state := in.State
	if state == "" {
		state = StateFocus
	}
	if !isValidState(state) {
		snap, listeners := s.reconciledNotifyLocked(reconciled)
		s.mu.Unlock()
		notifyListeners(listeners, snap)
		return WorkSlot{}, store.NewError(ErrCodeInvalidInput, fmt.Sprintf("invalid slot state %q", state), nil)
	}

	now := s.clk.Now().UnixMilli()
	var remindAt *int64
	if in.RemindInMinutes != nil {
		if state != StateRunning {
			snap, listeners := s.reconciledNotifyLocked(reconciled)
			s.mu.Unlock()
			notifyListeners(listeners, snap)
			return WorkSlot{}, store.NewError(ErrCodeInvalidInput, "remindInMinutes is only valid for running slots", nil)
		}
		if err := validateRemindMinutes(*in.RemindInMinutes); err != nil {
			snap, listeners := s.reconciledNotifyLocked(reconciled)
			s.mu.Unlock()
			notifyListeners(listeners, snap)
			return WorkSlot{}, err
		}
		target := now + int64(*in.RemindInMinutes)*60_000
		remindAt = &target
	}

	draft := cloneSlots(s.slots)
	if state == StateFocus {
		demoteFocusSlots(draft, "", now)
	}

	slot := WorkSlot{
		ID:             s.idGen(),
		Title:          title,
		State:          state,
		Breadcrumb:     breadcrumb,
		Tag:            tag,
		LinkedTaskID:   strings.TrimSpace(in.LinkedTaskID),
		StateChangedAt: now,
		RemindAt:       remindAt,
		Order:          len(draft),
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	draft = append(draft, slot)

	if err := s.persistLocked(draft); err != nil {
		snap, listeners := s.reconciledNotifyLocked(reconciled)
		s.mu.Unlock()
		notifyListeners(listeners, snap)
		return WorkSlot{}, err
	}
	s.slots = draft
	s.scheduleNextReminderLocked()
	snap := cloneSlots(s.slots)
	listeners := s.snapshotListenersLocked()
	s.mu.Unlock()

	notifyListeners(listeners, snap)
	return cloneSlot(slot), nil
}

// Update modifies an existing work slot's title, tag, breadcrumb, or linkedTaskId.
func (s *Service) Update(in UpdateInput) (WorkSlot, error) {
	s.mu.Lock()
	reconciled, err := s.reconcileRemindersLocked()
	if err != nil {
		s.mu.Unlock()
		return WorkSlot{}, err
	}

	id := strings.TrimSpace(in.ID)
	idx := s.indexOfLocked(id)
	if idx < 0 {
		snap, listeners := s.reconciledNotifyLocked(reconciled)
		s.mu.Unlock()
		notifyListeners(listeners, snap)
		return WorkSlot{}, store.NewError(ErrCodeNotFound, fmt.Sprintf("work slot %q not found", in.ID), nil)
	}

	draft := cloneSlots(s.slots)
	target := &draft[idx]
	changed := false

	if in.Title != nil {
		title, err := validateTitle(*in.Title)
		if err != nil {
			snap, listeners := s.reconciledNotifyLocked(reconciled)
			s.mu.Unlock()
			notifyListeners(listeners, snap)
			return WorkSlot{}, err
		}
		if title != target.Title {
			target.Title = title
			changed = true
		}
	}
	if in.Tag != nil {
		tag, err := validateTag(*in.Tag)
		if err != nil {
			snap, listeners := s.reconciledNotifyLocked(reconciled)
			s.mu.Unlock()
			notifyListeners(listeners, snap)
			return WorkSlot{}, err
		}
		if tag != target.Tag {
			target.Tag = tag
			changed = true
		}
	}
	if in.Breadcrumb != nil {
		breadcrumb, err := validateBreadcrumb(*in.Breadcrumb)
		if err != nil {
			snap, listeners := s.reconciledNotifyLocked(reconciled)
			s.mu.Unlock()
			notifyListeners(listeners, snap)
			return WorkSlot{}, err
		}
		if breadcrumb != target.Breadcrumb {
			target.Breadcrumb = breadcrumb
			changed = true
		}
	}
	if in.ClearLinkedTaskID {
		if target.LinkedTaskID != "" {
			target.LinkedTaskID = ""
			changed = true
		}
	} else if in.LinkedTaskID != nil {
		linked := strings.TrimSpace(*in.LinkedTaskID)
		if linked != target.LinkedTaskID {
			target.LinkedTaskID = linked
			changed = true
		}
	}

	if !changed {
		slot := cloneSlot(s.slots[idx])
		snap, listeners := s.reconciledNotifyLocked(reconciled)
		s.mu.Unlock()
		notifyListeners(listeners, snap)
		return slot, nil
	}

	target.UpdatedAt = s.clk.Now().UnixMilli()
	if err := s.persistLocked(draft); err != nil {
		snap, listeners := s.reconciledNotifyLocked(reconciled)
		s.mu.Unlock()
		notifyListeners(listeners, snap)
		return WorkSlot{}, err
	}
	s.slots = draft
	snap := cloneSlots(s.slots)
	listeners := s.snapshotListenersLocked()
	updated := cloneSlot(draft[idx])
	s.mu.Unlock()

	notifyListeners(listeners, snap)
	return updated, nil
}

// SetState transitions a slot to focus, running, or ready.
// Setting a slot to focus automatically demotes any previously focused slot to running.
// Setting RemindInMinutes on a running slot schedules a clock timer to transition
// it to ready when elapsed.
func (s *Service) SetState(in SetStateInput) ([]WorkSlot, error) {
	s.mu.Lock()
	reconciled, err := s.reconcileRemindersLocked()
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}

	if !isValidState(in.State) {
		snap, listeners := s.reconciledNotifyLocked(reconciled)
		s.mu.Unlock()
		notifyListeners(listeners, snap)
		return nil, store.NewError(ErrCodeInvalidInput, fmt.Sprintf("invalid slot state %q", in.State), nil)
	}
	id := strings.TrimSpace(in.ID)
	idx := s.indexOfLocked(id)
	if idx < 0 {
		snap, listeners := s.reconciledNotifyLocked(reconciled)
		s.mu.Unlock()
		notifyListeners(listeners, snap)
		return nil, store.NewError(ErrCodeNotFound, fmt.Sprintf("work slot %q not found", in.ID), nil)
	}

	if in.State != StateRunning && in.RemindInMinutes != nil {
		snap, listeners := s.reconciledNotifyLocked(reconciled)
		s.mu.Unlock()
		notifyListeners(listeners, snap)
		return nil, store.NewError(ErrCodeInvalidInput, "remindInMinutes is only valid for running slots", nil)
	}
	if in.RemindInMinutes != nil {
		if err := validateRemindMinutes(*in.RemindInMinutes); err != nil {
			snap, listeners := s.reconciledNotifyLocked(reconciled)
			s.mu.Unlock()
			notifyListeners(listeners, snap)
			return nil, err
		}
	}

	now := s.clk.Now().UnixMilli()
	draft := cloneSlots(s.slots)
	target := &draft[idx]
	changed := false

	if in.State == StateFocus {
		if demoteFocusSlots(draft, target.ID, now) {
			changed = true
		}
	}

	prevState := target.State
	if target.State != in.State {
		target.State = in.State
		target.StateChangedAt = now
		changed = true
	}

	if in.State != StateRunning {
		if target.RemindAt != nil {
			target.RemindAt = nil
			changed = true
		}
	} else {
		switch {
		case in.RemindInMinutes != nil:
			remind := now + int64(*in.RemindInMinutes)*60_000
			if target.RemindAt == nil || *target.RemindAt != remind {
				target.RemindAt = &remind
				changed = true
			}
		case in.ClearRemind:
			if target.RemindAt != nil {
				target.RemindAt = nil
				changed = true
			}
		case prevState != StateRunning:
			if target.RemindAt != nil {
				target.RemindAt = nil
				changed = true
			}
		}
	}

	if !changed {
		snap := cloneSlots(s.slots)
		var listeners []func([]WorkSlot)
		if reconciled {
			listeners = s.snapshotListenersLocked()
		}
		s.mu.Unlock()
		notifyListeners(listeners, snap)
		return snap, nil
	}

	target.UpdatedAt = now
	if err := s.persistLocked(draft); err != nil {
		snap, listeners := s.reconciledNotifyLocked(reconciled)
		s.mu.Unlock()
		notifyListeners(listeners, snap)
		return nil, err
	}
	s.slots = draft
	s.scheduleNextReminderLocked()
	snap := cloneSlots(s.slots)
	listeners := s.snapshotListenersLocked()
	s.mu.Unlock()

	notifyListeners(listeners, snap)
	return snap, nil
}

// Complete removes a finished work slot from the active workbench and returns
// both the removed slot (so callers can inspect LinkedTaskID) and the updated
// remaining slots.
func (s *Service) Complete(id string) (WorkSlot, []WorkSlot, error) {
	s.mu.Lock()
	reconciled, err := s.reconcileRemindersLocked()
	if err != nil {
		s.mu.Unlock()
		return WorkSlot{}, nil, err
	}

	idx := s.indexOfLocked(strings.TrimSpace(id))
	if idx < 0 {
		snap, listeners := s.reconciledNotifyLocked(reconciled)
		s.mu.Unlock()
		notifyListeners(listeners, snap)
		return WorkSlot{}, nil, store.NewError(ErrCodeNotFound, fmt.Sprintf("work slot %q not found", id), nil)
	}

	draft := cloneSlots(s.slots)
	removed := cloneSlot(draft[idx])
	draft = append(draft[:idx], draft[idx+1:]...)
	for i := range draft {
		draft[i].Order = i
	}

	if err := s.persistLocked(draft); err != nil {
		snap, listeners := s.reconciledNotifyLocked(reconciled)
		s.mu.Unlock()
		notifyListeners(listeners, snap)
		return WorkSlot{}, nil, err
	}
	s.slots = draft
	s.scheduleNextReminderLocked()
	snap := cloneSlots(s.slots)
	listeners := s.snapshotListenersLocked()
	s.mu.Unlock()

	notifyListeners(listeners, snap)
	return removed, snap, nil
}

// Reorder rearranges active work slots to match ids (must be a complete
// permutation of all active slot IDs).
func (s *Service) Reorder(ids []string) ([]WorkSlot, error) {
	s.mu.Lock()
	reconciled, err := s.reconcileRemindersLocked()
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}

	if len(ids) != len(s.slots) {
		snap, listeners := s.reconciledNotifyLocked(reconciled)
		s.mu.Unlock()
		notifyListeners(listeners, snap)
		return nil, store.NewError(ErrCodeInvalidInput, "reorder ids must match all active slots", nil)
	}

	byID := make(map[string]WorkSlot, len(s.slots))
	for _, slot := range s.slots {
		byID[slot.ID] = slot
	}
	seen := make(map[string]struct{}, len(ids))
	draft := make([]WorkSlot, 0, len(ids))
	changed := false
	for i, rawID := range ids {
		id := strings.TrimSpace(rawID)
		if _, dup := seen[id]; dup {
			snap, listeners := s.reconciledNotifyLocked(reconciled)
			s.mu.Unlock()
			notifyListeners(listeners, snap)
			return nil, store.NewError(ErrCodeInvalidInput, fmt.Sprintf("duplicate slot id %q", id), nil)
		}
		slot, ok := byID[id]
		if !ok {
			snap, listeners := s.reconciledNotifyLocked(reconciled)
			s.mu.Unlock()
			notifyListeners(listeners, snap)
			return nil, store.NewError(ErrCodeNotFound, fmt.Sprintf("work slot %q not found", rawID), nil)
		}
		seen[id] = struct{}{}
		cloned := cloneSlot(slot)
		if cloned.Order != i || s.slots[i].ID != id {
			changed = true
		}
		cloned.Order = i
		draft = append(draft, cloned)
	}

	if !changed {
		snap := cloneSlots(s.slots)
		var listeners []func([]WorkSlot)
		if reconciled {
			listeners = s.snapshotListenersLocked()
		}
		s.mu.Unlock()
		notifyListeners(listeners, snap)
		return snap, nil
	}

	if err := s.persistLocked(draft); err != nil {
		snap, listeners := s.reconciledNotifyLocked(reconciled)
		s.mu.Unlock()
		notifyListeners(listeners, snap)
		return nil, err
	}
	s.slots = draft
	snap := cloneSlots(s.slots)
	listeners := s.snapshotListenersLocked()
	s.mu.Unlock()

	notifyListeners(listeners, snap)
	return snap, nil
}

// reconcileRemindersLocked transitions any running slot whose RemindAt <= now
// into StateReady, clears RemindAt, persists atomically, and reschedules timers.
func (s *Service) reconcileRemindersLocked() (bool, error) {
	now := s.clk.Now().UnixMilli()
	hasDue := false
	for _, slot := range s.slots {
		if slot.State == StateRunning && slot.RemindAt != nil && *slot.RemindAt <= now {
			hasDue = true
			break
		}
	}
	if !hasDue {
		return false, nil
	}

	draft := cloneSlots(s.slots)
	for i := range draft {
		if draft[i].State == StateRunning && draft[i].RemindAt != nil && *draft[i].RemindAt <= now {
			draft[i].State = StateReady
			draft[i].RemindAt = nil
			draft[i].StateChangedAt = now
			draft[i].UpdatedAt = now
		}
	}
	if err := s.persistLocked(draft); err != nil {
		return false, err
	}
	s.slots = draft
	s.scheduleNextReminderLocked()
	return true, nil
}

func (s *Service) scheduleNextReminderLocked() {
	var earliest int64
	hasReminder := false
	for _, slot := range s.slots {
		if slot.State == StateRunning && slot.RemindAt != nil {
			if !hasReminder || *slot.RemindAt < earliest {
				earliest = *slot.RemindAt
				hasReminder = true
			}
		}
	}
	if !hasReminder {
		s.cancelTimerLocked()
		return
	}

	nowMs := s.clk.Now().UnixMilli()
	delayMs := earliest - nowMs
	if delayMs < 0 {
		delayMs = 0
	}
	s.scheduleReminderAfterLocked(time.Duration(delayMs) * time.Millisecond)
}

func (s *Service) cancelTimerLocked() {
	s.timerGen++
	if s.stopTimer != nil {
		s.stopTimer()
		s.stopTimer = nil
	}
}

func (s *Service) scheduleReminderAfterLocked(delay time.Duration) {
	s.cancelTimerLocked()
	if s.closed {
		return
	}
	gen := s.timerGen
	s.stopTimer = s.clk.AfterFunc(delay, func() {
		s.onReminderTimer(gen)
	})
}

func (s *Service) onReminderTimer(gen uint64) {
	s.mu.Lock()
	if s.closed || gen != s.timerGen {
		s.mu.Unlock()
		return
	}
	reconciled, err := s.reconcileRemindersLocked()
	if err != nil {
		// Retry after a non-zero backoff so transient disk errors never spin in a 0ms loop.
		s.scheduleReminderAfterLocked(errorRetryBackoff)
		s.mu.Unlock()
		return
	}
	if !reconciled {
		// Clock may have moved backwards before deadline; reschedule for current clock.
		s.scheduleNextReminderLocked()
		s.mu.Unlock()
		return
	}
	snap := cloneSlots(s.slots)
	listeners := s.snapshotListenersLocked()
	s.mu.Unlock()

	notifyListeners(listeners, snap)
}

func (s *Service) persistLocked(slots []WorkSlot) error {
	doc := persistedState{
		SchemaVersion: schemaVersion,
		Slots:         slots,
	}
	return s.store.WriteJSON(FileName, doc)
}

func (s *Service) indexOfLocked(id string) int {
	for i := range s.slots {
		if s.slots[i].ID == id {
			return i
		}
	}
	return -1
}

func (s *Service) snapshotListenersLocked() []func([]WorkSlot) {
	if len(s.listeners) == 0 {
		return nil
	}
	out := make([]func([]WorkSlot), len(s.listeners))
	for i, l := range s.listeners {
		out[i] = l.fn
	}
	return out
}

func (s *Service) reconciledNotifyLocked(reconciled bool) ([]WorkSlot, []func([]WorkSlot)) {
	if !reconciled {
		return nil, nil
	}
	return cloneSlots(s.slots), s.snapshotListenersLocked()
}

func notifyListeners(listeners []func([]WorkSlot), snap []WorkSlot) {
	for _, fn := range listeners {
		fn(cloneSlots(snap))
	}
}

func demoteFocusSlots(slots []WorkSlot, keepID string, now int64) bool {
	demoted := false
	for i := range slots {
		if slots[i].State == StateFocus && slots[i].ID != keepID {
			slots[i].State = StateRunning
			slots[i].RemindAt = nil
			slots[i].StateChangedAt = now
			slots[i].UpdatedAt = now
			demoted = true
		}
	}
	return demoted
}

func validatePersisted(doc persistedState) ([]WorkSlot, error) {
	if doc.SchemaVersion != schemaVersion {
		return nil, store.NewError(store.ErrCodeCorrupt, fmt.Sprintf("unsupported workbench schemaVersion %d", doc.SchemaVersion), nil)
	}
	seen := make(map[string]struct{}, len(doc.Slots))
	focusCount := 0
	out := make([]WorkSlot, 0, len(doc.Slots))
	for _, slot := range doc.Slots {
		if strings.TrimSpace(slot.ID) == "" {
			return nil, store.NewError(store.ErrCodeCorrupt, "stored work slot missing id", nil)
		}
		if _, dup := seen[slot.ID]; dup {
			return nil, store.NewError(store.ErrCodeCorrupt, fmt.Sprintf("duplicate work slot id %q", slot.ID), nil)
		}
		seen[slot.ID] = struct{}{}
		if !isValidState(slot.State) {
			return nil, store.NewError(store.ErrCodeCorrupt, fmt.Sprintf("invalid stored work slot state %q", slot.State), nil)
		}
		if slot.State == StateFocus {
			focusCount++
			if focusCount > 1 {
				return nil, store.NewError(store.ErrCodeCorrupt, "multiple focus slots in stored workbench state", nil)
			}
		}
		if _, err := validateTitle(slot.Title); err != nil {
			return nil, store.NewError(store.ErrCodeCorrupt, "invalid stored work slot title", err)
		}
		out = append(out, cloneSlot(slot))
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].Order < out[j].Order
	})
	for i := range out {
		out[i].Order = i
	}
	return out, nil
}

func isValidState(s WorkSlotState) bool {
	return s == StateFocus || s == StateRunning || s == StateReady
}

func validateTitle(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	n := utf8.RuneCountInString(trimmed)
	if n < 1 || n > maxTitleRunes {
		return "", store.NewError(ErrCodeInvalidInput, fmt.Sprintf("title must be 1..%d characters", maxTitleRunes), nil)
	}
	return trimmed, nil
}

func validateBreadcrumb(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if utf8.RuneCountInString(trimmed) > maxBreadcrumbRunes {
		return "", store.NewError(ErrCodeInvalidInput, fmt.Sprintf("breadcrumb must be at most %d characters", maxBreadcrumbRunes), nil)
	}
	return trimmed, nil
}

func validateTag(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if utf8.RuneCountInString(trimmed) > maxTagRunes {
		return "", store.NewError(ErrCodeInvalidInput, fmt.Sprintf("tag must be at most %d characters", maxTagRunes), nil)
	}
	return trimmed, nil
}

func validateRemindMinutes(mins int) error {
	if mins < 1 || mins > maxRemindMinutes {
		return store.NewError(ErrCodeInvalidInput, fmt.Sprintf("remindInMinutes must be in 1..%d", maxRemindMinutes), nil)
	}
	return nil
}

func cloneSlot(s WorkSlot) WorkSlot {
	c := s
	if s.RemindAt != nil {
		v := *s.RemindAt
		c.RemindAt = &v
	}
	return c
}

func cloneSlots(slots []WorkSlot) []WorkSlot {
	out := make([]WorkSlot, len(slots))
	for i, s := range slots {
		out[i] = cloneSlot(s)
	}
	return out
}
