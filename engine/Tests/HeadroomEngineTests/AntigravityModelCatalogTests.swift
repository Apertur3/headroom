import XCTest
@testable import CodexBarCore
@testable import headroom_engine

/// Synthetic model configs and quota buckets; no identity or live account data.
final class AntigravityModelCatalogTests: XCTestCase {
    private func identity(partial: Bool = false, quotaLess: Bool = false) throws -> AntigravityStatusSnapshot {
        let missingQuota = partial || quotaLess ? ", {\"label\":\"Synthetic Pending\",\"modelOrAlias\":{\"model\":\"\(partial ? "" : "synthetic-pending")\"}}" : ""
        let json = """
        {"userStatus":{"cascadeModelConfigData":{"clientModelConfigs":[
          {"label":"Synthetic Argon","modelOrAlias":{"model":"synthetic-argon"},"quotaInfo":{"remainingFraction":0.8}}
          \(missingQuota)
        ]}}}
        """
        return try AntigravityStatusProbe.parseUserStatusResponse(Data(json.utf8))
    }

    private func summary() -> AntigravityStatusSnapshot {
        let groups = ["Gemini Models", "Claude and GPT models"].enumerated().map { index, name in
            AntigravityQuotaSummaryGroup(displayName: name, description: nil, buckets: ["5h", "weekly"].map { window in
                AntigravityQuotaSummaryBucket(bucketId: "\(index == 0 ? "gemini" : "3p")-\(window)", displayName: window == "5h" ? "Five Hour Limit" : "Weekly Limit",
                    remainingFraction: 0.8, resetTime: nil, resetDescription: nil, disabled: false)
            })
        }
        return AntigravityStatusSnapshot(quotaSummary: AntigravityQuotaSummary(description: nil, groups: groups), accountEmail: nil, accountPlan: nil)
    }

    func testSyntheticSummaryPreservesModelsFromTheExistingIdentityReadAdditively() throws {
        let original = summary()
        let status = original.withIdentity(from: try identity())
        let usage = try status.toUsageSnapshot()
        let before = try original.toUsageSnapshot()
        XCTAssertEqual(HeadroomEngine.antigravityShape(usage), HeadroomEngine.antigravityShape(before))
        XCTAssertEqual(usage.extraRateWindows?.count, before.extraRateWindows?.count)
        // Existing recorder and quota conversion stay identical.
        XCTAssertTrue(status.modelQuotas.isEmpty)
        let facts = AntigravityPayloadFacts(status: status)
        XCTAssertEqual(facts.modelCatalog, [CatalogModel(id: "synthetic-argon", name: "Synthetic Argon")])
        let principal = Principal(id: "synthetic-agy", vendor: "antigravity", location: "agy")
        let rows = HeadroomEngine.antigravityWindows(principal, usage: usage, facts: facts)
        XCTAssertEqual(rows.count, 4)
        XCTAssertTrue(rows.allSatisfy { $0.metadata?.model_catalog == facts.modelCatalog })
        let json = String(decoding: try JSONEncoder().encode(rows), as: UTF8.self)
        XCTAssertTrue(json.contains("\"model_catalog\""))
        XCTAssertTrue(json.contains("Synthetic Argon"))
    }

    func testSyntheticModelDefinitionsWithoutPerModelQuotaStillJoinTheCompleteSummary() throws {
        let status = summary().withIdentity(from: try identity(quotaLess: true))
        let models = try XCTUnwrap(AntigravityPayloadFacts(status: status).modelCatalog)
        XCTAssertEqual(models.map(\.id), ["synthetic-argon", "synthetic-pending"])
        XCTAssertEqual(models.map(\.name), ["Synthetic Argon", "Synthetic Pending"])
        XCTAssertTrue(status.modelQuotas.isEmpty, "ordinary quota projection is unchanged")
    }

    func testSyntheticPartialOrFailedModelReadDoesNotSupplyACatalog() throws {
        XCTAssertNil(AntigravityPayloadFacts(status: summary().withIdentity(from: try identity(partial: true))).modelCatalog)
        XCTAssertNil(AntigravityPayloadFacts(status: summary().withIdentity(from: nil)).modelCatalog)
    }
}
