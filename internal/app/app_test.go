package app

import (
	"bytes"
	"context"
	"encoding/json/v2"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/muyuzhong/featherlog/internal/clock"
	"github.com/muyuzhong/featherlog/internal/dock"
	"github.com/muyuzhong/featherlog/internal/ipcsock"
	"github.com/muyuzhong/featherlog/internal/migrate"
	"github.com/muyuzhong/featherlog/internal/notes"
	"github.com/muyuzhong/featherlog/internal/settings"
	"github.com/muyuzhong/featherlog/internal/tasks"
	"github.com/muyuzhong/featherlog/internal/workbench"
)

type recordingSink struct {
	mu        sync.Mutex
	workbench [][]workbench.WorkSlot
	tasks     []tasks.ListResult
	notes     []NotesChangedEvent
	settings  []settings.Settings
	toggles   []DockToggleEvent
}

func (r *recordingSink) WorkbenchChanged(slots []workbench.WorkSlot) {
	r.mu.Lock()
	r.workbench = append(r.workbench, slots)
	r.mu.Unlock()
}

func (r *recordingSink) TasksChanged(res tasks.ListResult) {
	r.mu.Lock()
	r.tasks = append(r.tasks, res)
	r.mu.Unlock()
}

func (r *recordingSink) NotesChanged(evt NotesChangedEvent) {
	r.mu.Lock()
	r.notes = append(r.notes, evt)
	r.mu.Unlock()
}

func (r *recordingSink) SettingsChanged(s settings.Settings) {
	r.mu.Lock()
	r.settings = append(r.settings, s)
	r.mu.Unlock()
}

func (r *recordingSink) DockToggle(evt DockToggleEvent) {
	r.mu.Lock()
	r.toggles = append(r.toggles, evt)
	r.mu.Unlock()
}

type noopScreen struct{}

func (noopScreen) ActiveDisplay(dock.Rect) dock.Display {
	return dock.Display{
		Bounds:   dock.Rect{Width: 1920, Height: 1080},
		WorkArea: dock.Rect{Width: 1920, Height: 1032},
		Primary:  true,
	}
}
func (noopScreen) OnDisplaysChanged(func()) func() { return func() {} }

type noopLayer struct{}

func (noopLayer) Available() bool                      { return false }
func (noopLayer) AnchorBottomCenter(uintptr, int) bool { return false }

func openTestApp(t *testing.T, start time.Time) (*App, *clock.FakeClock, *recordingSink) {
	t.Helper()
	clk := clock.NewFake(start)
	sink := &recordingSink{}
	quitCalls := 0
	a, err := Open(Config{
		DataDir: t.TempDir(),
		Clock:   clk,
		Events:  sink,
		DockCfg: dock.Config{
			Screen: noopScreen{},
			Layer:  noopLayer{},
		},
		QuitFunc: func() { quitCalls++ },
	})
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	t.Cleanup(a.Close)
	return a, clk, sink
}

func TestMyGoBindAndTypeScriptGeneration(t *testing.T) {
	a, _, _ := openTestApp(t, time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))
	// Verify mygo.Bind accepts all 5 contract services without panicking.
	a.BindMyGo()

	outPath := filepath.Join(t.TempDir(), "mygo.ts")
	if err := mygo.WriteTypeScript(outPath); err != nil {
		t.Fatalf("mygo.WriteTypeScript failed: %v", err)
	}
	raw, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatalf("read generated TS: %v", err)
	}
	ts := string(raw)

	expectedSnippets := []string{
		"export const WorkbenchService",
		`"WorkbenchService.List"`,
		`"WorkbenchService.Create"`,
		`"WorkbenchService.Update"`,
		`"WorkbenchService.SetState"`,
		`"WorkbenchService.Complete"`,
		`"WorkbenchService.Reorder"`,
		"export const TaskService",
		`"TaskService.List"`,
		`"TaskService.Create"`,
		`"TaskService.Update"`,
		`"TaskService.SetItems"`,
		`"TaskService.ToggleItem"`,
		`"TaskService.StepQuota"`,
		`"TaskService.Complete"`,
		`"TaskService.Delete"`,
		`"TaskService.Reorder"`,
		"export const NoteService",
		`"NoteService.List"`,
		`"NoteService.Create"`,
		`"NoteService.Update"`,
		`"NoteService.Delete"`,
		"export const SettingsService",
		`"SettingsService.Get"`,
		`"SettingsService.Update"`,
		"export const DockService",
		`"DockService.Resize"`,
		`"DockService.Toggle"`,
		`"DockService.Quit"`,
		`"workbench:changed"`,
		`"tasks:changed"`,
		`"notes:changed"`,
		`"settings:changed"`,
		`"dock:toggle"`,
	}
	for _, want := range expectedSnippets {
		if !strings.Contains(ts, want) {
			t.Errorf("generated TS missing %s\n--- TS ---\n%s", want, ts)
		}
	}
}

