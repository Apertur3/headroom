import CodexBarCore
import Foundation

/// Redacted fixture recording for the Antigravity reader (`observe --record`).
///
/// This file never touches auth material: it only reads the already-parsed
/// `AntigravityStatusSnapshot` returned by the normal probe path. The output
/// is built from an allowlist of value types (`AntigravityRecordFile` and its
/// members). Anything not modelled there, including account e-mail, plan
/// names, user/project/installation IDs and the principal's own id, cannot
/// reach the file. String CONTENTS are constrained too: the file carries no
/// vendor or error free text. Labels and ids survive only when they match a
/// strict pattern (else "redacted"), descriptions are dropped unless purely
/// structured, and errors are a fixed code enum.
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
    var buckets: [AntigravityRecordBucket]
    var model_quotas: [AntigravityRecordModelQuota]
    /// A fixed `AntigravityRecordError` code, never vendor text.
    var error: String?
    /// Schema drift found while reading the snapshot, e.g. "missing field: groups".
    var extraction_errors: [String]

    enum CodingKeys: String, CodingKey {
        case principal, vendor, payload_kind, source, account, buckets, model_quotas, error, extraction_errors
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(principal, forKey: .principal)
        try c.encode(vendor, forKey: .vendor)
        try c.encode(payload_kind, forKey: .payload_kind)
        try c.encode(source, forKey: .source)
        try c.encode(account, forKey: .account)
        try c.encode(buckets, forKey: .buckets)
        try c.encode(model_quotas, forKey: .model_quotas)
        try c.encode(error, forKey: .error)
        try c.encode(extraction_errors, forKey: .extraction_errors)
    }
}

/// Fixed error vocabulary. Nothing from a thrown error's message is recorded.
enum AntigravityRecordError: String {
    case notRunning = "not_running"
    case missingCSRFToken = "missing_csrf_token"
    case portDetectionFailed = "port_detection_failed"
    case apiError = "api_error"
    case parseFailed = "parse_failed"
    case timedOut = "timed_out"
    case authenticationRequired = "authentication_required"
    case accountMismatch = "account_mismatch"
    case noStatus = "no_status"
    case vendorNotRecorded = "vendor_not_recorded"
    case other

