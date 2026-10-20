// Source-tier registry + independence (§6.4). Tiers come from this
// maintained map, never from the model. Unknown domains are `other`.
import type { evidenceSourceTier } from "@credit/db/research";

export type SourceTier = (typeof evidenceSourceTier.enumValues)[number];

const OFFICIAL_SUFFIX = [".gov.uk", ".gov", ".europa.eu", ".fca.org.uk"];
const OFFICIAL_HOSTS = new Set([
	"find-and-update.company-information.service.gov.uk",
	"thegazette.co.uk",
]);

const REGISTRY_HOSTS = new Set([
	"companieshouse.gov.uk",
	"opencorporates.com",
	"suite.endole.co.uk",
]);

const REPUTABLE_NEWS_HOSTS = new Set([
	"bbc.co.uk",
	"bbc.com",
	"reuters.com",
	"ft.com",
	"theguardian.com",
	"independent.co.uk",
	"telegraph.co.uk",
	"sky.com",
	"channel4.com",
	"economist.com",
	"bloomberg.com",
]);

const REVIEW_PLATFORM_HOSTS = new Set([
	"trustpilot.com",
	"uk.trustpilot.com",
	"reviews.io",
	"g2.com",
	"feefo.com",
]);

export function tierForHost(host: string): SourceTier {
	const h = host.toLowerCase();
	if (OFFICIAL_HOSTS.has(h) || OFFICIAL_SUFFIX.some((s) => h.endsWith(s))) return "official";
	if (REGISTRY_HOSTS.has(h)) return "registry";
	if (REPUTABLE_NEWS_HOSTS.has(h) || h.endsWith(".bbc.co.uk")) return "reputable_news";
	if (REVIEW_PLATFORM_HOSTS.has(h) || h.endsWith(".trustpilot.com")) return "review_platform";
	return "other";
}

const TWO_PART_SUFFIX = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "co.jp", "co.nz"]);

/** Naive registrable domain (eTLD+1 for common suffixes). */
export function registrableDomain(host: string): string {
	const parts = host.toLowerCase().split(".").filter(Boolean);
	if (parts.length < 2) return host.toLowerCase();
	const last2 = parts.slice(-2).join(".");
	if (TWO_PART_SUFFIX.has(last2) && parts.length >= 3) return parts.slice(-3).join(".");
	return last2;
}

const SYNDICATION_RE = /syndicat|republish|\bvia (reuters|associated press|\bap\b)|distributed by/i;

/** Independence = distinct registrable domain + distinct snapshot hash + no syndication marker. */
export function isIndependent(
	a: { host: string; snapshotHash: string; title: string | null },
	b: { host: string; snapshotHash: string; title: string | null },
): boolean {
	if (registrableDomain(a.host) === registrableDomain(b.host)) return false;
	if (a.snapshotHash === b.snapshotHash) return false;
	if (a.title && SYNDICATION_RE.test(a.title)) return false;
	if (b.title && SYNDICATION_RE.test(b.title)) return false;
	return true;
}

/** Review platforms are capped at low and excluded from the two-source rule. */
export function countsTowardTwoSourceRule(tier: SourceTier): boolean {
	return tier === "official" || tier === "registry" || tier === "reputable_news";
}
