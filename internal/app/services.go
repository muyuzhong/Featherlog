package app

import (
	"fmt"
	"log"
	"sync"

	"github.com/egoist/mygo"
	"github.com/muyuzhong/featherlog/internal/clock"
	"github.com/muyuzhong/featherlog/internal/dock"
	"github.com/muyuzhong/featherlog/internal/notes"
	"github.com/muyuzhong/featherlog/internal/settings"
	"github.com/muyuzhong/featherlog/internal/store"
	"github.com/muyuzhong/featherlog/internal/tasks"
	"github.com/muyuzhong/featherlog/internal/workbench"
)

// Config configures the Featherlog application composition root.
type Config struct {
	DataDir   string
	Clock     clock.Clock
	Events    EventSink
	DockCfg   dock.Config
	QuitFunc  func()
	IDGen     func() string
	OnCorrupt func(backupPath string, cause error)
}

// App owns the domain services, cross-domain coordination, dock controller,
// event sink, and the 5 MyGo-bound service facades.
type App struct {
	Store     *store.Store
	Clock     clock.Clock
	Workbench *workbench.Service
	Tasks     *tasks.Service
	Notes     *notes.Service
	Settings  *settings.Service
	Dock      *dock.Controller
	Events    EventSink
	quitFunc  func()

	WorkbenchSvc *WorkbenchService
	TaskSvc      *TaskService
	NoteSvc      *NoteService
	SettingsSvc  *SettingsService
	DockSvc      *DockService

	closeOnce sync.Once
	cleanups  []func()
}

// Open initializes all domain stores, wires cross-domain reactions and event
// broadcasts, and constructs the 5 service facades ready for mygo.Bind.
func Open(cfg Config) (*App, error) {
	if cfg.DataDir == "" {
		return nil, store.NewError("app/invalid-config", "dataDir is required", nil)
	}
	if err := store.EnsureDir(cfg.DataDir); err != nil {
		return nil, fmt.Errorf("ensure data dir: %w", err)
	}
	clk := cfg.Clock
	if clk == nil {
		clk = clock.NewReal()
	}
	events := cfg.Events
	if events == nil {
		events = MyGoEventSink{}
	}
	quitFn := cfg.QuitFunc
	if quitFn == nil {
		quitFn = func() { mygo.App.Quit() }
	}

	st := store.New(cfg.DataDir)

	var settingsOpts []settings.Option
	if cfg.IDGen != nil {
		settingsOpts = append(settingsOpts, settings.WithIDGenerator(cfg.IDGen))
	}
	if cfg.OnCorrupt != nil {
		settingsOpts = append(settingsOpts, settings.WithCorruptBackupHook(cfg.OnCorrupt))
	}
	settingsSvc, err := settings.Open(st, clk, settingsOpts...)
	if err != nil {
		return nil, fmt.Errorf("open settings: %w", err)
	}
	initialSettings := settingsSvc.Get()

	var wbOpts []workbench.Option
	if cfg.IDGen != nil {
		wbOpts = append(wbOpts, workbench.WithIDGenerator(cfg.IDGen))
	}
	wbSvc, err := workbench.Open(st, clk, wbOpts...)
	if err != nil {
		return nil, fmt.Errorf("open workbench: %w", err)
	}

	taskOpts := []tasks.Option{tasks.WithDayStartHour(initialSettings.DayStartHour)}
	if cfg.IDGen != nil {
		taskOpts = append(taskOpts, tasks.WithIDGenerator(cfg.IDGen))
	}
	taskSvc, err := tasks.Open(st, clk, taskOpts...)
	if err != nil {
		wbSvc.Close()
		return nil, fmt.Errorf("open tasks: %w", err)
	}

	var noteOpts []notes.Option
	if cfg.IDGen != nil {
		noteOpts = append(noteOpts, notes.WithIDGenerator(cfg.IDGen))
	}
	noteSvc, err := notes.Open(st, clk, noteOpts...)
	if err != nil {
		taskSvc.Close()
		wbSvc.Close()
		return nil, fmt.Errorf("open notes: %w", err)
	}

	dockCfg := cfg.DockCfg
	if dockCfg.Clock == nil {
		dockCfg.Clock = clk
	}
	dockCfg.InitialPin = initialSettings.Pinned
	userOnToggle := dockCfg.OnToggle
	dockCfg.OnToggle = func(expanded bool) {
		val := expanded
		events.DockToggle(DockToggleEvent{Expanded: &val})
		if userOnToggle != nil {
			userOnToggle(expanded)
		}
	}
	dockCtrl := dock.NewController(dockCfg)

	a := &App{
		Store:     st,
		Clock:     clk,
		Workbench: wbSvc,
		Tasks:     taskSvc,
		Notes:     noteSvc,
		Settings:  settingsSvc,
		Dock:      dockCtrl,
		Events:    events,
		quitFunc:  quitFn,
	}

	a.WorkbenchSvc = &WorkbenchService{app: a}
	a.TaskSvc = &TaskService{app: a}
	a.NoteSvc = &NoteService{app: a}
	a.SettingsSvc = &SettingsService{app: a}
	a.DockSvc = &DockService{app: a}

	// Wire real-time frontend broadcasts and cross-domain listeners.
	offWB := wbSvc.OnChange(func(slots []workbench.WorkSlot) {
		a.Events.WorkbenchChanged(slots)
	})
	offTasks := taskSvc.OnChange(func(res tasks.ListResult) {
		a.Events.TasksChanged(res)
	})
	offNotes := noteSvc.OnChange(func(reason string) {
		a.Events.NotesChanged(NotesChangedEvent{Reason: reason})
	})
	offSettings := settingsSvc.OnChange(func(next settings.Settings) {
		a.Dock.SetPinned(next.Pinned)
		a.Dock.SetTheme(string(next.Theme))
		if err := a.Tasks.SetDayStartHour(next.DayStartHour); err != nil {
			log.Printf("featherlog: apply dayStartHour=%d: %v", next.DayStartHour, err)
		}
		a.Events.SettingsChanged(next)
	})

	a.cleanups = []func(){offWB, offTasks, offNotes, offSettings}
	return a, nil
}

