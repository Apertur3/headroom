import CodexBarCore
import Foundation

/// Redacted fixture recording for the Antigravity reader (`observe --record`).
///
/// This file never touches auth material: it only reads the already-parsed
/// `AntigravityStatusSnapshot` returned by the normal probe path. The output
/// is built from an allowlist of value types (`AntigravityRecordFile` and its
/// members). Anything not modelled there, including account e-mail, plan
/// names, user/project/installation IDs and the principal's own id, cannot
/// reach the file. Free-text fields go through `HeadroomEngine.redact` and a
/// length cap as a second guard.
struct AntigravityRecordFile: Codable, Equatable {
    var schema: Int
    var recorded_at: String
    var engine_version: String
    var probe_version: String
    var principals: [AntigravityRecordPrincipal]
}

struct AntigravityRecordPrincipal: Codable, Equatable {
    var principal: String
    var vendor: String
    /// quota_summary | model_quota_fallback | availability_only | none
    var payload_kind: String
    /// local | remote
    var source: String?
    var account: String
    var summary_description: String?
    var buckets: [AntigravityRecordBucket]
    var model_quotas: [AntigravityRecordModelQuota]
    var error: String?

    enum CodingKeys: String, CodingKey {
        case principal, vendor, payload_kind, source, account, summary_description, buckets, model_quotas, error
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(principal, forKey: .principal)
        try c.encode(vendor, forKey: .vendor)
        try c.encode(payload_kind, forKey: .payload_kind)
        try c.encode(source, forKey: .source)
        try c.encode(account, forKey: .account)
        try c.encode(summary_description, forKey: .summary_description)
        try c.encode(buckets, forKey: .buckets)
        try c.encode(model_quotas, forKey: .model_quotas)
        try c.encode(error, forKey: .error)
    }
}

struct AntigravityRecordBucket: Codable, Equatable {
    var group: String
    var bucket_id: String
    var name: String
    var disabled: Bool
    /// null when the vendor sent no fraction. Encoded explicitly as null.
    var remaining_fraction: Double?
    /// `!disabled && remaining_fraction != nil`, the exact engine filter.
    var usage_known: Bool
    var reset_time: String?
    var reset_description: String?

    enum CodingKeys: String, CodingKey {
        case group, bucket_id, name, disabled, remaining_fraction, usage_known, reset_time, reset_description
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(group, forKey: .group)
        try c.encode(bucket_id, forKey: .bucket_id)
        try c.encode(name, forKey: .name)
        try c.encode(disabled, forKey: .disabled)
        try c.encode(remaining_fraction, forKey: .remaining_fraction)
        try c.encode(usage_known, forKey: .usage_known)
        try c.encode(reset_time, forKey: .reset_time)
        try c.encode(reset_description, forKey: .reset_description)
    }
}

struct AntigravityRecordModelQuota: Codable, Equatable {
    var label: String
    var model_id: String
    var remaining_fraction: Double?
    var reset_time: String?
    var reset_description: String?

    enum CodingKeys: String, CodingKey {
        case label, model_id, remaining_fraction, reset_time, reset_description
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(label, forKey: .label)
        try c.encode(model_id, forKey: .model_id)
        try c.encode(remaining_fraction, forKey: .remaining_fraction)
        try c.encode(reset_time, forKey: .reset_time)
        try c.encode(reset_description, forKey: .reset_description)
    }
}

/// Plain-value input for the recorder, so tests can build synthetic
/// snapshots without CodexBarCore's internal initialisers.
struct AntigravityRecordInput {
    struct Bucket {
        var group: String
        var bucketID: String
        var displayName: String
        var remainingFraction: Double?
        var resetTime: Date?
        var resetDescription: String?
        var disabled: Bool
    }
    struct Model {
        var label: String
        var modelID: String
        var remainingFraction: Double?
        var resetTime: Date?
        var resetDescription: String?
    }
    var isQuotaSummary: Bool
    var summaryDescription: String?
    var isLocal: Bool
    var buckets: [Bucket]
    var models: [Model]
}

