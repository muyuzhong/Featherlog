package migrate

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/muyuzhong/featherlog/internal/clock"
	"github.com/muyuzhong/featherlog/internal/notes"
	"github.com/muyuzhong/featherlog/internal/settings"
	"github.com/muyuzhong/featherlog/internal/store"
	"github.com/muyuzhong/featherlog/internal/tasks"
)

const (
	// SettingsBackupFileName is the atomic backup of v1 Electron settings.json
	// created before writing the migrated v2 settings.json.
	SettingsBackupFileName = "settings.v1.json.bak"

	ErrCodeInvalidInput = "migrate/invalid-input"
	ErrCodeCorrupt      = "migrate/corrupt"

	v2TasksSchemaVersion = 1
	v2NotesSchemaVersion = 1

	maxTaskTitleRunes    = 200
	maxTaskItemTextRunes = 500
	maxNoteContentRunes  = 20_000
)

// Report summarizes what Run migrated from Featherlog v1 Electron storage.
type Report struct {
	SettingsMigrated bool
	SettingsBackup   string
	TasksMigrated    int
	TasksSkipped     int
	NotesMigrated    int
	NotesSkipped     int
}

// Migrated reports whether any v1 data was converted to v2 format.
func (r Report) Migrated() bool {
	return r.SettingsMigrated || r.TasksMigrated > 0 || r.NotesMigrated > 0
}

// Run inspects st and performs idempotent, non-destructive migration from
// Featherlog v1 Electron files (<dataDir>/settings.json,
// <dataDir>/plugins/quest/, <dataDir>/plugins/notes/) to v2 JSON files.
//
// Files inside <dataDir>/plugins/ are strictly read-only and are never modified
// or deleted.
func Run(st *store.Store, clk clock.Clock) (Report, error) {
	if st == nil {
		return Report{}, store.NewError(ErrCodeInvalidInput, "store is required", nil)
	}
	if clk == nil {
		clk = clock.NewReal()
	}

	var report Report

	dayStartHour, settingsMigrated, backupPath, err := migrateSettings(st)
	if err != nil {
		return report, err
	}
	report.SettingsMigrated = settingsMigrated
	report.SettingsBackup = backupPath

	taskIDs, tasksMigrated, tasksSkipped, err := migrateQuests(st, clk, dayStartHour)
	if err != nil {
		return report, err
	}
	report.TasksMigrated = tasksMigrated
	report.TasksSkipped = tasksSkipped

	notesMigrated, notesSkipped, err := migrateNotes(st, clk, taskIDs)
	if err != nil {
		return report, err
	}
	report.NotesMigrated = notesMigrated
	report.NotesSkipped = notesSkipped

	return report, nil
}

