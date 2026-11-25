package app

import (
	"github.com/egoist/mygo"
	"github.com/muyuzhong/featherlog/internal/settings"
	"github.com/muyuzhong/featherlog/internal/tasks"
	"github.com/muyuzhong/featherlog/internal/workbench"
)

// NotesChangedEvent is the payload emitted on the "notes:changed" event.
type NotesChangedEvent struct {
	Reason string `json:"reason"`
}

// DockToggleEvent is the payload emitted on the "dock:toggle" event.
type DockToggleEvent struct {
	Expanded *bool `json:"expanded,omitempty"`
}

// Package-level typed MyGo events matching §4.3 of the shared contract.
var (
	EventWorkbenchChanged = mygo.NewEvent[[]workbench.WorkSlot]("workbench:changed")
	EventTasksChanged     = mygo.NewEvent[tasks.ListResult]("tasks:changed")
	EventNotesChanged     = mygo.NewEvent[NotesChangedEvent]("notes:changed")
	EventSettingsChanged  = mygo.NewEvent[settings.Settings]("settings:changed")
	EventDockToggle       = mygo.NewEvent[DockToggleEvent]("dock:toggle")
)

// EventSink delivers real-time state change events to connected frontends.
type EventSink interface {
	WorkbenchChanged(slots []workbench.WorkSlot)
	TasksChanged(result tasks.ListResult)
	NotesChanged(evt NotesChangedEvent)
	SettingsChanged(s settings.Settings)
	DockToggle(evt DockToggleEvent)
}

// MyGoEventSink broadcasts events to all MyGo webview windows.
type MyGoEventSink struct{}

func (MyGoEventSink) WorkbenchChanged(slots []workbench.WorkSlot) {
	if slots == nil {
		slots = []workbench.WorkSlot{}
	}
	_ = EventWorkbenchChanged.Broadcast(slots)
}

func (MyGoEventSink) TasksChanged(result tasks.ListResult) {
	if result.Tasks == nil {
		result.Tasks = []tasks.Task{}
	}
	_ = EventTasksChanged.Broadcast(result)
}

func (MyGoEventSink) NotesChanged(evt NotesChangedEvent) {
	_ = EventNotesChanged.Broadcast(evt)
}

func (MyGoEventSink) SettingsChanged(s settings.Settings) {
	_ = EventSettingsChanged.Broadcast(s)
}

func (MyGoEventSink) DockToggle(evt DockToggleEvent) {
	_ = EventDockToggle.Broadcast(evt)
}
