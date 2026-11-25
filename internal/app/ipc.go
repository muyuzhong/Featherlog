package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/muyuzhong/featherlog/internal/ipcsock"
	"github.com/muyuzhong/featherlog/internal/notes"
	"github.com/muyuzhong/featherlog/internal/workbench"
)

// DoneResult is returned by the CLI "done" command over IPC.
type DoneResult struct {
	Removed   workbench.WorkSlot   `json:"removed"`
	Remaining []workbench.WorkSlot `json:"remaining"`
}

// HandleIPC routes CLI requests received over the single-instance Unix socket.
func (a *App) HandleIPC(_ context.Context, req ipcsock.Request) (any, error) {
	switch req.Command {
	case ipcsock.CmdToggle:
		var p ipcsock.ToggleParams
		if len(req.Params) > 0 {
			if err := json.Unmarshal(req.Params, &p); err != nil {
				return nil, &ipcsock.CodedError{Code: "ipcsock/invalid-params", Message: err.Error()}
			}
		}
		expanded := a.Dock.Toggle(p.Expanded)
		return ipcsock.ToggleResult{Expanded: expanded}, nil

	case ipcsock.CmdStatus:
		return a.WorkbenchSvc.List()

	case ipcsock.CmdFocus:
		var p ipcsock.FocusParams
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return nil, &ipcsock.CodedError{Code: "ipcsock/invalid-params", Message: err.Error()}
		}
		return a.cliUpsertSlot(p.Title, p.Tag, p.Note, workbench.StateFocus, nil)

	case ipcsock.CmdRun:
		var p ipcsock.RunParams
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return nil, &ipcsock.CodedError{Code: "ipcsock/invalid-params", Message: err.Error()}
		}
		var remindMin *int
		if p.RemindSeconds > 0 {
			m := (p.RemindSeconds + 59) / 60
			if m < 1 {
				m = 1
			}
			remindMin = &m
		}
		return a.cliUpsertSlot(p.Title, p.Tag, p.Note, workbench.StateRunning, remindMin)

	case ipcsock.CmdReady:
		var p ipcsock.ReadyParams
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return nil, &ipcsock.CodedError{Code: "ipcsock/invalid-params", Message: err.Error()}
		}
		slot, err := a.Workbench.Find(p.Target)
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(p.Note) != "" {
			note := p.Note
			if _, err := a.Workbench.Update(workbench.UpdateInput{
				ID:         slot.ID,
				Breadcrumb: &note,
			}); err != nil {
				return nil, err
			}
		}
		if _, err := a.Workbench.SetState(workbench.SetStateInput{
			ID:    slot.ID,
			State: workbench.StateReady,
		}); err != nil {
			return nil, err
		}
		return a.Workbench.Get(slot.ID)

	case ipcsock.CmdDone:
		var p ipcsock.DoneParams
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return nil, &ipcsock.CodedError{Code: "ipcsock/invalid-params", Message: err.Error()}
		}
		slot, err := a.Workbench.Find(p.Target)
		if err != nil {
			return nil, err
		}
		remaining, err := a.WorkbenchSvc.Complete(WorkbenchCompleteInput{
			ID:                 slot.ID,
			CompleteLinkedTask: p.CompleteLinkedTask,
		})
		if err != nil {
			return nil, err
		}
		return DoneResult{Removed: slot, Remaining: remaining}, nil

	case ipcsock.CmdNote:
		var p ipcsock.NoteParams
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return nil, &ipcsock.CodedError{Code: "ipcsock/invalid-params", Message: err.Error()}
		}
		return a.NoteSvc.Create(notes.CreateInput{
			Content: p.Text,
			TaskID:  p.TaskID,
		})

	default:
		return nil, &ipcsock.CodedError{
			Code:    "ipcsock/unknown-command",
			Message: fmt.Sprintf("unknown command %q", req.Command),
		}
	}
}

// cliUpsertSlot updates and transitions an existing slot matching title/ID, or
// creates a new slot if none matches exactly.
func (a *App) cliUpsertSlot(title, tag, note string, state workbench.WorkSlotState, remindMin *int) (workbench.WorkSlot, error) {
	trimmed := strings.TrimSpace(title)
	if trimmed == "" {
		return workbench.WorkSlot{}, &ipcsock.CodedError{
			Code:    workbench.ErrCodeInvalidInput,
			Message: "slot title must not be empty",
		}
	}

	slots, err := a.Workbench.List()
	if err != nil {
		return workbench.WorkSlot{}, err
	}
	var existing *workbench.WorkSlot
	for i := range slots {
		if slots[i].ID == trimmed || strings.EqualFold(slots[i].Title, trimmed) {
			existing = &slots[i]
			break
		}
	}

	if existing == nil {
		return a.Workbench.Create(workbench.CreateInput{
			Title:           trimmed,
			Tag:             tag,
			Breadcrumb:      note,
			State:           state,
			RemindInMinutes: remindMin,
		})
	}

	if strings.TrimSpace(tag) != "" || strings.TrimSpace(note) != "" {
		upd := workbench.UpdateInput{ID: existing.ID}
		if strings.TrimSpace(tag) != "" {
			t := tag
			upd.Tag = &t
		}
		if strings.TrimSpace(note) != "" {
			n := note
			upd.Breadcrumb = &n
		}
		if _, err := a.Workbench.Update(upd); err != nil {
			return workbench.WorkSlot{}, err
		}
	}

	if _, err := a.Workbench.SetState(workbench.SetStateInput{
		ID:              existing.ID,
		State:           state,
		RemindInMinutes: remindMin,
	}); err != nil {
		return workbench.WorkSlot{}, err
	}
	return a.Workbench.Get(existing.ID)
}
