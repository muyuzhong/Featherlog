package tray

import (
	"fmt"
	"log"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/muyuzhong/featherlog/internal/app"
	"github.com/muyuzhong/featherlog/internal/settings"
	"github.com/muyuzhong/featherlog/internal/store"
	"github.com/muyuzhong/featherlog/internal/tasks"
	"github.com/muyuzhong/featherlog/internal/workbench"
)

const (
	trayID               = "featherlog-tray"
	maxMenuSlots         = 6
	maxDarwinTitleRunes  = 14
	maxSlotTitleRunes    = 28
	maxRunningTitleRunes = 32
)

// MenuItemKind identifies the kind of entry in a backend-agnostic tray menu.
type MenuItemKind string

const (
	MenuNormal    MenuItemKind = "normal"
	MenuSeparator MenuItemKind = "separator"
	MenuSubmenu   MenuItemKind = "submenu"
	MenuRadio     MenuItemKind = "radio"
)

// MenuItemSpec describes a single system tray menu item.
type MenuItemSpec struct {
	ID       string
	Label    string
	Kind     MenuItemKind
	Checked  bool
	Disabled bool
	Submenu  []MenuItemSpec
	OnClick  func()
}

// Backend abstracts the native system tray icon and context menu.
type Backend interface {
	SetTitle(title string)
	SetToolTip(tip string)
	SetMenu(items []MenuItemSpec)
	Destroy()
}

// Config configures the system tray controller.
type Config struct {
	App        *app.App
	Backend    Backend // optional; nil creates a MyGoBackend
	PlatformOS string  // optional override for tests; defaults to runtime.GOOS
	QuitFunc   func()
}

// Controller synchronizes Featherlog's workbench, tasks, settings, and panel
// visibility state with the native system tray icon and context menu.
type Controller struct {
	app      *app.App
	backend  Backend
	goos     string
	quitFunc func()

	mu        sync.Mutex
	applyMu   sync.Mutex
	closed    bool
	unsubs    []func()
	closeOnce sync.Once
}

// Start creates and wires a system tray controller. If the host environment
// lacks native system tray support (e.g. Linux without libayatana-appindicator3),
// Start logs once and returns (nil, nil) so the app continues running cleanly.
func Start(cfg Config) (*Controller, error) {
	if cfg.App == nil {
		return nil, store.NewError("tray/invalid-config", "app is required", nil)
	}
	goos := strings.TrimSpace(cfg.PlatformOS)
	if goos == "" {
		goos = runtime.GOOS
	}
	quitFn := cfg.QuitFunc
	if quitFn == nil {
		quitFn = func() { _ = cfg.App.DockSvc.Quit() }
	}

	ctrl := &Controller{
		app:      cfg.App,
		goos:     goos,
		quitFunc: quitFn,
	}

	title, tooltip, items := ctrl.buildSnapshot()

	backend := cfg.Backend
	if backend == nil {
		mygoBackend, err := NewMyGoBackend(MyGoOptions{
			Title:   title,
			ToolTip: tooltip,
			Menu:    items,
			OnToggle: func() {
				ctrl.app.Dock.Toggle(nil)
			},
		})
		if err != nil {
			log.Printf("featherlog: system tray unavailable: %v", err)
			return nil, nil
		}
		if mygoBackend == nil {
			return nil, nil
		}
		backend = mygoBackend
	} else {
		backend.SetTitle(title)
		backend.SetToolTip(tooltip)
		backend.SetMenu(items)
	}
	ctrl.backend = backend

	ctrl.unsubs = append(ctrl.unsubs,
		cfg.App.Workbench.OnChange(func([]workbench.WorkSlot) { ctrl.Refresh() }),
		cfg.App.Tasks.OnChange(func(tasks.ListResult) { ctrl.Refresh() }),
		cfg.App.Settings.OnChange(func(settings.Settings) { ctrl.Refresh() }),
		cfg.App.Dock.OnExpandedChange(func(bool) { ctrl.Refresh() }),
	)

	return ctrl, nil
}

// Refresh recomputes tray title, tooltip, and context menu from current app state.
func (c *Controller) Refresh() {
	c.mu.Lock()
	if c.closed || c.backend == nil {
		c.mu.Unlock()
		return
	}
	backend := c.backend
	c.mu.Unlock()

	title, tooltip, items := c.buildSnapshot()

	c.applyMu.Lock()
	defer c.applyMu.Unlock()

	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		return
	}

	backend.SetTitle(title)
	backend.SetToolTip(tooltip)
	backend.SetMenu(items)
}