func TestCrossDomainTaskDeletionDetachesNotesAndClearsSlotLink(t *testing.T) {
	a, _, sink := openTestApp(t, time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))

	task, err := a.TaskSvc.Create(tasks.CreateInput{
		Kind:  tasks.KindSide,
		Title: "Refactor auth",
	})
	if err != nil {
		t.Fatalf("Create task: %v", err)
	}

	taskID := task.ID
	note, err := a.NoteSvc.Create(notes.CreateInput{
		Content: "Remember refresh token rotation",
		TaskID:  &taskID,
	})
	if err != nil {
		t.Fatalf("Create note: %v", err)
	}
	if note.TaskID == nil || *note.TaskID != task.ID {
		t.Fatalf("expected note attached to task %s", task.ID)
	}

	slot, err := a.WorkbenchSvc.Create(workbench.CreateInput{
		Title:        "Auth work",
		LinkedTaskID: task.ID,
	})
	if err != nil {
		t.Fatalf("Create slot: %v", err)
	}

	// Delete task: notes must detach into standalone 随笔 (not deleted), and slot link cleared.
	if err := a.TaskSvc.Delete(IDInput{ID: task.ID}); err != nil {
		t.Fatalf("Delete task: %v", err)
	}

	allNotes, err := a.NoteSvc.List(nil)
	if err != nil {
		t.Fatalf("List notes: %v", err)
	}
	if len(allNotes) != 1 || allNotes[0].TaskID != nil || allNotes[0].Content != "Remember refresh token rotation" {
		t.Fatalf("expected detached standalone note, got %+v", allNotes)
	}

	updatedSlot, err := a.Workbench.Get(slot.ID)
	if err != nil {
		t.Fatalf("Get slot: %v", err)
	}
	if updatedSlot.LinkedTaskID != "" {
		t.Fatalf("expected dangling linkedTaskId cleared, got %q", updatedSlot.LinkedTaskID)
	}

	sink.mu.Lock()
	foundDetached := false
	for _, evt := range sink.notes {
		if evt.Reason == "detached" {
			foundDetached = true
		}
	}
	sink.mu.Unlock()
	if !foundDetached {
		t.Fatalf("expected notes:changed event with reason=detached")
	}
}

func TestWorkbenchCompleteOptionallyCompletesLinkedTask(t *testing.T) {
	a, _, _ := openTestApp(t, time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))

	t1, err := a.TaskSvc.Create(tasks.CreateInput{Kind: tasks.KindSide, Title: "Ship PR"})
	if err != nil {
		t.Fatalf("Create t1: %v", err)
	}
	t2, err := a.TaskSvc.Create(tasks.CreateInput{Kind: tasks.KindSide, Title: "Keep open"})
	if err != nil {
		t.Fatalf("Create t2: %v", err)
	}

	s1, err := a.WorkbenchSvc.Create(workbench.CreateInput{Title: "S1", LinkedTaskID: t1.ID})
	if err != nil {
		t.Fatalf("Create s1: %v", err)
	}
	s2, err := a.WorkbenchSvc.Create(workbench.CreateInput{Title: "S2", LinkedTaskID: t2.ID})
	if err != nil {
		t.Fatalf("Create s2: %v", err)
	}

	if _, err := a.WorkbenchSvc.Complete(WorkbenchCompleteInput{ID: s1.ID, CompleteLinkedTask: true}); err != nil {
		t.Fatalf("Complete s1: %v", err)
	}
	if _, err := a.WorkbenchSvc.Complete(WorkbenchCompleteInput{ID: s2.ID, CompleteLinkedTask: false}); err != nil {
		t.Fatalf("Complete s2: %v", err)
	}

	got1, err := a.Tasks.Get(t1.ID)
	if err != nil || got1.Status != tasks.StatusCompleted {
		t.Fatalf("expected t1 completed, got status=%q err=%v", got1.Status, err)
	}
	got2, err := a.Tasks.Get(t2.ID)
	if err != nil || got2.Status != tasks.StatusActive {
		t.Fatalf("expected t2 still active, got status=%q err=%v", got2.Status, err)
	}
}

