package tray

import (
	"bytes"
	"image/color"
	"image/png"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/muyuzhong/featherlog/internal/app"
	"github.com/muyuzhong/featherlog/internal/clock"
	"github.com/muyuzhong/featherlog/internal/dock"
	"github.com/muyuzhong/featherlog/internal/settings"
	"github.com/muyuzhong/featherlog/internal/tasks"
	"github.com/muyuzhong/featherlog/internal/workbench"
)

type trayTestScreen struct{}

func (trayTestScreen) ActiveDisplay(dock.Rect) dock.Display {
	return dock.Display{
		Bounds:   dock.Rect{Width: 1920, Height: 1080},
		WorkArea: dock.Rect{Width: 1920, Height: 1032},
		Primary:  true,
	}
}
func (trayTestScreen) OnDisplaysChanged(func()) func() { return func() {} }

type trayTestLayer struct{}

func (trayTestLayer) Available() bool                      { return false }
func (trayTestLayer) AnchorBottomCenter(uintptr, int) bool { return false }

type trayTestSink struct{}

func (trayTestSink) WorkbenchChanged([]workbench.WorkSlot) {}
func (trayTestSink) TasksChanged(tasks.ListResult)         {}
func (trayTestSink) NotesChanged(app.NotesChangedEvent)    {}
func (trayTestSink) SettingsChanged(settings.Settings)     {}
func (trayTestSink) DockToggle(app.DockToggleEvent)        {}

type fakeTrayBackend struct {
	mu        sync.Mutex
	title     string
	tooltip   string
	menu      []MenuItemSpec
	destroyed bool
}

func (f *fakeTrayBackend) SetTitle(title string) {
	f.mu.Lock()
	f.title = title
	f.mu.Unlock()
}

func (f *fakeTrayBackend) SetToolTip(tip string) {
	f.mu.Lock()
	f.tooltip = tip
	f.mu.Unlock()
}

func (f *fakeTrayBackend) SetMenu(items []MenuItemSpec) {
	f.mu.Lock()
	f.menu = items
	f.mu.Unlock()
}

func (f *fakeTrayBackend) Destroy() {
	f.mu.Lock()
	f.destroyed = true
	f.mu.Unlock()
}

func (f *fakeTrayBackend) snapshot() (title, tooltip string, menu []MenuItemSpec, destroyed bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.title, f.tooltip, f.menu, f.destroyed
}

func findMenuItem(items []MenuItemSpec, id string) *MenuItemSpec {
	for i := range items {
		if items[i].ID == id {
			return &items[i]
		}
		if len(items[i].Submenu) > 0 {
			if found := findMenuItem(items[i].Submenu, id); found != nil {
				return found
			}
		}
	}
	return nil
}

func TestTemplateIconPNGMonochromeAndTransparent(t *testing.T) {
	raw := TemplateIconPNG()
	if len(raw) == 0 {
		t.Fatalf("TemplateIconPNG returned empty bytes")
	}

	img, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("png.Decode failed: %v", err)
	}
	b := img.Bounds()
	if b.Dx() != 32 || b.Dy() != 32 {
		t.Fatalf("icon dimensions = %dx%d, want 32x32", b.Dx(), b.Dy())
	}

	var transparent, opaque, partial int
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			c := color.NRGBAModel.Convert(img.At(x, y)).(color.NRGBA)
			if c.A == 0 {
				transparent++
				continue
			}
			if c.R != inkR || c.G != inkG || c.B != inkB {
				t.Fatalf("pixel (%d,%d) = rgba(%d,%d,%d,%d), want monochrome ink (%d,%d,%d,A>0)",
					x, y, c.R, c.G, c.B, c.A, inkR, inkG, inkB)
			}
			if c.A == 255 {
				opaque++
			} else {
				partial++
			}
		}
	}

	if transparent == 0 {
		t.Fatalf("expected transparent background pixels (A==0)")
	}
	if opaque < 50 {
		t.Fatalf("expected visible opaque glyph pixels, got %d", opaque)
	}
	if partial == 0 {
		t.Fatalf("expected anti-aliased edge pixels (0 < A < 255)")
	}

	// Mutating returned slice must not corrupt cached bytes.
	raw[0] ^= 0xff
	raw2 := TemplateIconPNG()
	if _, err := png.Decode(bytes.NewReader(raw2)); err != nil {
		t.Fatalf("cached icon corrupted by caller mutation: %v", err)
	}
}