func migrateSettings(st *store.Store) (int, bool, string, error) {
	def := settings.Default()
	raw, found, err := st.ReadRaw(settings.FileName)
	if err != nil {
		return def.DayStartHour, false, "", err
	}
	if !found {
		return def.DayStartHour, false, "", nil
	}

	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		// Leave corrupt JSON untouched so settings.Open handles backup/recovery.
		return def.DayStartHour, false, "", nil
	}

	var top map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &top); err != nil || top == nil {
		return def.DayStartHour, false, "", nil
	}

	// Presence of a top-level "theme" string identifies an already-v2 settings file.
	if rawTheme, ok := top["theme"]; ok && isJSONString(rawTheme) {
		if h, ok := decodeJSONInt(top["dayStartHour"]); ok {
			return clampInt(h, 0, 23), false, "", nil
		}
		return def.DayStartHour, false, "", nil
	}

	shellObj, hasShell := decodeJSONObject(top["shell"])
	pluginsObj, hasPlugins := decodeJSONObject(top["plugins"])
	if !hasShell && !hasPlugins {
		// Not a v1 Electron settings document; let settings.Open validate or back up.
		if h, ok := decodeJSONInt(top["dayStartHour"]); ok {
			return clampInt(h, 0, 23), false, "", nil
		}
		return def.DayStartHour, false, "", nil
	}

	out := settings.Default()
	out.Theme = settings.ThemeStone
	out.Pinned = false

	if hasShell {
		if b, ok := decodeJSONBool(shellObj["sound"]); ok {
			out.Sound = b
		}
		if v, ok := decodeJSONInt(shellObj["volume"]); ok {
			out.Volume = clampInt(v, 0, 10)
		}
	}
	if hasPlugins {
		if questObj, ok := decodeJSONObject(pluginsObj["quest"]); ok {
			if h, ok := decodeJSONInt(questObj["dayStartHour"]); ok {
				out.DayStartHour = clampInt(h, 0, 23)
			}
		}
	}

	bakPath, err := st.Path(SettingsBackupFileName)
	if err != nil {
		return def.DayStartHour, false, "", err
	}
	if _, statErr := os.Stat(bakPath); errors.Is(statErr, os.ErrNotExist) {
		if err := writeFileAtomic(bakPath, raw); err != nil {
			return def.DayStartHour, false, "", fmt.Errorf("backup v1 settings to %s: %w", bakPath, err)
		}
	} else if statErr != nil {
		return def.DayStartHour, false, "", fmt.Errorf("stat settings backup %s: %w", bakPath, statErr)
	}

	if err := st.WriteJSON(settings.FileName, out); err != nil {
		return def.DayStartHour, false, "", fmt.Errorf("write migrated settings: %w", err)
	}
	return out.DayStartHour, true, bakPath, nil
}

type v2StoredTask struct {
	ID           string                `json:"id"`
	Kind         tasks.TaskKind        `json:"kind"`
	Title        string                `json:"title"`
	Status       tasks.TaskStatus      `json:"status"`
	Items        []tasks.TaskItem      `json:"items"`
	Quota        *tasks.TaskQuota      `json:"quota,omitempty"`
	Recurrence   *tasks.TaskRecurrence `json:"recurrence,omitempty"`
	PeriodKey    string                `json:"periodKey,omitempty"`
	Deadline     string                `json:"deadline,omitempty"`
	ScheduledFor string                `json:"scheduledFor,omitempty"`
	Order        int                   `json:"order"`
	CreatedAt    int64                 `json:"createdAt"`
	CompletedAt  *int64                `json:"completedAt,omitempty"`
}

type v2TasksPersistedState struct {
	SchemaVersion int                 `json:"schemaVersion"`
	LastPeriodKey string              `json:"lastPeriodKey"`
	Tasks         []v2StoredTask      `json:"tasks"`
	History       map[string][]string `json:"history"`
}

type v2NotesPersistedState struct {
	SchemaVersion int          `json:"schemaVersion"`
	Notes         []notes.Note `json:"notes"`
}

type v1QuestStateEnvelope struct {
	SchemaVersion int                 `json:"schemaVersion"`
	Quests        json.RawMessage     `json:"quests"`
	History       map[string][]string `json:"history"`
	Meta          struct {
		LastPeriodKey string `json:"lastPeriodKey"`
	} `json:"meta"`
}

type v1QuestRef struct {
	ID  string `json:"id"`
	Key string `json:"key"`
}

type v1QuestRecord struct {
	Quest   *v1Quest `json:"quest"`
	History []string `json:"history"`
}

type v1Quest struct {
	ID           string        `json:"id"`
	Kind         string        `json:"kind"`
	Title        string        `json:"title"`
	Name         string        `json:"name"`
	Status       string        `json:"status"`
	Chapters     []v1Chapter   `json:"chapters"`
	Recurrence   *v1Recurrence `json:"recurrence"`
	Quota        *v1Quota      `json:"quota"`
	Cycle        *v1Cycle      `json:"cycle"`
	Deadline     string        `json:"deadline"`
	ScheduledFor string        `json:"scheduledFor"`
	Order        int           `json:"order"`
	CreatedAt    string        `json:"createdAt"`
	UpdatedAt    string        `json:"updatedAt"`
	CompletedAt  string        `json:"completedAt"`
}

