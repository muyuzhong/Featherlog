package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"text/tabwriter"
	"time"

	"github.com/egoist/mygo"
	"github.com/muyuzhong/featherlog/internal/app"
	"github.com/muyuzhong/featherlog/internal/barhttp"
	"github.com/muyuzhong/featherlog/internal/clock"
	"github.com/muyuzhong/featherlog/internal/dock"
	"github.com/muyuzhong/featherlog/internal/ipcsock"
	"github.com/muyuzhong/featherlog/internal/notes"
	"github.com/muyuzhong/featherlog/internal/store"
	"github.com/muyuzhong/featherlog/internal/tray"
	"github.com/muyuzhong/featherlog/internal/workbench"
)

const defaultDevURL = "http://localhost:5173"

// version is embedded at build time via -ldflags "-X main.version=...".
var version = "2.0.0"

func main() {
	attachParentConsoleIfCLI(os.Args)
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func ensureDevURL() {
	if os.Getenv("MYGO_DEV_URL") == "" {
		_ = os.Setenv("MYGO_DEV_URL", defaultDevURL)
	}
}

type globalOptions struct {
	dev         bool
	show        bool
	dataDir     string
	httpPort    int
	httpPortSet bool
	jsonOut     bool
}

func run(args []string, stdout, stderr io.Writer) int {
	opts, subcmd, subargs, err := splitGlobalArgs(args)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "featherlog: %v\n", err)
		return 2
	}

	if subcmd == "help" || subcmd == "-h" || subcmd == "--help" {
		printUsage(stdout)
		return 0
	}

	if subcmd == "version" || subcmd == "-v" || subcmd == "--version" {
		_, _ = fmt.Fprintf(stdout, "featherlog %s\n", version)
		return 0
	}

	// Support `MYGO_GENERATE=<path>` without opening a window or taking the socket.
	if subcmd == "" && os.Getenv("MYGO_GENERATE") != "" {
		if err := runGenerateBindings(); err != nil {
			_, _ = fmt.Fprintf(stderr, "featherlog: %v\n", err)
			return 1
		}
		return 0
	}

	dataDir, err := resolveDataDir(opts)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "featherlog: %v\n", err)
		return 1
	}

	if subcmd == "" {
		devMode := opts.dev || os.Getenv("FEATHERLOG_DEV") == "1"
		httpPort, err := resolveHTTPPort(opts, os.Getenv)
		if err != nil {
			_, _ = fmt.Fprintf(stderr, "featherlog: %v\n", err)
			return 2
		}
		if err := runGUI(dataDir, devMode, opts.show, httpPort); err != nil {
			_, _ = fmt.Fprintf(stderr, "featherlog: %v\n", err)
			return 1
		}
		return 0
	}

	if err := runCLI(context.Background(), dataDir, subcmd, subargs, opts.jsonOut, stdout); err != nil {
		_, _ = fmt.Fprintf(stderr, "featherlog: %v\n", err)
		return 1
	}
	return 0
}

func splitGlobalArgs(args []string) (globalOptions, string, []string, error) {
	var opts globalOptions
	var rest []string

	i := 0
	for i < len(args) {
		a := args[i]
		if a == "--" {
			rest = append(rest, args[i+1:]...)
			break
		}
		switch {
		case a == "--dev":
			opts.dev = true
			i++
		case a == "--show":
			opts.show = true
			i++
		case a == "--json":
			opts.jsonOut = true
			i++
		case a == "--data-dir":
			if i+1 >= len(args) {
				return opts, "", nil, errors.New("--data-dir requires a value")
			}
			opts.dataDir = args[i+1]
			i += 2
		case strings.HasPrefix(a, "--data-dir="):
			opts.dataDir = strings.TrimPrefix(a, "--data-dir=")
			i++
		case a == "--http-port":
			if i+1 >= len(args) {
				return opts, "", nil, errors.New("--http-port requires a value")
			}
			port, err := parsePort(args[i+1])
			if err != nil {
				return opts, "", nil, fmt.Errorf("invalid --http-port: %w", err)
			}
			opts.httpPort = port
			opts.httpPortSet = true
			i += 2
		case strings.HasPrefix(a, "--http-port="):
			port, err := parsePort(strings.TrimPrefix(a, "--http-port="))
			if err != nil {
				return opts, "", nil, fmt.Errorf("invalid --http-port: %w", err)
			}
			opts.httpPort = port
			opts.httpPortSet = true
			i++
		default:
			rest = append(rest, a)
			i++
		}
	}

	if len(rest) == 0 {
		return opts, "", nil, nil
	}
	return opts, rest[0], rest[1:], nil
}

