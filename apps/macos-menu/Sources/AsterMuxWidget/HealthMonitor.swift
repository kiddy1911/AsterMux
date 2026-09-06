import Foundation

enum HealthState {
    case unknown
    case offline
    case online(StatusInfo)
}

final class HealthMonitor {
    private let client: GatewayClient
    private let interval: TimeInterval
    private let onUpdate: (HealthState) -> Void
    private var timer: Timer?

    init(
        client: GatewayClient,
        interval: TimeInterval,
        onUpdate: @escaping (HealthState) -> Void
    ) {
        self.client = client
        self.interval = interval
        self.onUpdate = onUpdate
    }

    func start() {
        refreshNow()
        let t = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            self?.refreshNow()
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    func refreshNow() {
        client.fetchStatus { [weak self] info in
            DispatchQueue.main.async {
                guard let self else { return }
                if let info, info.running {
                    self.onUpdate(.online(info))
                } else {
                    self.onUpdate(.offline)
                }
            }
        }
    }
}