// BindMyGo registers all 5 contract services with MyGo before App.Run.
func (a *App) BindMyGo() {
	mygo.Bind(
		a.WorkbenchSvc,
		a.TaskSvc,
		a.NoteSvc,
		a.SettingsSvc,
		a.DockSvc,
	)
}

// Close releases timers, listeners, and global dock hooks.
func (a *App) Close() {
	a.closeOnce.Do(func() {
		for _, fn := range a.cleanups {
			if fn != nil {
				fn()
			}
		}
		a.cleanups = nil
		if a.Dock != nil {
			a.Dock.Close()
		}
		if a.Tasks != nil {
			a.Tasks.Close()
		}
		if a.Workbench != nil {
			a.Workbench.Close()
		}
	})
}

// IDInput identifies a single entity by ID.
type IDInput struct {
	ID string `json:"id"`
}

// WorkbenchCompleteInput completes an active work slot and optionally its linked task.
type WorkbenchCompleteInput struct {
	ID                 string `json:"id"`
	CompleteLinkedTask bool   `json:"completeLinkedTask,omitempty"`
}

// WorkbenchReorderInput reorders active work slots.
type WorkbenchReorderInput struct {
	IDs []string `json:"ids"`
}

// WorkbenchService is the MyGo-bound facade for concurrent work slots (§4.2.1).
type WorkbenchService struct {
	app *App
}

// List returns all active concurrent work slots in display order.
func (s *WorkbenchService) List() ([]workbench.WorkSlot, error) {
	return s.app.Workbench.List()
}

// Create adds a new concurrent work slot.
func (s *WorkbenchService) Create(input workbench.CreateInput) (workbench.WorkSlot, error) {
	return s.app.Workbench.Create(input)
}

// Update modifies a work slot's title, tag, breadcrumb, or linked task.
func (s *WorkbenchService) Update(input workbench.UpdateInput) (workbench.WorkSlot, error) {
	return s.app.Workbench.Update(input)
}

// SetState transitions a work slot between focus, running, and ready states.
func (s *WorkbenchService) SetState(input workbench.SetStateInput) ([]workbench.WorkSlot, error) {
	return s.app.Workbench.SetState(input)
}

// Complete removes a finished work slot and optionally completes its linked task.
func (s *WorkbenchService) Complete(input WorkbenchCompleteInput) ([]workbench.WorkSlot, error) {
	removed, remaining, err := s.app.Workbench.Complete(input.ID)
	if err != nil {
		return nil, err
	}
	if input.CompleteLinkedTask && removed.LinkedTaskID != "" {
		if _, taskErr := s.app.Tasks.Complete(tasks.CompleteInput{
			ID:        removed.LinkedTaskID,
			Completed: true,
		}); taskErr != nil && !store.IsCode(taskErr, tasks.ErrCodeNotFound) {
			return remaining, taskErr
		}
	}
	return remaining, nil
}