func TestReminderTimerPeriodRolloverAndSettingsSyncEmitEvents(t *testing.T) {
	start := time.Date(2026, 11, 25, 3, 50, 0, 0, time.UTC)
	a, clk, sink := openTestApp(t, start)

	// Daily task + running slot with 5m reminder.
	if _, err := a.TaskSvc.Create(tasks.CreateInput{
		Kind:       tasks.KindDaily,
		Title:      "Read docs",
		Recurrence: &tasks.TaskRecurrence{Freq: tasks.FreqDaily},
	}); err != nil {
		t.Fatalf("Create daily task: %v", err)
	}
	remind := 5
	slot, err := a.WorkbenchSvc.Create(workbench.CreateInput{
		Title:           "CI pipeline",
		State:           workbench.StateRunning,
		RemindInMinutes: &remind,
	})
	if err != nil {
		t.Fatalf("Create running slot: %v", err)
	}

	// Advance 5 minutes -> reminder timer transitions running -> ready and broadcasts workbench:changed.
	clk.Advance(5 * time.Minute)
	gotSlot, err := a.Workbench.Get(slot.ID)
	if err != nil {
		t.Fatalf("Get slot: %v", err)
	}
	if gotSlot.State != workbench.StateReady {
		t.Fatalf("expected slot ready after 5m, got %s", gotSlot.State)
	}

	// Advance another 6 minutes past 04:00 dayStartHour -> triggers period rollover & tasks:changed.
	clk.Advance(6 * time.Minute)
	listRes, err := a.TaskSvc.List()
	if err != nil {
		t.Fatalf("TaskSvc.List: %v", err)
	}
	if listRes.PeriodKey != "2026-11-25" {
		t.Fatalf("periodKey = %q, want 2026-11-25", listRes.PeriodKey)
	}

	// Update settings (pinned=true, dayStartHour=6) -> syncs Dock and emits settings:changed.
	pinned := true
	hour := 6
	updatedSettings, err := a.SettingsSvc.Update(settings.Patch{
		Pinned:       &pinned,
		DayStartHour: &hour,
	})
	if err != nil {
		t.Fatalf("SettingsSvc.Update: %v", err)
	}
	if !updatedSettings.Pinned || updatedSettings.DayStartHour != 6 {
		t.Fatalf("unexpected settings: %+v", updatedSettings)
	}
	_, dockPinned, _, _ := a.Dock.State()
	if !dockPinned {
		t.Fatalf("expected Dock controller pinned synced to true")
	}

	sink.mu.Lock()
	wbEvents := len(sink.workbench)
	taskEvents := len(sink.tasks)
	settingsEvents := len(sink.settings)
	sink.mu.Unlock()
	if wbEvents < 2 {
		t.Fatalf("expected >=2 workbench:changed events (create + reminder), got %d", wbEvents)
	}
	if taskEvents < 2 {
		t.Fatalf("expected >=2 tasks:changed events (create + rollover), got %d", taskEvents)
	}
	if settingsEvents != 1 {
		t.Fatalf("expected 1 settings:changed event, got %d", settingsEvents)
	}
}

func TestJSONv2TriStateDecodingCompatibility(t *testing.T) {
	// MyGo decodes bound method args using encoding/json/v2. Verify @core's
	// custom UnmarshalJSON methods preserve tri-state null semantics under v2.
	var wbUpd workbench.UpdateInput
	if err := json.Unmarshal([]byte(`{"id":"s1","linkedTaskId":null}`), &wbUpd); err != nil {
		t.Fatalf("json/v2 workbench.UpdateInput: %v", err)
	}
	if !wbUpd.ClearLinkedTaskID || wbUpd.LinkedTaskID != nil {
		t.Fatalf("expected ClearLinkedTaskID=true, got %+v", wbUpd)
	}

	var wbState workbench.SetStateInput
	if err := json.Unmarshal([]byte(`{"id":"s1","state":"running","remindInMinutes":null}`), &wbState); err != nil {
		t.Fatalf("json/v2 workbench.SetStateInput: %v", err)
	}
	if !wbState.ClearRemind || wbState.RemindInMinutes != nil {
		t.Fatalf("expected ClearRemind=true, got %+v", wbState)
	}

	var taskUpd tasks.UpdateInput
	if err := json.Unmarshal([]byte(`{"id":"t1","quotaTarget":null,"deadline":null}`), &taskUpd); err != nil {
		t.Fatalf("json/v2 tasks.UpdateInput: %v", err)
	}
	if !taskUpd.ClearQuota || !taskUpd.ClearDeadline || taskUpd.ClearScheduledFor {
		t.Fatalf("unexpected taskUpd clear flags: %+v", taskUpd)
	}

	var noteList notes.ListInput
	if err := json.Unmarshal([]byte(`{"taskId":null,"query":"hi"}`), &noteList); err != nil {
		t.Fatalf("json/v2 notes.ListInput: %v", err)
	}
	if !noteList.FilterByTask || noteList.TaskID != nil || noteList.Query != "hi" {
		t.Fatalf("unexpected noteList: %+v", noteList)
	}

	var settingsClear settings.Patch
	if err := json.Unmarshal([]byte(`{"barX":null,"barY":null}`), &settingsClear); err != nil {
		t.Fatalf("json/v2 settings.Patch clear: %v", err)
	}
	if !settingsClear.ClearBarX || !settingsClear.ClearBarY || settingsClear.BarX != nil || settingsClear.BarY != nil {
		t.Fatalf("unexpected settingsClear: %+v", settingsClear)
	}

	var settingsSet settings.Patch
	if err := json.Unmarshal([]byte(`{"barMode":"standalone","barX":420,"barY":980}`), &settingsSet); err != nil {
		t.Fatalf("json/v2 settings.Patch set: %v", err)
	}
	if settingsSet.ClearBarX || settingsSet.ClearBarY || settingsSet.BarMode == nil || *settingsSet.BarMode != settings.BarModeStandalone ||
		settingsSet.BarX == nil || *settingsSet.BarX != 420 || settingsSet.BarY == nil || *settingsSet.BarY != 980 {
		t.Fatalf("unexpected settingsSet: %+v", settingsSet)
	}
}

