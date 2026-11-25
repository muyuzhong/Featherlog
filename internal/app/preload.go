package app

// PreloadScript installs window.__FEATHERLOG_MYGO__ on top of MyGo's built-in
// window.mygo bridge at document start so frontend code can use either the
// typed service facade, raw window.mygo.call/on, or mygo generate bindings.
const PreloadScript = `(() => {
  if (typeof window === "undefined" || !window.mygo || window.__FEATHERLOG_MYGO__) {
    return;
  }
  const m = window.mygo;
  const invoke = (method, ...args) => m.call(method, ...args);
  const bridge = Object.freeze({
    platform: m.platform,
    version: m.version,
    windowId: m.windowId,
    call: invoke,
    on: (name, fn) => m.on(name, fn),
    once: (name, fn) => m.once(name, fn),
    WorkbenchService: Object.freeze({
      list: () => invoke("WorkbenchService.List"),
      create: (input) => invoke("WorkbenchService.Create", input),
      update: (input) => invoke("WorkbenchService.Update", input),
      setState: (input) => invoke("WorkbenchService.SetState", input),
      complete: (input) => invoke("WorkbenchService.Complete", input),
      reorder: (input) => invoke("WorkbenchService.Reorder", input),
    }),
    TaskService: Object.freeze({
      list: () => invoke("TaskService.List"),
      create: (input) => invoke("TaskService.Create", input),
      update: (input) => invoke("TaskService.Update", input),
      setItems: (input) => invoke("TaskService.SetItems", input),
      toggleItem: (input) => invoke("TaskService.ToggleItem", input),
      stepQuota: (input) => invoke("TaskService.StepQuota", input),
      complete: (input) => invoke("TaskService.Complete", input),
      delete: (input) => invoke("TaskService.Delete", input),
      reorder: (input) => invoke("TaskService.Reorder", input),
    }),
    NoteService: Object.freeze({
      list: (input) => (input === undefined ? invoke("NoteService.List") : invoke("NoteService.List", input)),
      create: (input) => invoke("NoteService.Create", input),
      update: (input) => invoke("NoteService.Update", input),
      delete: (input) => invoke("NoteService.Delete", input),
    }),
    SettingsService: Object.freeze({
      get: () => invoke("SettingsService.Get"),
      update: (patch) => invoke("SettingsService.Update", patch),
    }),
    DockService: Object.freeze({
      resize: (geom) => invoke("DockService.Resize", geom),
      toggle: (input) => (input === undefined ? invoke("DockService.Toggle") : invoke("DockService.Toggle", input)),
      quit: () => invoke("DockService.Quit"),
    }),
    events: Object.freeze({
      on: (name, fn) => m.on(name, fn),
      once: (name, fn) => m.once(name, fn),
    }),
  });
  Object.defineProperty(window, "__FEATHERLOG_MYGO__", {
    value: bridge,
    enumerable: true,
    configurable: false,
  });
})();`
