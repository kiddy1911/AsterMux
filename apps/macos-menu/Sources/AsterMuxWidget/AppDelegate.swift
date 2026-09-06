import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var menuBar: MenuBarController?
    private var monitor: HealthMonitor?

    func applicationDidFinishLaunching(_ notification: Notification) {
        Log.info("widget starting")
        let config = Config.load()
        let shellEnv = ShellEnvironment.discover()
        Log.info("shell PATH resolved (\(shellEnv.path.split(separator: ":").count) dirs)")
        if let node = shellEnv.nodePath {
            Log.info("node resolved: \(node)")
        } else {
            Log.error("node not found in PATH — start/restart will fail until ASTERMUX_NODE is set")
        }
        let client = GatewayClient(config: config)
        let controller = GatewayController(config: config, shellEnv: shellEnv)
        let menuBar = MenuBarController(
            controller: controller,
            dashboardURL: config.dashboardURL
        )
        let monitor = HealthMonitor(
            client: client,
            interval: config.pollIntervalSeconds
        ) { state in
            menuBar.update(state: state)
        }
        menuBar.onRefresh = { [weak monitor] in monitor?.refreshNow() }
        self.menuBar = menuBar
        self.monitor = monitor
        monitor.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        monitor?.stop()
        Log.info("widget exiting")
    }
}