func TestEndToEndUnixSocketIPCCommands(t *testing.T) {
	a, _, sink := openTestApp(t, time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))
	sockPath := ipcsock.SocketPath(t.TempDir())
	srv, err := ipcsock.Listen(sockPath, a.HandleIPC)
	if err != nil {
		t.Fatalf("ipcsock.Listen: %v", err)
	}
	defer func() { _ = srv.Close() }()

	client := ipcsock.NewClient(sockPath)
	ctx := context.Background()

	// focus creates a focus slot.
	var focused workbench.WorkSlot
	if err := client.Call(ctx, ipcsock.CmdFocus, ipcsock.FocusParams{
		Title: "Build host",
		Tag:   "Featherlog",
		Note:  "wire mygo services",
	}, &focused); err != nil {
		t.Fatalf("IPC focus: %v", err)
	}
	if focused.State != workbench.StateFocus || focused.Tag != "Featherlog" || focused.Breadcrumb != "wire mygo services" {
		t.Fatalf("unexpected focused slot: %+v", focused)
	}

	// run creates a running slot with reminder without stealing focus.
	var running workbench.WorkSlot
	if err := client.Call(ctx, ipcsock.CmdRun, ipcsock.RunParams{
		Title:         "Claude frontend",
		Tag:           "UI",
		Note:          "waiting for vitest",
		RemindSeconds: 900,
	}, &running); err != nil {
		t.Fatalf("IPC run: %v", err)
	}
	if running.State != workbench.StateRunning || running.RemindAt == nil {
		t.Fatalf("unexpected running slot: %+v", running)
	}

	// ready matches by substring and updates breadcrumb.
	var ready workbench.WorkSlot
	if err := client.Call(ctx, ipcsock.CmdReady, ipcsock.ReadyParams{
		Target: "frontend",
		Note:   "vitest passed",
	}, &ready); err != nil {
		t.Fatalf("IPC ready: %v", err)
	}
	if ready.State != workbench.StateReady || ready.Breadcrumb != "vitest passed" {
		t.Fatalf("unexpected ready slot: %+v", ready)
	}

	// status returns both slots.
	var slots []workbench.WorkSlot
	if err := client.Call(ctx, ipcsock.CmdStatus, nil, &slots); err != nil {
		t.Fatalf("IPC status: %v", err)
	}
	if len(slots) != 2 {
		t.Fatalf("status len = %d, want 2", len(slots))
	}

	// done completes matched slot.
	var doneRes DoneResult
	if err := client.Call(ctx, ipcsock.CmdDone, ipcsock.DoneParams{Target: "frontend"}, &doneRes); err != nil {
		t.Fatalf("IPC done: %v", err)
	}
	if doneRes.Removed.ID != running.ID || len(doneRes.Remaining) != 1 {
		t.Fatalf("unexpected done result: %+v", doneRes)
	}

	// note creates a standalone note.
	var note notes.Note
	if err := client.Call(ctx, ipcsock.CmdNote, ipcsock.NoteParams{Text: "shipped IPC"}, &note); err != nil {
		t.Fatalf("IPC note: %v", err)
	}
	if note.Content != "shipped IPC" || note.TaskID != nil {
		t.Fatalf("unexpected note: %+v", note)
	}

	// toggle broadcasts dock:toggle.
	var toggleRes ipcsock.ToggleResult
	if err := client.Call(ctx, ipcsock.CmdToggle, ipcsock.ToggleParams{}, &toggleRes); err != nil {
		t.Fatalf("IPC toggle: %v", err)
	}
	if !toggleRes.Expanded {
		t.Fatalf("expected toggle expanded=true")
	}

	sink.mu.Lock()
	toggles := len(sink.toggles)
	sink.mu.Unlock()
	if toggles != 1 {
		t.Fatalf("expected 1 dock:toggle event, got %d", toggles)
	}
}

type fakeAppWindow struct {
	bounds       dock.Rect
	shown        int
	hidden       int
	bg           string
	moveHandlers []func()
}

