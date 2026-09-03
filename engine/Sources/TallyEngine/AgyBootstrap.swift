import Foundation
import CodexBarCore

/// Cold `agy` starts bind their localhost HTTPS port well after the process is
/// visible. The Core's generic probe otherwise reports a misleading immediate
/// failure. This helper owns only the process it started and waits at most 30s.
enum AgyBootstrap {
    private static let attempts = 60
    private static let pollNanoseconds: UInt64 = 500_000_000

    static func fetch(binaryHint: String) async throws -> AntigravityStatusSnapshot {
        let binary = FileManager.default.isExecutableFile(atPath: binaryHint) ? binaryHint : "agy"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/script")
        process.arguments = ["-q", "/dev/null", binary]
        process.environment = ["HOME": NSHomeDirectory(), "PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"]
        let sink = Pipe()
        process.standardOutput = sink
        process.standardError = sink
        try process.run()
        defer {
            // `script` closes the PTY when its root exits; this is intentionally
            // limited to the process tree launched above, never a user-owned agy.
            if process.isRunning { process.terminate() }
        }
        for _ in 0..<attempts {
            guard process.isRunning else { throw EngineError.noUsage }
            let ports = agyListeningPorts(rootPID: process.processIdentifier)
            if !ports.isEmpty {
                // Port readiness is separate from API readiness; the Core owns
                // the short request retry and protocol parsing after this point.
                return try await AntigravityStatusProbe(timeout: 8).fetchFromPorts(ports)
            }
            try await Task.sleep(nanoseconds: pollNanoseconds)
        }
        throw EngineError.noUsage
    }

    private static func agyListeningPorts(rootPID: Int32) -> [Int] {
        let pids = [rootPID] + descendantPIDs(of: rootPID)
        let lsof = Process()
        lsof.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        lsof.arguments = ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pids.map(String.init).joined(separator: ",")]
        let output = Pipe()
        lsof.standardOutput = output
        lsof.standardError = Pipe()
        do { try lsof.run(); lsof.waitUntilExit() } catch { return [] }
        guard lsof.terminationStatus == 0,
              let text = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8),
              let expression = try? NSRegularExpression(pattern: #":(\d+)\s+\(LISTEN\)"#)
        else { return [] }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return expression.matches(in: text, range: range).compactMap { match in
            guard let portRange = Range(match.range(at: 1), in: text) else { return nil }
            return Int(text[portRange])
        }
    }

    private static func descendantPIDs(of root: Int32) -> [Int32] {
        var result: [Int32] = []
        var pending = [root]
        while let parent = pending.popLast() {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
            task.arguments = ["-P", String(parent)]
            let output = Pipe()
            task.standardOutput = output
            task.standardError = Pipe()
            guard (try? task.run()) != nil else { continue }
            task.waitUntilExit()
            let children = (String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "")
                .split(whereSeparator: \ .isNewline).compactMap { Int32($0) }
            result += children
            pending += children
        }
        return result
    }
}
