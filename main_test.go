package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/muyuzhong/featherlog/internal/app"
	"github.com/muyuzhong/featherlog/internal/barhttp"
	"github.com/muyuzhong/featherlog/internal/clock"
	"github.com/muyuzhong/featherlog/internal/dock"
	"github.com/muyuzhong/featherlog/internal/ipcsock"
	"github.com/muyuzhong/featherlog/internal/notes"
	"github.com/muyuzhong/featherlog/internal/workbench"
)

type cliTestScreen struct{}

func (cliTestScreen) ActiveDisplay(dock.Rect) dock.Display {
	return dock.Display{
		Bounds:   dock.Rect{Width: 1920, Height: 1080},
		WorkArea: dock.Rect{Width: 1920, Height: 1032},
		Primary:  true,
	}
}
func (cliTestScreen) OnDisplaysChanged(func()) func() { return func() {} }

type cliTestLayer struct{}

func (cliTestLayer) Available() bool                      { return false }
func (cliTestLayer) AnchorBottomCenter(uintptr, int) bool { return false }

func TestCLIEndToEndLiveSocketFlow(t *testing.T) {
	dataDir := t.TempDir()
	clk := clock.NewFake(time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC))

	application, err := app.Open(app.Config{
		DataDir: dataDir,
		Clock:   clk,
		DockCfg: dock.Config{
			Screen: cliTestScreen{},
			Layer:  cliTestLayer{},
		},
	})
	if err != nil {
		t.Fatalf("app.Open: %v", err)
	}
	defer application.Close()

	srv, err := ipcsock.Listen(ipcsock.SocketPath(dataDir), application.HandleIPC)
	if err != nil {
		t.Fatalf("ipcsock.Listen: %v", err)
	}
	defer func() { _ = srv.Close() }()

	execCLI := func(args ...string) (string, string, int) {
		var out, errBuf bytes.Buffer
		full := append([]string{"--data-dir", dataDir}, args...)
		code := run(full, &out, &errBuf)
		return out.String(), errBuf.String(), code
	}

	// 1. focus
	out, errOut, code := execCLI("focus", "Implement OAuth", "--tag", "API", "--note", "add refresh test", "--json")
	if code != 0 {
		t.Fatalf("focus failed (%d): %s", code, errOut)
	}
	var focusSlot workbench.WorkSlot
	if err := json.Unmarshal([]byte(out), &focusSlot); err != nil {
		t.Fatalf("decode focus JSON: %v\n%s", err, out)
	}
	if focusSlot.State != workbench.StateFocus || focusSlot.Tag != "API" || focusSlot.Breadcrumb != "add refresh test" {
		t.Fatalf("unexpected focus slot: %+v", focusSlot)
	}

	// 2. run with --remind 15m
	out, errOut, code = execCLI("run", "Frontend Vitest", "--tag", "UI", "--remind", "15m", "--note", "wait for green", "--json")
	if code != 0 {
		t.Fatalf("run failed (%d): %s", code, errOut)
	}
	var runSlot workbench.WorkSlot
	if err := json.Unmarshal([]byte(out), &runSlot); err != nil {
		t.Fatalf("decode run JSON: %v", err)
	}
	if runSlot.State != workbench.StateRunning || runSlot.RemindAt == nil {
		t.Fatalf("unexpected run slot: %+v", runSlot)
	}

	// 3. ready by substring
	out, errOut, code = execCLI("ready", "Vitest", "--note", "all 42 tests green", "--json")
	if code != 0 {
		t.Fatalf("ready failed (%d): %s", code, errOut)
	}
	var readySlot workbench.WorkSlot
	if err := json.Unmarshal([]byte(out), &readySlot); err != nil {
		t.Fatalf("decode ready JSON: %v", err)
	}
	if readySlot.State != workbench.StateReady || readySlot.Breadcrumb != "all 42 tests green" {
		t.Fatalf("unexpected ready slot: %+v", readySlot)
	}

	// 4. status table & JSON
	tableOut, errOut, code := execCLI("status")
	if code != 0 {
		t.Fatalf("status table failed (%d): %s", code, errOut)
	}
	if !strings.Contains(tableOut, "FOCUS") || !strings.Contains(tableOut, "READY") || !strings.Contains(tableOut, "Implement OAuth") {
		t.Fatalf("unexpected status table:\n%s", tableOut)
	}

	jsonOut, errOut, code := execCLI("status", "--json")
	if code != 0 {
		t.Fatalf("status json failed (%d): %s", code, errOut)
	}
	var slots []workbench.WorkSlot
	if err := json.Unmarshal([]byte(jsonOut), &slots); err != nil || len(slots) != 2 {
		t.Fatalf("status json slots=%d err=%v", len(slots), err)
	}

	// 5. done
	out, errOut, code = execCLI("done", "Vitest", "--json")
	if code != 0 {
		t.Fatalf("done failed (%d): %s", code, errOut)
	}
	var doneRes app.DoneResult
	if err := json.Unmarshal([]byte(out), &doneRes); err != nil || len(doneRes.Remaining) != 1 {
		t.Fatalf("done json=%+v err=%v", doneRes, err)
	}

	// 6. note
	out, errOut, code = execCLI("note", "Checked Wayland bottom anchoring", "--json")
	if code != 0 {
		t.Fatalf("note failed (%d): %s", code, errOut)
	}
	var note notes.Note
	if err := json.Unmarshal([]byte(out), &note); err != nil || note.Content != "Checked Wayland bottom anchoring" {
		t.Fatalf("note json=%+v err=%v", note, err)
	}

	// 7. toggle
	out, errOut, code = execCLI("toggle", "--expand", "--json")
	if code != 0 {
		t.Fatalf("toggle failed (%d): %s", code, errOut)
	}
	var toggleRes ipcsock.ToggleResult
	if err := json.Unmarshal([]byte(out), &toggleRes); err != nil || !toggleRes.Expanded {
		t.Fatalf("toggle json=%+v err=%v", toggleRes, err)
	}
}