func (f *fakeAppWindow) Bounds() dock.Rect           { return f.bounds }
func (f *fakeAppWindow) SetBounds(r dock.Rect)       { f.bounds = r }
func (f *fakeAppWindow) Show()                       { f.shown++ }
func (f *fakeAppWindow) ShowInactive()               { f.shown++ }
func (f *fakeAppWindow) Hide()                       { f.hidden++ }
func (f *fakeAppWindow) Focus()                      {}
func (f *fakeAppWindow) SetBackgroundColor(c string) { f.bg = c }
func (f *fakeAppWindow) NativeHandle() uintptr       { return 0 }
func (f *fakeAppWindow) RunOnMain(fn func())         { fn() }
func (f *fakeAppWindow) OnBlur(func()) func()        { return func() {} }
func (f *fakeAppWindow) OnMove(fn func()) func() {
	f.moveHandlers = append(f.moveHandlers, fn)
	idx := len(f.moveHandlers) - 1
	return func() { f.moveHandlers[idx] = nil }
}
func (f *fakeAppWindow) triggerMove() {
	for _, fn := range f.moveHandlers {
		if fn != nil {
			fn()
		}
	}
}
func (f *fakeAppWindow) IsDestroyed() bool { return false }

func TestSettingsThemeSyncAndDockHideOnCollapse(t *testing.T) {
	a, _, _ := openTestApp(t, time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))
	win := &fakeAppWindow{}
	a.Dock.Attach(win)

	theme := settings.ThemeGraphite
	if _, err := a.SettingsSvc.Update(settings.Patch{Theme: &theme}); err != nil {
		t.Fatalf("SettingsSvc.Update theme: %v", err)
	}
	if win.bg != dock.GraphiteBackgroundColor {
		t.Fatalf("window bg = %q, want %q", win.bg, dock.GraphiteBackgroundColor)
	}

	open := true
	a.Dock.Toggle(&open)
	if win.shown != 1 {
		t.Fatalf("expected window shown once, got %d", win.shown)
	}
	if err := a.DockSvc.Resize(dock.Geometry{Width: 880, Height: 520, Expanded: false}); err != nil {
		t.Fatalf("DockSvc.Resize collapse: %v", err)
	}
	if win.hidden != 1 {
		t.Fatalf("expected window hidden on Resize(expanded=false), got %d", win.hidden)
	}
}