func parsePort(raw string) (int, error) {
	p, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || p < 0 || p > 65535 {
		return 0, fmt.Errorf("%q must be an integer in 0..65535", raw)
	}
	return p, nil
}

func resolveHTTPPort(opts globalOptions, getenv func(string) string) (int, error) {
	if opts.httpPortSet {
		return opts.httpPort, nil
	}
	if raw := strings.TrimSpace(getenv("FEATHERLOG_HTTP_PORT")); raw != "" {
		p, err := parsePort(raw)
		if err != nil {
			return 0, fmt.Errorf("invalid FEATHERLOG_HTTP_PORT: %w", err)
		}
		return p, nil
	}
	isDevOrCustom := opts.dev ||
		strings.TrimSpace(opts.dataDir) != "" ||
		strings.TrimSpace(getenv("FEATHERLOG_DATA_DIR")) != "" ||
		getenv("FEATHERLOG_DEV") == "1" ||
		getenv("MYGO_DEV_URL") != ""
	if isDevOrCustom {
		return barhttp.DefaultDevPort, nil
	}
	return barhttp.DefaultProdPort, nil
}

func resolveDataDir(opts globalOptions) (string, error) {
	if strings.TrimSpace(opts.dataDir) != "" {
		return opts.dataDir, nil
	}
	if envDir := strings.TrimSpace(os.Getenv("FEATHERLOG_DATA_DIR")); envDir != "" {
		return envDir, nil
	}
	dev := opts.dev || os.Getenv("FEATHERLOG_DEV") == "1" || os.Getenv("MYGO_DEV_URL") != ""
	return store.DataDir(dev)
}