type v1Chapter struct {
	ID         string        `json:"id"`
	Title      string        `json:"title"`
	Deadline   string        `json:"deadline"`
	DoneAt     string        `json:"doneAt"`
	Objectives []v1Objective `json:"objectives"`
}

type v1Objective struct {
	ID     string   `json:"id"`
	Text   string   `json:"text"`
	Detail string   `json:"detail"`
	DoneAt string   `json:"doneAt"`
	Count  *v1Count `json:"count"`
}

type v1Count struct {
	Target  int    `json:"target"`
	Current int    `json:"current"`
	Unit    string `json:"unit"`
}

type v1Recurrence struct {
	Freq     string `json:"freq"`
	Weekdays []int  `json:"weekdays"`
}

type v1Quota struct {
	Target int    `json:"target"`
	Unit   string `json:"unit"`
}

type v1Cycle struct {
	PeriodKey string `json:"periodKey"`
	Current   int    `json:"current"`
	Done      bool   `json:"done"`
}

type loadedV1Quest struct {
	quest      v1Quest
	history    []string
	stateIndex int
}

type migratedTaskEntry struct {
	task       v2StoredTask
	origKind   string
	origOrder  int
	stateIndex int
}

func migrateQuests(st *store.Store, clk clock.Clock, dayStartHour int) (map[string]struct{}, int, int, error) {
	tasksPath, err := st.Path(tasks.FileName)
	if err != nil {
		return nil, 0, 0, err
	}
	if exists, err := fileExists(tasksPath); err != nil {
		return nil, 0, 0, err
	} else if exists {
		// Never overwrite an existing v2 tasks.json, but still load existing task
		// IDs so a pending notes migration can validate questId links.
		return readExistingTaskIDs(st), 0, 0, nil
	}

	questDir := filepath.Join(st.Dir(), "plugins", "quest")
	statePath := filepath.Join(questDir, "state.json")
	rawState, err := os.ReadFile(statePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, 0, 0, nil
		}
		return nil, 0, 0, fmt.Errorf("read v1 quest state: %w", err)
	}

	var env v1QuestStateEnvelope
	if err := json.Unmarshal(bytes.TrimSpace(rawState), &env); err != nil {
		return nil, 0, 0, store.NewError(ErrCodeCorrupt, "parse v1 quest state.json", err)
	}

	var loaded []loadedV1Quest
	skipped := 0

	switch env.SchemaVersion {
	case 2:
		var refs []v1QuestRef
		if len(bytes.TrimSpace(env.Quests)) > 0 {
			if err := json.Unmarshal(env.Quests, &refs); err != nil {
				return nil, 0, 0, store.NewError(ErrCodeCorrupt, "parse v1 quest index", err)
			}
		}
		for i, ref := range refs {
			rec, ok := readQuestRecord(questDir, ref.Key)
			if !ok || rec.Quest == nil {
				skipped++
				continue
			}
			q := *rec.Quest
			if strings.TrimSpace(q.ID) == "" && strings.TrimSpace(ref.ID) != "" {
				q.ID = strings.TrimSpace(ref.ID)
			}
			loaded = append(loaded, loadedV1Quest{
				quest:      q,
				history:    rec.History,
				stateIndex: i,
			})
		}
	case 1:
		var quests []v1Quest
		if len(bytes.TrimSpace(env.Quests)) > 0 {
			if err := json.Unmarshal(env.Quests, &quests); err != nil {
				return nil, 0, 0, store.NewError(ErrCodeCorrupt, "parse v1 inline quests", err)
			}
		}
		for i, q := range quests {
			loaded = append(loaded, loadedV1Quest{
				quest:      q,
				history:    env.History[q.ID],
				stateIndex: i,
			})
		}
	default:
		return nil, 0, 0, store.NewError(ErrCodeCorrupt, fmt.Sprintf("unsupported v1 quest schemaVersion %d", env.SchemaVersion), nil)
	}

	lastPeriodKey, ok := normalizeDateKey(env.Meta.LastPeriodKey)
	if !ok {
		for _, item := range loaded {
			if item.quest.Cycle != nil {
				if ck, valid := normalizeDateKey(item.quest.Cycle.PeriodKey); valid && ck > lastPeriodKey {
					lastPeriodKey = ck
				}
			}
		}
	}
	if lastPeriodKey == "" {
		lastPeriodKey = tasks.PeriodKey(clk.Now(), dayStartHour)
	}

	nowMs := clk.Now().UnixMilli()
	seenTaskIDs := make(map[string]struct{}, len(loaded))
	entries := make([]migratedTaskEntry, 0, len(loaded))
	history := make(map[string][]string)

	for _, item := range loaded {
		converted, histDays, ok := convertQuest(item.quest, item.history, lastPeriodKey, nowMs, seenTaskIDs)
		if !ok {
			skipped++
			continue
		}
		seenTaskIDs[converted.ID] = struct{}{}
		if len(histDays) > 0 {
			history[converted.ID] = histDays
		}
		entries = append(entries, migratedTaskEntry{
			task:       converted,
			origKind:   strings.TrimSpace(item.quest.Kind),
			origOrder:  item.quest.Order,
			stateIndex: item.stateIndex,
		})
	}

	if len(entries) == 0 {
		return seenTaskIDs, 0, skipped, nil
	}

	sort.SliceStable(entries, func(i, j int) bool {
		si, sj := statusOrderRank(entries[i].task.Status), statusOrderRank(entries[j].task.Status)
		if si != sj {
			return si < sj
		}
		ki, kj := v1KindOrderRank(entries[i].origKind), v1KindOrderRank(entries[j].origKind)
		if ki != kj {
			return ki < kj
		}
		if entries[i].origOrder != entries[j].origOrder {
			return entries[i].origOrder < entries[j].origOrder
		}
		return entries[i].stateIndex < entries[j].stateIndex
	})

	storedTasks := make([]v2StoredTask, len(entries))
	for i := range entries {
		entries[i].task.Order = i
		storedTasks[i] = entries[i].task
	}

	doc := v2TasksPersistedState{
		SchemaVersion: v2TasksSchemaVersion,
		LastPeriodKey: lastPeriodKey,
		Tasks:         storedTasks,
		History:       history,
	}
	if err := st.WriteJSON(tasks.FileName, doc); err != nil {
		return nil, 0, skipped, fmt.Errorf("write migrated tasks: %w", err)
	}
	return seenTaskIDs, len(storedTasks), skipped, nil
}