// Close unsubscribes from app events and destroys the native system tray icon.
// Safe to call multiple times.
func (c *Controller) Close() {
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.closed = true
		unsubs := c.unsubs
		c.unsubs = nil
		backend := c.backend
		c.mu.Unlock()

		for _, fn := range unsubs {
			if fn != nil {
				fn()
			}
		}

		c.applyMu.Lock()
		if backend != nil {
			backend.Destroy()
		}
		c.applyMu.Unlock()
	})
}

func (c *Controller) buildSnapshot() (title, tooltip string, items []MenuItemSpec) {
	slots, _ := c.app.Workbench.List()
	taskList, _ := c.app.Tasks.List()
	st := c.app.Settings.Get()
	panelOpen, _, _, _ := c.app.Dock.State()

	var loc *time.Location
	if c.app.Clock != nil {
		loc = c.app.Clock.Now().Location()
	}
	todayDone, todayTotal := computeTodayCounts(taskList.Tasks, taskList.PeriodKey, st.DayStartHour, loc)

	title = FormatTitle(c.goos, slots)
	tooltip = FormatToolTip(slots, todayDone, todayTotal)
	items = c.buildMenuItems(panelOpen, slots, st)
	return title, tooltip, items
}

func (c *Controller) buildMenuItems(panelOpen bool, slots []workbench.WorkSlot, st settings.Settings) []MenuItemSpec {
	toggleLabel := "打开工作台"
	if panelOpen {
		toggleLabel = "收起工作台"
	}
	items := []MenuItemSpec{
		{
			ID:    "toggle-panel",
			Label: toggleLabel,
			Kind:  MenuNormal,
			OnClick: func() {
				c.app.Dock.Toggle(nil)
			},
		},
	}

	if len(slots) > 0 {
		items = append(items, MenuItemSpec{Kind: MenuSeparator})
		limit := len(slots)
		if limit > maxMenuSlots {
			limit = maxMenuSlots
		}
		for i := 0; i < limit; i++ {
			slot := slots[i]
			slotID := slot.ID
			items = append(items, MenuItemSpec{
				ID:    "slot:" + slotID,
				Label: formatSlotMenuLabel(slot),
				Kind:  MenuNormal,
				OnClick: func() {
					_, _ = c.app.Workbench.SetState(workbench.SetStateInput{
						ID:    slotID,
						State: workbench.StateFocus,
					})
				},
			})
		}
	}

	setBarMode := func(mode settings.BarMode) func() {
		return func() {
			m := mode
			_, _ = c.app.Settings.Update(settings.Patch{BarMode: &m})
		}
	}

	items = append(items,
		MenuItemSpec{Kind: MenuSeparator},
		MenuItemSpec{
			ID:    "bar-mode",
			Label: "常驻滚筒条",
			Kind:  MenuSubmenu,
			Submenu: []MenuItemSpec{
				{
					ID:      "bar-mode:auto",
					Label:   "自动（推荐）",
					Kind:    MenuRadio,
					Checked: st.BarMode == settings.BarModeAuto,
					OnClick: setBarMode(settings.BarModeAuto),
				},
				{
					ID:      "bar-mode:standalone",
					Label:   "始终显示桌面滚筒条",
					Kind:    MenuRadio,
					Checked: st.BarMode == settings.BarModeStandalone,
					OnClick: setBarMode(settings.BarModeStandalone),
				},
				{
					ID:      "bar-mode:tray-only",
					Label:   "仅系统托盘图标",
					Kind:    MenuRadio,
					Checked: st.BarMode == settings.BarModeTrayOnly,
					OnClick: setBarMode(settings.BarModeTrayOnly),
				},
			},
		},
		MenuItemSpec{
			ID:    "reset-bar-position",
			Label: "重置滚筒条位置",
			Kind:  MenuNormal,
			OnClick: func() {
				_, _ = c.app.Settings.Update(settings.Patch{
					ClearBarX: true,
					ClearBarY: true,
				})
			},
		},
		MenuItemSpec{Kind: MenuSeparator},
		MenuItemSpec{
			ID:      "quit",
			Label:   "退出羽记",
			Kind:    MenuNormal,
			OnClick: c.quitFunc,
		},
	)

	return items
}

