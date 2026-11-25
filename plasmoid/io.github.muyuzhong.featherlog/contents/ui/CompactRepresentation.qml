pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.plasma.core as PlasmaCore
import org.kde.plasma.plasmoid

Item {
    id: compact

    property var plasmoidRoot: null

    readonly property bool isVertical: Plasmoid.formFactor === PlasmaCore.Types.Vertical
    readonly property bool horizontal: !isVertical

    readonly property bool isConnected: plasmoidRoot ? !!plasmoidRoot.connected : false
    readonly property bool isLaunching: plasmoidRoot ? !!plasmoidRoot.launchingDaemon : false
    readonly property bool isPanelOpen: plasmoidRoot ? !!plasmoidRoot.panelOpen : false
    readonly property string language: plasmoidRoot ? String(plasmoidRoot.language || "zh") : "zh"
    readonly property bool isEn: language === "en"
    readonly property bool showTodayCount: plasmoidRoot ? !!plasmoidRoot.showTodayCount : true
    readonly property int todayDone: plasmoidRoot ? Number(plasmoidRoot.todayDone || 0) : 0
    readonly property int todayTotal: plasmoidRoot ? Number(plasmoidRoot.todayTotal || 0) : 0
    readonly property var allSlots: (plasmoidRoot && Array.isArray(plasmoidRoot.slots)) ? plasmoidRoot.slots : []
    readonly property int slotCount: allSlots.length
    readonly property int activeDrumIndex: {
        if (!plasmoidRoot) {
            return -1;
        }
        if (plasmoidRoot.activeDrumIndex !== undefined) {
            return Number(plasmoidRoot.activeDrumIndex);
        }
        return findFallbackActiveIndex(allSlots);
    }
    readonly property double nowMs: plasmoidRoot ? Number(plasmoidRoot.nowMs || 0) : 0

    // Continuous unbounded cylindrical ring position (slot index in real coordinates).
    // Animating along an unbounded float avoids rewind artifacts when wrapping N-1 <-> 0.
    property real drumPosition: 0.0
    property real drumTarget: 0.0
    property string anchoredSlotId: ""
    property int anchoredSlotCount: 0
    property double lastWheelStepMs: 0

    // Pure monochrome ink & neutral surfaces derived from the active Plasma palette.
    // Zero colored status LEDs: adapts cleanly to dark translucent docks (#0b0e14)
    // and light panels alike.
    readonly property color tc: Kirigami.Theme.textColor
    readonly property color bg: Kirigami.Theme.backgroundColor
    readonly property color solidBg: Qt.rgba(bg.r, bg.g, bg.b, 1.0)
    readonly property bool isDarkSurface: Kirigami.ColorUtils.brightnessForColor(tc) === Kirigami.ColorUtils.Light
    readonly property color inverseInk: {
        if (isDarkSurface) {
            return Kirigami.ColorUtils.brightnessForColor(solidBg) === Kirigami.ColorUtils.Dark
                ? solidBg
                : Qt.rgba(0.05, 0.06, 0.09, 1.0);
        }
        return Kirigami.ColorUtils.brightnessForColor(solidBg) === Kirigami.ColorUtils.Light
            ? solidBg
            : Qt.rgba(0.96, 0.96, 0.95, 1.0);
    }

    readonly property int baseFontSize: {
        if (Kirigami.Theme.defaultFont.pixelSize > 0) {
            return Math.max(11, Math.min(13, Math.round(Kirigami.Theme.defaultFont.pixelSize)));
        }
        if (Kirigami.Theme.defaultFont.pointSize > 0) {
            return Math.max(11, Math.min(13, Math.round(Kirigami.Theme.defaultFont.pointSize * 1.25)));
        }
        return 12;
    }

    // Cylinder geometry constants tuned for a compact 32-40px dock height.
    readonly property real stepAngleDeg: 54.0
    readonly property real cylRadius: 113.0
    readonly property real focalDistance: 225.0
    readonly property int drumCardWidth: 122
    readonly property int horizontalMargin: 4
    readonly property int minHorizontalWidth: 136
    readonly property int pillHeight: Math.max(24, Math.min(32, compact.height > 0 ? Math.round(compact.height - 8) : 30))
    readonly property int drumViewportHeight: pillHeight + 4
    readonly property int drumViewportWidth: {
        if (slotCount >= 3) {
            return 240;
        }
        if (slotCount === 2) {
            return 184;
        }
        return 122;
    }
    readonly property real drumCenterX: slotCount === 2 ? (4 + drumCardWidth * 0.5) : (drumViewportWidth * 0.5)
    readonly property real crownRestFactor: Math.pow(Math.abs(Math.cos(drumPosition * Math.PI)), 2.0)

    // Detect any "ready" slot currently hidden on the back side of a 4+ slot drum.
    readonly property var hiddenReadyInfo: computeHiddenReadyInfo(allSlots, drumPosition)
    readonly property int hiddenReadyCount: hiddenReadyInfo.count
    readonly property int firstHiddenReadyIndex: hiddenReadyInfo.firstIndex
    readonly property string firstHiddenReadyId: hiddenReadyInfo.firstId

    readonly property int contentWidth: Math.max(minHorizontalWidth, Math.ceil(barRow.implicitWidth) + horizontalMargin * 2)
    readonly property int verticalHeight: Math.max(36, Math.ceil(verticalBadge.implicitHeight) + 8)

    // Width flows bottom-up from the drum + tally; height uses constant bounds
    // so pillHeight tracks compact.height without creating any binding loop.
    implicitWidth: horizontal ? contentWidth : 36
    implicitHeight: horizontal ? 36 : verticalHeight

    Layout.preferredWidth: horizontal ? contentWidth : -1
    Layout.minimumWidth: horizontal ? contentWidth : 24
    Layout.preferredHeight: horizontal ? 36 : verticalHeight
    Layout.minimumHeight: horizontal ? 24 : verticalHeight
    Layout.fillHeight: horizontal
    Layout.fillWidth: !horizontal

    clip: true

    onAllSlotsChanged: syncDrumWithSlots()
    onActiveDrumIndexChanged: syncDrumWithSlots()
    Component.onCompleted: syncDrumWithSlots()

    NumberAnimation {
        id: drumAnim
        target: compact
        property: "drumPosition"
        duration: 280
        easing.type: Easing.OutCubic
        onStopped: {
            // Normalize unbounded drumPosition modulo N once at rest so
            // floating-point coordinates stay small across long uptime.
            const n = compact.slotCount;
            if (n >= 2 && Math.abs(compact.drumPosition - compact.drumTarget) < 0.0005) {
                const norm = ((Math.round(compact.drumTarget) % n) + n) % n;
                compact.drumTarget = norm;
                compact.drumPosition = norm;
            }
        }
    }

    function mixColor(a, b, t, alpha) {
        const k = Math.max(0.0, Math.min(1.0, t));
        return Qt.rgba(
            a.r + (b.r - a.r) * k,
            a.g + (b.g - a.g) * k,
            a.b + (b.b - a.b) * k,
            alpha
        );
    }

    function checkHasExplicitFocus(list, optimisticId) {
        if (optimisticId && optimisticId.length > 0) {
            return true;
        }
        if (!Array.isArray(list)) {
            return false;
        }
        for (let i = 0; i < list.length; ++i) {
            if (list[i].state === "focus") {
                return true;
            }
        }
        return false;
    }

    function findFallbackActiveIndex(list) {
        if (!Array.isArray(list) || list.length === 0) {
            return -1;
        }
        for (let i = 0; i < list.length; ++i) {
            if (list[i].state === "focus") {
                return i;
            }
        }
        for (let j = 0; j < list.length; ++j) {
            if (list[j].state === "ready") {
                return j;
            }
        }
        return 0;
    }

    function circularOffset(index, pos, count) {
        if (count <= 1) {
            return 0.0;
        }
        let d = (index - pos) % count;
        if (d < 0) {
            d += count;
        }
        if (d > count * 0.5) {
            d -= count;
        }
        return d;
    }

    function shortestCircularDelta(fromPos, targetIdx, count) {
        if (count <= 1) {
            return 0.0;
        }
        let diff = (targetIdx - fromPos) % count;
        if (diff < 0) {
            diff += count;
        }
        if (diff > count * 0.5) {
            diff -= count;
        }
        return diff;
    }

    function computeHiddenReadyInfo(list, pos) {
        const out = { count: 0, firstIndex: -1, firstId: "" };
        if (!Array.isArray(list) || list.length < 4) {
            return out;
        }
        const n = list.length;
        for (let i = 0; i < n; ++i) {
            if (list[i].state === "ready") {
                const off = Math.abs(circularOffset(i, pos, n));
                if (off > 1.2) {
                    out.count += 1;
                    if (out.firstIndex < 0) {
                        out.firstIndex = i;
                        out.firstId = String(list[i].id || "");
                    }
                }
            }
        }
        return out;
    }

    // Exact projective 3D Y-axis rotation + cylindrical depth recess around (w/2, h/2).
    // For a convex cylinder bulging toward the viewer:
    //   theta < 0 (left wing):  outer-left edge recedes (+Z) and tapers shorter;
    //   theta > 0 (right wing): outer-right edge recedes (+Z) and tapers shorter.
    function cylinderCardMatrix(w, h, thetaDeg, radius, focalD, extraZ) {
        if (w <= 0 || h <= 0) {
            return Qt.matrix4x4();
        }
        const clampedDeg = Math.max(-85.0, Math.min(85.0, thetaDeg));
        if (Math.abs(clampedDeg) < 0.05 && Math.abs(extraZ) < 0.05) {
            return Qt.matrix4x4();
        }
        const rad = clampedDeg * Math.PI / 180.0;
        const c = Math.cos(rad);
        const s = Math.sin(rad);
        const absS = Math.abs(s);
        const cx = w * 0.5;
        const cy = h * 0.5;
        const zCenter = 0.56 * w * absS + 0.30 * radius * (1.0 - c) + extraZ;
        const p = s / focalD;
        const q = 1.0 + zCenter / focalD;
        return Qt.matrix4x4(
            c + cx * p,  0, 0, cx * (q - c - cx * p),
            cy * p,      1, 0, cy * (q - 1.0 - cx * p),
            0,           0, 1, 0,
            p,           0, 0, q - cx * p
        );
    }

    function setDrumPositionImmediate(pos) {
        drumAnim.stop();
        compact.drumTarget = pos;
        compact.drumPosition = pos;
    }

    function stepDrumBy(delta) {
        const n = compact.slotCount;
        if (n <= 1 || delta === 0) {
            return "";
        }
        const step = delta > 0 ? 1 : -1;
        const nextTarget = Math.round(compact.drumTarget) + step;
        const targetIdx = ((nextTarget % n) + n) % n;
        const targetId = compact.allSlots[targetIdx] ? String(compact.allSlots[targetIdx].id || "") : "";
        compact.drumTarget = nextTarget;
        compact.anchoredSlotId = targetId;
        compact.anchoredSlotCount = n;
        drumAnim.stop();
        drumAnim.from = compact.drumPosition;
        drumAnim.to = nextTarget;
        drumAnim.start();
        return targetId;
    }

    function rollDrumToIndex(targetIdx, immediate) {
        const n = compact.slotCount;
        if (n <= 0) {
            drumAnim.stop();
            compact.drumTarget = 0;
            compact.drumPosition = 0;
            compact.anchoredSlotId = "";
            compact.anchoredSlotCount = 0;
            return;
        }
        const clampedIdx = ((targetIdx % n) + n) % n;
        compact.anchoredSlotId = compact.allSlots[clampedIdx] ? String(compact.allSlots[clampedIdx].id || "") : "";
        compact.anchoredSlotCount = n;

        if (immediate || n === 1) {
            drumAnim.stop();
            compact.drumTarget = clampedIdx;
            compact.drumPosition = clampedIdx;
            return;
        }

        const currentTargetIdx = ((Math.round(compact.drumTarget) % n) + n) % n;
        if (currentTargetIdx === clampedIdx) {
            if (!drumAnim.running && Math.abs(compact.drumPosition - compact.drumTarget) > 0.0005) {
                drumAnim.from = compact.drumPosition;
                drumAnim.to = compact.drumTarget;
                drumAnim.start();
            }
            return;
        }

        const baseTarget = Math.round(compact.drumTarget);
        const delta = shortestCircularDelta(baseTarget, clampedIdx, n);
        const nextTarget = baseTarget + delta;
        compact.drumTarget = nextTarget;
        drumAnim.stop();
        drumAnim.from = compact.drumPosition;
        drumAnim.to = nextTarget;
        drumAnim.start();
    }

    function syncDrumWithSlots() {
        const list = (compact.plasmoidRoot && Array.isArray(compact.plasmoidRoot.slots))
            ? compact.plasmoidRoot.slots
            : compact.allSlots;
        const n = list.length;
        if (n === 0) {
            rollDrumToIndex(0, true);
            return;
        }

        const optId = compact.plasmoidRoot ? String(compact.plasmoidRoot.optimisticFocusSlotId || "") : "";
        const explicitFocus = compact.checkHasExplicitFocus(list, optId);
        const desiredIdx = compact.activeDrumIndex >= 0 && compact.activeDrumIndex < n
            ? compact.activeDrumIndex
            : 0;

        if (compact.anchoredSlotCount === 0) {
            rollDrumToIndex(desiredIdx, true);
            return;
        }

        if (n !== compact.anchoredSlotCount) {
            let prevNewIdx = -1;
            if (compact.anchoredSlotId.length > 0) {
                for (let i = 0; i < n; ++i) {
                    if (list[i].id === compact.anchoredSlotId) {
                        prevNewIdx = i;
                        break;
                    }
                }
            }
            compact.anchoredSlotCount = n;
            if (prevNewIdx >= 0) {
                drumAnim.stop();
                compact.drumTarget = prevNewIdx;
                compact.drumPosition = prevNewIdx;
                if (explicitFocus && prevNewIdx !== desiredIdx) {
                    rollDrumToIndex(desiredIdx, false);
                }
            } else {
                rollDrumToIndex(desiredIdx, true);
            }
            return;
        }

        // Preserve visual anchor if slots were reordered without changing count.
        let anchorIndex = -1;
        if (compact.anchoredSlotId.length > 0) {
            const curTargetIdx = ((Math.round(compact.drumTarget) % n) + n) % n;
            if (list[curTargetIdx] && list[curTargetIdx].id === compact.anchoredSlotId) {
                anchorIndex = curTargetIdx;
            } else {
                for (let j = 0; j < n; ++j) {
                    if (list[j].id === compact.anchoredSlotId) {
                        anchorIndex = j;
                        const frac = compact.drumPosition - compact.drumTarget;
                        drumAnim.stop();
                        compact.drumTarget = j;
                        compact.drumPosition = j + frac;
                        break;
                    }
                }
            }
        }

        // If no slot currently holds focus (e.g. user middle-clicked the front card
        // to mark it "ready"), keep that anchored slot steady in front.
        if (!explicitFocus && anchorIndex >= 0) {
            if (!drumAnim.running && Math.abs(compact.drumPosition - compact.drumTarget) > 0.0005) {
                drumAnim.from = compact.drumPosition;
                drumAnim.to = compact.drumTarget;
                drumAnim.start();
            }
            return;
        }

        rollDrumToIndex(desiredIdx, false);
    }

    function handleWheelStep(step) {
        if (!compact.isConnected || compact.slotCount <= 1) {
            return;
        }
        const now = Date.now();
        if (now - compact.lastWheelStepMs < 75) {
            return;
        }
        compact.lastWheelStepMs = now;
        // Start cylindrical rotation at 0ms optimistically before HTTP round-trip,
        // and focus the exact slot stepped to so the drum stays single-source-of-truth
        // even when no slot currently holds backend focus.
        const targetId = compact.stepDrumBy(step);
        if (compact.plasmoidRoot) {
            if (targetId.length > 0) {
                compact.plasmoidRoot.focusSlot(targetId);
            } else {
                compact.plasmoidRoot.cycleSlot(step);
            }
        }
    }

    WheelHandler {
        id: wheelHandler
        property int accumulatedDelta: 0
        acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
        onWheel: function (event) {
            const rawDelta = event.angleDelta.y !== 0 ? event.angleDelta.y : event.angleDelta.x;
            if (rawDelta === 0) {
                return;
            }
            if ((accumulatedDelta > 0 && rawDelta < 0) || (accumulatedDelta < 0 && rawDelta > 0)) {
                accumulatedDelta = 0;
            }
            accumulatedDelta += rawDelta;
            while (accumulatedDelta >= 120) {
                accumulatedDelta -= 120;
                compact.handleWheelStep(-1);
            }
            while (accumulatedDelta <= -120) {
                accumulatedDelta += 120;
                compact.handleWheelStep(1);
            }
            event.accepted = true;
        }
    }

    // Compact stacked monochrome indicator for narrow vertical side panels.
    Rectangle {
        id: verticalBadge
        visible: !compact.horizontal
        anchors.centerIn: parent
        readonly property bool hovered: verticalMouse.containsMouse

        width: Math.max(24, Math.min(compact.width - 4, 34))
        implicitHeight: verticalCol.implicitHeight + 10
        height: implicitHeight
        radius: 7
        color: Qt.rgba(compact.tc.r, compact.tc.g, compact.tc.b,
            compact.isDarkSurface
                ? (hovered ? 0.22 : (compact.isPanelOpen ? 0.20 : 0.12))
                : (hovered ? 0.16 : (compact.isPanelOpen ? 0.15 : 0.09)))
        border.width: 1
        border.color: Qt.rgba(compact.tc.r, compact.tc.g, compact.tc.b,
            compact.isDarkSurface
                ? (compact.isPanelOpen ? 0.42 : (hovered ? 0.34 : 0.22))
                : (compact.isPanelOpen ? 0.32 : (hovered ? 0.24 : 0.16)))

        ColumnLayout {
            id: verticalCol
            anchors.centerIn: parent
            spacing: 2

            Text {
                text: compact.isEn ? "F" : "羽"
                textFormat: Text.PlainText
                renderType: Text.NativeRendering
                color: compact.tc
                font.pixelSize: compact.baseFontSize
                font.weight: Font.Bold
                Layout.alignment: Qt.AlignHCenter
            }

            Text {
                visible: compact.isConnected && compact.slotCount > 0
                text: String(compact.slotCount)
                textFormat: Text.PlainText
                renderType: Text.NativeRendering
                color: compact.tc
                opacity: 0.82
                font.family: "monospace"
                font.pixelSize: Math.max(9, compact.baseFontSize - 2)
                Layout.alignment: Qt.AlignHCenter
            }
        }

        MouseArea {
            id: verticalMouse
            anchors.fill: parent
            hoverEnabled: true
            acceptedButtons: Qt.LeftButton | Qt.MiddleButton
            cursorShape: Qt.PointingHandCursor
            onClicked: {
                if (compact.plasmoidRoot) {
                    compact.plasmoidRoot.toggleOrLaunchPanel();
                }
            }
        }
    }

    // Horizontal dock strip: Offline / Idle pill, 1-slot card, or 3D Cylindrical Drum + Tally.
    RowLayout {
        id: barRow
        visible: compact.horizontal
        anchors.verticalCenter: parent.verticalCenter
        x: compact.width >= implicitWidth + compact.horizontalMargin * 2
            ? Math.round((compact.width - implicitWidth) / 2)
            : compact.horizontalMargin
        spacing: 5

        // Offline state pill
        Rectangle {
            id: offlinePill
            visible: !compact.isConnected
            readonly property bool hovered: offlineMouse.containsMouse

            implicitWidth: Math.max(128, Math.ceil(offlineRow.implicitWidth) + 20)
            implicitHeight: compact.pillHeight
            Layout.preferredWidth: implicitWidth
            Layout.minimumWidth: implicitWidth
            Layout.preferredHeight: compact.pillHeight
            Layout.alignment: Qt.AlignVCenter

            radius: 8
            opacity: hovered ? 1.0 : 0.92
            color: Qt.rgba(compact.tc.r, compact.tc.g, compact.tc.b,
                compact.isDarkSurface
                    ? (hovered ? 0.20 : 0.12)
                    : (hovered ? 0.14 : 0.08))
            border.width: 1
            border.color: Qt.rgba(compact.tc.r, compact.tc.g, compact.tc.b,
                compact.isDarkSurface
                    ? (hovered ? 0.34 : 0.22)
                    : (hovered ? 0.24 : 0.15))

            Behavior on color {
                ColorAnimation {
                    duration: Kirigami.Units.shortDuration
                }
            }

            RowLayout {
                id: offlineRow
                anchors.centerIn: parent
                spacing: 6

                Rectangle {
                    Layout.preferredWidth: 2
                    Layout.preferredHeight: Math.max(11, Math.round(compact.pillHeight * 0.44))
                    Layout.alignment: Qt.AlignVCenter
                    radius: 1
                    color: Qt.rgba(compact.tc.r, compact.tc.g, compact.tc.b, compact.isDarkSurface ? 0.60 : 0.50)
                }

                Text {
                    text: compact.isLaunching
                        ? (compact.isEn ? "Starting Featherlog…" : "正在启动羽记…")
                        : (compact.isEn ? "Offline · Click to Start" : "羽记未运行 · 点此启动")
                    textFormat: Text.PlainText
                    renderType: Text.NativeRendering
                    color: compact.tc
                    font.pixelSize: compact.baseFontSize
                    font.weight: Font.Medium
                    Layout.alignment: Qt.AlignVCenter
                }

                Text {
                    text: "⌃"
                    textFormat: Text.PlainText
                    renderType: Text.NativeRendering
                    color: compact.tc
                    opacity: 0.72
                    font.pixelSize: compact.baseFontSize
                    Layout.topMargin: 2
                    Layout.alignment: Qt.AlignVCenter
                }
            }

            MouseArea {
                id: offlineMouse
                anchors.fill: parent
                hoverEnabled: true
                acceptedButtons: Qt.LeftButton | Qt.MiddleButton
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                    if (compact.plasmoidRoot) {
                        compact.plasmoidRoot.launchDaemonAndOpen();
                    }
                }
            }
        }

        // Connected idle state (0 active slots)
        Rectangle {
            id: idlePill
            visible: compact.isConnected && compact.slotCount === 0
            readonly property bool hovered: idleMouse.containsMouse

            implicitWidth: Math.max(128, Math.ceil(idleRow.implicitWidth) + 20)
            implicitHeight: compact.pillHeight
            Layout.preferredWidth: implicitWidth
            Layout.minimumWidth: implicitWidth
            Layout.preferredHeight: compact.pillHeight
            Layout.alignment: Qt.AlignVCenter

            radius: 8
            color: Qt.rgba(compact.tc.r, compact.tc.g, compact.tc.b,
                compact.isDarkSurface
                    ? (hovered ? 0.22 : (compact.isPanelOpen ? 0.20 : 0.13))
                    : (hovered ? 0.16 : (compact.isPanelOpen ? 0.15 : 0.09)))
            border.width: 1
            border.color: Qt.rgba(compact.tc.r, compact.tc.g, compact.tc.b,
                compact.isDarkSurface
                    ? (compact.isPanelOpen ? 0.40 : (hovered ? 0.34 : 0.22))
                    : (compact.isPanelOpen ? 0.30 : (hovered ? 0.24 : 0.15)))

            Behavior on color {
                ColorAnimation {
                    duration: Kirigami.Units.shortDuration
                }
            }

            RowLayout {
                id: idleRow
                anchors.centerIn: parent
                spacing: 6

                Rectangle {
                    Layout.preferredWidth: 2
                    Layout.preferredHeight: Math.max(11, Math.round(compact.pillHeight * 0.44))
                    Layout.alignment: Qt.AlignVCenter
                    radius: 1
                    color: Qt.rgba(compact.tc.r, compact.tc.g, compact.tc.b, compact.isDarkSurface ? 0.68 : 0.56)
                }

                Text {
                    text: compact.isEn ? "Empty · Open Workbench" : "空槽 · 点此开工作台"
                    textFormat: Text.PlainText
                    renderType: Text.NativeRendering
                    color: compact.tc
                    opacity: 0.94
                    font.pixelSize: compact.baseFontSize
                    font.weight: Font.Medium
                    Layout.alignment: Qt.AlignVCenter
                }

                Rectangle {
                    visible: compact.showTodayCount && compact.todayTotal > 0
                    Layout.preferredWidth: 1
                    Layout.preferredHeight: Math.max(10, Math.round(compact.pillHeight * 0.44))
                    Layout.alignment: Qt.AlignVCenter
                    color: Qt.rgba(compact.tc.r, compact.tc.g, compact.tc.b, 0.28)
                }

                Text {
                    visible: compact.showTodayCount && compact.todayTotal > 0
                    text: compact.todayDone + "/" + compact.todayTotal
                    textFormat: Text.PlainText
                    renderType: Text.NativeRendering
                    color: compact.tc
                    opacity: 0.86
                    font.family: "monospace"
                    font.pixelSize: Math.max(10, compact.baseFontSize - 1)
                    Layout.alignment: Qt.AlignVCenter
                }

                Text {
                    text: compact.isPanelOpen ? "⌄" : "⌃"
                    textFormat: Text.PlainText
                    renderType: Text.NativeRendering
                    color: compact.tc
                    opacity: 0.80
                    font.pixelSize: compact.baseFontSize
                    Layout.topMargin: compact.isPanelOpen ? -2 : 2
                    Layout.alignment: Qt.AlignVCenter
                }
            }

            MouseArea {
                id: idleMouse
                anchors.fill: parent
                hoverEnabled: true
                acceptedButtons: Qt.LeftButton | Qt.MiddleButton
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                    if (compact.plasmoidRoot) {
                        compact.plasmoidRoot.togglePanel();
                    }
                }
            }
        }

        // Clean single-slot prominent crown card (no empty drum flanks when slotCount === 1)
        Rectangle {
            id: singleSlotCard
            visible: compact.isConnected && compact.slotCount === 1
            readonly property var slotObj: compact.slotCount === 1 ? compact.allSlots[0] : null
            readonly property string slotId: slotObj ? String(slotObj.id || "") : ""
            readonly property string slotTitle: slotObj ? String(slotObj.title || "") : ""
            readonly property string slotState: slotObj ? String(slotObj.state || "focus") : "focus"
            readonly property string slotTag: slotObj ? String(slotObj.tag || "") : ""
            readonly property double slotRemindAt: slotObj ? Number(slotObj.remindAt || 0) : 0
            readonly property bool isReady: slotState === "ready"
            readonly property bool isRunning: slotState === "running"
            readonly property bool hovered: singleMouse.containsMouse

            implicitWidth: Math.max(108, Math.min(168, Math.ceil(singleRow.implicitWidth) + 20))
            implicitHeight: compact.pillHeight
            Layout.preferredWidth: implicitWidth
            Layout.minimumWidth: implicitWidth
            Layout.preferredHeight: compact.pillHeight
            Layout.alignment: Qt.AlignVCenter

            radius: 8
            color: compact.isDarkSurface
                ? compact.mixColor(compact.solidBg, compact.tc, hovered ? 0.21 : (compact.isPanelOpen ? 0.19 : 0.16), 0.98)
                : compact.mixColor(compact.solidBg, Qt.rgba(1.0, 1.0, 1.0, 1.0), hovered ? 0.92 : 0.78, 0.98)
            border.width: 1
            border.color: Qt.rgba(compact.tc.r, compact.tc.g, compact.tc.b,
                compact.isDarkSurface
                    ? (compact.isPanelOpen ? 0.44 : (hovered ? 0.38 : 0.30))
                    : (compact.isPanelOpen ? 0.34 : (hovered ? 0.28 : 0.22)))

            // Subtle top specular highlight along the crown ridge
            Rectangle {
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.leftMargin: 8
                anchors.rightMargin: 8
                anchors.topMargin: 1
                height: 1
                color: Qt.rgba(1.0, 1.0, 1.0, compact.isDarkSurface ? 0.26 : 0.75)
            }

            // Hairline 1px monochrome bottom reminder tick when running with remindAt
            Rectangle {
                visible: singleSlotCard.isRunning && singleSlotCard.slotRemindAt > 0
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                anchors.leftMargin: 8
                anchors.rightMargin: 8
                anchors.bottomMargin: 1
                height: 1
                color: Qt.rgba(compact.tc.r, compact.tc.g, compact.tc.b, compact.isDarkSurface ? 0.46 : 0.36)
            }

            RowLayout {
                id: singleRow
                anchors.verticalCenter: parent.verticalCenter
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.leftMargin: 10
                anchors.rightMargin: 10
                spacing: 6

                Rectangle {
                    Layout.preferredWidth: 2
                    Layout.preferredHeight: Math.max(12, Math.round(compact.pillHeight * 0.46))
                    Layout.alignment: Qt.AlignVCenter
                    radius: 1
                    color: compact.tc
                }

                Text {
                    text: singleSlotCard.slotTitle
                    textFormat: Text.PlainText
                    renderType: Text.QtRendering
                    color: compact.tc
                    font.pixelSize: compact.baseFontSize
                    font.weight: Font.Bold
                    maximumLineCount: 1
                    elide: Text.ElideRight
                    Layout.fillWidth: true
                    Layout.alignment: Qt.AlignVCenter
                }

                Rectangle {
                    visible: singleSlotCard.isReady
                    radius: 4
                    color: compact.tc
                    implicitWidth: Math.ceil(singleReadyText.implicitWidth) + 7
                    implicitHeight: Math.ceil(singleReadyText.implicitHeight) + 2
                    Layout.preferredWidth: implicitWidth
                    Layout.minimumWidth: implicitWidth
                    Layout.preferredHeight: implicitHeight
                    Layout.alignment: Qt.AlignVCenter

                    Text {
                        id: singleReadyText
                        anchors.centerIn: parent
                        text: compact.isEn ? "READY" : "待看"
                        textFormat: Text.PlainText
                        renderType: Text.QtRendering
                        color: compact.inverseInk
                        font.pixelSize: Math.max(9, compact.baseFontSize - 3)
                        font.weight: Font.Bold
                    }
                }

                Text {
                    visible: !singleSlotCard.isReady && singleSlotCard.slotTag.length > 0
                    text: singleSlotCard.slotTag
                    textFormat: Text.PlainText
                    renderType: Text.QtRendering
                    color: compact.tc
                    opacity: compact.isDarkSurface ? 0.62 : 0.56
                    font.pixelSize: Math.max(9, compact.baseFontSize - 2)
                    maximumLineCount: 1
                    elide: Text.ElideRight
                    Layout.maximumWidth: 42
                    Layout.alignment: Qt.AlignVCenter
                }
            }

            MouseArea {
                id: singleMouse
                anchors.fill: parent
                hoverEnabled: true
                acceptedButtons: Qt.LeftButton | Qt.MiddleButton
                cursorShape: Qt.PointingHandCursor
                onEntered: {
                    if (compact.plasmoidRoot) {
                        compact.plasmoidRoot.hoveredSlotId = singleSlotCard.slotId;
                    }
                }
                onExited: {
                    if (compact.plasmoidRoot && compact.plasmoidRoot.hoveredSlotId === singleSlotCard.slotId) {
                        compact.plasmoidRoot.hoveredSlotId = "";
                    }
                }
                onClicked: function (mouse) {
                    if (!compact.plasmoidRoot) {
                        return;
                    }
                    if (mouse.button === Qt.MiddleButton) {
                        compact.plasmoidRoot.setSlotState(singleSlotCard.slotId, singleSlotCard.isReady ? "running" : "ready");
                        return;
                    }
                    if (mouse.button === Qt.LeftButton) {
                        compact.plasmoidRoot.togglePanel();
                    }
                }
            }
        }

        // 3D Cylindrical Drum Carousel viewport (for >= 2 concurrent slots)
        Rectangle {
            id: drumViewport
            visible: compact.isConnected && compact.slotCount >= 2

            implicitWidth: compact.drumViewportWidth
            implicitHeight: compact.drumViewportHeight
            Layout.preferredWidth: implicitWidth
            Layout.minimumWidth: implicitWidth
            Layout.preferredHeight: implicitHeight
            Layout.alignment: Qt.AlignVCenter

            radius: 9
            clip: true
            color: compact.isDarkSurface
                ? Qt.rgba(0.0, 0.0, 0.0, 0.36)
                : Qt.rgba(compact.tc.r, compact.tc.g, compact.tc.b, 0.06)
            border.width: 1
            border.color: Qt.rgba(compact.tc.r, compact.tc.g, compact.tc.b, compact.isDarkSurface ? 0.14 : 0.13)

            // Recessed cylindrical barrel sheen along top & bottom aperture lips
            Rectangle {
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.leftMargin: 12
                anchors.rightMargin: 12
                anchors.topMargin: 1
                height: 1
                z: 1
                color: Qt.rgba(0.0, 0.0, 0.0, compact.isDarkSurface ? 0.50 : 0.08)
            }
            Rectangle {
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                anchors.leftMargin: 12
                anchors.rightMargin: 12
                anchors.bottomMargin: 1
                height: 1
                z: 1
                color: Qt.rgba(1.0, 1.0, 1.0, compact.isDarkSurface ? 0.07 : 0.45)
            }

            // Soft cast-shadow halo beneath the raised front crown card (sits between wings and crown,
            // fading cleanly during mid-roll so cards never pass through a stationary dark bar).
            Rectangle {
                id: crownShadowLeft
                visible: compact.slotCount >= 3 && compact.crownRestFactor > 0.05
                z: 74
                x: Math.round(compact.drumCenterX - compact.drumCardWidth * 0.5) - 10
                y: 2
                width: 12
                height: drumViewport.height - 4
                opacity: compact.crownRestFactor
                gradient: Gradient {
                    orientation: Gradient.Horizontal
                    GradientStop { position: 0.0; color: Qt.rgba(0.0, 0.0, 0.0, 0.0) }
                    GradientStop { position: 1.0; color: Qt.rgba(0.0, 0.0, 0.0, compact.isDarkSurface ? 0.52 : 0.16) }
                }
            }
            Rectangle {
                id: crownShadowRight
                visible: compact.crownRestFactor > 0.05
                z: 74
                x: Math.round(compact.drumCenterX + compact.drumCardWidth * 0.5) - 2
                y: 2
                width: 12
                height: drumViewport.height - 4
                opacity: compact.crownRestFactor
                gradient: Gradient {
                    orientation: Gradient.Horizontal
                    GradientStop { position: 0.0; color: Qt.rgba(0.0, 0.0, 0.0, compact.isDarkSurface ? 0.52 : 0.16) }
                    GradientStop { position: 1.0; color: Qt.rgba(0.0, 0.0, 0.0, 0.0) }
                }
            }

            // Slots mounted parametrically around the 3D cylinder
            Repeater {
                id: drumRepeater
                model: (compact.isConnected && compact.slotCount >= 2) ? compact.allSlots : []

                delegate: Item {
                    id: slotHolder

                    required property var modelData
                    required property int index

                    readonly property string slotId: String(modelData.id || "")
                    readonly property string slotTitle: String(modelData.title || "")
                    readonly property string slotState: String(modelData.state || "running")
                    readonly property string slotTag: String(modelData.tag || "")
                    readonly property double slotChangedAt: Number(modelData.stateChangedAt || 0)
                    readonly property double slotRemindAt: Number(modelData.remindAt || 0)
                    readonly property bool isFocus: slotState === "focus"
                    readonly property bool isReady: slotState === "ready"
                    readonly property bool isRunning: slotState === "running"
                    readonly property bool hovered: cardMouse.containsMouse

                    // Raw circular offset on the cylinder ring.
                    readonly property real rawOffset: compact.circularOffset(index, compact.drumPosition, compact.slotCount)

                    // For 2-slot mode, map phase u in [0, 2) onto a smooth front/back swap
                    // between crown (0) and curled right wing (+1) without left-edge pop.
                    readonly property real twoSlotPhase: {
                        if (compact.slotCount !== 2) {
                            return 0.0;
                        }
                        let u = (index - compact.drumPosition) % 2.0;
                        if (u < 0.0) {
                            u += 2.0;
                        }
                        return u;
                    }
                    readonly property bool twoSlotReceding: compact.slotCount === 2 && twoSlotPhase > 1.0

                    // Signed angular offset along the visible cylinder surface (-1.5 .. +1.5).
                    readonly property real ringOffset: {
                        if (compact.slotCount === 2) {
                            return twoSlotReceding ? (2.0 - twoSlotPhase) : twoSlotPhase;
                        }
                        return rawOffset;
                    }
                    readonly property real absOffset: Math.abs(ringOffset)
                    readonly property real thetaDeg: ringOffset * compact.stepAngleDeg
                    readonly property real thetaRad: thetaDeg * Math.PI / 180.0
                    readonly property real cosTheta: Math.max(0.0, Math.cos(thetaRad))
                    readonly property real sinTheta: Math.sin(thetaRad)

                    // Smooth frontness weight: 1.0 at crown, ~0.58 on wings, 0.0 at horizon.
                    readonly property real frontness: Math.pow(cosTheta, 1.35)
                    readonly property real curlAmount: Math.min(1.0, absOffset)
                    readonly property real isFrontFactor: Math.max(0.0, 1.0 - absOffset * 2.2)

                    // Extra depth push on the receding back-arc of a 2-slot swap so it tucks cleanly behind.
                    readonly property real extraDepthZ: twoSlotReceding
                        ? (34.0 * Math.sin((2.0 - twoSlotPhase) * Math.PI))
                        : 0.0

                    // Opacity fades to 0 before the +/-1.5 wrap point so 3+ slot horizon wrap is invisible.
                    readonly property real horizonAlpha: {
                        if (compact.slotCount === 2) {
                            return twoSlotReceding
                                ? (1.0 - 0.28 * Math.sin((2.0 - twoSlotPhase) * Math.PI))
                                : 1.0;
                        }
                        if (absOffset >= 1.46) {
                            return 0.0;
                        }
                        if (absOffset > 1.08) {
                            return Math.max(0.0, (1.46 - absOffset) / 0.38);
                        }
                        return 1.0;
                    }

                    readonly property real cardOpacity: horizonAlpha * (0.76 + 0.24 * cosTheta)

                    visible: horizonAlpha > 0.01 && absOffset < 1.52
                    width: compact.drumCardWidth
                    height: compact.pillHeight
                    x: Math.round(compact.drumCenterX + compact.cylRadius * sinTheta - width * 0.5)
                    y: Math.round((drumViewport.height - height) * 0.5)
                    opacity: cardOpacity
                    z: {
                        if (compact.slotCount === 2) {
                            const baseZ = 100.0 - ringOffset * 42.0;
                            return twoSlotReceding
                                ? (baseZ - 32.0 * Math.sin((2.0 - twoSlotPhase) * Math.PI))
                                : baseZ;
                        }
                        return Math.round(100.0 * cosTheta);
                    }

                    transform: Matrix4x4 {
                        matrix: compact.cylinderCardMatrix(
                            slotHolder.width,
                            slotHolder.height,
                            slotHolder.thetaDeg,
                            compact.cylRadius,
                            compact.focalDistance,
                            slotHolder.extraDepthZ
                        )
                    }

                    Rectangle {
                        id: cardSurface
                        anchors.fill: parent
                        radius: 8
                        clip: true
                        antialiasing: true

                        // High-opacity monochrome surface so tucked wings never bleed through the front crown.
                        color: {
                            const hoverBoost = slotHolder.hovered ? 0.045 : 0.0;
                            const openBoost = (compact.isPanelOpen && slotHolder.absOffset < 0.3) ? 0.025 : 0.0;
                            if (compact.isDarkSurface) {
                                const mixT = 0.085 + 0.080 * slotHolder.frontness + hoverBoost + openBoost;
                                return compact.mixColor(compact.solidBg, compact.tc, mixT, 0.98);
                            }
                            const lightT = 0.15 + 0.65 * slotHolder.frontness + (slotHolder.hovered ? 0.10 : 0.0);
                            const wingBase = compact.mixColor(compact.solidBg, compact.tc, 0.06, 0.98);
                            return compact.mixColor(wingBase, Qt.rgba(1.0, 1.0, 1.0, 1.0), lightT, 0.98);
                        }

                        border.width: 1
                        border.color: {
                            const hoverAlpha = slotHolder.hovered ? 0.09 : 0.0;
                            const openAlpha = (compact.isPanelOpen && slotHolder.absOffset < 0.3) ? 0.10 : 0.0;
                            if (compact.isDarkSurface) {
                                const baseA = 0.16 + 0.15 * slotHolder.frontness + (slotHolder.isReady ? 0.06 : 0.0);
                                return Qt.rgba(compact.tc.r, compact.tc.g, compact.tc.b, Math.min(0.50, baseA + hoverAlpha + openAlpha));
                            }
                            const baseLightA = 0.12 + 0.12 * slotHolder.frontness + (slotHolder.isReady ? 0.06 : 0.0);
                            return Qt.rgba(compact.tc.r, compact.tc.g, compact.tc.b, Math.min(0.42, baseLightA + hoverAlpha + openAlpha));
                        }

                        // Specular catch-light along the top crown ridge (peaks when centered at offset = 0)
                        Rectangle {
                            anchors.left: parent.left
                            anchors.right: parent.right
                            anchors.top: parent.top
                            anchors.leftMargin: 7
                            anchors.rightMargin: 7
                            anchors.topMargin: 1
                            height: 1
                            z: 12
                            color: Qt.rgba(1.0, 1.0, 1.0,
                                (compact.isDarkSurface ? 0.28 : 0.80) * Math.pow(slotHolder.cosTheta, 2.2))
                        }

                        // Subtle lower edge bevel on the prominent front card
                        Rectangle {
                            anchors.left: parent.left
                            anchors.right: parent.right
                            anchors.bottom: parent.bottom
                            anchors.leftMargin: 7
                            anchors.rightMargin: 7
                            anchors.bottomMargin: 1
                            height: 1
                            z: 12
                            visible: !(slotHolder.isRunning && slotHolder.slotRemindAt > 0)
                            color: Qt.rgba(0.0, 0.0, 0.0,
                                (compact.isDarkSurface ? 0.34 : 0.10) * Math.pow(slotHolder.cosTheta, 2.0))
                        }

                        // Hairline 1px monochrome bottom tick when a running slot has an active reminder
                        Rectangle {
                            visible: slotHolder.isRunning && slotHolder.slotRemindAt > 0
                            anchors.left: parent.left
                            anchors.right: parent.right
                            anchors.bottom: parent.bottom
                            anchors.leftMargin: 7
                            anchors.rightMargin: 7
                            anchors.bottomMargin: 1
                            height: 1
                            z: 12
                            color: Qt.rgba(compact.tc.r, compact.tc.g, compact.tc.b,
                                (compact.isDarkSurface ? 0.50 : 0.38) * (0.55 + 0.45 * slotHolder.cosTheta))
                        }

                        // Card typography & monochrome state hierarchy
                        RowLayout {
                            id: cardRow
                            anchors.verticalCenter: parent.verticalCenter
                            anchors.left: parent.left
                            anchors.right: parent.right
                            anchors.leftMargin: 10
                            anchors.rightMargin: 9
                            spacing: 5
                            z: 4

                            // Front prominent indicator: crisp 2px monochrome vertical ink bar
                            Rectangle {
                                visible: slotHolder.isFocus || slotHolder.absOffset < 0.38
                                opacity: slotHolder.isFocus ? 1.0 : Math.max(0.35, slotHolder.isFrontFactor)
                                Layout.preferredWidth: 2
                                Layout.preferredHeight: Math.max(11, Math.round(compact.pillHeight * 0.46))
                                Layout.alignment: Qt.AlignVCenter
                                radius: 1
                                color: compact.tc
                            }

                            // Ready badge on side wings sits on the left so it peeks out cleanly on both wings
                            Rectangle {
                                visible: slotHolder.isReady && slotHolder.absOffset >= 0.38
                                radius: 3
                                color: compact.tc
                                implicitWidth: Math.ceil(wingReadyText.implicitWidth) + 6
                                implicitHeight: Math.ceil(wingReadyText.implicitHeight) + 2
                                Layout.preferredWidth: implicitWidth
                                Layout.minimumWidth: implicitWidth
                                Layout.preferredHeight: implicitHeight
                                Layout.alignment: Qt.AlignVCenter

                                Text {
                                    id: wingReadyText
                                    anchors.centerIn: parent
                                    text: compact.isEn ? "READY" : "待看"
                                    textFormat: Text.PlainText
                                    renderType: Text.QtRendering
                                    color: compact.inverseInk
                                    font.pixelSize: Math.max(8, compact.baseFontSize - 3)
                                    font.weight: Font.Bold
                                }
                            }

                            // Slot title (SDF QtRendering stays sharp under 3D perspective curl)
                            Text {
                                id: slotTitleText
                                text: slotHolder.slotTitle
                                textFormat: Text.PlainText
                                renderType: Text.QtRendering
                                color: compact.tc
                                opacity: 0.72 + 0.28 * slotHolder.frontness
                                font.pixelSize: compact.baseFontSize
                                font.weight: slotHolder.absOffset < 0.38
                                    ? Font.Bold
                                    : (slotHolder.isReady ? Font.DemiBold : Font.Medium)
                                maximumLineCount: 1
                                elide: Text.ElideRight
                                Layout.fillWidth: true
                                Layout.alignment: Qt.AlignVCenter
                            }

                            // Front-slot inverse monochrome "待看" badge when centered slot is ready
                            Rectangle {
                                visible: slotHolder.isReady && slotHolder.absOffset < 0.38
                                radius: 4
                                color: compact.tc
                                implicitWidth: Math.ceil(frontReadyText.implicitWidth) + 7
                                implicitHeight: Math.ceil(frontReadyText.implicitHeight) + 2
                                Layout.preferredWidth: implicitWidth
                                Layout.minimumWidth: implicitWidth
                                Layout.preferredHeight: implicitHeight
                                Layout.alignment: Qt.AlignVCenter

                                Text {
                                    id: frontReadyText
                                    anchors.centerIn: parent
                                    text: compact.isEn ? "READY" : "待看"
                                    textFormat: Text.PlainText
                                    renderType: Text.QtRendering
                                    color: compact.inverseInk
                                    font.pixelSize: Math.max(9, compact.baseFontSize - 3)
                                    font.weight: Font.Bold
                                }
                            }

                            // Optional compact muted tag on front slot when not showing "待看"
                            Text {
                                visible: !slotHolder.isReady && slotHolder.absOffset < 0.38 && slotHolder.slotTag.length > 0
                                text: slotHolder.slotTag
                                textFormat: Text.PlainText
                                renderType: Text.QtRendering
                                color: compact.tc
                                opacity: (compact.isDarkSurface ? 0.58 : 0.52) * slotHolder.isFrontFactor
                                font.pixelSize: Math.max(9, compact.baseFontSize - 3)
                                maximumLineCount: 1
                                elide: Text.ElideRight
                                Layout.maximumWidth: 32
                                Layout.alignment: Qt.AlignVCenter
                            }
                        }

                        // Curved cylindrical Lambertian surface shading + contact shadow overlay.
                        // Left wing (ringOffset < 0) darkens toward its outer-left receding limb;
                        // Right wing (ringOffset > 0) darkens toward its outer-right receding limb.
                        Rectangle {
                            id: cylinderShadeOverlay
                            anchors.fill: parent
                            radius: parent.radius
                            antialiasing: true
                            z: 10
                            visible: slotHolder.curlAmount > 0.02

                            readonly property real cAmt: slotHolder.curlAmount
                            readonly property real outerStrength: compact.isDarkSurface ? 0.50 : 0.30
                            readonly property real midStrength: compact.isDarkSurface ? 0.19 : 0.11
                            readonly property real crownShoulder: compact.isDarkSurface ? 0.04 : 0.02
                            readonly property real seamStrength: compact.isDarkSurface ? 0.28 : 0.15
                            readonly property bool isLeftWing: slotHolder.ringOffset < 0.0

                            gradient: Gradient {
                                orientation: Gradient.Horizontal
                                GradientStop {
                                    position: 0.0
                                    color: Qt.rgba(0.0, 0.0, 0.0,
                                        (cylinderShadeOverlay.isLeftWing
                                            ? cylinderShadeOverlay.outerStrength
                                            : cylinderShadeOverlay.seamStrength) * cylinderShadeOverlay.cAmt)
                                }
                                GradientStop {
                                    position: cylinderShadeOverlay.isLeftWing ? 0.42 : 0.18
                                    color: Qt.rgba(0.0, 0.0, 0.0,
                                        (cylinderShadeOverlay.isLeftWing
                                            ? cylinderShadeOverlay.midStrength
                                            : cylinderShadeOverlay.crownShoulder) * cylinderShadeOverlay.cAmt)
                                }
                                GradientStop {
                                    position: cylinderShadeOverlay.isLeftWing ? 0.82 : 0.58
                                    color: Qt.rgba(0.0, 0.0, 0.0,
                                        (cylinderShadeOverlay.isLeftWing
                                            ? cylinderShadeOverlay.crownShoulder
                                            : cylinderShadeOverlay.midStrength) * cylinderShadeOverlay.cAmt)
                                }
                                GradientStop {
                                    position: 1.0
                                    color: Qt.rgba(0.0, 0.0, 0.0,
                                        (cylinderShadeOverlay.isLeftWing
                                            ? cylinderShadeOverlay.seamStrength
                                            : cylinderShadeOverlay.outerStrength) * cylinderShadeOverlay.cAmt)
                                }
                            }
                        }

                        MouseArea {
                            id: cardMouse
                            anchors.fill: parent
                            enabled: slotHolder.visible && slotHolder.absOffset < 1.25 && slotHolder.cardOpacity > 0.18
                            hoverEnabled: true
                            acceptedButtons: Qt.LeftButton | Qt.MiddleButton
                            cursorShape: Qt.PointingHandCursor

                            onEntered: {
                                if (compact.plasmoidRoot) {
                                    compact.plasmoidRoot.hoveredSlotId = slotHolder.slotId;
                                }
                            }
                            onExited: {
                                if (compact.plasmoidRoot && compact.plasmoidRoot.hoveredSlotId === slotHolder.slotId) {
                                    compact.plasmoidRoot.hoveredSlotId = "";
                                }
                            }
                            onClicked: function (mouse) {
                                if (!compact.plasmoidRoot) {
                                    return;
                                }
                                if (mouse.button === Qt.MiddleButton) {
                                    compact.plasmoidRoot.setSlotState(
                                        slotHolder.slotId,
                                        slotHolder.isReady ? "running" : "ready"
                                    );
                                    return;
                                }
                                if (mouse.button === Qt.LeftButton) {
                                    if (slotHolder.absOffset < 0.3) {
                                        compact.plasmoidRoot.togglePanel();
                                    } else {
                                        // Optimistically roll clicked flank wing straight to front crown.
                                        compact.rollDrumToIndex(slotHolder.index, false);
                                        compact.plasmoidRoot.focusSlot(slotHolder.slotId);
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Inner barrel rim vignettes at left & right horizons of the drum housing
            Rectangle {
                id: leftRimVignette
                visible: compact.slotCount >= 3
                anchors.left: parent.left
                anchors.top: parent.top
                anchors.bottom: parent.bottom
                width: 18
                z: 180
                radius: 8
                gradient: Gradient {
                    orientation: Gradient.Horizontal
                    GradientStop { position: 0.0; color: Qt.rgba(0.0, 0.0, 0.0, compact.isDarkSurface ? 0.46 : 0.16) }
                    GradientStop { position: 0.55; color: Qt.rgba(0.0, 0.0, 0.0, compact.isDarkSurface ? 0.15 : 0.05) }
                    GradientStop { position: 1.0; color: Qt.rgba(0.0, 0.0, 0.0, 0.0) }
                }
            }

            Rectangle {
                id: rightRimVignette
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.bottom: parent.bottom
                width: 18
                z: 180
                radius: 8
                gradient: Gradient {
                    orientation: Gradient.Horizontal
                    GradientStop { position: 0.0; color: Qt.rgba(0.0, 0.0, 0.0, 0.0) }
                    GradientStop { position: 0.45; color: Qt.rgba(0.0, 0.0, 0.0, compact.isDarkSurface ? 0.15 : 0.05) }
                    GradientStop { position: 1.0; color: Qt.rgba(0.0, 0.0, 0.0, compact.isDarkSurface ? 0.46 : 0.16) }
                }
            }
        }

        // Quiet monochrome divider before tally / panel toggle button
        Rectangle {
            visible: compact.isConnected && compact.slotCount > 0
            Layout.preferredWidth: 1
            Layout.preferredHeight: Math.max(12, Math.round(compact.pillHeight * 0.46))
            Layout.alignment: Qt.AlignVCenter
            color: Qt.rgba(compact.tc.r, compact.tc.g, compact.tc.b, compact.isDarkSurface ? 0.24 : 0.20)
        }

        // Today task tally + optional hidden-ready monochrome pip + panel toggle chevron
        Rectangle {
            id: tallyButton
            visible: compact.isConnected && compact.slotCount > 0
            readonly property bool hovered: tallyMouse.containsMouse || hiddenReadyMouse.containsMouse
            readonly property bool showTally: compact.showTodayCount && compact.todayTotal > 0
            readonly property bool showHiddenReady: compact.hiddenReadyCount > 0

            implicitWidth: Math.ceil(tallyRow.implicitWidth) + (showTally || showHiddenReady ? 14 : 12)
            implicitHeight: compact.pillHeight
            Layout.preferredWidth: implicitWidth
            Layout.minimumWidth: implicitWidth
            Layout.preferredHeight: compact.pillHeight
            Layout.alignment: Qt.AlignVCenter

            radius: 8
            color: Qt.rgba(compact.tc.r, compact.tc.g, compact.tc.b,
                compact.isDarkSurface
                    ? (hovered ? 0.19 : (compact.isPanelOpen ? 0.18 : 0.09))
                    : (hovered ? 0.15 : (compact.isPanelOpen ? 0.14 : 0.06)))
            border.width: 1
            border.color: Qt.rgba(compact.tc.r, compact.tc.g, compact.tc.b,
                compact.isDarkSurface
                    ? (compact.isPanelOpen ? 0.36 : (hovered ? 0.28 : 0.16))
                    : (compact.isPanelOpen ? 0.26 : (hovered ? 0.20 : 0.10)))

            Behavior on color {
                ColorAnimation {
                    duration: Kirigami.Units.shortDuration
                }
            }

            MouseArea {
                id: tallyMouse
                anchors.fill: parent
                hoverEnabled: true
                acceptedButtons: Qt.LeftButton | Qt.MiddleButton
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                    if (compact.plasmoidRoot) {
                        compact.plasmoidRoot.togglePanel();
                    }
                }
            }

            RowLayout {
                id: tallyRow
                anchors.centerIn: parent
                spacing: 5

                // Crisp monochrome inverse "待看" pip when a ready slot is hidden on the back of a 4+ slot drum
                Rectangle {
                    id: hiddenReadyPip
                    visible: tallyButton.showHiddenReady
                    radius: 4
                    color: compact.tc
                    implicitWidth: Math.ceil(hiddenReadyLabel.implicitWidth) + 7
                    implicitHeight: Math.ceil(hiddenReadyLabel.implicitHeight) + 2
                    Layout.preferredWidth: implicitWidth
                    Layout.minimumWidth: implicitWidth
                    Layout.preferredHeight: implicitHeight
                    Layout.alignment: Qt.AlignVCenter

                    Text {
                        id: hiddenReadyLabel
                        anchors.centerIn: parent
                        text: compact.hiddenReadyCount > 1
                            ? ((compact.isEn ? "READY " : "待看 ") + compact.hiddenReadyCount)
                            : (compact.isEn ? "READY" : "待看")
                        textFormat: Text.PlainText
                        renderType: Text.NativeRendering
                        color: compact.inverseInk
                        font.pixelSize: Math.max(9, compact.baseFontSize - 3)
                        font.weight: Font.Bold
                    }

                    MouseArea {
                        id: hiddenReadyMouse
                        anchors.fill: parent
                        hoverEnabled: true
                        acceptedButtons: Qt.LeftButton
                        cursorShape: Qt.PointingHandCursor
                        onEntered: {
                            if (compact.plasmoidRoot && compact.firstHiddenReadyId.length > 0) {
                                compact.plasmoidRoot.hoveredSlotId = compact.firstHiddenReadyId;
                            }
                        }
                        onExited: {
                            if (compact.plasmoidRoot && compact.plasmoidRoot.hoveredSlotId === compact.firstHiddenReadyId) {
                                compact.plasmoidRoot.hoveredSlotId = "";
                            }
                        }
                        onClicked: {
                            if (compact.plasmoidRoot && compact.firstHiddenReadyIndex >= 0 && compact.firstHiddenReadyId.length > 0) {
                                compact.rollDrumToIndex(compact.firstHiddenReadyIndex, false);
                                compact.plasmoidRoot.focusSlot(compact.firstHiddenReadyId);
                            }
                        }
                    }
                }

                Text {
                    visible: tallyButton.showTally
                    text: compact.todayDone + "/" + compact.todayTotal
                    textFormat: Text.PlainText
                    renderType: Text.NativeRendering
                    color: compact.tc
                    opacity: 0.88
                    font.family: "monospace"
                    font.pixelSize: Math.max(10, compact.baseFontSize - 1)
                    Layout.alignment: Qt.AlignVCenter
                }

                Text {
                    text: compact.isPanelOpen ? "⌄" : "⌃"
                    textFormat: Text.PlainText
                    renderType: Text.NativeRendering
                    color: compact.tc
                    opacity: compact.isPanelOpen ? 0.98 : 0.84
                    font.pixelSize: compact.baseFontSize
                    Layout.topMargin: compact.isPanelOpen ? -2 : 2
                    Layout.alignment: Qt.AlignVCenter
                }
            }
        }
    }
}