func convertQuest(
	q v1Quest,
	rawHistory []string,
	lastPeriodKey string,
	nowMs int64,
	seenTaskIDs map[string]struct{},
) (v2StoredTask, []string, bool) {
	id := strings.TrimSpace(q.ID)
	if id == "" {
		id = store.NewID()
	}
	if _, dup := seenTaskIDs[id]; dup {
		return v2StoredTask{}, nil, false
	}

	title := strings.TrimSpace(q.Title)
	if title == "" {
		title = strings.TrimSpace(q.Name)
	}
	if title == "" {
		return v2StoredTask{}, nil, false
	}
	title = truncateRunes(title, maxTaskTitleRunes)

	origKind := strings.TrimSpace(q.Kind)
	isDaily := origKind == "daily"
	kind := tasks.KindSide
	if isDaily {
		kind = tasks.KindDaily
	}

	var rec *tasks.TaskRecurrence
	if isDaily {
		rec = normalizeRecurrence(q.Recurrence)
	}

	historySet := make(map[string]struct{}, len(rawHistory)+1)
	for _, d := range rawHistory {
		if validDay, ok := normalizeDateKey(d); ok {
			historySet[validDay] = struct{}{}
		}
	}

	createdAt, ok := parseTimestampMs(q.CreatedAt)
	if !ok {
		if updatedAt, okU := parseTimestampMs(q.UpdatedAt); okU {
			createdAt = updatedAt
		} else {
			createdAt = nowMs
		}
	}

	rawStatus := strings.TrimSpace(q.Status)
	var status tasks.TaskStatus
	var completedAt *int64
	var periodKey string
	var quota *tasks.TaskQuota

	if isDaily {
		periodKey = lastPeriodKey

		var cycleKey string
		var hasCycleKey bool
		var cycleDone bool
		var cycleCurrent int
		if q.Cycle != nil {
			cycleKey, hasCycleKey = normalizeDateKey(q.Cycle.PeriodKey)
			cycleDone = q.Cycle.Done
			cycleCurrent = q.Cycle.Current
			if cycleDone && hasCycleKey {
				historySet[cycleKey] = struct{}{}
			}
		}

		cycleMatchesLast := !hasCycleKey || cycleKey >= lastPeriodKey

		switch {
		case rawStatus == "archived":
			status = tasks.StatusArchived
			if ts, ok := parseTimestampMs(q.CompletedAt); ok {
				completedAt = &ts
			}
		case (cycleDone && cycleMatchesLast) || (rawStatus == "completed" && cycleMatchesLast):
			// v1 keeps daily quest.status == "active" while cycle.done == true;
			// v2 represents current-period completion with status == "completed".
			status = tasks.StatusCompleted
			if hasCycleKey {
				historySet[cycleKey] = struct{}{}
			} else {
				historySet[lastPeriodKey] = struct{}{}
			}
			ts, ok := parseTimestampMs(q.CompletedAt)
			if !ok {
				ts, ok = parseTimestampMs(q.UpdatedAt)
			}
			if !ok {
				ts = nowMs
			}
			completedAt = &ts
		default:
			if rawStatus == "completed" && hasCycleKey {
				historySet[cycleKey] = struct{}{}
			}
			status = tasks.StatusActive
		}

		if q.Quota != nil && q.Quota.Target >= 1 {
			cur := 0
			if q.Cycle != nil && cycleMatchesLast && cycleCurrent > 0 {
				cur = cycleCurrent
			}
			if cur > q.Quota.Target {
				cur = q.Quota.Target
			}
			if status == tasks.StatusCompleted && cur < q.Quota.Target {
				cur = q.Quota.Target
			}
			quota = &tasks.TaskQuota{
				Current: cur,
				Target:  q.Quota.Target,
			}
		}
	} else {
		switch rawStatus {
		case "completed":
			status = tasks.StatusCompleted
			ts, ok := parseTimestampMs(q.CompletedAt)
			if !ok {
				ts, ok = parseTimestampMs(q.UpdatedAt)
			}
			if !ok {
				ts = createdAt
			}
			completedAt = &ts
		case "archived":
			status = tasks.StatusArchived
			if ts, ok := parseTimestampMs(q.CompletedAt); ok {
				completedAt = &ts
			}
		default:
			status = tasks.StatusActive
		}

		if q.Quota != nil && q.Quota.Target >= 1 {
			cur := 0
			if status == tasks.StatusCompleted {
				cur = q.Quota.Target
			}
			quota = &tasks.TaskQuota{
				Current: cur,
				Target:  q.Quota.Target,
			}
		}
	}

	items := flattenChapters(q.Chapters, status == tasks.StatusCompleted)
	deadline, _ := normalizeDateKey(q.Deadline)
	scheduledFor, _ := normalizeDateKey(q.ScheduledFor)

	var histDays []string
	if len(historySet) > 0 {
		histDays = make([]string, 0, len(historySet))
		for d := range historySet {
			histDays = append(histDays, d)
		}
		sort.Strings(histDays)
	}

	task := v2StoredTask{
		ID:           id,
		Kind:         kind,
		Title:        title,
		Status:       status,
		Items:        items,
		Quota:        quota,
		Recurrence:   rec,
		PeriodKey:    periodKey,
		Deadline:     deadline,
		ScheduledFor: scheduledFor,
		CreatedAt:    createdAt,
		CompletedAt:  completedAt,
	}
	return task, histDays, true
}