func runGenerateBindings() error {
	tmpDir, err := os.MkdirTemp("", "featherlog-gen-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(tmpDir) }()

	application, err := app.Open(app.Config{
		DataDir: tmpDir,
		Clock:   clock.NewReal(),
	})
	if err != nil {
		return err
	}
	defer application.Close()

	application.BindMyGo()
	return mygo.App.Run()
}

func runGUI(dataDir string, devMode, showOnStart bool, httpPort int) error {
	sockPath := ipcsock.SocketPath(dataDir)
	client := ipcsock.NewClient(sockPath)

	toggleParams := ipcsock.ToggleParams{}
	if showOnStart {
		open := true
		toggleParams.Expanded = &open
	}

	// If an instance is already running, toggle (or show) its panel instead of launching a second GUI.
	if err := client.Ping(context.Background()); err == nil {
		var res ipcsock.ToggleResult
		return client.Call(context.Background(), ipcsock.CmdToggle, toggleParams, &res)
	}

	configureFrontend(devMode)

	clk := clock.NewReal()
	application, err := app.Open(app.Config{
		DataDir: dataDir,
		Clock:   clk,
		DockCfg: dock.Config{
			Clock:           clk,
			BottomInset:     dock.PanelBottomInset,
			InitialExpanded: showOnStart,
			StartHidden:     !showOnStart,
			BlurToggleGrace: 300 * time.Millisecond,
		},
		OnCorrupt: func(backupPath string, cause error) {
			log.Printf("featherlog: corrupt settings backed up to %s (%v); using defaults", backupPath, cause)
		},
	})
	if err != nil {
		return err
	}

	ipcSrv, err := ipcsock.Listen(sockPath, application.HandleIPC)
	if errors.Is(err, ipcsock.ErrAlreadyRunning) {
		application.Close()
		var res ipcsock.ToggleResult
		return client.Call(context.Background(), ipcsock.CmdToggle, toggleParams, &res)
	}
	if err != nil {
		application.Close()
		return err
	}

	barSrv, err := barhttp.Start(barhttp.Config{
		App:     application,
		DataDir: dataDir,
		Port:    httpPort,
	})
	if err != nil {
		_ = ipcSrv.Close()
		application.Close()
		return err
	}
	log.Printf("featherlog: bar HTTP API listening on %s", barSrv.URL())

	offBarActivity := barSrv.OnClientActivity(application.Dock.SetExternalBarActive)
	application.Dock.SetExternalBarActive(barSrv.HasActiveClient())

	kwinPlacer := dock.NewKWinPlacer(dock.KWinConfig{
		DataDir:      dataDir,
		Caption:      dock.PanelWindowTitle,
		BottomOffset: dock.PanelBottomInset,
	})
	if !dock.DefaultLayerShell().Available() && kwinPlacer.Supported() {
		if err := kwinPlacer.Start(context.Background()); err != nil {
			log.Printf("featherlog: kwin panel positioning unavailable: %v", err)
		} else {
			log.Printf("featherlog: kwin panel positioning active (%s)", dock.PanelWindowTitle)
		}
	}

	var (
		trayMu   sync.Mutex
		trayCtrl *tray.Controller
	)

	var cleanupOnce sync.Once
	cleanup := func() {
		cleanupOnce.Do(func() {
			if offBarActivity != nil {
				offBarActivity()
			}
			trayMu.Lock()
			tc := trayCtrl
			trayCtrl = nil
			trayMu.Unlock()
			if tc != nil {
				tc.Close()
			}
			_ = barSrv.Close()
			_ = ipcSrv.Close()
			_ = kwinPlacer.Close()
			application.Close()
		})
	}
	defer cleanup()

	mygo.App.SetName("Featherlog")
	mygo.App.SetPath(mygo.PathUserData, dataDir)
	if runtime.GOOS == "darwin" {
		mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory)
	}
	application.BindMyGo()

	var quitting atomic.Bool
	mygo.App.OnBeforeQuit(func(*mygo.QuitEvent) {
		quitting.Store(true)
	})
	mygo.App.OnQuitCanceled(func() {
		quitting.Store(false)
	})
	mygo.App.OnWindowAllClosed(func() {
		// Keep daemon alive while the Workspace Panel is hidden; only quit on
		// DockService.Quit / tray Quit / SIGTERM / SIGINT.
	})
	mygo.App.OnQuit(cleanup)

	mygo.App.WhenReady(func() {
		initial := application.Dock.InitialRect()
		theme := string(application.Settings.Get().Theme)
		opts := dock.WindowOptions("/?mode=panel", app.PreloadScript, initial,
			dock.WithTheme(theme),
			dock.WithHidden(!showOnStart),
		)
		win := mygo.NewWindow(opts)
		if page := win.Page(); page != nil {
			page.OnPageTitleUpdated(func(e *mygo.TitleEvent) {
				// Preserve native title "featherlog-panel" for KWin script matching.
				e.PreventDefault()
			})
		}
		win.OnClose(func(e *mygo.CloseEvent) {
			if !quitting.Load() {
				e.PreventDefault()
				collapsed := false
				application.Dock.Toggle(&collapsed)
			}
		})
		application.Dock.Attach(dock.MyGoWindow{W: win})
		if showOnStart {
			win.Focus()
		}

		miniInitial := application.Dock.InitialMiniBarRect()
		miniOpts := dock.MiniBarWindowOptions("/?mode=bar", app.PreloadScript, miniInitial, theme)
		miniWin := mygo.NewWindow(miniOpts)
		if page := miniWin.Page(); page != nil {
			page.OnPageTitleUpdated(func(e *mygo.TitleEvent) {
				// Preserve native title "featherlog-bar".
				e.PreventDefault()
			})
		}
		miniWin.OnClose(func(e *mygo.CloseEvent) {
			if !quitting.Load() {
				e.PreventDefault()
			}
		})
		application.Dock.AttachMiniBar(dock.MyGoWindow{W: miniWin})

		tc, err := tray.Start(tray.Config{
			App:      application,
			QuitFunc: func() { mygo.App.Quit() },
		})
		if err != nil {
			log.Printf("featherlog: system tray unavailable: %v", err)
		} else if tc != nil {
			trayMu.Lock()
			if quitting.Load() {
				trayMu.Unlock()
				tc.Close()
			} else {
				trayCtrl = tc
				trayMu.Unlock()
			}
		}

		if acc, err := application.Dock.RegisterShortcut(nil); err != nil {
			log.Printf("featherlog: global shortcut unavailable: %v", err)
		} else {
			log.Printf("featherlog: global panel toggle shortcut registered (%s)", acc)
		}
	})

	return mygo.App.Run()
}