func TestFormatStatusTitleAndToolTipLocalized(t *testing.T) {
	longTitle := "这是一个非常非常长的并发工作槽标题测试"
	focusedSlots := []workbench.WorkSlot{
		{ID: "s1", Title: longTitle, Breadcrumb: "check tray menu", State: workbench.StateFocus},
		{ID: "s2", Title: "CI build", State: workbench.StateReady},
	}

	// Non-darwin title is always empty in both languages.
	for _, goos := range []string{"windows", "linux"} {
		for _, lang := range []settings.LanguageMode{settings.LangZH, settings.LangEN} {
			if got := FormatTitle(goos, focusedSlots, lang); got != "" {
				t.Fatalf("FormatTitle(%q, %q) = %q, want empty", goos, lang, got)
			}
		}
	}

	// Darwin focused title: "┃ " + up to 14 runes.
	darwinFocus := FormatTitle("darwin", focusedSlots, settings.LangZH)
	if !strings.HasPrefix(darwinFocus, "┃ ") {
		t.Fatalf("darwin focus title = %q, want '┃ ' prefix", darwinFocus)
	}
	trimmed := strings.TrimPrefix(darwinFocus, "┃ ")
	if n := len([]rune(trimmed)); n > maxDarwinTitleRunes {
		t.Fatalf("darwin focus short title length = %d runes (%q), want <= %d", n, trimmed, maxDarwinTitleRunes)
	}

	// Darwin with no focus and ready slots -> "待看 N" (zh) / "Ready N" (en).
	readyAndRunning := []workbench.WorkSlot{
		{ID: "s1", Title: "PR 1", State: workbench.StateReady},
		{ID: "s2", Title: "PR 2", State: workbench.StateReady},
		{ID: "s3", Title: "BG", State: workbench.StateRunning},
	}
	if got := FormatTitle("darwin", readyAndRunning, settings.LangZH); got != "待看 2" {
		t.Fatalf("darwin ready title (zh) = %q, want '待看 2'", got)
	}
	if got := FormatTitle("darwin", readyAndRunning, settings.LangEN); got != "Ready 2" {
		t.Fatalf("darwin ready title (en) = %q, want 'Ready 2'", got)
	}

	// Darwin idle or running-only -> "".
	for _, lang := range []settings.LanguageMode{settings.LangZH, settings.LangEN} {
		if got := FormatTitle("darwin", nil, lang); got != "" {
			t.Fatalf("darwin idle title (%q) = %q, want empty", lang, got)
		}
		if got := FormatTitle("darwin", []workbench.WorkSlot{{ID: "s1", Title: "BG", State: workbench.StateRunning}}, lang); got != "" {
			t.Fatalf("darwin running-only title (%q) = %q, want empty", lang, got)
		}
	}

	// ToolTip zh formatting.
	_, tipZH := FormatStatus("linux", focusedSlots, 2, 5, settings.LangZH)
	if !strings.HasPrefix(tipZH, "羽记 · 专注中：") || !strings.Contains(tipZH, "check tray menu") || !strings.HasSuffix(tipZH, "（待办 2/5）") {
		t.Fatalf("unexpected focus tooltip (zh): %q", tipZH)
	}
	readyRunTipZH := FormatToolTip(readyAndRunning, 1, 4, settings.LangZH)
	if readyRunTipZH != "羽记 · 待看 2 · 后台 1（待办 1/4）" {
		t.Fatalf("unexpected ready+running tooltip (zh): %q", readyRunTipZH)
	}
	idleTipZH := FormatToolTip(nil, 0, 3, settings.LangZH)
	if idleTipZH != "羽记 · 空闲（待办 0/3）" {
		t.Fatalf("unexpected idle tooltip (zh): %q", idleTipZH)
	}

	// ToolTip en formatting.
	_, tipEN := FormatStatus("linux", focusedSlots, 2, 5, settings.LangEN)
	if !strings.HasPrefix(tipEN, "Featherlog · Focusing: ") || !strings.Contains(tipEN, "check tray menu") || !strings.HasSuffix(tipEN, " (Tasks 2/5)") {
		t.Fatalf("unexpected focus tooltip (en): %q", tipEN)
	}
	readyRunTipEN := FormatToolTip(readyAndRunning, 1, 4, settings.LangEN)
	if readyRunTipEN != "Featherlog · Ready 2 · Running 1 (Tasks 1/4)" {
		t.Fatalf("unexpected ready+running tooltip (en): %q", readyRunTipEN)
	}
	idleTipEN := FormatToolTip(nil, 0, 3, settings.LangEN)
	if idleTipEN != "Featherlog · Idle (Tasks 0/3)" {
		t.Fatalf("unexpected idle tooltip (en): %q", idleTipEN)
	}
}

