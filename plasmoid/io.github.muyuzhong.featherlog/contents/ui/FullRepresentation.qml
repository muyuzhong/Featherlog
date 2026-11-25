import QtQuick
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.plasma.components as PlasmaComponents

Item {
    id: full

    property var plasmoidRoot: null

    readonly property bool isConnected: plasmoidRoot ? !!plasmoidRoot.connected : false
    readonly property bool isLaunching: plasmoidRoot ? !!plasmoidRoot.launchingDaemon : false
    readonly property bool isPanelOpen: plasmoidRoot ? !!plasmoidRoot.panelOpen : false
    readonly property string language: plasmoidRoot ? String(plasmoidRoot.language || "zh") : "zh"
    readonly property bool isEn: language === "en"
    readonly property int slotCount: (plasmoidRoot && Array.isArray(plasmoidRoot.slots)) ? plasmoidRoot.slots.length : 0
    readonly property var focusedSlot: plasmoidRoot ? plasmoidRoot.focusedSlot : null
    readonly property color tc: Kirigami.Theme.textColor

    implicitWidth: 260
    implicitHeight: 132
    Layout.minimumWidth: 220
    Layout.preferredWidth: 260
    Layout.minimumHeight: 112
    Layout.preferredHeight: 132

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Kirigami.Units.largeSpacing
        spacing: Kirigami.Units.smallSpacing

        RowLayout {
            Layout.fillWidth: true
            spacing: 8

            Rectangle {
                Layout.preferredWidth: 2
                Layout.preferredHeight: 16
                Layout.alignment: Qt.AlignVCenter
                radius: 1
                color: full.tc
            }

            Text {
                text: full.isEn ? "Featherlog" : "羽记 Featherlog"
                textFormat: Text.PlainText
                renderType: Text.NativeRendering
                color: full.tc
                font.weight: Font.Bold
                Layout.fillWidth: true
            }
        }

        Text {
            Layout.fillWidth: true
            textFormat: Text.PlainText
            renderType: Text.NativeRendering
            color: full.tc
            opacity: 0.78
            elide: Text.ElideRight
            maximumLineCount: 2
            wrapMode: Text.Wrap
            text: {
                if (!full.isConnected) {
                    if (full.isLaunching) {
                        return full.isEn ? "Starting Featherlog…" : "正在启动羽记…";
                    }
                    return full.isEn ? "Offline · Click to Start" : "羽记未运行 · 点此启动";
                }
                if (full.focusedSlot) {
                    if (full.isEn) {
                        return "Focusing: " + full.focusedSlot.title + (full.slotCount > 1 ? (" (" + full.slotCount + " active slots)") : "");
                    }
                    return "正在做：" + full.focusedSlot.title + (full.slotCount > 1 ? ("（共 " + full.slotCount + " 个活跃槽位）") : "");
                }
                if (full.slotCount > 0) {
                    return full.isEn
                        ? (full.slotCount + " active work slots")
                        : ("当前有 " + full.slotCount + " 个活跃并发工作槽");
                }
                return full.isEn ? "Empty · Open Workbench" : "空槽 · 点此开工作台";
            }
        }

        Item {
            Layout.fillHeight: true
        }

        PlasmaComponents.Button {
            Layout.fillWidth: true
            text: !full.isConnected
                ? (full.isEn ? "Start Featherlog" : "启动羽记后台服务")
                : (full.isPanelOpen
                    ? (full.isEn ? "Hide Workbench" : "收起工作台")
                    : (full.isEn ? "Open Workbench" : "打开工作台"))
            onClicked: {
                if (full.plasmoidRoot) {
                    full.plasmoidRoot.toggleOrLaunchPanel();
                }
            }
        }
    }
}
