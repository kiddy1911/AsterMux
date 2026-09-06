import Foundation

enum GatewayAction: String {
    case start
    case stop
    case restart
    case rebuild
    case folder
}

struct GatewayControllerError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

final class GatewayController {
    private let config: Config
    private let shellEnv: ShellEnvironment

    init(config: Config, shellEnv: ShellEnvironment) {
        self.config = config
        self.shellEnv = shellEnv
    }

    func run(
        _ action: GatewayAction,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let output = try self.spawn(action)
                completion(.success(output))
            } catch {
                Log.error("\(action.rawValue) failed: \(error.localizedDescription)")
                completion(.failure(error))
            }
        }
    }

    private func spawn(_ action: GatewayAction) throws -> String {
        guard FileManager.default.isExecutableFile(atPath: config.cliPath) else {
            throw GatewayControllerError(
                message: "CLI not found or not executable:\n\(config.cliPath)"
            )
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: config.cliPath)
        process.arguments = [action.rawValue]
        process.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        process.environment = shellEnv.apply(
            to: ProcessInfo.processInfo.environment
        )
        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        try process.run()
        process.waitUntilExit()

        let stdout = readAll(outPipe)
        let stderr = readAll(errPipe)
        if process.terminationStatus != 0 {
            throw GatewayControllerError(
                message: errorMessage(
                    code: Int(process.terminationStatus),
                    stdout: stdout,
                    stderr: stderr
                )
            )
        }
        return stdout.isEmpty ? stderr : stdout
    }

    private func readAll(_ pipe: Pipe) -> String {
        var data = Data()
        if let payload = (try? pipe.fileHandleForReading.readToEnd()) ?? nil {
            data = payload
        }
        return String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private func errorMessage(code: Int, stdout: String, stderr: String) -> String {
        let detail = !stderr.isEmpty ? stderr : (stdout.isEmpty ? "(no output)" : stdout)
        return "CLI exited with status \(code).\n\n\(detail)"
    }
}