    static func code(for error: Error) -> AntigravityRecordError {
        guard let probe = error as? AntigravityStatusProbeError else { return .other }
        switch probe {
        case .notRunning: return .notRunning
        case .missingCSRFToken: return .missingCSRFToken
        case .portDetectionFailed: return .portDetectionFailed
        case .apiError: return .apiError
        case .parseFailed: return .parseFailed
        case .timedOut: return .timedOut
        case .authenticationRequired: return .authenticationRequired
        case .accountMismatch: return .accountMismatch
        }
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
    var isLocal: Bool
    var buckets: [Bucket]
    var models: [Model]
    var extractionErrors: [String] = []
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
            buckets: input.buckets.enumerated().map { position, bucket in
                AntigravityRecordBucket(
                    group: bucketName(bucket.group, placeholder: "group-\(position + 1)"),
                    bucket_id: bucketName(bucket.bucketID, placeholder: "bucket-\(position + 1)"),
                    name: bucketName(bucket.displayName, placeholder: "bucket-\(position + 1)"),
                    disabled: bucket.disabled,
                    remaining_fraction: bucket.remainingFraction,
                    usage_known: !bucket.disabled && bucket.remainingFraction != nil,
                    reset_time: HeadroomEngine.iso(bucket.resetTime),
                    reset_description: structuredReset(bucket.resetDescription))
            },
            model_quotas: input.models.enumerated().map { position, model in
                AntigravityRecordModelQuota(
                    label: modelName(model.label, placeholder: "model-\(position + 1)"),
                    model_id: modelName(model.modelID, placeholder: "model-\(position + 1)"),
                    remaining_fraction: model.remainingFraction,
                    reset_time: HeadroomEngine.iso(model.resetTime),
                    reset_description: structuredReset(model.resetDescription))
            },
            error: nil,
            extraction_errors: input.extractionErrors)
    }

    static func failedRecord(index: Int, vendor: String, code: AntigravityRecordError) -> AntigravityRecordPrincipal {
        AntigravityRecordPrincipal(
            principal: "principal-\(index)", vendor: vendor, payload_kind: "none", source: nil,
            account: redactedMarker, buckets: [], model_quotas: [],
            error: code.rawValue, extraction_errors: [])
    }

    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }

    /// True for anything shaped like a secret or an id: long hex, UUID, JWT,
    /// long base64/alnum runs, `sk-` keys, long digit runs.
    private static func looksLikeToken(_ value: String) -> Bool {
        matches(value, #"[0-9A-Fa-f]{16,}"#)
            || matches(value, #"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}"#)
            || matches(value, #"[A-Za-z0-9+/_-]{20,}"#)
            || matches(value, #"[0-9]{9,}"#)
            || matches(value, #"(?i)eyJ|sk-|bearer|token|cookie|csrf|secret|password|session"#)
    }

    /// The bucket ids Antigravity is known to send (CodexBar probe and the
    /// Headroom adapter). The fixture only needs structure, so a bucket or
    /// group value is kept only when it equals one of these exactly.
    static let knownBucketIDs: Set<String> = ["gemini-5h", "gemini-weekly", "3p-5h", "3p-weekly", "cg-5h", "cg-weekly"]

    /// Known model-family prefixes (the families the probe recognises).
    static let knownModelPrefixes = ["gemini-", "claude-", "gpt-"]

    /// Bucket or group value: kept only if a known bucket id, else the
    /// positional placeholder. Human-readable names never survive.
    static func bucketName(_ value: String, placeholder: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return knownBucketIDs.contains(trimmed) ? trimmed : placeholder
    }

    /// Model id or label: kept only if it is a known-family model id (or a
    /// known bucket id) with no token shape, else the positional placeholder.
    static func modelName(_ value: String, placeholder: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if knownBucketIDs.contains(trimmed) { return trimmed }
        guard knownModelPrefixes.contains(where: { trimmed.hasPrefix($0) }),
              matches(trimmed, #"^[a-z0-9][a-z0-9.-]{1,47}$"#), !looksLikeToken(trimmed) else { return placeholder }
        return trimmed
    }

    /// Reset descriptions are kept only in the pure "Resets in 2d 3h" shape.
    /// Anything else is vendor free text and is dropped (null).
    static func structuredReset(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        return matches(trimmed, #"^[Rr]esets in( [0-9]{1,4} ?(d|h|m|s|days?|hours?|hrs?|minutes?|mins?|seconds?|secs?))+$"#) ? trimmed : nil
    }

    /// Reads the probe snapshot. `quotaSummary` is internal to CodexBarCore, so
    /// it is reached by reflection and only its allowlisted scalar members are
    /// copied out (never the whole object, and never the account fields).
    /// Reflection is fragile against upstream drift, so every expected member
    /// must be present with the expected type; each miss is reported in
    /// `extractionErrors` instead of defaulting to a plausible value.
    static func input(from status: AntigravityStatusSnapshot) -> AntigravityRecordInput {
        let models = status.modelQuotas.map {
            AntigravityRecordInput.Model(label: $0.label, modelID: $0.modelId, remainingFraction: $0.remainingFraction, resetTime: $0.resetTime, resetDescription: $0.resetDescription)
        }
        var result = extractSummary(from: status)
        result.models = models
        result.isLocal = status.source == .local
        return result
    }

    /// Reflection half of `input(from:)`, split out so tests can hand it a
    /// deliberately mismatched mirror type.
    static func extractSummary(from host: Any) -> AntigravityRecordInput {
        var out = AntigravityRecordInput(isQuotaSummary: false, isLocal: false, buckets: [], models: [])
        var errors: [String] = []
        guard let summary = member(host, "quotaSummary", &errors) else {
            out.extractionErrors = errors
            return out
        }
        guard let unwrapped = unwrap(summary) else { return out } // present and nil: not a quota summary
        out.isQuotaSummary = true
        _ = member(unwrapped, "description", &errors)
        var groupList: [Any] = []
        if let raw = member(unwrapped, "groups", &errors).flatMap(unwrap) {
            if let list = raw as? [Any] { groupList = list } else { errors.append("wrong type: groups") }
        }
        for group in groupList {
            let groupName = string(group, "displayName", &errors) ?? ""
            var bucketList: [Any] = []
            if let raw = member(group, "buckets", &errors).flatMap(unwrap) {
                if let list = raw as? [Any] { bucketList = list } else { errors.append("wrong type: buckets") }
            }
            for bucket in bucketList {
                out.buckets.append(.init(
                    group: groupName,
                    bucketID: string(bucket, "bucketId", &errors) ?? "",
                    displayName: string(bucket, "displayName", &errors) ?? "",
                    remainingFraction: optional(bucket, "remainingFraction", Double.self, &errors),
                    resetTime: optional(bucket, "resetTime", Date.self, &errors),
                    resetDescription: optional(bucket, "resetDescription", String.self, &errors),
                    // A missing `disabled` is drift, never "enabled": fail closed to true.
                    disabled: required(bucket, "disabled", Bool.self, &errors) ?? true))
            }
        }
        var seen = Set<String>()
        out.extractionErrors = errors.filter { seen.insert($0).inserted }
        return out
    }

    /// The stored property's value (possibly an Optional wrapper), or nil with
    /// an error recorded when the member does not exist.
    private static func member(_ value: Any, _ label: String, _ errors: inout [String]) -> Any? {
        guard let found = Mirror(reflecting: value).children.first(where: { $0.label == label }) else {
            errors.append("missing field: \(label)")
            return nil
        }
        return found.value
    }

    private static func required<T>(_ value: Any, _ label: String, _ type: T.Type, _ errors: inout [String]) -> T? {
        guard let raw = member(value, label, &errors) else { return nil }
        guard let typed = unwrap(raw) as? T else { errors.append("wrong type: \(label)"); return nil }
        return typed
    }

    private static func string(_ value: Any, _ label: String, _ errors: inout [String]) -> String? {
        required(value, label, String.self, &errors)
    }

    /// Member must exist; a nil value is legitimate, a non-nil wrong type is not.
    private static func optional<T>(_ value: Any, _ label: String, _ type: T.Type, _ errors: inout [String]) -> T? {
        guard let raw = member(value, label, &errors), let inner = unwrap(raw) else { return nil }
        guard let typed = inner as? T else { errors.append("wrong type: \(label)"); return nil }
        return typed
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

    /// Creates the file with mode 0600 from the first byte. O_EXCL (and no
    /// O_TRUNC) means an existing file is never touched, even with concurrent
    /// writers or a direct engine call.
    static func write(_ data: Data, to path: String) throws {
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, fileMode)
        guard fd >= 0 else { throw errno == EEXIST ? RecordError.exists : RecordError.cannotWrite }
        defer { close(fd) }
        guard fchmod(fd, fileMode) == 0 else { throw RecordError.cannotWrite }
        let written = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, data.count) }
        guard written == data.count else { throw RecordError.cannotWrite }
    }

    enum RecordError: Error { case cannotWrite, exists }

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
            guard let status = box.get() else { return failedRecord(index: index, vendor: "antigravity", code: .noStatus) }
            return principalRecord(index: index, input: input(from: status))
        } catch {
            return failedRecord(index: index, vendor: "antigravity", code: .code(for: error))
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
                records.append(failedRecord(index: index, vendor: principal.vendor == "codex" ? "codex" : "unknown", code: .vendorNotRecorded))
            }
        }
        // Deliberately no `ProviderCLISessionLifecycle.shutdownPersistentSessions()`
        // here. Record mode only calls `AntigravityStatusProbe.fetch()`, which
        // on macOS reads the process table via sysctl and talks to the already
        // running language server over localhost. It launches no agy session
        // (that is `AgyBootstrap`, used only by `observe`), so there is nothing
        // of ours to shut down, and the shutdown would create CodexBar's
        // `~/.codexbar/antigravity/agy-session.lock`, rewrite session records
        // and kill sessions owned by other tools.
        let file = AntigravityRecordFile(
            schema: 1,
            recorded_at: HeadroomEngine.iso(Date())!,
            engine_version: HeadroomEngine.engineVersion,
            probe_version: HeadroomEngine.upstreamVersion,
            principals: records)
        do {
            try write(try encode(file), to: outputPath)
        } catch RecordError.exists {
            FileHandle.standardError.write(Data("record: output file already exists; refusing to overwrite\n".utf8))
            return 4
        } catch {
            FileHandle.standardError.write(Data("record: could not write output file\n".utf8))
            return 4
        }
        let drifted = records.filter { !$0.extraction_errors.isEmpty }.count
        if drifted > 0 {
            FileHandle.standardError.write(Data("record: schema drift in \(drifted) principal(s); see extraction_errors in the output; do not use it as a fixture\n".utf8))
            return 5
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