func TestTrayControllerMenuActionsI18nAndLiveSync(t *testing.T) {
	clk := clock.NewFake(time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))
	quitCalls := 0

	application, err := app.Open(app.Config{
		DataDir: t.TempDir(),
		Clock:   clk,
		Events:  trayTestSink{},
		DockCfg: dock.Config{
			Screen:      trayTestScreen{},
			Layer:       trayTestLayer{},
			StartHidden: true,
		},
		QuitFunc: func() { quitCalls++ },
	})
	if err != nil {
		t.Fatalf("app.Open: %v", err)
	}
	defer application.Close()

	// Seed 1 completed task + 1 active task -> 待办 1/2 / Tasks 1/2.
	t1, err := application.Tasks.Create(tasks.CreateInput{Title: "Ship tray"})
	if err != nil {
		t.Fatalf("create task 1: %v", err)
	}
	if _, err := application.Tasks.Complete(tasks.CompleteInput{ID: t1.ID, Completed: true}); err != nil {
		t.Fatalf("complete task 1: %v", err)
	}
	if _, err := application.Tasks.Create(tasks.CreateInput{Title: "Verify windows"}); err != nil {
		t.Fatalf("create task 2: %v", err)
	}

	// Seed 7 slots so we also verify the 6-slot menu cap.
	sFocus, err := application.Workbench.Create(workbench.CreateInput{
		Title:      "Main Slot",
		Breadcrumb: "editing tray",
		State:      workbench.StateFocus,
	})
	if err != nil {
		t.Fatalf("create focus slot: %v", err)
	}
	sReady, err := application.Workbench.Create(workbench.CreateInput{
		Title: "Review PR",
		State: workbench.StateReady,
	})
	if err != nil {
		t.Fatalf("create ready slot: %v", err)
	}
	for i := 0; i < 5; i++ {
		if _, err := application.Workbench.Create(workbench.CreateInput{
			Title: "BG Slot",
			State: workbench.StateRunning,
		}); err != nil {
			t.Fatalf("create running slot %d: %v", i, err)
		}
	}

	backend := &fakeTrayBackend{}
	ctrl, err := Start(Config{
		App:        application,
		Backend:    backend,
		PlatformOS: "darwin",
		QuitFunc:   func() { quitCalls++ },
	})
	if err != nil {
		t.Fatalf("tray.Start: %v", err)
	}

	title, tooltip, menu, _ := backend.snapshot()
	if title != "┃ Main Slot" {
		t.Fatalf("initial darwin title = %q, want '┃ Main Slot'", title)
	}
	if tooltip != "羽记 · 专注中：Main Slot — editing tray（待办 1/2）" {
		t.Fatalf("initial tooltip = %q", tooltip)
	}

	// BarMode submenu must be completely removed.
	if it := findMenuItem(menu, "bar-mode"); it != nil {
		t.Fatalf("bar-mode submenu must not exist, got %+v", it)
	}
	// Reset Bar Position must be hidden when BarX/BarY are nil.
	if it := findMenuItem(menu, "reset-bar-position"); it != nil {
		t.Fatalf("reset-bar-position should be hidden when BarX/BarY are nil, got %+v", it)
	}

	// Verify slot cap (max 6) and [专注] / [待看] labels.
	slotCount := 0
	for _, it := range menu {
		if strings.HasPrefix(it.ID, "slot:") {
			slotCount++
		}
	}
	if slotCount != maxMenuSlots {
		t.Fatalf("menu slot count = %d, want %d", slotCount, maxMenuSlots)
	}
	if it := findMenuItem(menu, "slot:"+sFocus.ID); it == nil || it.Label != "[专注] Main Slot" {
		t.Fatalf("focus menu item = %+v", it)
	}
	if it := findMenuItem(menu, "slot:"+sReady.ID); it == nil || it.Label != "[待看] Review PR" {
		t.Fatalf("ready menu item = %+v", it)
	}

	// Verify Language submenu defaults to zh checked.
	langMenu := findMenuItem(menu, "language")
	if langMenu == nil || langMenu.Kind != MenuSubmenu || langMenu.Label != "语言" {
		t.Fatalf("language submenu = %+v, want label '语言'", langMenu)
	}
	zhRadio := findMenuItem(menu, "language:zh")
	enRadio := findMenuItem(menu, "language:en")
	if zhRadio == nil || zhRadio.Kind != MenuRadio || !zhRadio.Checked || zhRadio.Label != "简体中文" {
		t.Fatalf("zh radio = %+v", zhRadio)
	}
	if enRadio == nil || enRadio.Kind != MenuRadio || enRadio.Checked || enRadio.Label != "English" {
		t.Fatalf("en radio = %+v", enRadio)
	}

	// 1. Toggle panel menu item opens panel and flips label to "收起工作台".
	toggleItem := findMenuItem(menu, "toggle-panel")
	if toggleItem == nil || toggleItem.Label != "打开工作台" {
		t.Fatalf("initial toggle item = %+v, want 打开工作台", toggleItem)
	}
	toggleItem.OnClick()
	_, _, menu, _ = backend.snapshot()
	if toggleItem = findMenuItem(menu, "toggle-panel"); toggleItem == nil || toggleItem.Label != "收起工作台" {
		t.Fatalf("toggled item = %+v, want 收起工作台", toggleItem)
	}

	// 2. Setting custom bar coords reveals "重置滚筒位置".
	x, y := 1200, 1036
	if _, err := application.Settings.Update(settings.Patch{BarX: &x, BarY: &y}); err != nil {
		t.Fatalf("set bar coords: %v", err)
	}
	_, _, menu, _ = backend.snapshot()
	if it := findMenuItem(menu, "reset-bar-position"); it == nil || it.Label != "重置滚筒位置" {
		t.Fatalf("zh reset item = %+v, want 重置滚筒位置", it)
	}

	// 3. Clicking "English" radio switches settings, tooltip, and all menu labels to English.
	findMenuItem(menu, "language:en").OnClick()
	if got := application.Settings.Get().Language; got != settings.LangEN {
		t.Fatalf("Language = %q, want en", got)
	}
	title, tooltip, menu, _ = backend.snapshot()
	if title != "┃ Main Slot" {
		t.Fatalf("en darwin title = %q, want '┃ Main Slot'", title)
	}
	if tooltip != "Featherlog · Focusing: Main Slot — editing tray (Tasks 1/2)" {
		t.Fatalf("en tooltip = %q", tooltip)
	}
	if it := findMenuItem(menu, "toggle-panel"); it == nil || it.Label != "Hide Workbench" {
		t.Fatalf("en toggle item = %+v, want Hide Workbench", it)
	}
	if it := findMenuItem(menu, "slot:"+sFocus.ID); it == nil || it.Label != "[Focus] Main Slot" {
		t.Fatalf("en focus item = %+v", it)
	}
	if it := findMenuItem(menu, "slot:"+sReady.ID); it == nil || it.Label != "[Ready] Review PR" {
		t.Fatalf("en ready item = %+v", it)
	}
	if it := findMenuItem(menu, "language"); it == nil || it.Label != "Language" {
		t.Fatalf("en language submenu = %+v, want Language", it)
	}
	if it := findMenuItem(menu, "language:en"); it == nil || !it.Checked {
		t.Fatalf("expected language:en checked, got %+v", it)
	}
	if it := findMenuItem(menu, "language:zh"); it == nil || it.Checked {
		t.Fatalf("expected language:zh unchecked, got %+v", it)
	}
	resetItemEN := findMenuItem(menu, "reset-bar-position")
	if resetItemEN == nil || resetItemEN.Label != "Reset Bar Position" {
		t.Fatalf("en reset item = %+v, want Reset Bar Position", resetItemEN)
	}
	if it := findMenuItem(menu, "quit"); it == nil || it.Label != "Quit Featherlog" {
		t.Fatalf("en quit item = %+v, want Quit Featherlog", it)
	}

	// 4. Clicking a ready slot focuses it and updates darwin title & English labels.
	findMenuItem(menu, "slot:"+sReady.ID).OnClick()
	title, _, menu, _ = backend.snapshot()
	if title != "┃ Review PR" {
		t.Fatalf("after focus click darwin title = %q, want '┃ Review PR'", title)
	}
	if it := findMenuItem(menu, "slot:"+sReady.ID); it == nil || it.Label != "[Focus] Review PR" {
		t.Fatalf("after focus click item = %+v", it)
	}

	// 5. Clicking "Reset Bar Position" clears BarX/BarY and hides the menu item again.
	findMenuItem(menu, "reset-bar-position").OnClick()
	st := application.Settings.Get()
	if st.BarX != nil || st.BarY != nil {
		t.Fatalf("expected BarX/BarY cleared to nil, got %+v", st)
	}
	_, _, menu, _ = backend.snapshot()
	if it := findMenuItem(menu, "reset-bar-position"); it != nil {
		t.Fatalf("expected reset-bar-position hidden after reset, got %+v", it)
	}

	// 6. Toggle panel closed -> English label flips to "Open Workbench"; switch back to zh -> "退出羽记".
	findMenuItem(menu, "toggle-panel").OnClick()
	_, _, menu, _ = backend.snapshot()
	if it := findMenuItem(menu, "toggle-panel"); it == nil || it.Label != "Open Workbench" {
		t.Fatalf("closed en toggle item = %+v, want Open Workbench", it)
	}
	findMenuItem(menu, "language:zh").OnClick()
	_, _, menu, _ = backend.snapshot()
	quitItem := findMenuItem(menu, "quit")
	if quitItem == nil || quitItem.Label != "退出羽记" {
		t.Fatalf("zh quit item = %+v, want 退出羽记", quitItem)
	}
	quitItem.OnClick()
	if quitCalls != 1 {
		t.Fatalf("quitCalls = %d, want 1", quitCalls)
	}

	// 7. Close unsubscribes and destroys backend.
	ctrl.Close()
	_, _, _, destroyed := backend.snapshot()
	if !destroyed {
		t.Fatalf("expected backend.Destroy() on Close")
	}
}
