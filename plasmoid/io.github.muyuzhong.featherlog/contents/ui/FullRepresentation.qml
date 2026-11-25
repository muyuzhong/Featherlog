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
                text: "羽记 Featherlog"
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
                    return full.isLaunching ? "正在启动羽记守护进程…" : "羽记守护进程未运行";
                }
                if (full.focusedSlot) {
                    return "正在做：" + full.focusedSlot.title + (full.slotCount > 1 ? ("（共 " + full.slotCount + " 个活跃槽位）") : "");
                }
                if (full.slotCount > 0) {
                    return "当前有 " + full.slotCount + " 个活跃并发工作槽";
                }
                return "当前空闲，暂无活跃工作槽";
            }
        }

        Item {
            Layout.fillHeight: true
        }

        PlasmaComponents.Button {
            Layout.fillWidth: true
            text: !full.isConnected
                ? "启动并打开工作台"
                : (full.isPanelOpen ? "收起羽记工作台" : "打开羽记工作台")
            onClicked: {
                if (full.plasmoidRoot) {
                    full.plasmoidRoot.toggleOrLaunchPanel();
                }
            }
        }
    }
}
