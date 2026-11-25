package notes

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/muyuzhong/featherlog/internal/clock"
	"github.com/muyuzhong/featherlog/internal/store"
)

const (
	// FileName is the JSON file used to persist notes.
	FileName = "notes.json"

	schemaVersion = 1

	maxContentRunes = 20_000

	ErrCodeInvalidInput = "notes/invalid-input"
	ErrCodeNotFound     = "notes/not-found"
)

// Note is a plain-text journal entry. TaskID == nil represents a standalone 随笔;
// a non-nil TaskID attaches the note to a task as a 手记.
type Note struct {
	ID        string  `json:"id"`
	Content   string  `json:"content"`
	TaskID    *string `json:"taskId"`
	CreatedAt int64   `json:"createdAt"`
	UpdatedAt int64   `json:"updatedAt"`
}

// CreateInput creates a standalone or task-linked note.
type CreateInput struct {
	Content string  `json:"content"`
	TaskID  *string `json:"taskId,omitempty"`
}

// UpdateInput modifies a note's plain-text content.
type UpdateInput struct {
	ID      string `json:"id"`
	Content string `json:"content"`
}

// ListInput filters notes returned by List.
//
// Three-way TaskID semantics:
//   - TaskID != nil: only notes attached to *TaskID.
//   - TaskID == nil && FilterByTask == true (or JSON `"taskId": null`): only standalone notes (TaskID == nil).
//   - TaskID == nil && FilterByTask == false (or JSON omitted): all notes.
type ListInput struct {
	FilterByTask bool    `json:"filterByTask,omitempty"`
	TaskID       *string `json:"taskId,omitempty"`
	Query        string  `json:"query,omitempty"`
	Limit        int     `json:"limit,omitempty"`
}

// UnmarshalJSON distinguishes omitted "taskId" from explicit JSON null.
func (in *ListInput) UnmarshalJSON(data []byte) error {
	type alias ListInput
	var raw alias
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*in = ListInput(raw)

	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	if v, ok := fields["taskId"]; ok {
		in.FilterByTask = true
		if bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
			in.TaskID = nil
		}
	}
	return nil
}

type persistedState struct {
	SchemaVersion int    `json:"schemaVersion"`
	Notes         []Note `json:"notes"`
}

// Option customizes Service creation.
type Option func(*options)

type options struct {
	idGen func() string
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
	fn func(reason string)
}

// Service manages plain-text notes with atomic persistence and task detachment.
type Service struct {
	mu           sync.Mutex
	store        *store.Store
	clk          clock.Clock
	idGen        func() string
	notes        []Note
	nextListener uint64
	listeners    []listenerEntry
}

// Open loads notes from st. Corrupt files return store/corrupt without modifying disk.
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
		notes: []Note{},
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
		svc.notes = validated
	}
	return svc, nil
}