enum AntigravityRecorder {
    static let redactedMarker = "redacted"
    static let fileMode: mode_t = 0o600

    static func principalRecord(index: Int, input: AntigravityRecordInput) -> AntigravityRecordPrincipal {
        let kind: String
        if input.isQuotaSummary {
            kind = "quota_summary"
        } else if input.models.isEmpty {
            kind = "none"
        } else if input.models.allSatisfy({ $0.remainingFraction == nil }) {
            kind = "availability_only"
        } else {
            kind = "model_quota_fallback"
        }
        return AntigravityRecordPrincipal(
            principal: "principal-\(index)",
            vendor: "antigravity",
            payload_kind: kind,
            source: input.isLocal ? "local" : "remote",
            account: redactedMarker,
            summary_description: input.summaryDescription.map(text),
            buckets: input.buckets.map { bucket in
                AntigravityRecordBucket(
                    group: text(bucket.group),
                    bucket_id: text(bucket.bucketID),
                    name: text(bucket.displayName),
                    disabled: bucket.disabled,
                    remaining_fraction: bucket.remainingFraction,
                    usage_known: !bucket.disabled && bucket.remainingFraction != nil,
                    reset_time: HeadroomEngine.iso(bucket.resetTime),
                    reset_description: bucket.resetDescription.map(text))
            },
            model_quotas: input.models.map { model in
                AntigravityRecordModelQuota(
                    label: text(model.label),
                    model_id: text(model.modelID),
                    remaining_fraction: model.remainingFraction,
                    reset_time: HeadroomEngine.iso(model.resetTime),
                    reset_description: model.resetDescription.map(text))
            },
            error: nil)
    }

    static func failedRecord(index: Int, vendor: String, message: String) -> AntigravityRecordPrincipal {
        AntigravityRecordPrincipal(
            principal: "principal-\(index)", vendor: vendor, payload_kind: "none", source: nil,
            account: redactedMarker, summary_description: nil, buckets: [], model_quotas: [],
            error: text(message))
    }