func runCLI(ctx context.Context, dataDir, subcmd string, args []string, jsonOut bool, stdout io.Writer) error {
	sockPath := ipcsock.SocketPath(dataDir)

	switch subcmd {
	case "status":
		flags, pos, err := parseSubFlags(args, map[string]bool{"--json": false})
		if err != nil {
			return err
		}
		if len(pos) > 0 {
			return fmt.Errorf("status takes no positional arguments (got %q)", strings.Join(pos, " "))
		}
		if flags["--json"] == "true" {
			jsonOut = true
		}
		var slots []workbench.WorkSlot
		if err := callOrDirect(ctx, dataDir, sockPath, ipcsock.CmdStatus, nil, &slots); err != nil {
			return err
		}
		if slots == nil {
			slots = []workbench.WorkSlot{}
		}
		if jsonOut {
			return writeJSON(stdout, slots)
		}
		return writeStatusTable(stdout, slots, clock.NewReal().Now())

	case "focus":
		flags, pos, err := parseSubFlags(args, map[string]bool{
			"--tag":  true,
			"--note": true,
			"--json": false,
		})
		if err != nil {
			return err
		}
		title := strings.TrimSpace(strings.Join(pos, " "))
		if title == "" {
			return errors.New("usage: featherlog focus <title> [--tag <tag>] [--note <breadcrumb>]")
		}
		if flags["--json"] == "true" {
			jsonOut = true
		}
		var slot workbench.WorkSlot
		if err := callOrDirect(ctx, dataDir, sockPath, ipcsock.CmdFocus, ipcsock.FocusParams{
			Title: title,
			Tag:   flags["--tag"],
			Note:  flags["--note"],
		}, &slot); err != nil {
			return err
		}
		if jsonOut {
			return writeJSON(stdout, slot)
		}
		_, _ = fmt.Fprintf(stdout, "focus  %s  %s\n", shortID(slot.ID), slot.Title)
		return nil

	case "run":
		flags, pos, err := parseSubFlags(args, map[string]bool{
			"--tag":    true,
			"--note":   true,
			"--remind": true,
			"--json":   false,
		})
		if err != nil {
			return err
		}
		title := strings.TrimSpace(strings.Join(pos, " "))
		if title == "" {
			return errors.New("usage: featherlog run <title> [--tag <tag>] [--remind <duration>] [--note <breadcrumb>]")
		}
		if flags["--json"] == "true" {
			jsonOut = true
		}
		var remindSec int
		if rawRemind := strings.TrimSpace(flags["--remind"]); rawRemind != "" {
			d, err := parseRemindDuration(rawRemind)
			if err != nil {
				return err
			}
			remindSec = int(d / time.Second)
		}
		var slot workbench.WorkSlot
		if err := callOrDirect(ctx, dataDir, sockPath, ipcsock.CmdRun, ipcsock.RunParams{
			Title:         title,
			Tag:           flags["--tag"],
			Note:          flags["--note"],
			RemindSeconds: remindSec,
		}, &slot); err != nil {
			return err
		}
		if jsonOut {
			return writeJSON(stdout, slot)
		}
		_, _ = fmt.Fprintf(stdout, "run    %s  %s\n", shortID(slot.ID), slot.Title)
		return nil

	case "ready":
		flags, pos, err := parseSubFlags(args, map[string]bool{
			"--note": true,
			"--json": false,
		})
		if err != nil {
			return err
		}
		target := strings.TrimSpace(strings.Join(pos, " "))
		if target == "" {
			return errors.New("usage: featherlog ready <id-or-substring> [--note <breadcrumb>]")
		}
		if flags["--json"] == "true" {
			jsonOut = true
		}
		var slot workbench.WorkSlot
		if err := callOrDirect(ctx, dataDir, sockPath, ipcsock.CmdReady, ipcsock.ReadyParams{
			Target: target,
			Note:   flags["--note"],
		}, &slot); err != nil {
			return err
		}
		if jsonOut {
			return writeJSON(stdout, slot)
		}
		_, _ = fmt.Fprintf(stdout, "ready  %s  %s\n", shortID(slot.ID), slot.Title)
		return nil

	case "done":
		flags, pos, err := parseSubFlags(args, map[string]bool{
			"--complete-task": false,
			"--json":          false,
		})
		if err != nil {
			return err
		}
		target := strings.TrimSpace(strings.Join(pos, " "))
		if target == "" {
			return errors.New("usage: featherlog done <id-or-substring> [--complete-task]")
		}
		if flags["--json"] == "true" {
			jsonOut = true
		}
		var res app.DoneResult
		if err := callOrDirect(ctx, dataDir, sockPath, ipcsock.CmdDone, ipcsock.DoneParams{
			Target:             target,
			CompleteLinkedTask: flags["--complete-task"] == "true",
		}, &res); err != nil {
			return err
		}
		if jsonOut {
			return writeJSON(stdout, res)
		}
		_, _ = fmt.Fprintf(stdout, "done   %s  %s\n", shortID(res.Removed.ID), res.Removed.Title)
		return nil

	case "note":
		flags, pos, err := parseSubFlags(args, map[string]bool{
			"--task": true,
			"--json": false,
		})
		if err != nil {
			return err
		}
		text := strings.TrimSpace(strings.Join(pos, " "))
		if text == "" {
			return errors.New("usage: featherlog note <text> [--task <taskId>]")
		}
		if flags["--json"] == "true" {
			jsonOut = true
		}
		var taskID *string
		if t := strings.TrimSpace(flags["--task"]); t != "" {
			taskID = &t
		}
		var created notes.Note
		if err := callOrDirect(ctx, dataDir, sockPath, ipcsock.CmdNote, ipcsock.NoteParams{
			Text:   text,
			TaskID: taskID,
		}, &created); err != nil {
			return err
		}
		if jsonOut {
			return writeJSON(stdout, created)
		}
		_, _ = fmt.Fprintf(stdout, "note   %s  %s\n", shortID(created.ID), created.Content)
		return nil

	case "toggle":
		flags, pos, err := parseSubFlags(args, map[string]bool{
			"--expand":   false,
			"--collapse": false,
			"--json":     false,
		})
		if err != nil {
			return err
		}
		if len(pos) > 0 {
			return fmt.Errorf("toggle takes no positional arguments (got %q)", strings.Join(pos, " "))
		}
		if flags["--expand"] == "true" && flags["--collapse"] == "true" {
			return errors.New("cannot pass both --expand and --collapse")
		}
		if flags["--json"] == "true" {
			jsonOut = true
		}
		var expanded *bool
		if flags["--expand"] == "true" {
			v := true
			expanded = &v
		} else if flags["--collapse"] == "true" {
			v := false
			expanded = &v
		}
		var res ipcsock.ToggleResult
		if err := ipcsock.NewClient(sockPath).Call(ctx, ipcsock.CmdToggle, ipcsock.ToggleParams{Expanded: expanded}, &res); err != nil {
			return err
		}
		if jsonOut {
			return writeJSON(stdout, res)
		}
		state := "collapsed"
		if res.Expanded {
			state = "expanded"
		}
		_, _ = fmt.Fprintf(stdout, "dock   %s\n", state)
		return nil

	default:
		return fmt.Errorf("unknown subcommand %q (run `featherlog help` for usage)", subcmd)
	}
}

