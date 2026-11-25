import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.kcmutils as KCM

KCM.SimpleKCM {
    id: configPage

    property alias cfg_apiPort: apiPortSpinBox.value
    property alias cfg_maxVisibleSlots: maxVisibleSlotsSpinBox.value
    property alias cfg_showTodayCount: showTodayCountCheckBox.checked
    property alias cfg_featherlogCommand: featherlogCommandField.text

    Kirigami.FormLayout {
        id: formLayout
        Layout.fillWidth: true

        Kirigami.Separator {
            Kirigami.FormData.isSection: true
            Kirigami.FormData.label: "外观与显示"
        }

        SpinBox {
            id: maxVisibleSlotsSpinBox
            Kirigami.FormData.label: "最多显示并发槽："
            from: 1
            to: 5
        }

        CheckBox {
            id: showTodayCountCheckBox
            Kirigami.FormData.label: "今日进度："
            text: "显示今日待办计数（完成/总数）"
        }

        Kirigami.Separator {
            Kirigami.FormData.isSection: true
            Kirigami.FormData.label: "本机连接与启动"
        }

        RowLayout {
            Kirigami.FormData.label: "本地 HTTP 端口："

            SpinBox {
                id: apiPortSpinBox
                from: 0
                to: 65535
                editable: true
            }

            Kirigami.ContextualHelpButton {
                toolTipText: "默认 39173。设为 0 或 39173 且未连接时，将自动回退探测开发端口 39174。"
            }
        }

        RowLayout {
            Kirigami.FormData.label: "启动命令："
            Layout.fillWidth: true

            TextField {
                id: featherlogCommandField
                Layout.fillWidth: true
                placeholderText: "featherlog"
            }

            Kirigami.ContextualHelpButton {
                toolTipText: "羽记守护进程未运行时，点击底栏将后台执行该命令启动并自动打开工作台。"
            }
        }
    }
}