// Reorder updates the ordering of active work slots.
func (s *WorkbenchService) Reorder(input WorkbenchReorderInput) ([]workbench.WorkSlot, error) {
	return s.app.Workbench.Reorder(input.IDs)
}

// TaskService is the MyGo-bound facade for streamlined tasks (§4.2.2).
type TaskService struct {
	app *App
}

// List returns the active periodKey and all tasks with derived fields.
func (s *TaskService) List() (tasks.ListResult, error) {
	return s.app.Tasks.List()
}

// Create creates a main, side, or daily task.
func (s *TaskService) Create(input tasks.CreateInput) (tasks.Task, error) {
	return s.app.Tasks.Create(input)
}

// Update modifies a task's mutable fields.
func (s *TaskService) Update(input tasks.UpdateInput) (tasks.Task, error) {
	return s.app.Tasks.Update(input)
}

// SetItems replaces a task's free-order checklist items.
func (s *TaskService) SetItems(input tasks.SetItemsInput) (tasks.Task, error) {
	return s.app.Tasks.SetItems(input)
}

// ToggleItem toggles a checklist item in any order.
func (s *TaskService) ToggleItem(input tasks.ToggleItemInput) (tasks.Task, error) {
	return s.app.Tasks.ToggleItem(input)
}

// StepQuota adjusts a task's or item's quota by delta (+1 / -1).
func (s *TaskService) StepQuota(input tasks.StepQuotaInput) (tasks.Task, error) {
	return s.app.Tasks.StepQuota(input)
}

// Complete marks a task completed or reopens it.
func (s *TaskService) Complete(input tasks.CompleteInput) (tasks.Task, error) {
	return s.app.Tasks.Complete(input)
}

// Delete removes a task, detaches its notes into standalone notes so no text is
// lost, and clears any dangling linkedTaskId on active work slots.
func (s *TaskService) Delete(input IDInput) error {
	if err := s.app.Tasks.Delete(input.ID); err != nil {
		return err
	}
	if _, err := s.app.Notes.DetachTask(input.ID); err != nil {
		return err
	}
	// Clear dangling linkedTaskId references on active workbench slots.
	if slots, err := s.app.Workbench.List(); err == nil {
		for _, slot := range slots {
			if slot.LinkedTaskID == input.ID {
				_, _ = s.app.Workbench.Update(workbench.UpdateInput{
					ID:                slot.ID,
					ClearLinkedTaskID: true,
				})
			}
		}
	}
	return nil
}

// Reorder updates the ordering of tasks within a kind.
func (s *TaskService) Reorder(input tasks.ReorderInput) ([]tasks.Task, error) {
	return s.app.Tasks.Reorder(input)
}

// NoteService is the MyGo-bound facade for standalone notes and task notes (§4.2.3).
type NoteService struct {
	app *App
}

// List returns notes matching the optional filter (omitted input lists all notes).
func (s *NoteService) List(input *notes.ListInput) ([]notes.Note, error) {
	var in notes.ListInput
	if input != nil {
		in = *input
	}
	return s.app.Notes.List(in)
}

// Create adds a standalone note or a task-linked note.
func (s *NoteService) Create(input notes.CreateInput) (notes.Note, error) {
	return s.app.Notes.Create(input)
}

// Update modifies an existing note's text content.
func (s *NoteService) Update(input notes.UpdateInput) (notes.Note, error) {
	return s.app.Notes.Update(input)
}

// Delete removes a note by ID.
func (s *NoteService) Delete(input IDInput) error {
	return s.app.Notes.Delete(input.ID)
}

// SettingsService is the MyGo-bound facade for application preferences (§4.2.4).
type SettingsService struct {
	app *App
}

// Get returns the current application settings.
func (s *SettingsService) Get() settings.Settings {
	return s.app.Settings.Get()
}

// Update validates and persists a partial settings patch.
func (s *SettingsService) Update(patch settings.Patch) (settings.Settings, error) {
	return s.app.Settings.Update(patch)
}

// DockService is the MyGo-bound facade for window geometry and lifecycle (§4.2.5).
type DockService struct {
	app *App
}

// Resize updates the dock window dimensions while preserving bottom-center anchoring.
func (s *DockService) Resize(geom dock.Geometry) error {
	s.app.Dock.Resize(geom)
	return nil
}

// Quit requests graceful shutdown of the desktop host.
func (s *DockService) Quit() error {
	if s.app.quitFunc != nil {
		s.app.quitFunc()
	}
	return nil
}