// callOrDirect sends cmd to the running desktop instance over Unix socket; if
// no desktop instance is running, it executes directly against local storage so
// CLI and AI agent hooks still work cleanly.
func callOrDirect(ctx context.Context, dataDir, sockPath, cmd string, params any, out any) error {
	client := ipcsock.NewClient(sockPath)
	err := client.Call(ctx, cmd, params, out)
	if err == nil || !errors.Is(err, ipcsock.ErrNotRunning) {
		return err
	}

	application, openErr := app.Open(app.Config{
		DataDir: dataDir,
		Clock:   clock.NewReal(),
	})
	if openErr != nil {
		return openErr
	}
	defer application.Close()

	var rawParams json.RawMessage
	if params != nil {
		b, mErr := json.Marshal(params)
		if mErr != nil {
			return mErr
		}
		rawParams = b
	}
	res, hErr := application.HandleIPC(ctx, ipcsock.Request{Command: cmd, Params: rawParams})
	if hErr != nil {
		return hErr
	}
	if out != nil && res != nil {
		b, mErr := json.Marshal(res)
		if mErr != nil {
			return mErr
		}
		if uErr := json.Unmarshal(b, out); uErr != nil {
			return uErr
		}
	}
	return nil
}

// parseSubFlags parses interleaved flags and positional args (unlike stdlib flag.FlagSet
// which stops at the first positional argument).
func parseSubFlags(args []string, spec map[string]bool) (map[string]string, []string, error) {
	vals := map[string]string{}
	var pos []string

	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			pos = append(pos, args[i+1:]...)
			break
		}
		if !strings.HasPrefix(a, "--") {
			pos = append(pos, a)
			continue
		}
		name, inlineVal, hasInline := strings.Cut(a, "=")
		needsVal, known := spec[name]
		if !known {
			return nil, nil, fmt.Errorf("unknown flag %q", name)
		}
		if !needsVal {
			if hasInline {
				vals[name] = inlineVal
			} else {
				vals[name] = "true"
			}
			continue
		}
		if hasInline {
			vals[name] = inlineVal
			continue
		}
		if i+1 >= len(args) {
			return nil, nil, fmt.Errorf("flag %s requires a value", name)
		}
		vals[name] = args[i+1]
		i++
	}
	return vals, pos, nil
}

