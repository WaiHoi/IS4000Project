import { describe, expect, it } from "vitest";
import {
	buildSearchQuery,
	createStubTavilyClient,
	stubAcraLookup,
} from "../../src/agents/case-brief/index.js";

const envy = { name: "Envy Global Trading Pte. Ltd.", city: "Singapore", registrationNumber: null };
const opts = { maxResults: 5, endDate: "2026-01-01" };

describe("stub web services (--stub)", () => {
	it("serves the demo entity's pages for the queried category, then extracts them", async () => {
		const tavily = createStubTavilyClient();
		const adverse = await tavily.search(buildSearchQuery(envy, "adverse_media"), opts);
		expect(adverse).toHaveLength(2);
		const [page] = await tavily.extract([adverse[0]!.url]);
		expect(page?.rawContent).toContain("Envy Global Trading Pte. Ltd.");
		expect(await tavily.search(buildSearchQuery(envy, "registry"), opts)).toHaveLength(1);
	});

	it("returns nothing for unknown entities or pages after the as-of date", async () => {
		const tavily = createStubTavilyClient();
		const other = { ...envy, name: "Unknown Pte Ltd" };
		expect(await tavily.search(buildSearchQuery(other, "adverse_media"), opts)).toEqual([]);
		const early = { ...opts, endDate: "2024-01-01" };
		expect(await tavily.search(buildSearchQuery(envy, "adverse_media"), early)).toEqual([]);
	});

	it("looks up demo UENs in the canned ACRA registry", async () => {
		const record = await stubAcraLookup({ uen: "201941770r", entityName: "Envy" });
		expect(record?.status).toContain("Liquidation");
		expect(await stubAcraLookup({ uen: "000000000X", entityName: "x" })).toBeNull();
	});
});