// OnChange registers a listener invoked whenever notes change (reason is
// "created", "updated", "deleted", or "detached").
func (s *Service) OnChange(fn func(reason string)) func() {
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

// List returns notes matching in, ordered newest first.
func (s *Service) List(in ListInput) ([]Note, error) {
	if in.Limit < 0 {
		return nil, store.NewError(ErrCodeInvalidInput, "limit must be non-negative", nil)
	}

	var wantTaskID *string
	filterTask := in.FilterByTask
	if in.TaskID != nil {
		tid, err := validateTaskID(*in.TaskID)
		if err != nil {
			return nil, err
		}
		wantTaskID = &tid
		filterTask = true
	}

	queryLower := strings.ToLower(in.Query)

	s.mu.Lock()
	// Snapshot with insertion index so equal CreatedAt values still preserve
	// newest-created-first order deterministically.
	type indexedNote struct {
		idx  int
		note Note
	}
	matched := make([]indexedNote, 0, len(s.notes))
	for i, n := range s.notes {
		if filterTask {
			if wantTaskID == nil {
				if n.TaskID != nil {
					continue
				}
			} else {
				if n.TaskID == nil || *n.TaskID != *wantTaskID {
					continue
				}
			}
		}
		if queryLower != "" && !strings.Contains(strings.ToLower(n.Content), queryLower) {
			continue
		}
		matched = append(matched, indexedNote{idx: i, note: cloneNote(n)})
	}
	s.mu.Unlock()

	sort.Slice(matched, func(i, j int) bool {
		if matched[i].note.CreatedAt != matched[j].note.CreatedAt {
			return matched[i].note.CreatedAt > matched[j].note.CreatedAt
		}
		return matched[i].idx > matched[j].idx
	})

	if in.Limit > 0 && len(matched) > in.Limit {
		matched = matched[:in.Limit]
	}

	out := make([]Note, len(matched))
	for i, m := range matched {
		out[i] = m.note
	}
	return out, nil
}

// Get retrieves a note by ID.
func (s *Service) Get(id string) (Note, error) {
	key := strings.TrimSpace(id)
	if key == "" {
		return Note{}, store.NewError(ErrCodeInvalidInput, "note id must not be empty", nil)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	idx := s.indexOfLocked(key)
	if idx < 0 {
		return Note{}, store.NewError(ErrCodeNotFound, fmt.Sprintf("note %q not found", id), nil)
	}
	return cloneNote(s.notes[idx]), nil
}

// Create validates and persists a new note.
func (s *Service) Create(in CreateInput) (Note, error) {
	content, err := validateContent(in.Content)
	if err != nil {
		return Note{}, err
	}
	var taskID *string
	if in.TaskID != nil {
		tid, err := validateTaskID(*in.TaskID)
		if err != nil {
			return Note{}, err
		}
		taskID = &tid
	}

	s.mu.Lock()
	now := s.clk.Now().UnixMilli()
	note := Note{
		ID:        s.idGen(),
		Content:   content,
		TaskID:    taskID,
		CreatedAt: now,
		UpdatedAt: now,
	}
	draft := cloneNotes(s.notes)
	draft = append(draft, note)
	if err := s.persistLocked(draft); err != nil {
		s.mu.Unlock()
		return Note{}, err
	}
	s.notes = draft
	listeners := s.snapshotListenersLocked()
	s.mu.Unlock()

	notifyListeners(listeners, "created")
	return cloneNote(note), nil
}

// Update changes an existing note's content.
func (s *Service) Update(in UpdateInput) (Note, error) {
	id := strings.TrimSpace(in.ID)
	if id == "" {
		return Note{}, store.NewError(ErrCodeInvalidInput, "note id must not be empty", nil)
	}
	content, err := validateContent(in.Content)
	if err != nil {
		return Note{}, err
	}

	s.mu.Lock()
	idx := s.indexOfLocked(id)
	if idx < 0 {
		s.mu.Unlock()
		return Note{}, store.NewError(ErrCodeNotFound, fmt.Sprintf("note %q not found", in.ID), nil)
	}
	if s.notes[idx].Content == content {
		existing := cloneNote(s.notes[idx])
		s.mu.Unlock()
		return existing, nil
	}

	draft := cloneNotes(s.notes)
	draft[idx].Content = content
	draft[idx].UpdatedAt = s.clk.Now().UnixMilli()
	if err := s.persistLocked(draft); err != nil {
		s.mu.Unlock()
		return Note{}, err
	}
	s.notes = draft
	updated := cloneNote(draft[idx])
	listeners := s.snapshotListenersLocked()
	s.mu.Unlock()

	notifyListeners(listeners, "updated")
	return updated, nil
}

// Delete removes a note by ID.
func (s *Service) Delete(id string) error {
	key := strings.TrimSpace(id)
	if key == "" {
		return store.NewError(ErrCodeInvalidInput, "note id must not be empty", nil)
	}

	s.mu.Lock()
	idx := s.indexOfLocked(key)
	if idx < 0 {
		s.mu.Unlock()
		return store.NewError(ErrCodeNotFound, fmt.Sprintf("note %q not found", id), nil)
	}

	draft := cloneNotes(s.notes)
	draft = append(draft[:idx], draft[idx+1:]...)
	if err := s.persistLocked(draft); err != nil {
		s.mu.Unlock()
		return err
	}
	s.notes = draft
	listeners := s.snapshotListenersLocked()
	s.mu.Unlock()

	notifyListeners(listeners, "deleted")
	return nil
}

// DetachTask converts all notes attached to taskID into standalone notes
// (TaskID = nil) without deleting any note. Returns the number of detached notes.
func (s *Service) DetachTask(taskID string) (int, error) {
	tid, err := validateTaskID(taskID)
	if err != nil {
		return 0, err
	}

	s.mu.Lock()
	matched := 0
	for _, n := range s.notes {
		if n.TaskID != nil && *n.TaskID == tid {
			matched++
		}
	}
	if matched == 0 {
		s.mu.Unlock()
		return 0, nil
	}

	now := s.clk.Now().UnixMilli()
	draft := cloneNotes(s.notes)
	for i := range draft {
		if draft[i].TaskID != nil && *draft[i].TaskID == tid {
			draft[i].TaskID = nil
			draft[i].UpdatedAt = now
		}
	}
	if err := s.persistLocked(draft); err != nil {
		s.mu.Unlock()
		return 0, err
	}
	s.notes = draft
	listeners := s.snapshotListenersLocked()
	s.mu.Unlock()

	notifyListeners(listeners, "detached")
	return matched, nil
}

func (s *Service) persistLocked(notes []Note) error {
	doc := persistedState{
		SchemaVersion: schemaVersion,
		Notes:         notes,
	}
	return s.store.WriteJSON(FileName, doc)
}

func (s *Service) indexOfLocked(id string) int {
	for i := range s.notes {
		if s.notes[i].ID == id {
			return i
		}
	}
	return -1
}

func (s *Service) snapshotListenersLocked() []func(string) {
	if len(s.listeners) == 0 {
		return nil
	}
	out := make([]func(string), len(s.listeners))
	for i, l := range s.listeners {
		out[i] = l.fn
	}
	return out
}

func notifyListeners(listeners []func(string), reason string) {
	for _, fn := range listeners {
		fn(reason)
	}
}

func validatePersisted(doc persistedState) ([]Note, error) {
	if doc.SchemaVersion != schemaVersion {
		return nil, store.NewError(store.ErrCodeCorrupt, fmt.Sprintf("unsupported notes schemaVersion %d", doc.SchemaVersion), nil)
	}
	seen := make(map[string]struct{}, len(doc.Notes))
	out := make([]Note, 0, len(doc.Notes))
	for _, n := range doc.Notes {
		if strings.TrimSpace(n.ID) == "" {
			return nil, store.NewError(store.ErrCodeCorrupt, "stored note missing id", nil)
		}
		if _, dup := seen[n.ID]; dup {
			return nil, store.NewError(store.ErrCodeCorrupt, fmt.Sprintf("duplicate note id %q", n.ID), nil)
		}
		seen[n.ID] = struct{}{}
		if _, err := validateContent(n.Content); err != nil {
			return nil, store.NewError(store.ErrCodeCorrupt, "invalid stored note content", err)
		}
		if n.TaskID != nil {
			if _, err := validateTaskID(*n.TaskID); err != nil {
				return nil, store.NewError(store.ErrCodeCorrupt, "invalid stored note taskId", err)
			}
		}
		out = append(out, cloneNote(n))
	}
	return out, nil
}

func validateContent(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	n := utf8.RuneCountInString(trimmed)
	if n < 1 || n > maxContentRunes {
		return "", store.NewError(ErrCodeInvalidInput, fmt.Sprintf("note content must be 1..%d characters after trim", maxContentRunes), nil)
	}
	return trimmed, nil
}

func validateTaskID(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", store.NewError(ErrCodeInvalidInput, "taskId must not be empty", nil)
	}
	return trimmed, nil
}

func cloneNote(n Note) Note {
	c := n
	if n.TaskID != nil {
		v := *n.TaskID
		c.TaskID = &v
	}
	return c
}

func cloneNotes(notes []Note) []Note {
	out := make([]Note, len(notes))
	for i, n := range notes {
		out[i] = cloneNote(n)
	}
	return out
}
