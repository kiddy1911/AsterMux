import Foundation

struct StatusInfo {
    let running: Bool
    let pid: Int?
    let uptimeSeconds: Int?
    let host: String?
    let port: Int?
    let version: String?
}

final class GatewayClient {
    private let config: Config
    private let session: URLSession

    init(config: Config) {
        self.config = config
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 3
        cfg.timeoutIntervalForResource = 3
        cfg.waitsForConnectivity = false
        self.session = URLSession(configuration: cfg)
    }

    func fetchStatus(completion: @escaping (StatusInfo?) -> Void) {
        let task = session.dataTask(with: config.statusURL) { data, _, _ in
            guard let data, let info = Self.parse(data) else {
                completion(nil)
                return
            }
            completion(info)
        }
        task.resume()
    }

    private static func parse(_ data: Data) -> StatusInfo? {
        guard
            let obj = try? JSONSerialization.jsonObject(with: data)
                as? [String: Any]
        else { return nil }
        return StatusInfo(
            running: obj["running"] as? Bool ?? false,
            pid: obj["pid"] as? Int,
            uptimeSeconds: obj["uptimeSeconds"] as? Int,
            host: obj["host"] as? String,
            port: obj["port"] as? Int,
            version: obj["version"] as? String
        )
    }
}