func TestOpenMigratesV1ElectronDataDirEndToEnd(t *testing.T) {
	dir := t.TempDir()
	writeFile := func(rel, content string) {
		t.Helper()
		full := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", filepath.Dir(full), err)
		}
		if err := os.WriteFile(full, []byte(content), 0o600); err != nil {
			t.Fatalf("write %s: %v", full, err)
		}
	}

	v1SettingsRaw := `{
  "shell": {
    "paper": "aged",
    "sound": false,
    "volume": 7
  },
  "plugins": {
    "quest": {
      "dayStartHour": 5
    }
  }
}`
	writeFile("settings.json", v1SettingsRaw)

	writeFile(filepath.Join("plugins", "quest", "state.json"), `{
  "schemaVersion": 2,
  "quests": [
    {"id": "quest-career", "key": "record:fb13abae-1111-2222-3333-444444444444"},
    {"id": "quest-daily", "key": "record:fb13abae-5555-6666-7777-888888888888"},
    {"id": "quest-done", "key": "record:fb13abae-9999-aaaa-bbbb-cccccccccccc"},
    {"id": "quest-archived", "key": "record:fb13abae-dddd-eeee-ffff-000000000000"}
  ],
  "meta": {"lastPeriodKey": "2026-11-25"}
}`)

	// Active main quest with dummy "1" chapter ("简历") and counted objective ("人月神话" 4/19).
	writeFile(filepath.Join("plugins", "quest", "record%3Afb13abae-1111-2222-3333-444444444444.json"), `{
  "quest": {
    "id": "quest-career",
    "kind": "main",
    "title": "秋招冲刺",
    "status": "active",
    "chapters": [
      {
        "id": "ch-resume",
        "title": "简历",
        "objectives": [
          {"id": "obj-resume", "text": "1"}
        ]
      },
      {
        "id": "ch-book",
        "title": "经典阅读",
        "objectives": [
          {
            "id": "obj-mmm",
            "text": "读完人月神话",
            "count": {"target": 19, "current": 4, "unit": "章"}
          }
        ]
      }
    ],
    "deadline": "2026-12-01",
    "order": 0,
    "createdAt": "2026-10-29T16:24:45.897Z",
    "updatedAt": "2026-11-24T12:00:00.000Z"
  },
  "history": []
}`)

	// Daily quest with quota progress and history.
	writeFile(filepath.Join("plugins", "quest", "record%3Afb13abae-5555-6666-7777-888888888888.json"), `{
  "quest": {
    "id": "quest-daily",
    "kind": "daily",
    "title": "每日刷题",
    "status": "active",
    "chapters": [],
    "recurrence": {"freq": "daily"},
    "quota": {"target": 5},
    "cycle": {"periodKey": "2026-11-25", "current": 2, "done": false},
    "order": 0,
    "createdAt": "2026-11-01T08:00:00.000Z",
    "updatedAt": "2026-11-25T07:00:00.000Z"
  },
  "history": ["2026-11-23", "2026-11-24"]
}`)

	// Completed quest.
	writeFile(filepath.Join("plugins", "quest", "record%3Afb13abae-9999-aaaa-bbbb-cccccccccccc.json"), `{
  "quest": {
    "id": "quest-done",
    "kind": "side",
    "title": "完成实习项目包装",
    "status": "completed",
    "chapters": [
      {
        "id": "ch-done",
        "title": "",
        "doneAt": "2026-11-13T12:25:09.189Z",
        "objectives": [
          {"id": "obj-done", "text": "输出 STAR 复盘", "doneAt": "2026-11-13T12:25:09.189Z"}
        ]
      }
    ],
    "order": 1,
    "createdAt": "2026-10-15T10:00:00.000Z",
    "updatedAt": "2026-11-13T12:25:09.189Z",
    "completedAt": "2026-11-13T12:25:09.189Z"
  },
  "history": []
}`)

	// Archived quest.
	writeFile(filepath.Join("plugins", "quest", "record%3Afb13abae-dddd-eeee-ffff-000000000000.json"), `{
  "quest": {
    "id": "quest-archived",
    "kind": "side",
    "title": "旧版草稿",
    "status": "archived",
    "chapters": [],
    "order": 2,
    "createdAt": "2026-09-01T10:00:00.000Z",
    "updatedAt": "2026-09-05T10:00:00.000Z"
  },
  "history": []
}`)

	// Notes: one linked to quest-career, one standalone, one linked to a missing quest.
	writeFile(filepath.Join("plugins", "notes", "note%3A11111111-aaaa-bbbb-cccc-000000000001.json"), `{
  "schemaVersion": 1,
  "note": {
    "id": "note-linked",
    "text": "简历项目指标需量化到毫秒级",
    "questId": "quest-career",
    "createdAt": "2026-11-24T08:45:07.118Z",
    "updatedAt": "2026-11-24T08:45:07.118Z"
  }
}`)
	writeFile(filepath.Join("plugins", "notes", "note%3A22222222-aaaa-bbbb-cccc-000000000002.json"), `{
  "schemaVersion": 1,
  "note": {
    "id": "note-free",
    "text": "独立随笔内容",
    "questId": null,
    "createdAt": "2026-11-25T06:00:00.000Z",
    "updatedAt": "2026-11-25T06:00:00.000Z"
  }
}`)
	writeFile(filepath.Join("plugins", "notes", "note%3A33333333-aaaa-bbbb-cccc-000000000003.json"), `{
  "schemaVersion": 1,
  "note": {
    "id": "note-orphan",
    "text": "已删任务的遗留手记",
    "questId": "quest-nonexistent",
    "createdAt": "2026-11-22T06:00:00.000Z",
    "updatedAt": "2026-11-22T06:00:00.000Z"
  }
}`)

	snapshotPlugins := func() map[string][]byte {
		t.Helper()
		snap := make(map[string][]byte)
		root := filepath.Join(dir, "plugins")
		if err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			raw, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			snap[rel] = raw
			return nil
		}); err != nil {
			t.Fatalf("snapshot plugins: %v", err)
		}
		return snap
	}
	pluginsBefore := snapshotPlugins()

	clk := clock.NewFake(time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))
	corruptCalled := false
	a, err := Open(Config{
		DataDir: dir,
		Clock:   clk,
		Events:  &recordingSink{},
		DockCfg: dock.Config{
			Screen: noopScreen{},
			Layer:  noopLayer{},
		},
		OnCorrupt: func(backupPath string, cause error) {
			corruptCalled = true
		},
	})
	if err != nil {
		t.Fatalf("app.Open on v1 dataDir failed: %v", err)
	}

	if corruptCalled {
		t.Fatalf("app.Open unexpectedly triggered OnCorrupt on v1 settings.json")
	}

	// Verify migrated settings & atomic v1 backup.
	gotSettings := a.SettingsSvc.Get()
	wantSettings := settings.Settings{
		Theme:        settings.ThemeStone,
		DayStartHour: 5,
		Sound:        false,
		Volume:       7,
		Pinned:       false,
		BarMode:      settings.BarModeAuto,
	}
	if !settings.Equal(gotSettings, wantSettings) {
		t.Fatalf("Settings = %+v, want %+v", gotSettings, wantSettings)
	}
	bakRaw, err := os.ReadFile(filepath.Join(dir, migrate.SettingsBackupFileName))
	if err != nil || string(bakRaw) != v1SettingsRaw {
		t.Fatalf("settings.v1.json.bak mismatch: err=%v raw=%q", err, string(bakRaw))
	}

	// Verify migrated tasks.
	taskList, err := a.TaskSvc.List()
	if err != nil {
		t.Fatalf("TaskSvc.List: %v", err)
	}
	if len(taskList.Tasks) != 4 {
		t.Fatalf("len(tasks) = %d, want 4", len(taskList.Tasks))
	}
	taskMap := make(map[string]tasks.Task, len(taskList.Tasks))
	for _, tk := range taskList.Tasks {
		taskMap[tk.ID] = tk
	}

	career := taskMap["quest-career"]
	if len(career.Items) != 2 {
		t.Fatalf("career items = %+v, want 2 items", career.Items)
	}
	if career.Items[0].Text != "简历" || career.Items[0].Done {
		t.Fatalf("career item[0] = %+v, want 简历 done=false", career.Items[0])
	}
	if career.Items[1].Text != "经典阅读 · 读完人月神话" || *career.Items[1].Current != 4 || *career.Items[1].Target != 19 {
		t.Fatalf("career item[1] = %+v, want 经典阅读 · 读完人月神话 4/19", career.Items[1])
	}

	daily := taskMap["quest-daily"]
	if daily.Kind != tasks.KindDaily || daily.Status != tasks.StatusActive ||
		daily.Quota == nil || daily.Quota.Current != 2 || daily.Quota.Target != 5 ||
		daily.Streak == nil || *daily.Streak != 2 {
		t.Fatalf("unexpected migrated daily task: %+v", daily)
	}
	if taskMap["quest-done"].Status != tasks.StatusCompleted {
		t.Fatalf("quest-done status = %s, want completed", taskMap["quest-done"].Status)
	}
	if taskMap["quest-archived"].Status != tasks.StatusArchived {
		t.Fatalf("quest-archived status = %s, want archived", taskMap["quest-archived"].Status)
	}

	// Verify migrated notes (newest first, linked vs standalone vs detached).
	allNotes, err := a.NoteSvc.List(nil)
	if err != nil {
		t.Fatalf("NoteSvc.List: %v", err)
	}
	if len(allNotes) != 3 {
		t.Fatalf("len(notes) = %d, want 3", len(allNotes))
	}
	if allNotes[0].ID != "note-free" || allNotes[0].TaskID != nil {
		t.Fatalf("allNotes[0] = %+v, want note-free standalone", allNotes[0])
	}
	if allNotes[1].ID != "note-linked" || allNotes[1].TaskID == nil || *allNotes[1].TaskID != "quest-career" {
		t.Fatalf("allNotes[1] = %+v, want note-linked attached to quest-career", allNotes[1])
	}
	if allNotes[2].ID != "note-orphan" || allNotes[2].TaskID != nil {
		t.Fatalf("allNotes[2] = %+v, want note-orphan detached to nil", allNotes[2])
	}

	// Mutate a migrated task via v2 service and re-open to verify migration is idempotent.
	if _, err := a.TaskSvc.StepQuota(tasks.StepQuotaInput{
		ID:     "quest-career",
		ItemID: "obj-mmm",
		Delta:  1,
	}); err != nil {
		t.Fatalf("StepQuota on migrated item: %v", err)
	}
	a.Close()

	a2, err := Open(Config{
		DataDir: dir,
		Clock:   clk,
		Events:  &recordingSink{},
		DockCfg: dock.Config{
			Screen: noopScreen{},
			Layer:  noopLayer{},
		},
	})
	if err != nil {
		t.Fatalf("second app.Open failed: %v", err)
	}
	defer a2.Close()

	reloadedCareer, err := a2.Tasks.Get("quest-career")
	if err != nil {
		t.Fatalf("reloaded Get quest-career: %v", err)
	}
	if *reloadedCareer.Items[1].Current != 5 {
		t.Fatalf("expected persisted v2 mutation current=5 after reopen, got %d", *reloadedCareer.Items[1].Current)
	}

	// Non-destructive guarantee: plugins/ directory must remain byte-for-byte untouched.
	pluginsAfter := snapshotPlugins()
	if len(pluginsBefore) != len(pluginsAfter) {
		t.Fatalf("plugins/ file count changed: before=%d after=%d", len(pluginsBefore), len(pluginsAfter))
	}
	for k, want := range pluginsBefore {
		if !bytes.Equal(want, pluginsAfter[k]) {
			t.Fatalf("plugins/%s was modified during app.Open migration", k)
		}
	}
}