func flattenChapters(chapters []v1Chapter, questCompleted bool) []tasks.TaskItem {
	items := make([]tasks.TaskItem, 0)
	seenItemIDs := make(map[string]struct{})

	for _, ch := range chapters {
		chTitle := strings.TrimSpace(ch.Title)
		chDone := strings.TrimSpace(ch.DoneAt) != ""

		for _, obj := range ch.Objectives {
			text := formatItemText(chTitle, obj.Text, len(ch.Objectives))
			if text == "" {
				continue
			}
			text = truncateRunes(text, maxTaskItemTextRunes)

			itemID := strings.TrimSpace(obj.ID)
			if itemID == "" {
				itemID = store.NewID()
			}
			if _, dup := seenItemIDs[itemID]; dup {
				itemID = store.NewID()
			}
			seenItemIDs[itemID] = struct{}{}

			done := strings.TrimSpace(obj.DoneAt) != "" || chDone || questCompleted
			item := tasks.TaskItem{
				ID:   itemID,
				Text: text,
				Done: done,
			}

			if obj.Count != nil && obj.Count.Target >= 1 {
				tgt := obj.Count.Target
				cur := obj.Count.Current
				if cur < 0 {
					cur = 0
				}
				if cur >= tgt {
					done = true
					cur = tgt
				}
				if done && cur < tgt {
					cur = tgt
				}
				item.Done = done
				item.Current = &cur
				item.Target = &tgt
			}

			items = append(items, item)
		}
	}
	return items
}