// FormatTitle formats the short menu bar title shown beside the tray icon on
// macOS. Outside macOS ("darwin") it always returns "".
func FormatTitle(goos string, slots []workbench.WorkSlot) string {
	if goos != "darwin" {
		return ""
	}
	var readyCount int
	for _, s := range slots {
		if s.State == workbench.StateFocus {
			return "┃ " + truncateRunes(s.Title, maxDarwinTitleRunes)
		}
		if s.State == workbench.StateReady {
			readyCount++
		}
	}
	if readyCount > 0 {
		return fmt.Sprintf("待看 %d", readyCount)
	}
	return ""
}

// FormatToolTip formats the hover tooltip for the system tray icon without any
// colored status indicators.
func FormatToolTip(slots []workbench.WorkSlot, todayDone, todayTotal int) string {
	var focus *workbench.WorkSlot
	var readyCount, runningCount int
	for i := range slots {
		switch slots[i].State {
		case workbench.StateFocus:
			if focus == nil {
				focus = &slots[i]
			}
		case workbench.StateReady:
			readyCount++
		case workbench.StateRunning:
			runningCount++
		}
	}

	tally := fmt.Sprintf("待办 %d/%d", todayDone, todayTotal)
	if focus != nil {
		desc := truncateRunes(focus.Title, 40)
		if bc := strings.TrimSpace(focus.Breadcrumb); bc != "" {
			desc += " — " + truncateRunes(bc, 60)
		}
		return fmt.Sprintf("羽记 · %s · %s", desc, tally)
	}
	if readyCount > 0 {
		return fmt.Sprintf("羽记 · 待看 %d · %s", readyCount, tally)
	}
	if runningCount > 0 {
		return fmt.Sprintf("羽记 · 进行中 %d · %s", runningCount, tally)
	}
	return fmt.Sprintf("羽记 Featherlog · %s", tally)
}

func formatSlotMenuLabel(slot workbench.WorkSlot) string {
	switch slot.State {
	case workbench.StateFocus:
		return "[专注] " + truncateRunes(slot.Title, maxSlotTitleRunes)
	case workbench.StateReady:
		return "[待看] " + truncateRunes(slot.Title, maxSlotTitleRunes)
	default:
		return truncateRunes(slot.Title, maxRunningTitleRunes)
	}
}

func truncateRunes(s string, maxRunes int) string {
	trimmed := strings.TrimSpace(s)
	if maxRunes <= 0 {
		return ""
	}
	runes := []rune(trimmed)
	if len(runes) <= maxRunes {
		return trimmed
	}
	if maxRunes == 1 {
		return string(runes[:1])
	}
	return string(runes[:maxRunes-1]) + "…"
}

func computeTodayCounts(list []tasks.Task, periodKey string, dayStartHour int, loc *time.Location) (done, total int) {
	if loc == nil {
		loc = time.Local
	}
	for _, t := range list {
		switch t.Status {
		case tasks.StatusArchived:
			continue
		case tasks.StatusActive:
			if t.Recurrence != nil && t.Recurrence.Freq == tasks.FreqWeekly && !t.DueToday {
				continue
			}
			total++
		case tasks.StatusCompleted:
			completedThisPeriod := t.DueToday
			if !completedThisPeriod && t.CompletedAt != nil && periodKey != "" {
				completedThisPeriod = tasks.PeriodKey(time.UnixMilli(*t.CompletedAt).In(loc), dayStartHour) == periodKey
			}
			if completedThisPeriod {
				total++
				done++
			}
		}
	}
	return done, total
}

// MyGoOptions configures a native MyGoBackend tray icon.
type MyGoOptions struct {
	Title    string
	ToolTip  string
	Menu     []MenuItemSpec
	OnToggle func()
}

// MyGoBackend adapts *mygo.Tray and *mygo.Menu to Backend with platform-aware
// click handling:
//   - Windows & Linux: persistent context menu attached to the tray icon;
//     left-click invokes OnToggle.
//   - macOS: Menu stays nil on the tray so left-click invokes OnToggle (toggling
//     the Workspace Panel), while right-click opens the context menu via
//     SetMenu(menu) -> PopUpMenu() -> SetMenu(nil).
type MyGoBackend struct {
	mu            sync.Mutex
	tray          *mygo.Tray
	menu          *mygo.Menu
	isDarwin      bool
	destroyed     bool
	offClick      func()
	offRightClick func()
}

