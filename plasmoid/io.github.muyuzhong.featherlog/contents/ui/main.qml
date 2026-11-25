import QtQuick
import org.kde.plasma.core as PlasmaCore
import org.kde.plasma.plasma5support as P5Support
import org.kde.plasma.plasmoid

PlasmoidItem {
    id: root

    readonly property bool editMode: Plasmoid.containment?.corona?.editMode ?? false

    // Omit standard Plasma frame outside edit mode so the panel or Panel Colorizer
    // does not wrap an extra opaque box around our monochrome pill strip.
    Plasmoid.backgroundHints: editMode
        ? PlasmaCore.Types.StandardBackground
        : PlasmaCore.Types.NoBackground
    Plasmoid.status: PlasmaCore.Types.ActiveStatus

    // Non-zero initial dimensions ensure AppletQuickItem::init() runs
    // compactRepresentationCheck() on the first pass and propagates Layout hints.
    implicitWidth: 148
    implicitHeight: 36

    // Both compactRepresentation and fullRepresentation must be defined:
    // libPlasmaQuick treats an unset fullRepresentation as always-expanded and
    // skips instantiating compactRepresentation altogether.
    preferredRepresentation: compactRepresentation
    compactRepresentation: CompactRepresentation {
        plasmoidRoot: root
    }
    fullRepresentation: FullRepresentation {
        plasmoidRoot: root
    }
    activationTogglesExpanded: false

    readonly property int configuredPort: Plasmoid.configuration.apiPort
    readonly property int maxVisibleSlots: Math.max(1, Math.min(5, Plasmoid.configuration.maxVisibleSlots || 3))
    readonly property bool showTodayCount: Plasmoid.configuration.showTodayCount !== false
    readonly property string featherlogCommand: (Plasmoid.configuration.featherlogCommand || "featherlog").trim()

    property int activePort: 39173
    property int probeIndex: 0
    property int failedProbesInCycle: 0
    property bool connected: false
    property bool hasInitialSnapshot: false
    property bool launchingDaemon: false
    property bool pendingOpenAfterLaunch: false
    property int launchPollAttempts: 0

    property double rev: 0
    property bool panelOpen: false
    property bool pinned: false
    property string themeName: "stone"
    property int todayDone: 0
    property int todayTotal: 0
    property var slots: []
    property string lastSlotsJson: "[]"
    property string hoveredSlotId: ""
    property double nowMs: Date.now()

    property int pollGeneration: 0
    property var pollXhr: null
    property bool initialized: false
    property bool destroying: false
    property double lastWheelCycleMs: 0
    property string optimisticFocusSlotId: ""
    property int inFlightFocusOps: 0

    readonly property var visibleSlots: computeVisibleSlots(slots, maxVisibleSlots)
    readonly property int overflowCount: Math.max(0, (Array.isArray(slots) ? slots.length : 0) - visibleSlots.length)
    readonly property var focusedSlot: findFocusedSlot(slots)
    readonly property int activeDrumIndex: findActiveDrumIndex(slots, optimisticFocusSlotId)
    readonly property var tooltipSlot: findTooltipSlot(slots, hoveredSlotId)
    readonly property bool hasVisibleRunningSlot: checkVisibleRunning(slots)

    toolTipTextFormat: Text.PlainText
    toolTipMainText: buildToolTipMainText(connected, launchingDaemon, tooltipSlot)
    toolTipSubText: buildToolTipSubText(connected, launchingDaemon, tooltipSlot, nowMs, showTodayCount, todayDone, todayTotal)

    Plasmoid.contextualActions: [
        PlasmaCore.Action {
            text: root.panelOpen ? "收起羽记工作台" : "打开羽记工作台"
            icon.name: "view-list-details"
            onTriggered: root.toggleOrLaunchPanel()
        },
        PlasmaCore.Action {
            text: "启动羽记守护进程"
            icon.name: "media-playback-start"
            visible: !root.connected
            onTriggered: root.launchDaemonAndOpen()
        },
        PlasmaCore.Action {
            text: "重新连接羽记"
            icon.name: "view-refresh"
            onTriggered: root.reconnectNow()
        }
    ]

    Connections {
        target: Plasmoid
        function onActivated() {
            root.toggleOrLaunchPanel();
        }
    }

    onExpandedChanged: {
        // Panel interactions always target the native MyGo Workspace Panel
        // over loopback HTTP rather than opening a duplicate Plasma popup.
        if (expanded) {
            expanded = false;
        }
    }

    onConfiguredPortChanged: {
        if (initialized) {
            reconnectNow();
        }
    }

    Component.onCompleted: {
        initialized = true;
        reconnectNow();
    }

    Component.onDestruction: {
        destroying = true;
        abortActivePoll();
        retryTimer.stop();
        nextPollTimer.stop();
        pollWatchdogTimer.stop();
        elapsedTickTimer.stop();
        optimisticClearTimer.stop();
    }

    // Launches the configured daemon command detached from stdio so Plasma's
    // executable DataEngine completes immediately without holding pipes open.
    P5Support.DataSource {
        id: daemonLauncher
        engine: "executable"
        connectedSources: []
        onNewData: function (source, data) {
            disconnectSource(source);
        }
    }

    // Lightweight local timer to refresh relative elapsed durations ("12m")
    // without making network requests; active only when a running slot is shown.
    Timer {
        id: elapsedTickTimer
        interval: 15000
        repeat: true
        running: root.connected && root.hasVisibleRunningSlot
        onTriggered: root.nowMs = Date.now()
    }

    Timer {
        id: nextPollTimer
        interval: 50
        repeat: false
        onTriggered: root.startPoll()
    }

    Timer {
        id: retryTimer
        interval: 2000
        repeat: false
        onTriggered: root.startPoll()
    }

    Timer {
        id: pollWatchdogTimer
        interval: 28000
        repeat: false
        onTriggered: {
            if (root.destroying) {
                return;
            }
            root.abortActivePoll();
            root.handlePollFailure();
        }
    }

    // Safety net that releases optimistic focus lock if a focus/cycle HTTP call
    // races with a server-side change or drops silently.
    Timer {
        id: optimisticClearTimer
        interval: 700
        repeat: false
        onTriggered: {
            if (root.inFlightFocusOps === 0) {
                root.optimisticFocusSlotId = "";
            }
        }
    }

    function candidatePorts() {
        if (configuredPort <= 0 || configuredPort === 39173) {
            return [39173, 39174];
        }
        return [configuredPort];
    }

    function apiBaseUrl() {
        return "http://127.0.0.1:" + activePort;
    }

    function slotPriority(state) {
        if (state === "focus") {
            return 0;
        }
        if (state === "ready") {
            return 1;
        }
        return 2;
    }

    function computeVisibleSlots(allSlots, limit) {
        if (!Array.isArray(allSlots) || allSlots.length === 0) {
            return [];
        }
        const prioritizeState = allSlots.length > limit;
        const copy = allSlots.slice();
        copy.sort(function (a, b) {
            if (prioritizeState) {
                const pDiff = slotPriority(a.state) - slotPriority(b.state);
                if (pDiff !== 0) {
                    return pDiff;
                }
            }
            return (a.order || 0) - (b.order || 0);
        });
        return copy.slice(0, limit);
    }

    function findFocusedSlot(allSlots) {
        if (!Array.isArray(allSlots)) {
            return null;
        }
        for (let i = 0; i < allSlots.length; ++i) {
            if (allSlots[i].state === "focus") {
                return allSlots[i];
            }
        }
        return null;
    }

    function findActiveDrumIndex(allSlots, optimisticId) {
        if (!Array.isArray(allSlots) || allSlots.length === 0) {
            return -1;
        }
        if (optimisticId && optimisticId.length > 0) {
            for (let k = 0; k < allSlots.length; ++k) {
                if (allSlots[k].id === optimisticId) {
                    return k;
                }
            }
        }
        for (let i = 0; i < allSlots.length; ++i) {
            if (allSlots[i].state === "focus") {
                return i;
            }
        }
        for (let j = 0; j < allSlots.length; ++j) {
            if (allSlots[j].state === "ready") {
                return j;
            }
        }
        return 0;
    }

    function findTooltipSlot(allSlots, hoveredId) {
        if (!Array.isArray(allSlots) || allSlots.length === 0) {
            return null;
        }
        if (hoveredId && hoveredId.length > 0) {
            for (let i = 0; i < allSlots.length; ++i) {
                if (allSlots[i].id === hoveredId) {
                    return allSlots[i];
                }
            }
        }
        const focused = findFocusedSlot(allSlots);
        if (focused) {
            return focused;
        }
        for (let j = 0; j < allSlots.length; ++j) {
            if (allSlots[j].state === "ready") {
                return allSlots[j];
            }
        }
        return allSlots[0];
    }

    function checkVisibleRunning(list) {
        if (!Array.isArray(list)) {
            return false;
        }
        for (let i = 0; i < list.length; ++i) {
            if (list[i].state === "running") {
                return true;
            }
        }
        return false;
    }

    function stateLabel(state) {
        if (state === "focus") {
            return "正在做";
        }
        if (state === "ready") {
            return "待看";
        }
        return "后台运行";
    }

    function formatElapsed(stateChangedAt, currentMs) {
        if (!stateChangedAt || stateChangedAt <= 0) {
            return "";
        }
        const diffSec = Math.max(0, Math.floor((currentMs - stateChangedAt) / 1000));
        if (diffSec < 60) {
            return "<1m";
        }
        const totalMin = Math.floor(diffSec / 60);
        if (totalMin < 60) {
            return totalMin + "m";
        }
        const hours = Math.floor(totalMin / 60);
        const mins = totalMin % 60;
        if (hours < 24) {
            return mins > 0 ? (hours + "h" + mins + "m") : (hours + "h");
        }
        const days = Math.floor(hours / 24);
        const remHours = hours % 24;
        return remHours > 0 ? (days + "d" + remHours + "h") : (days + "d");
    }

    function buildToolTipMainText(isConnected, isLaunching, slot) {
        if (!isConnected) {
            return isLaunching ? "羽记 Featherlog · 启动中" : "羽记 Featherlog · 未运行";
        }
        if (!slot) {
            return "羽记 Featherlog · 空闲";
        }
        const tag = slot.tag ? (" · " + slot.tag) : "";
        return (slot.title || "未命名槽位") + tag;
    }

    function buildToolTipSubText(isConnected, isLaunching, slot, currentMs, showToday, doneCount, totalCount) {
        if (!isConnected) {
            return isLaunching ? "正在等待本地服务就绪…" : "点击启动羽记守护进程并打开工作台";
        }
        const lines = [];
        if (slot) {
            const crumb = (slot.breadcrumb || "").trim();
            if (crumb.length > 0) {
                lines.push("下一步锚点：" + crumb);
            }
            let statusLine = "状态：" + stateLabel(slot.state);
            if (slot.state === "running" && slot.stateChangedAt > 0) {
                statusLine += " · 已运行 " + formatElapsed(slot.stateChangedAt, currentMs);
            }
            if (showToday && totalCount > 0) {
                statusLine += " · 今日待办 " + doneCount + "/" + totalCount;
            }
            lines.push(statusLine);
            lines.push("滚轮拨动滚筒 · 点侧翼切焦点 · 点主槽开工作台 · 中键切待看");
        } else {
            if (showToday && totalCount > 0) {
                lines.push("今日待办：" + doneCount + "/" + totalCount);
            }
            lines.push("点击打开羽记工作台");
        }
        return lines.join("\n");
    }

    function normalizeSlots(rawSlots) {
        if (!Array.isArray(rawSlots)) {
            return [];
        }
        const result = [];
        for (let i = 0; i < rawSlots.length; ++i) {
            const s = rawSlots[i];
            if (!s || typeof s !== "object") {
                continue;
            }
            result.push({
                id: String(s.id || ""),
                title: String(s.title || ""),
                state: String(s.state || "running"),
                breadcrumb: String(s.breadcrumb || ""),
                tag: String(s.tag || ""),
                stateChangedAt: Number(s.stateChangedAt || 0),
                remindAt: s.remindAt ? Number(s.remindAt) : 0,
                order: Number(s.order || 0)
            });
        }
        return result;
    }

    function applyBarSnapshot(data, force) {
        if (!data || typeof data !== "object") {
            return;
        }
        const nextRev = typeof data.rev === "number" ? data.rev : 0;
        if (!force && connected && hasInitialSnapshot && nextRev === rev) {
            return;
        }
        if (!force && connected && hasInitialSnapshot && nextRev > 0 && nextRev < rev) {
            return;
        }

        rev = nextRev;
        panelOpen = !!data.panelOpen;
        pinned = !!data.pinned;
        themeName = data.theme ? String(data.theme) : "stone";
        todayDone = Number(data.todayDone || 0);
        todayTotal = Number(data.todayTotal || 0);
        nowMs = Date.now();

        const normalized = normalizeSlots(data.slots);
        const serialized = JSON.stringify(normalized);
        if (force || serialized !== lastSlotsJson) {
            lastSlotsJson = serialized;
            slots = normalized;
            if (hoveredSlotId.length > 0) {
                let stillExists = false;
                for (let i = 0; i < normalized.length; ++i) {
                    if (normalized[i].id === hoveredSlotId) {
                        stillExists = true;
                        break;
                    }
                }
                if (!stillExists) {
                    hoveredSlotId = "";
                }
            }
        }
        reconcileOptimisticFocus(normalized);
        hasInitialSnapshot = true;
    }

    function reconcileOptimisticFocus(slotList) {
        if (optimisticFocusSlotId.length === 0) {
            return;
        }
        let targetExists = false;
        let serverFocusedId = "";
        for (let i = 0; i < slotList.length; ++i) {
            if (slotList[i].id === optimisticFocusSlotId) {
                targetExists = true;
            }
            if (slotList[i].state === "focus") {
                serverFocusedId = slotList[i].id;
            }
        }
        if (!targetExists) {
            optimisticFocusSlotId = "";
            optimisticClearTimer.stop();
            return;
        }
        if (inFlightFocusOps === 0 && serverFocusedId === optimisticFocusSlotId) {
            optimisticFocusSlotId = "";
            optimisticClearTimer.stop();
        }
    }

    function abortActivePoll() {
        pollGeneration += 1;
        pollWatchdogTimer.stop();
        if (pollXhr) {
            const xhr = pollXhr;
            pollXhr = null;
            try {
                xhr.abort();
            } catch (e) {
                // Ignore abort race errors during teardown or reconnect.
            }
        }
    }

    function reconnectNow() {
        abortActivePoll();
        retryTimer.stop();
        nextPollTimer.stop();
        optimisticClearTimer.stop();
        optimisticFocusSlotId = "";
        inFlightFocusOps = 0;
        connected = false;
        hasInitialSnapshot = false;
        rev = 0;
        const ports = candidatePorts();
        probeIndex = 0;
        failedProbesInCycle = 0;
        activePort = ports[0];
        startPoll();
    }

    function startPoll() {
        if (destroying) {
            return;
        }
        abortActivePoll();
        retryTimer.stop();
        nextPollTimer.stop();

        const gen = pollGeneration;
        const isLongPoll = connected && hasInitialSnapshot;
        const waitSec = isLongPoll ? 20 : 0;
        const reqRev = isLongPoll ? rev : 0;
        const url = apiBaseUrl() + "/api/bar?rev=" + encodeURIComponent(String(reqRev)) + "&wait=" + waitSec;

        const xhr = new XMLHttpRequest();
        pollXhr = xhr;
        pollWatchdogTimer.interval = isLongPoll ? 28000 : 3500;
        pollWatchdogTimer.restart();

        xhr.onreadystatechange = function () {
            if (destroying || gen !== pollGeneration) {
                return;
            }
            if (xhr.readyState !== XMLHttpRequest.DONE) {
                return;
            }
            pollXhr = null;
            pollWatchdogTimer.stop();

            if (xhr.status >= 200 && xhr.status < 300) {
                let parsed = null;
                try {
                    parsed = JSON.parse(xhr.responseText);
                } catch (e) {
                    handlePollFailure();
                    return;
                }
                const wasOffline = !connected;
                connected = true;
                failedProbesInCycle = 0;
                launchingDaemon = false;
                launchPollAttempts = 0;

                applyBarSnapshot(parsed, wasOffline);

                if (pendingOpenAfterLaunch) {
                    pendingOpenAfterLaunch = false;
                    togglePanel(true);
                }
                nextPollTimer.interval = 40;
                nextPollTimer.restart();
            } else {
                handlePollFailure();
            }
        };

        try {
            xhr.open("GET", url, true);
            xhr.send();
        } catch (e) {
            pollXhr = null;
            pollWatchdogTimer.stop();
            handlePollFailure();
        }
    }

    function handlePollFailure() {
        if (destroying) {
            return;
        }
        const wasConnected = connected;
        connected = false;
        hasInitialSnapshot = false;
        rev = 0;
        panelOpen = false;
        pinned = false;
        todayDone = 0;
        todayTotal = 0;
        optimisticClearTimer.stop();
        optimisticFocusSlotId = "";
        inFlightFocusOps = 0;
        if (lastSlotsJson !== "[]") {
            lastSlotsJson = "[]";
            slots = [];
            hoveredSlotId = "";
        }

        const ports = candidatePorts();
        failedProbesInCycle += 1;

        if (ports.length > 1 && failedProbesInCycle < ports.length) {
            probeIndex = (probeIndex + 1) % ports.length;
            activePort = ports[probeIndex];
            nextPollTimer.interval = 40;
            nextPollTimer.restart();
            return;
        }

        failedProbesInCycle = 0;
        probeIndex = wasConnected ? 0 : ((probeIndex + 1) % ports.length);
        activePort = ports[probeIndex];

        if (pendingOpenAfterLaunch) {
            launchPollAttempts += 1;
            if (launchPollAttempts > 30) {
                pendingOpenAfterLaunch = false;
                launchingDaemon = false;
                launchPollAttempts = 0;
                retryTimer.interval = 2000;
            } else {
                retryTimer.interval = 500;
            }
        } else {
            retryTimer.interval = 2000;
        }
        retryTimer.restart();
    }

    function postAction(path, payload, isFocusOp) {
        if (!connected || destroying) {
            return;
        }
        const trackFocus = !!isFocusOp;
        if (trackFocus) {
            inFlightFocusOps += 1;
            optimisticClearTimer.restart();
        }
        const xhr = new XMLHttpRequest();
        xhr.onreadystatechange = function () {
            if (destroying || xhr.readyState !== XMLHttpRequest.DONE) {
                return;
            }
            if (trackFocus) {
                inFlightFocusOps = Math.max(0, inFlightFocusOps - 1);
            }
            if (xhr.status >= 200 && xhr.status < 300) {
                if (xhr.responseText && xhr.responseText.trim().length > 0) {
                    try {
                        const data = JSON.parse(xhr.responseText);
                        if (data && typeof data === "object") {
                            if (Array.isArray(data.slots)) {
                                applyBarSnapshot(data, false);
                            } else if (data.panelOpen !== undefined) {
                                panelOpen = !!data.panelOpen;
                            }
                        }
                    } catch (e) {
                        // Long-poll remains authoritative if action body isn't JSON.
                    }
                }
                if (trackFocus) {
                    reconcileOptimisticFocus(slots);
                    if (inFlightFocusOps === 0 && optimisticFocusSlotId.length > 0) {
                        // Re-arm safety timer in case the original one-shot timer fired
                        // while a slow POST was still in flight and a server-side change
                        // superseded our optimistic target.
                        optimisticClearTimer.restart();
                    }
                }
            } else if (xhr.status === 0) {
                abortActivePoll();
                handlePollFailure();
            } else if (trackFocus && inFlightFocusOps === 0) {
                optimisticFocusSlotId = "";
                optimisticClearTimer.stop();
            }
        };
        try {
            xhr.open("POST", apiBaseUrl() + path, true);
            xhr.setRequestHeader("Content-Type", "application/json");
            xhr.send(JSON.stringify(payload || {}));
        } catch (e) {
            if (trackFocus) {
                inFlightFocusOps = Math.max(0, inFlightFocusOps - 1);
                if (inFlightFocusOps === 0) {
                    optimisticFocusSlotId = "";
                    optimisticClearTimer.stop();
                }
            }
            // Ignore transient loopback send failures; long-poll handles recovery.
        }
    }

    function togglePanel(explicitOpen) {
        if (explicitOpen === true || explicitOpen === false) {
            postAction("/api/panel/toggle", {
                "open": explicitOpen
            }, false);
        } else {
            postAction("/api/panel/toggle", {}, false);
        }
    }

    function toggleOrLaunchPanel() {
        if (connected) {
            togglePanel();
        } else {
            launchDaemonAndOpen();
        }
    }

    function focusSlot(slotId) {
        if (!connected || !slotId) {
            return;
        }
        optimisticFocusSlotId = slotId;
        postAction("/api/slot/focus", {
            "id": slotId
        }, true);
    }

    function cycleSlot(delta) {
        if (!connected || !Array.isArray(slots) || slots.length === 0 || delta === 0) {
            return false;
        }
        const now = Date.now();
        if (now - lastWheelCycleMs < 40) {
            return false;
        }
        lastWheelCycleMs = now;
        const step = delta > 0 ? 1 : -1;
        const n = slots.length;
        if (n === 1) {
            if (slots[0].state !== "focus" && slots[0].id) {
                focusSlot(slots[0].id);
            }
            return true;
        }
        const baseIdx = activeDrumIndex >= 0 ? activeDrumIndex : 0;
        const nextIdx = ((baseIdx + step) % n + n) % n;
        const targetId = slots[nextIdx] ? (slots[nextIdx].id || "") : "";
        if (targetId.length > 0) {
            optimisticFocusSlotId = targetId;
            postAction("/api/slot/focus", {
                "id": targetId
            }, true);
            return true;
        }
        postAction("/api/slot/cycle", {
            "delta": step
        }, true);
        return true;
    }

    function setSlotState(slotId, nextState) {
        if (!slotId || !nextState) {
            return;
        }
        postAction("/api/slot/state", {
            "id": slotId,
            "state": nextState
        }, false);
    }

    function launchDaemonAndOpen() {
        if (connected) {
            togglePanel(true);
            return;
        }
        if (launchingDaemon) {
            pendingOpenAfterLaunch = true;
            return;
        }
        const cmd = featherlogCommand.length > 0 ? featherlogCommand : "featherlog";
        launchingDaemon = true;
        pendingOpenAfterLaunch = true;
        launchPollAttempts = 0;

        const launchCmd = "nohup " + cmd + " </dev/null >/dev/null 2>&1 &";
        daemonLauncher.connectSource(launchCmd);

        abortActivePoll();
        retryTimer.stop();
        nextPollTimer.stop();
        const ports = candidatePorts();
        probeIndex = 0;
        failedProbesInCycle = 0;
        activePort = ports[0];
        retryTimer.interval = 350;
        retryTimer.restart();
    }
}