func parseRemindDuration(raw string) (time.Duration, error) {
	if mins, err := strconv.Atoi(raw); err == nil {
		if mins <= 0 {
			return 0, fmt.Errorf("invalid --remind duration %q: must be positive", raw)
		}
		return time.Duration(mins) * time.Minute, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("invalid --remind duration %q: %w", raw, err)
	}
	if d <= 0 {
		return 0, fmt.Errorf("invalid --remind duration %q: must be positive", raw)
	}
	return d, nil
}

func writeJSON(w io.Writer, v any) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func writeStatusTable(w io.Writer, slots []workbench.WorkSlot, now time.Time) error {
	if len(slots) == 0 {
		_, err := fmt.Fprintln(w, "No active work slots.")
		return err
	}
	tw := tabwriter.NewWriter(w, 0, 2, 2, ' ', 0)
	_, _ = fmt.Fprintln(tw, "STATE\tID\tTITLE\tTAG\tELAPSED\tNOTE")
	nowMs := now.UnixMilli()
	for _, s := range slots {
		elapsed := ""
		if s.State == workbench.StateRunning && s.StateChangedAt > 0 && nowMs >= s.StateChangedAt {
			mins := (nowMs - s.StateChangedAt) / 60_000
			elapsed = fmt.Sprintf("%dm", mins)
			if s.RemindAt != nil && *s.RemindAt > nowMs {
				rem := (*s.RemindAt - nowMs + 59_999) / 60_000
				elapsed = fmt.Sprintf("%dm (in %dm)", mins, rem)
			}
		}
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n",
			strings.ToUpper(string(s.State)),
			shortID(s.ID),
			s.Title,
			s.Tag,
			elapsed,
			s.Breadcrumb,
		)
	}
	return tw.Flush()
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func printUsage(w io.Writer) {
	_, _ = fmt.Fprint(w, `Featherlog v2 — Cross-platform concurrent workbench, 3D Drum Mini-Bar, tray & CLI hooks

Usage:
  featherlog [--show] [--dev] [--data-dir <dir>] [--http-port <port>]
      Launch the background desktop host + loopback bar HTTP API (hidden by default;
      pass --show to open the 880x520 Workspace Panel immediately, or re-run when
      already active to toggle it).
      Default loopback API port: 127.0.0.1:39173 (prod), 127.0.0.1:39174 (--dev or
      custom --data-dir). Override via --http-port or FEATHERLOG_HTTP_PORT.

  featherlog status [--json]
      Show active concurrent work slots.

  featherlog focus <title> [--tag <tag>] [--note <breadcrumb>] [--json]
      Focus a work slot (demotes any previous focus slot to running).

  featherlog run <title> [--tag <tag>] [--remind <duration>] [--note <breadcrumb>] [--json]
      Start or switch a slot to running in the background (e.g. --remind 15m).

  featherlog ready <id-or-substring> [--note <breadcrumb>] [--json]
      Mark a matching work slot as ready for review.

  featherlog done <id-or-substring> [--complete-task] [--json]
      Complete and remove a matching work slot.

  featherlog note <text> [--task <taskId>] [--json]
      Add a standalone note (or task-linked note with --task).

  featherlog toggle [--expand | --collapse] [--json]
      Toggle the running desktop Workspace Panel.

  featherlog version | -v | --version
      Print the featherlog version and exit.
`)
}