func TestDockServiceToggleAndMiniBarSettingsWiring(t *testing.T) {
	dir := t.TempDir()
	clk := clock.NewFake(time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))
	sink := &recordingSink{}

	kdeFalse := false
	a, err := Open(Config{
		DataDir: dir,
		Clock:   clk,
		Events:  sink,
		DockCfg: dock.Config{
			Screen:            noopScreen{},
			Layer:             noopLayer{},
			StartHidden:       true,
			PlatformOS:        "windows",
			KDESession:        &kdeFalse,
			PlasmoidInstalled: &kdeFalse,
		},
		QuitFunc: func() {},
	})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer a.Close()

	panelWin := &fakeAppWindow{}
	miniWin := &fakeAppWindow{}
	a.Dock.Attach(panelWin)
	a.Dock.AttachMiniBar(miniWin)

	// PreloadScript exposes DockService.toggle.
	if !strings.Contains(PreloadScript, `invoke("DockService.Toggle"`) {
		t.Fatalf("PreloadScript missing DockService.Toggle")
	}

	// 1. DockService.Toggle toggles and sets explicit expanded state, and
	// DockService.Resize(expanded=false) broadcasts dock:toggle { expanded: false }
	// so the standalone Mini-Bar stays in sync when the Panel collapses via Esc/blur.
	res, err := a.DockSvc.Toggle(nil)
	if err != nil || !res.Expanded {
		t.Fatalf("DockSvc.Toggle(nil) = (%+v, %v), want expanded=true", res, err)
	}
	if err := a.DockSvc.Resize(dock.Geometry{Width: dock.PanelWidth, Height: dock.PanelHeight, Expanded: false}); err != nil {
		t.Fatalf("DockSvc.Resize(expanded=false): %v", err)
	}
	sink.mu.Lock()
	gotToggles := append([]DockToggleEvent(nil), sink.toggles...)
	sink.mu.Unlock()
	if len(gotToggles) != 2 || gotToggles[0].Expanded == nil || !*gotToggles[0].Expanded ||
		gotToggles[1].Expanded == nil || *gotToggles[1].Expanded {
		t.Fatalf("dock:toggle events after Toggle+Resize(false) = %+v, want [true, false]", gotToggles)
	}
	expand := true
	res, err = a.DockSvc.Toggle(&DockToggleInput{Expanded: &expand})
	if err != nil || !res.Expanded {
		t.Fatalf("DockSvc.Toggle(true) = (%+v, %v), want expanded=true", res, err)
	}
	collapse := false
	res, err = a.DockSvc.Toggle(&DockToggleInput{Expanded: &collapse})
	if err != nil || res.Expanded {
		t.Fatalf("DockSvc.Toggle(false) = (%+v, %v), want expanded=false", res, err)
	}

	// 2. MiniBar shown initially in auto mode on Windows; drag persists to settings.json after 400ms.
	if vis, _ := a.Dock.MiniBarState(); !vis {
		t.Fatalf("expected MiniBar visible on Windows auto mode")
	}
	miniWin.bounds = dock.Rect{X: 1200, Y: 1036, Width: dock.MiniBarWidth, Height: dock.MiniBarHeight}
	miniWin.triggerMove()
	clk.Advance(400 * time.Millisecond)

	st := a.SettingsSvc.Get()
	if st.BarX == nil || *st.BarX != 1200 || st.BarY == nil || *st.BarY != 1036 {
		t.Fatalf("dragged position not persisted to Settings: %+v", st)
	}

	// 3. Updating barMode to tray-only hides MiniBar; resetting barX/barY via JSON null clears coords.
	trayOnly := settings.BarModeTrayOnly
	if _, err := a.SettingsSvc.Update(settings.Patch{BarMode: &trayOnly}); err != nil {
		t.Fatalf("Update tray-only: %v", err)
	}
	if vis, _ := a.Dock.MiniBarState(); vis {
		t.Fatalf("expected MiniBar hidden in tray-only mode")
	}

	var resetPatch settings.Patch
	if err := json.Unmarshal([]byte(`{"barMode":"standalone","barX":null,"barY":null}`), &resetPatch); err != nil {
		t.Fatalf("unmarshal reset patch: %v", err)
	}
	updated, err := a.SettingsSvc.Update(resetPatch)
	if err != nil {
		t.Fatalf("Update resetPatch: %v", err)
	}
	if updated.BarMode != settings.BarModeStandalone || updated.BarX != nil || updated.BarY != nil {
		t.Fatalf("unexpected updated settings after reset: %+v", updated)
	}
	vis, bounds := a.Dock.MiniBarState()
	wantDefault := dock.ComputeMiniBarBounds(noopScreen{}.ActiveDisplay(dock.Rect{}), nil, nil)
	if !vis || bounds != wantDefault {
		t.Fatalf("after reset: vis=%v bounds=%+v, want true %+v", vis, bounds, wantDefault)
	}
}