// NewMyGoBackend creates a native MyGo system tray icon on the main thread.
func NewMyGoBackend(opts MyGoOptions) (*MyGoBackend, error) {
	isDarwin := runtime.GOOS == "darwin"

	var (
		t           *mygo.Tray
		initialMenu *mygo.Menu
		err         error
	)
	mygo.RunOnMain(func() {
		initialMenu = buildMyGoMenu(opts.Menu)
		trayOpts := mygo.TrayOptions{
			ID:             trayID,
			Icon:           TemplateIconPNG(),
			IconIsTemplate: true,
			Title:          opts.Title,
			ToolTip:        opts.ToolTip,
		}
		if !isDarwin {
			trayOpts.Menu = initialMenu
		}
		t, err = mygo.NewTray(trayOpts)
	})
	if err != nil {
		return nil, err
	}
	if t == nil {
		return nil, nil
	}

	b := &MyGoBackend{
		tray:     t,
		menu:     initialMenu,
		isDarwin: isDarwin,
	}

	mygo.RunOnMain(func() {
		if opts.OnToggle != nil {
			b.offClick = t.OnClick(func() {
				go opts.OnToggle()
			})
		}
		if isDarwin {
			b.offRightClick = t.OnRightClick(func() {
				b.mu.Lock()
				if b.destroyed {
					b.mu.Unlock()
					return
				}
				menu := b.menu
				b.mu.Unlock()
				if menu != nil {
					t.SetMenu(menu)
					t.PopUpMenu()
					t.SetMenu(nil)
				}
			})
		}
	})

	return b, nil
}

func (b *MyGoBackend) SetTitle(title string) {
	mygo.RunOnMain(func() {
		b.mu.Lock()
		destroyed := b.destroyed
		t := b.tray
		b.mu.Unlock()
		if !destroyed && t != nil {
			t.SetTitle(title)
		}
	})
}

func (b *MyGoBackend) SetToolTip(tip string) {
	mygo.RunOnMain(func() {
		b.mu.Lock()
		destroyed := b.destroyed
		t := b.tray
		b.mu.Unlock()
		if !destroyed && t != nil {
			t.SetToolTip(tip)
		}
	})
}

func (b *MyGoBackend) SetMenu(items []MenuItemSpec) {
	mygo.RunOnMain(func() {
		b.mu.Lock()
		if b.destroyed {
			b.mu.Unlock()
			return
		}
		isDarwin := b.isDarwin
		t := b.tray
		b.mu.Unlock()

		menu := buildMyGoMenu(items)

		b.mu.Lock()
		if b.destroyed {
			b.mu.Unlock()
			return
		}
		b.menu = menu
		b.mu.Unlock()

		if !isDarwin && t != nil {
			t.SetMenu(menu)
		}
	})
}

func (b *MyGoBackend) Destroy() {
	b.mu.Lock()
	if b.destroyed {
		b.mu.Unlock()
		return
	}
	b.destroyed = true
	offClick := b.offClick
	offRightClick := b.offRightClick
	b.offClick = nil
	b.offRightClick = nil
	t := b.tray
	b.tray = nil
	b.menu = nil
	b.mu.Unlock()

	mygo.RunOnMain(func() {
		if offClick != nil {
			offClick()
		}
		if offRightClick != nil {
			offRightClick()
		}
		if t != nil {
			t.Destroy()
		}
	})
}

func buildMyGoMenu(items []MenuItemSpec) *mygo.Menu {
	return mygo.NewMenu(buildMyGoMenuItems(items))
}

func buildMyGoMenuItems(specs []MenuItemSpec) []*mygo.MenuItem {
	out := make([]*mygo.MenuItem, 0, len(specs))
	for _, spec := range specs {
		if spec.Kind == MenuSeparator {
			out = append(out, mygo.Separator())
			continue
		}
		item := &mygo.MenuItem{
			ID:       spec.ID,
			Label:    spec.Label,
			Disabled: spec.Disabled,
			Checked:  spec.Checked,
		}
		switch spec.Kind {
		case MenuRadio:
			item.Type = mygo.MenuItemRadio
		case MenuSubmenu:
			item.Type = mygo.MenuItemSubmenu
			item.Submenu = buildMyGoMenuItems(spec.Submenu)
		default:
			item.Type = mygo.MenuItemNormal
		}
		if spec.OnClick != nil {
			fn := spec.OnClick
			item.Click = func(*mygo.MenuItem, *mygo.Window) {
				go fn()
			}
		}
		out = append(out, item)
	}
	return out
}