func TestCLIOfflineDirectStoreFallback(t *testing.T) {
	dataDir := t.TempDir()

	var out, errBuf bytes.Buffer
	if code := run([]string{"--data-dir", dataDir, "focus", "Offline Slot", "--note", "saved directly", "--json"}, &out, &errBuf); code != 0 {
		t.Fatalf("offline focus failed (%d): %s", code, errBuf.String())
	}

	out.Reset()
	errBuf.Reset()
	if code := run([]string{"--data-dir", dataDir, "status", "--json"}, &out, &errBuf); code != 0 {
		t.Fatalf("offline status failed (%d): %s", code, errBuf.String())
	}
	var slots []workbench.WorkSlot
	if err := json.Unmarshal(out.Bytes(), &slots); err != nil {
		t.Fatalf("decode offline status: %v", err)
	}
	if len(slots) != 1 || slots[0].Title != "Offline Slot" || slots[0].Breadcrumb != "saved directly" {
		t.Fatalf("unexpected offline slots: %+v", slots)
	}
}

func TestParseRemindDuration(t *testing.T) {
	d, err := parseRemindDuration("15m")
	if err != nil || d != 15*time.Minute {
		t.Fatalf("parseRemindDuration(15m) = %v, %v", d, err)
	}
	d, err = parseRemindDuration("20")
	if err != nil || d != 20*time.Minute {
		t.Fatalf("parseRemindDuration(20) = %v, %v", d, err)
	}
	if _, err := parseRemindDuration("-5m"); err == nil {
		t.Fatalf("expected error for negative duration")
	}
	if _, err := parseRemindDuration("0"); err == nil {
		t.Fatalf("expected error for zero duration")
	}
}

