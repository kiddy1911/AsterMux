import AppKit

final class MenuBarController {
    private let controller: GatewayController
    private let dashboardURL: URL
    private let statusItem: NSStatusItem
    private let menu = NSMenu()
    private var state: HealthState = .unknown
    var onRefresh: (() -> Void)?

    init(controller: GatewayController, dashboardURL: URL) {
        self.controller = controller
        self.dashboardURL = dashboardURL
        self.statusItem = NSStatusBar.system.statusItem(
            withLength: NSStatusItem.variableLength
        )
        self.statusItem.menu = menu
        applyTitle()
        rebuildMenu()
    }

    func update(state: HealthState) {
        self.state = state
        DispatchQueue.main.async { [weak self] in
            self?.applyTitle()
            self?.rebuildMenu()
        }
    }

    private func applyTitle() {
        let color: NSColor
        switch state {
        case .unknown: color = .systemGray
        case .offline: color = .systemRed
        case .online:  color = .systemGreen
        }
        statusItem.button?.attributedTitle = NSAttributedString(
            string: "\u{25CF}",
            attributes: [
                .foregroundColor: color,
                .font: NSFont.menuBarFont(ofSize: 0),
            ]
        )
        statusItem.button?.toolTip = "astermux"
    }

    private func rebuildMenu() {
        menu.removeAllItems()
        addStatusRows()
        menu.addItem(.separator())
        menu.addItem(action("Refresh Now", key: "r") { [weak self] in
            self?.onRefresh?()
        })
        menu.addItem(.separator())
        addControlRows()
        menu.addItem(.separator())
        menu.addItem(action("Open Dashboard\u{2026}", key: "d") { [weak self] in
            guard let self else { return }
            NSWorkspace.shared.open(self.dashboardURL)
        })
        menu.addItem(.separator())
        let quit = NSMenuItem(
            title: "Quit Widget",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        quit.target = NSApp
        menu.addItem(quit)
    }

    private func addStatusRows() {
        switch state {
        case .unknown:
            menu.addItem(info("Status: Checking\u{2026}"))
        case .offline:
            menu.addItem(info("Status: Offline"))
        case .online(let s):
            menu.addItem(info("Status: Running"))
            if let pid = s.pid { menu.addItem(info("PID: \(pid)")) }
            if let host = s.host, let port = s.port {
                menu.addItem(info("\(host):\(port)"))
            }
            if let up = s.uptimeSeconds {
                menu.addItem(info("Uptime: \(format(seconds: up))"))
            }
            if let v = s.version { menu.addItem(info("Version: \(v)")) }
        }
    }

    private func addControlRows() {
        switch state {
        case .online:
            menu.addItem(action("Stop", key: "x") { [weak self] in
                self?.runAction(.stop)
            })
            menu.addItem(action("Restart", key: "R") { [weak self] in
                self?.runAction(.restart)
            })
        case .offline, .unknown:
            menu.addItem(action("Start", key: "s") { [weak self] in
                self?.runAction(.start)
            })
        }
        menu.addItem(action("Rebuild", key: "b") { [weak self] in
            self?.runAction(.rebuild)
        })
        menu.addItem(action("Go to App Folder", key: "f") { [weak self] in
            self?.runAction(.folder)
        })
    }

    private func info(_ text: String) -> NSMenuItem {
        let item = NSMenuItem(title: text, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func action(
        _ title: String,
        key: String,
        handler: @escaping () -> Void
    ) -> NSMenuItem {
        let item = NSMenuItem(
            title: title,
            action: #selector(MenuActionTarget.fire(_:)),
            keyEquivalent: key
        )
        let target = MenuActionTarget(handler: handler)
        item.target = target
        item.representedObject = target
        return item
    }

    private func runAction(_ action: GatewayAction) {
        controller.run(action) { [weak self] result in
            if case .failure(let err) = result {
                DispatchQueue.main.async {
                    self?.showError(
                        title: "Failed to \(action.rawValue) gateway",
                        message: err.localizedDescription
                    )
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                self?.onRefresh?()
            }
        }
    }

    private func showError(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.runModal()
    }

    private func format(seconds: Int) -> String {
        let h = seconds / 3600
        let m = (seconds % 3600) / 60
        let s = seconds % 60
        if h > 0 { return "\(h)h \(m)m" }
        if m > 0 { return "\(m)m \(s)s" }
        return "\(s)s"
    }
}

private final class MenuActionTarget: NSObject {
    let handler: () -> Void
    init(handler: @escaping () -> Void) { self.handler = handler }
    @objc func fire(_ sender: Any?) { handler() }
}
