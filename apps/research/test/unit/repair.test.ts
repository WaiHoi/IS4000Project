// Language-repair unit tests: fake OpenAI client, no network.
import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import {
	createLlmLanguageRepair,
	RepairRejectedError,
	stubLanguageRepair,
} from "../../src/repair.js";
import type { ModelBrief } from "../../src/validator.js";

function modelBrief(): ModelBrief {
	return {
		summary: "Registry shows timely filings; the loan terms look fine.",
		findings: [
			{
				claim: "Acme Ltd filed accounts for the year ending March 2025 on time.",
				category: "registry",
				whyItMatters: "Timely filing supports approval.",
				allegationStatus: "unknown",
				entityMatch: {
					identifierType: "name_city",
					value: "Acme Ltd, Leeds",
					confidence: "medium",
				},
				evidenceLocalIds: ["ev-1"],
			},
		],
		evidence: [
			{
				localId: "ev-1",
				url: "https://find-and-update.company-information.service.gov.uk/company/123",
				title: "Filings",
				publisher: "Companies House",
				publishedAt: "2025-06-01",
				quote: "Acme Ltd filed accounts for the year ending March 2025 on time.",
			},
		],
		contradictions: [],
		unknowns: ["No adverse media found in the searched sources."],
		questionsForOfficer: [],
	};
}

interface RecordedCall {
	params: Record<string, unknown>;
}

function fakeOpenai(reply: unknown, recorded: RecordedCall[]): OpenAI {
	return {
		chat: {
			completions: {
				create: async (params: Record<string, unknown>) => {
					recorded.push({ params });
					return {
						choices: [
							{ message: { content: typeof reply === "string" ? reply : JSON.stringify(reply) } },
						],
						usage: { prompt_tokens: 10, completion_tokens: 5 },
					};
				},
			},
		},
	} as unknown as OpenAI;
}

describe("createLlmLanguageRepair", () => {
	it("rewrites only summary/claim/whyItMatters and preserves everything else", async () => {
		const recorded: RecordedCall[] = [];
		const repair = createLlmLanguageRepair(
			fakeOpenai(
				{
					summary: "Registry shows timely filings in the public record.",
					findings: [
						{
							claim: "Acme Ltd filed accounts for the year ending March 2025 on time.",
							whyItMatters: "Timely filing is part of the public record.",
						},
					],
				},
				recorded,
			),
			"deepseek/deepseek-v4.1-flash-1017",
		);
		const before = modelBrief();
		const out = await repair(before);
		expect(recorded).toHaveLength(1);
		const params = recorded[0].params as Record<string, unknown>;
		expect(params.model).toBe("deepseek/deepseek-v4.1-flash-1017");
		expect(params.temperature).toBe(0);
		expect(params.response_format).toEqual({ type: "json_object" });
		expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
		expect(out.brief.summary).toBe("Registry shows timely filings in the public record.");
		expect(out.brief.findings[0].whyItMatters).toBe("Timely filing is part of the public record.");
		// Untouched: evidence, citations, contradictions, unknowns, questions.
		expect(out.brief.evidence).toEqual(before.evidence);
		expect(out.brief.findings[0].evidenceLocalIds).toEqual(["ev-1"]);
		expect(out.brief.contradictions).toEqual(before.contradictions);
		expect(out.brief.unknowns).toEqual(before.unknowns);
		expect(out.brief.questionsForOfficer).toEqual(before.questionsForOfficer);
	});

	it("rejects a reply that changes the finding count", async () => {
		const recorded: RecordedCall[] = [];
		const repair = createLlmLanguageRepair(
			fakeOpenai({ summary: "Clean.", findings: [] }, recorded),
			"deepseek/deepseek-v4.1-flash-1017",
		);
		await expect(repair(modelBrief())).rejects.toBeInstanceOf(RepairRejectedError);
	});

	it("rejects invalid JSON", async () => {
		const recorded: RecordedCall[] = [];
		const repair = createLlmLanguageRepair(
			fakeOpenai("not json", recorded),
			"deepseek/deepseek-v4.1-flash-1017",
		);
		await expect(repair(modelBrief())).rejects.toBeInstanceOf(RepairRejectedError);
	});
});

describe("stubLanguageRepair", () => {
	it("passes through by default and counts calls", async () => {
		const stub = stubLanguageRepair();
		const brief = modelBrief();
		const out = await stub(brief);
		expect(out.brief).toBe(brief);
		expect(stub.calls).toBe(1);
	});
});
