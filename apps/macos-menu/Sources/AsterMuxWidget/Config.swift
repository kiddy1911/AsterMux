import Foundation

struct Config {
    let host: String
    let port: Int
    let cliPath: String
    let pollIntervalSeconds: TimeInterval

    var statusURL: URL { URL(string: "http://\(host):\(port)/api/status")! }
    var dashboardURL: URL { URL(string: "http://\(host):\(port)/")! }

    static func load() -> Config {
        let env = ProcessInfo.processInfo.environment
        let host = env["ASTERMUX_HOST"] ?? "127.0.0.1"
        let port = Int(env["ASTERMUX_PORT"] ?? "") ?? 8787
        let defaultCli = "\(NSHomeDirectory())/.local/bin/astermux"
        let cli = env["ASTERMUX_WIDGET_CLI"] ?? defaultCli
        let interval = TimeInterval(env["ASTERMUX_WIDGET_INTERVAL"] ?? "") ?? 15
        return Config(
            host: host,
            port: port,
            cliPath: cli,
            pollIntervalSeconds: max(3, interval)
        )
    }
}
