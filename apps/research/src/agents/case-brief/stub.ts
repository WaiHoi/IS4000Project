// Standalone mode (`pnpm start --stub`, EXTERNAL_STUBS=true): canned Tavily
// and ACRA responses so the case brief runs with no web access or Tavily key.
// Only the demo personas have pages; any other entity gets no results, which
// the brief reports as "nothing found" (not a real screen; env.ts refuses
// stubs in production). Company names/UENs are real public entities; page text
// and registry details are SYNTHETIC (marked), copied from the brief eval.
// ponytail: duplicates brief-eval's demo pages; share one copy if they drift.
import type { AcraLookup, AcraRecord } from "./acra.js";
import type { TavilyClient } from "./tavily.js";

interface StubPage {
	url: string;
	title: string;
	publishedDate: string;
	rawContent: string;
	/** Matched against the search query's CATEGORY_KEYWORDS. */
	keyword: string;
}

const ADVERSE = "fraud OR insolvency";
const REGISTRY = "company registration OR filing";

const PAGES: Record<string, StubPage[]> = {
	"breadtalk group pte. ltd.": [
		{
			keyword: ADVERSE,
			url: "https://www.businesstimes.com.sg/companies/breadtalk-new-outlets",
			title: "BreadTalk Group opens new outlets (synthetic fixture)",
			publishedDate: "2025-09-01",
			rawContent:
				"The Business Times, 2025-09-01.\nBreadTalk Group Pte. Ltd. of Singapore opened three new bakery outlets and said it plans further expansion in the coming year.",
		},
		{
			keyword: REGISTRY,
			url: "https://www.acra.gov.sg/breadtalk-200302045G",
			title: "ACRA record: BreadTalk Group Pte. Ltd. (synthetic fixture)",
			publishedDate: "2025-03-01",
			rawContent:
				"ACRA record, 2025-03-01.\nBreadTalk Group Pte. Ltd. (UEN 200302045G) is recorded as a live company.",
		},
	],
	"envy global trading pte. ltd.": [
		{
			keyword: ADVERSE,
			url: "https://www.straitstimes.com/singapore/courts-crime/envy-nickel-fraud",
			title: "Envy Global Trading director charged over nickel trading fraud (synthetic fixture)",
			publishedDate: "2024-05-10",
			rawContent:
				"The Straits Times, 2024-05-10.\nThe director of Envy Global Trading Pte. Ltd. was charged with fraud over a nickel trading scheme that police said involved about S$1.46 billion. The Singapore company is now in compulsory liquidation.",
		},
		{
			keyword: ADVERSE,
			url: "https://www.channelnewsasia.com/singapore/envy-nickel-scheme-investors",
			title:
				"Envy Global Trading director faces fraud charges; investors file claims (synthetic fixture)",
			publishedDate: "2024-06-02",
			rawContent:
				"CNA, 2024-06-02.\nThe director of Singapore-based Envy Global Trading Pte. Ltd. faces fraud charges linked to its nickel trading scheme, and investors have filed claims after the company was placed in compulsory liquidation. The Monetary Authority of Singapore said the company was not licensed to deal in capital markets products.",
		},
		{
			keyword: REGISTRY,
			url: "https://www.acra.gov.sg/envy-201941770R",
			title: "ACRA record: Envy Global Trading Pte. Ltd. (synthetic fixture)",
			publishedDate: "2025-01-15",
			rawContent:
				"ACRA record, 2025-01-15.\nEnvy Global Trading Pte. Ltd. (UEN 201941770R) is recorded as in compulsory liquidation.",
		},
	],
};

const ALL_PAGES = Object.values(PAGES).flat();

/** The entity is the first quoted phrase of buildSearchQuery's output. */
function entityOf(query: string): string {
	return (/^"([^"]*)"/.exec(query)?.[1] ?? "").trim().toLowerCase();
}

export function createStubTavilyClient(): TavilyClient {
	return {
		async search(query, { maxResults, endDate }) {
			return (PAGES[entityOf(query)] ?? [])
				.filter((p) => query.includes(p.keyword) && p.publishedDate <= endDate)
				.slice(0, maxResults)
				.map(({ url, title, publishedDate }) => ({ url, title, publishedDate }));
		},
		async extract(urls) {
			return ALL_PAGES.filter((p) => urls.includes(p.url)).map(({ url, rawContent }) => ({
				url,
				rawContent,
			}));
		},
	};
}

const ACRA: Record<string, Omit<AcraRecord, "retrievedAt">> = {
	"200302045G": {
		uen: "200302045G",
		entityName: "BREADTALK GROUP PTE. LTD.",
		entityType: "Local Company (synthetic fixture)",
		status: "Live Company",
		incorporationDate: "2003-03-05",
		ssicCode: "10710",
		ssicDescription: "MANUFACTURE OF BREAD, CAKES AND CONFECTIONERY",
		officers: 6,
		datasetUrl: "https://data.gov.sg/datasets/d_3a3807c023c61ddfba947dc069eb53f2/view",
	},
	"201941770R": {
		uen: "201941770R",
		entityName: "ENVY GLOBAL TRADING PTE. LTD.",
		entityType: "Local Company (synthetic fixture)",
		status: "In Liquidation - Compulsory Winding Up (Insolvency)",
		incorporationDate: "2019-12-17",
		ssicCode: "46100",
		ssicDescription: "WHOLESALE ON A FEE OR CONTRACT BASIS",
		officers: 2,
		datasetUrl: "https://data.gov.sg/datasets/d_124a9bd407c7a25f8335b93b86e50fdd/view",
	},
};

export const stubAcraLookup: AcraLookup = async ({ uen }) => {
	const record = ACRA[uen.trim().toUpperCase()];
	return record ? { ...record, retrievedAt: new Date().toISOString() } : null;
};
