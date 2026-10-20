// Integration setup: real Postgres (credit_research via compose), fake
// agent runner + stub support judge — no model/Tavily/Grafana network.
// Hermetic observability: OTEL_SDK_DISABLED + no OTLP endpoint.
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

process.env.OTEL_SDK_DISABLED = "true";
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

import { randomUUID } from "node:crypto";
import { createDb } from "@credit/db/research";
import { createLogger, signInternalHeaders } from "@credit/service-kit";
import { stubAgentRunner, type FetchedEvidence } from "../src/agent.js";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { resetObservability } from "../src/observability.js";
import { stubLanguageRepair } from "../src/repair.js";
import { stubSupportJudge } from "../src/support.js";
import type { CaseFactsPayload } from "../src/lifecycle.js";

process.env.LOG_LEVEL ??= "silent";

export interface TestUser {
	id: string;
	email: string;
	role: "applicant" | "officer";
}

export interface TestContext {
	app: ReturnType<typeof createApp>;
	db: ReturnType<typeof createDb>["db"];
	sql: ReturnType<typeof createDb>["sql"];
	secret: string;
}

export const OFFICER: TestUser = {
	id: randomUUID(),
	email: "officer@example.com",
	role: "officer",
};
export const APPLICANT: TestUser = {
	id: randomUUID(),
	email: "applicant@example.com",
	role: "applicant",
};

export function user(role: "applicant" | "officer"): TestUser {
	return { id: randomUUID(), email: `svc-${randomUUID()}@example.com`, role };
}

/** Signed internal headers for `app.request`, as the P1b gateway would send. */
export function signed(
	ctx: TestContext,
	who: TestUser,
	method: string,
	path: string,
	extra: Record<string, string> = {},
	body?: string,
): Record<string, string> {
	return {
		...signInternalHeaders(ctx.secret, {
			userId: who.id,
			role: who.role,
			email: who.email,
			method,
			path,
			body,
		}),
		...extra,
	};
}

export interface BriefFixture {
	brief: unknown;
	fetched: FetchedEvidence[];
}

/** One official + one news source, quotes embedded in raw content. */
export function successFixture(): BriefFixture {
	const quoteA = "Acme Ltd filed accounts for the year ending March 2025 on time.";
	const quoteB = "Local paper notes Acme Ltd opened a second warehouse in Leeds.";
	// Model dates appear verbatim in the page text, so date verification
	// resolves them as publisher_metadata.
	const rawA = `Published 2025-06-01.\nheader\n${quoteA}\nfooter `.repeat(20);
	const rawB = `Published 2025-05-01.\nintro\n${quoteB}\nmore text here `.repeat(20);
	return {
		brief: {
			summary: "Registry shows timely filings; local press notes expansion.",
			findings: [
				{
					claim: "Acme Ltd filed accounts for the year ending March 2025 on time.",
					category: "registry",
					whyItMatters: "Timely filing is part of the public record.",
					allegationStatus: "unknown",
					entityMatch: {
						identifierType: "name_city",
						value: "Acme Ltd, Leeds",
						confidence: "medium",
					},
					evidenceLocalIds: ["ev-1"],
				},
				{
					claim: "Local paper notes Acme Ltd opened a second warehouse in Leeds.",
					category: "market",
					whyItMatters: "Expansion is context for the application.",
					allegationStatus: "unknown",
					entityMatch: {
						identifierType: "name_city",
						value: "Acme Ltd, Leeds",
						confidence: "medium",
					},
					evidenceLocalIds: ["ev-2"],
				},
			],
			evidence: [
				{
					localId: "ev-1",
					url: "https://find-and-update.company-information.service.gov.uk/company/123",
					title: "Acme Ltd filings",
					publisher: "Companies House",
					publishedAt: "2025-06-01",
					quote: quoteA,
				},
				{
					localId: "ev-2",
					url: "https://www.bbc.co.uk/news/acme-leeds",
					title: "Acme opens warehouse",
					publisher: "BBC",
					publishedAt: "2025-05-01",
					quote: quoteB,
				},
			],
			contradictions: [],
			unknowns: ["No adverse media found in the searched sources."],
			questionsForOfficer: [],
		},
		fetched: [
			{
				requestedUrl: "https://find-and-update.company-information.service.gov.uk/company/123",
				returnedUrl: "https://find-and-update.company-information.service.gov.uk/company/123",
				title: "Acme Ltd filings",
				searchPublishedDate: null,
				rawContent: rawA,
			},
			{
				requestedUrl: "https://www.bbc.co.uk/news/acme-leeds",
				returnedUrl: "https://www.bbc.co.uk/news/acme-leeds",
				title: "Acme opens warehouse",
				searchPublishedDate: null,
				rawContent: rawB,
			},
		],
	};
}

export function setupApp(
	fixture?: BriefFixture,
	overrides: {
		runner?: Parameters<typeof createApp>[0]["runner"];
		judge?: Parameters<typeof createApp>[0]["judge"];
		repair?: Parameters<typeof createApp>[0]["repair"];
		observability?: Parameters<typeof createApp>[0]["observability"];
	} = {},
): TestContext {
	resetObservability();
	const env = loadEnv();
	const { db, sql } = createDb(env.databaseUrl);
	const use = fixture ?? successFixture();
	const app = createApp({
		db,
		sql,
		env,
		logger: createLogger("research-test"),
		runner: overrides.runner ?? stubAgentRunner({ brief: use.brief, fetched: use.fetched }),
		judge: overrides.judge ?? stubSupportJudge(),
		repair: overrides.repair ?? stubLanguageRepair(),
		observability: overrides.observability ?? {
			status: "degraded",
			hooksFor: () => ({ detach: () => {} }),
			trackModelCall: (_opts, fn) => fn(),
			trackToolExecution: (_opts, fn) => fn(),
		},
	});
	return { app, db, sql, secret: env.internalSecret };
}

export function caseFacts(overrides: Partial<CaseFactsPayload> = {}): CaseFactsPayload {
	return {
		applicationId: randomUUID(),
		reference: "CR-2026-0001",
		type: "sme",
		product: "business_loan",
		amountCents: 500000,
		termMonths: 36,
		submittedAt: "2026-01-15T10:00:00.000Z",
		asOf: "2026-01-15T10:00:00.000Z",
		applicantName: "Jane Doe",
		companyName: "Acme Ltd",
		registrationNumber: "12345678",
		industry: "manufacturing",
		yearsTrading: 5,
		city: "Leeds",
		aiResearchConsent: true,
		status: "pending_review",
		...overrides,
	};
}

export async function teardown(ctx: TestContext): Promise<void> {
	await ctx.sql.end();
}