    static func text(_ value: String) -> String {
        HeadroomEngine.redact(value.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Reads the probe snapshot. `quotaSummary` is internal to CodexBarCore, so
    /// it is reached by reflection and only its allowlisted scalar members are
    /// copied out (never the whole object, and never the account fields).
    static func input(from status: AntigravityStatusSnapshot) -> AntigravityRecordInput {
        var buckets: [AntigravityRecordInput.Bucket] = []
        var description: String?
        var isSummary = false
        if let summary = child(status, "quotaSummary"), let unwrapped = unwrap(summary) {
            isSummary = true
            description = child(unwrapped, "description").flatMap(unwrap) as? String
            for group in (child(unwrapped, "groups").flatMap(unwrap) as? [Any]) ?? [] {
                let groupName = (child(group, "displayName").flatMap(unwrap) as? String) ?? ""
                for bucket in (child(group, "buckets").flatMap(unwrap) as? [Any]) ?? [] {
                    buckets.append(.init(
                        group: groupName,
                        bucketID: (child(bucket, "bucketId").flatMap(unwrap) as? String) ?? "",
                        displayName: (child(bucket, "displayName").flatMap(unwrap) as? String) ?? "",
                        remainingFraction: child(bucket, "remainingFraction").flatMap(unwrap) as? Double,
                        resetTime: child(bucket, "resetTime").flatMap(unwrap) as? Date,
                        resetDescription: child(bucket, "resetDescription").flatMap(unwrap) as? String,
                        disabled: (child(bucket, "disabled").flatMap(unwrap) as? Bool) ?? false))
                }
            }
        }
        let models = status.modelQuotas.map {
            AntigravityRecordInput.Model(label: $0.label, modelID: $0.modelId, remainingFraction: $0.remainingFraction, resetTime: $0.resetTime, resetDescription: $0.resetDescription)
        }
        return AntigravityRecordInput(isQuotaSummary: isSummary, summaryDescription: description, isLocal: status.source == .local, buckets: buckets, models: models)
    }

    private static func child(_ value: Any, _ label: String) -> Any? {
        Mirror(reflecting: value).children.first { $0.label == label }?.value
    }

    private static func unwrap(_ value: Any) -> Any? {
        let mirror = Mirror(reflecting: value)
        guard mirror.displayStyle == .optional else { return value }
        return mirror.children.first?.value
    }

    static func encode(_ file: AntigravityRecordFile) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(file) + Data("\n".utf8)
    }

    /// Creates the file with mode 0600 from the first byte (never widened then
    /// narrowed) and re-asserts the mode in case the file already existed.
    static func write(_ data: Data, to path: String) throws {
        let fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, fileMode)
        guard fd >= 0 else { throw RecordError.cannotWrite }
        defer { close(fd) }
        guard fchmod(fd, fileMode) == 0 else { throw RecordError.cannotWrite }
        let written = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, data.count) }
        guard written == data.count else { throw RecordError.cannotWrite }
    }

    enum RecordError: Error { case cannotWrite }

    /// Runs the engine's normal wait/probe path for one principal and returns
    /// the record. The fetch closure keeps the last parsed status alongside the
    /// usual `AntigravitySnapshotFetch`, so the readiness rules are unchanged.
    static func record(index: Int) async -> AntigravityRecordPrincipal {
        let box = StatusBox()
        do {
            _ = try await AntigravitySnapshotWaiter.wait(
                timeout: 30,
                pollNanoseconds: 1_500_000_000,
                fetch: { remaining in
                    let status = try await AntigravityStatusProbe(timeout: min(8, remaining)).fetch()
                    let fetch = try AntigravitySnapshotFetch(status: status)
                    box.set(status)
                    return fetch
                })
            guard let status = box.get() else { return failedRecord(index: index, vendor: "antigravity", message: "no status returned") }
            return principalRecord(index: index, input: input(from: status))
        } catch {
            return failedRecord(index: index, vendor: "antigravity", message: error.localizedDescription)
        }
    }

    /// Entry point for `observe --principals <json> --record <out>`. Prints a
    /// count only; never a path, id or payload.
    static func run(principals: [Principal], outputPath: String) async -> Int32 {
        var records: [AntigravityRecordPrincipal] = []
        for (index, raw) in principals.enumerated() {
            let principal = HeadroomEngine.safePrincipal(raw)
            if principal.vendor == "antigravity" {
                records.append(await record(index: index))
            } else {
                records.append(failedRecord(index: index, vendor: principal.vendor == "codex" ? "codex" : "unknown", message: "vendor not recorded"))
            }
        }
        await ProviderCLISessionLifecycle.shutdownPersistentSessions()
        let file = AntigravityRecordFile(
            schema: 1,
            recorded_at: HeadroomEngine.iso(Date())!,
            engine_version: HeadroomEngine.engineVersion,
            probe_version: HeadroomEngine.upstreamVersion,
            principals: records)
        do {
            try write(try encode(file), to: outputPath)
        } catch {
            FileHandle.standardError.write(Data("record: could not write output file\n".utf8))
            return 4
        }
        let usable = records.filter { $0.vendor == "antigravity" && $0.error == nil }.count
        FileHandle.standardOutput.write(Data("recorded \(usable) antigravity principal(s)\n".utf8))
        return usable > 0 ? 0 : 3
    }
}

private final class StatusBox: @unchecked Sendable {
    private let lock = NSLock()
    private var status: AntigravityStatusSnapshot?
    func set(_ value: AntigravityStatusSnapshot) { lock.lock(); status = value; lock.unlock() }
    func get() -> AntigravityStatusSnapshot? { lock.lock(); defer { lock.unlock() }; return status }
}
