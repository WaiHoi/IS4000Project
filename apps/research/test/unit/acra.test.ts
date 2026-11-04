// ACRA open-data lookup: letter-bucket dataset, UEN filter, best-effort
// failure, and the prompt/evidence text staying byte-identical.
import { describe, expect, it, vi } from "vitest";
import {
	buildAcraContext,
	lookupAcra,
	stubLanguageRepair,
	stubSupportJudge,
	validateAndBuild,
} from "../../src/agents/case-brief/index.js";

const envy = {
	uen: "201941770R",
	entity_name: "ENVY GLOBAL TRADING PTE. LTD.",
	entity_type_description: "Local Company",
	entity_status_description: "In Liquidation - Compulsory Winding Up (Insolvency)",
	registration_incorporation_date: "2019-12-10",
	primary_ssic_code: "46900",
	primary_ssic_description: "na",
	no_of_officers: "11",
};

function response(records: unknown[]): Response {
	return new Response(JSON.stringify({ success: true, result: { records } }), { status: 200 });
}

describe("lookupAcra", () => {
	it("queries the E dataset and maps the record", async () => {
		const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			expect(url).toContain("resource_id=d_124a9bd407c7a25f8335b93b86e50fdd");
			expect(url).toContain("201941770R");
			return response([envy]);
		});
		const record = await lookupAcra({
			uen: "201941770r",
			entityName: "Envy Global Trading Pte. Ltd.",
			fetchImpl,
		});
		expect(record).toMatchObject({
			uen: "201941770R",
			entityName: "ENVY GLOBAL TRADING PTE. LTD.",
			entityType: "Local Company",
			status: "In Liquidation - Compulsory Winding Up (Insolvency)",
			incorporationDate: "2019-12-10",
			ssicCode: "46900",
			ssicDescription: null,
			officers: 11,
			datasetUrl: "https://data.gov.sg/datasets/d_124a9bd407c7a25f8335b93b86e50fdd/view",
		});
		expect(record?.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("uses the Others dataset when the name does not start with A-Z", async () => {
		const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
			expect(String(input)).toContain("d_300ddc8da4e8f7bdc1bfc62d0d99e2e7");
			return response([]);
		});
		expect(await lookupAcra({ uen: "12345678", entityName: "3M Pte Ltd", fetchImpl })).toBeNull();
	});

	it("returns null on a miss, a failed response, or malformed JSON", async () => {
		const miss = await lookupAcra({
			uen: "CAFEAURC",
			entityName: "Cafe Aur",
			fetchImpl: async () => response([]),
		});
		expect(miss).toBeNull();
		const failed = await lookupAcra({
			uen: "201941770R",
			entityName: "Envy",
			fetchImpl: async () => new Response("down", { status: 503 }),
		});
		expect(failed).toBeNull();
		const malformed = await lookupAcra({
			uen: "201941770R",
			entityName: "Envy",
			fetchImpl: async () => new Response("not json", { status: 200 }),
		});
		expect(malformed).toBeNull();
	});
});

describe("buildAcraContext", () => {
	it("keeps the prompt text and evidence snapshot identical", async () => {
		const record = await lookupAcra({
			uen: "201941770R",
			entityName: "Envy Global Trading Pte. Ltd.",
			fetchImpl: async () => response([envy]),
		});
		expect(record).not.toBeNull();
		const context = buildAcraContext(record!);
		expect(context.block).toContain("Entity status: In Liquidation");
		expect(context.block).toContain("<registry_record id=");
		expect(context.evidence.rawContent).toBe(context.text);
		expect(context.evidence.requestedUrl).toBe(record!.datasetUrl);
		expect(context.evidence.searchPublishedDate).toBeNull();
	});
});

describe("ACRA evidence", () => {
	it("validates the registry quote as an official source", async () => {
		const record = await lookupAcra({
			uen: "201941770R",
			entityName: "Envy Global Trading Pte. Ltd.",
			fetchImpl: async () => response([envy]),
		});
		expect(record).not.toBeNull();
		const context = buildAcraContext(record!);
		const out = await validateAndBuild({
			brief: {
				summary: "ACRA records the entity as in compulsory winding up.",
				findings: [
					{
						claim: "ACRA records Envy Global Trading Pte. Ltd. as in compulsory winding up.",
						category: "registry",
						whyItMatters: "This is part of the public record.",
						allegationStatus: "unknown",
						entityMatch: {
							identifierType: "registration_number",
							value: "201941770R",
							confidence: "high",
						},
						evidenceLocalIds: ["acra"],
					},
				],
				evidence: [
					{
						localId: "acra",
						url: record!.datasetUrl,
						title: "ACRA record: Envy Global Trading Pte. Ltd.",
						publisher: "Accounting and Corporate Regulatory Authority (ACRA)",
						publishedAt: null,
						quote: "Entity status: In Liquidation - Compulsory Winding Up (Insolvency)",
					},
				],
				contradictions: [],
				unknowns: [],
				questionsForOfficer: [],
			},
			fetched: [context.evidence],
			entity: {
				kind: "sme",
				applicantName: "Envy Demo",
				companyName: "Envy Global Trading Pte. Ltd.",
				registrationNumber: "201941770R",
				city: "Singapore",
			},
			asOf: "2026-06-30",
			judge: stubSupportJudge(),
			repair: stubLanguageRepair(),
			runId: "acra-test",
		});
		expect(out.evidence).toHaveLength(1);
		expect(out.evidence[0]?.sourceTier).toBe("official");
		expect(out.findings).toHaveLength(1);
		expect(out.findings[0]?.confidence).toBe("high");
		expect(out.findings[0]?.entityMatch.confidence).toBe("high");
	});
});