func formatItemText(chTitle, rawObjText string, objCount int) string {
	chTitle = strings.TrimSpace(chTitle)
	objText := strings.TrimSpace(rawObjText)
	if objCount == 1 && chTitle != "" && (objText == "1" || objText == chTitle || objText == "") {
		return chTitle
	}
	if chTitle != "" && !strings.Contains(objText, chTitle) {
		if objText == "" {
			return chTitle
		}
		return chTitle + " · " + objText
	}
	return objText
}

type v1NoteRecord struct {
	SchemaVersion int     `json:"schemaVersion"`
	Note          *v1Note `json:"note"`
}

type v1Note struct {
	ID        string  `json:"id"`
	Text      string  `json:"text"`
	QuestID   *string `json:"questId"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
}

func migrateNotes(st *store.Store, clk clock.Clock, validTaskIDs map[string]struct{}) (int, int, error) {
	notesPath, err := st.Path(notes.FileName)
	if err != nil {
		return 0, 0, err
	}
	if exists, err := fileExists(notesPath); err != nil {
		return 0, 0, err
	} else if exists {
		return 0, 0, nil
	}

	notesDir := filepath.Join(st.Dir(), "plugins", "notes")
	info, err := os.Stat(notesDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, 0, nil
		}
		return 0, 0, fmt.Errorf("stat v1 notes dir: %w", err)
	}
	if !info.IsDir() {
		return 0, 0, nil
	}

	dirEntries, err := os.ReadDir(notesDir)
	if err != nil {
		return 0, 0, fmt.Errorf("read v1 notes dir: %w", err)
	}

	nowMs := clk.Now().UnixMilli()
	seenIDs := make(map[string]struct{})
	migrated := make([]notes.Note, 0)
	skipped := 0

	for _, entry := range dirEntries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasPrefix(name, "note") || !strings.HasSuffix(name, ".json") {
			continue
		}

		raw, err := os.ReadFile(filepath.Join(notesDir, name))
		if err != nil {
			skipped++
			continue
		}
		var rec v1NoteRecord
		if err := json.Unmarshal(bytes.TrimSpace(raw), &rec); err != nil || rec.Note == nil {
			skipped++
			continue
		}
		if rec.SchemaVersion != 0 && rec.SchemaVersion != 1 {
			skipped++
			continue
		}

		content := strings.TrimSpace(rec.Note.Text)
		if content == "" {
			skipped++
			continue
		}
		content = truncateRunes(content, maxNoteContentRunes)

		id := strings.TrimSpace(rec.Note.ID)
		if id == "" {
			id = store.NewID()
		}
		if _, dup := seenIDs[id]; dup {
			skipped++
			continue
		}
		seenIDs[id] = struct{}{}

		createdAt, okC := parseTimestampMs(rec.Note.CreatedAt)
		updatedAt, okU := parseTimestampMs(rec.Note.UpdatedAt)
		if !okC && okU {
			createdAt = updatedAt
		} else if !okC {
			createdAt = nowMs
		}
		if !okU {
			updatedAt = createdAt
		}

		var taskID *string
		if rec.Note.QuestID != nil {
			qid := strings.TrimSpace(*rec.Note.QuestID)
			if qid != "" {
				if _, exists := validTaskIDs[qid]; exists {
					taskID = &qid
				}
			}
		}

		migrated = append(migrated, notes.Note{
			ID:        id,
			Content:   content,
			TaskID:    taskID,
			CreatedAt: createdAt,
			UpdatedAt: updatedAt,
		})
	}

	if len(migrated) == 0 {
		return 0, skipped, nil
	}

	sort.Slice(migrated, func(i, j int) bool {
		if migrated[i].CreatedAt != migrated[j].CreatedAt {
			return migrated[i].CreatedAt > migrated[j].CreatedAt
		}
		return migrated[i].ID > migrated[j].ID
	})

	doc := v2NotesPersistedState{
		SchemaVersion: v2NotesSchemaVersion,
		Notes:         migrated,
	}
	if err := st.WriteJSON(notes.FileName, doc); err != nil {
		return 0, skipped, fmt.Errorf("write migrated notes: %w", err)
	}
	return len(migrated), skipped, nil
}

func readExistingTaskIDs(st *store.Store) map[string]struct{} {
	var doc struct {
		Tasks []struct {
			ID string `json:"id"`
		} `json:"tasks"`
	}
	found, err := st.ReadJSON(tasks.FileName, &doc)
	if err != nil || !found {
		return nil
	}
	ids := make(map[string]struct{}, len(doc.Tasks))
	for _, t := range doc.Tasks {
		if id := strings.TrimSpace(t.ID); id != "" {
			ids[id] = struct{}{}
		}
	}
	return ids
}

func readQuestRecord(questDir, key string) (v1QuestRecord, bool) {
	if strings.TrimSpace(key) == "" {
		return v1QuestRecord{}, false
	}

	// v1 Electron uses JS encodeURIComponent(key) + ".json" (encoding ":" as "%3A").
	// Also fall back to lowercase "%3a", url.PathEscape, and literal key + ".json"
	// safely inside questDir.
	encoded := encodeURIComponent(key)
	candidates := []string{
		encoded + ".json",
		strings.ReplaceAll(encoded, "%3A", "%3a") + ".json",
		url.PathEscape(key) + ".json",
		key + ".json",
	}

	seen := make(map[string]struct{}, len(candidates))
	for _, name := range candidates {
		if _, dup := seen[name]; dup {
			continue
		}
		seen[name] = struct{}{}
		if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) {
			continue
		}
		full := filepath.Join(questDir, name)
		if filepath.Dir(full) != filepath.Clean(questDir) {
			continue
		}
		raw, err := os.ReadFile(full)
		if err != nil {
			continue
		}
		var rec v1QuestRecord
		if err := json.Unmarshal(bytes.TrimSpace(raw), &rec); err != nil {
			return v1QuestRecord{}, false
		}
		return rec, true
	}
	return v1QuestRecord{}, false
}

// encodeURIComponent matches ECMAScript encodeURIComponent so v1 plugin storage
// keys like "record:<uuid>" resolve to "record%3A<uuid>.json".
func encodeURIComponent(s string) string {
	const hexDigits = "0123456789ABCDEF"
	var b strings.Builder
	b.Grow(len(s) + 8)
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') ||
			(c >= 'a' && c <= 'z') ||
			(c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '!' || c == '~' || c == '*' || c == '\'' || c == '(' || c == ')' {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hexDigits[c>>4])
		b.WriteByte(hexDigits[c&0x0f])
	}
	return b.String()
}

func normalizeRecurrence(r *v1Recurrence) *tasks.TaskRecurrence {
	if r == nil {
		return &tasks.TaskRecurrence{Freq: tasks.FreqDaily}
	}
	if strings.TrimSpace(r.Freq) == string(tasks.FreqWeekly) {
		seen := make(map[int]struct{}, len(r.Weekdays))
		days := make([]int, 0, len(r.Weekdays))
		for _, wd := range r.Weekdays {
			if wd < 0 || wd > 6 {
				continue
			}
			if _, dup := seen[wd]; dup {
				continue
			}
			seen[wd] = struct{}{}
			days = append(days, wd)
		}
		if len(days) > 0 {
			return &tasks.TaskRecurrence{Freq: tasks.FreqWeekly, Weekdays: days}
		}
	}
	return &tasks.TaskRecurrence{Freq: tasks.FreqDaily}
}

func normalizeDateKey(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	if len(s) != 10 {
		return "", false
	}
	parsed, err := time.ParseInLocation("2006-01-02", s, time.UTC)
	if err != nil || parsed.Format("2006-01-02") != s {
		return "", false
	}
	return s, true
}

func parseTimestampMs(raw string) (int64, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return 0, false
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return 0, false
	}
	return t.UnixMilli(), true
}

func statusOrderRank(s tasks.TaskStatus) int {
	switch s {
	case tasks.StatusActive:
		return 0
	case tasks.StatusCompleted:
		return 1
	default:
		return 2
	}
}

func v1KindOrderRank(k string) int {
	switch k {
	case "main":
		return 0
	case "side":
		return 1
	case "daily":
		return 2
	default:
		return 3
	}
}

func truncateRunes(s string, maxRunes int) string {
	if utf8.RuneCountInString(s) <= maxRunes {
		return s
	}
	count := 0
	for i := range s {
		if count == maxRunes {
			return strings.TrimSpace(s[:i])
		}
		count++
	}
	return s
}

func isJSONString(raw json.RawMessage) bool {
	t := bytes.TrimSpace(raw)
	if len(t) == 0 || t[0] != '"' {
		return false
	}
	var s string
	return json.Unmarshal(t, &s) == nil
}

func decodeJSONObject(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	t := bytes.TrimSpace(raw)
	if len(t) == 0 || t[0] != '{' {
		return nil, false
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(t, &m); err != nil || m == nil {
		return nil, false
	}
	return m, true
}

func decodeJSONBool(raw json.RawMessage) (bool, bool) {
	t := bytes.TrimSpace(raw)
	if bytes.Equal(t, []byte("true")) {
		return true, true
	}
	if bytes.Equal(t, []byte("false")) {
		return false, true
	}
	return false, false
}

func decodeJSONInt(raw json.RawMessage) (int, bool) {
	t := bytes.TrimSpace(raw)
	if len(t) == 0 || t[0] == '"' || bytes.Equal(t, []byte("null")) || bytes.Equal(t, []byte("true")) || bytes.Equal(t, []byte("false")) {
		return 0, false
	}
	var f float64
	if err := json.Unmarshal(t, &f); err != nil {
		return 0, false
	}
	if math.IsNaN(f) || math.IsInf(f, 0) || f < math.MinInt32 || f > math.MaxInt32 {
		return 0, false
	}
	return int(math.Round(f)), true
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func fileExists(path string) (bool, error) {
	_, err := os.Stat(path)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return false, err
}

func writeFileAtomic(target string, data []byte) error {
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}

	tmpPath := fmt.Sprintf("%s.%s.tmp", target, store.NewID())
	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}

	renamed := false
	defer func() {
		if !renamed {
			_ = os.Remove(tmpPath)
		}
	}()

	for rem := data; len(rem) > 0; {
		n, err := f.Write(rem)
		if err != nil {
			_ = f.Close()
			return err
		}
		rem = rem[n:]
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, target); err != nil {
		return err
	}
	renamed = true
	syncDirBestEffort(dir)
	return nil
}

func syncDirBestEffort(dir string) {
	d, err := os.Open(dir)
	if err != nil {
		return
	}
	defer func() { _ = d.Close() }()
	_ = d.Sync()
}