func TestSplitGlobalArgsAndHTTPPortResolution(t *testing.T) {
	opts, subcmd, _, err := splitGlobalArgs([]string{"--show", "--http-port", "40100", "--dev"})
	if err != nil {
		t.Fatalf("splitGlobalArgs: %v", err)
	}
	if !opts.show || !opts.dev || !opts.httpPortSet || opts.httpPort != 40100 || subcmd != "" {
		t.Fatalf("unexpected opts=%+v subcmd=%q", opts, subcmd)
	}

	optsZero, _, _, err := splitGlobalArgs([]string{"--http-port=0"})
	if err != nil {
		t.Fatalf("splitGlobalArgs --http-port=0: %v", err)
	}
	if !optsZero.httpPortSet || optsZero.httpPort != 0 {
		t.Fatalf("expected ephemeral port 0 marked set, got %+v", optsZero)
	}

	if _, _, _, err := splitGlobalArgs([]string{"--http-port", "70000"}); err == nil {
		t.Fatalf("expected error for out-of-range --http-port")
	}

	emptyEnv := func(string) string { return "" }
	if p, err := resolveHTTPPort(globalOptions{}, emptyEnv); err != nil || p != barhttp.DefaultProdPort {
		t.Fatalf("prod default port = (%d, %v), want (%d, nil)", p, err, barhttp.DefaultProdPort)
	}
	if p, err := resolveHTTPPort(globalOptions{dev: true}, emptyEnv); err != nil || p != barhttp.DefaultDevPort {
		t.Fatalf("dev default port = (%d, %v), want (%d, nil)", p, err, barhttp.DefaultDevPort)
	}
	if p, err := resolveHTTPPort(globalOptions{dataDir: "/tmp/custom"}, emptyEnv); err != nil || p != barhttp.DefaultDevPort {
		t.Fatalf("custom dataDir port = (%d, %v), want (%d, nil)", p, err, barhttp.DefaultDevPort)
	}
	if p, err := resolveHTTPPort(optsZero, func(k string) string {
		if k == "FEATHERLOG_HTTP_PORT" {
			return "45555"
		}
		return ""
	}); err != nil || p != 0 {
		t.Fatalf("explicit --http-port=0 must override env, got (%d, %v)", p, err)
	}
	if p, err := resolveHTTPPort(globalOptions{}, func(k string) string {
		if k == "FEATHERLOG_HTTP_PORT" {
			return "45555"
		}
		return ""
	}); err != nil || p != 45555 {
		t.Fatalf("env FEATHERLOG_HTTP_PORT = (%d, %v), want (45555, nil)", p, err)
	}
}

func TestVersionFlagAndSubcommand(t *testing.T) {
	if version != "2.0.0" {
		t.Fatalf("default version = %q, want %q", version, "2.0.0")
	}

	for _, arg := range []string{"version", "-v", "--version"} {
		var out, errBuf bytes.Buffer
		code := run([]string{arg}, &out, &errBuf)
		if code != 0 {
			t.Fatalf("%s exited %d: %s", arg, code, errBuf.String())
		}
		if errBuf.Len() != 0 {
			t.Fatalf("%s wrote unexpected stderr: %q", arg, errBuf.String())
		}
		want := "featherlog 2.0.0\n"
		if out.String() != want {
			t.Fatalf("%s stdout = %q, want %q", arg, out.String(), want)
		}
	}

	prev := version
	version = "2.1.0-rc.1"
	t.Cleanup(func() { version = prev })

	var out, errBuf bytes.Buffer
	if code := run([]string{"--version"}, &out, &errBuf); code != 0 {
		t.Fatalf("--version with overridden version exited %d: %s", code, errBuf.String())
	}
	if out.String() != "featherlog 2.1.0-rc.1\n" {
		t.Fatalf("--version stdout = %q, want %q", out.String(), "featherlog 2.1.0-rc.1\n")
	}
}
