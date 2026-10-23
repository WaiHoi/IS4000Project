// D3a integration (real Postgres): seeded customer/accounts/transactions
// over the signed service-only context routes — candidate outputs, consent/
// draft gates, cross-app/account IDOR, date clamp + cursor bounds, the
// document-findings text strip, and context.read/denied audits.
import { randomUUID } from "node:crypto";
import { createDb } from "@credit/db";
import {
	applications,
	auditLog,
	customerAccounts,
	customerProfiles,
	customerTransactions,
	decisions,
	documentCrosschecks,
	documentFiles,
	documentFindings,
	externalReports,
	kycChecks,
} from "@credit/db/applications";
import { createLogger } from "@credit/service-kit";
import { stubGateway } from "@credit/service-kit/test";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { loadEnv } from "../../src/env.js";
import { createUser, signed, type TestContext, type TestUser } from "../helper.js";

process.env.LOG_LEVEL ??= "silent";

// Fixed case clock: submittedAt doubles as the context as-of, so the
// 6-month window is 2025-12-30 → 2026-06-30 whatever wall clock says.
const AS_OF = new Date("2026-06-30T00:00:00Z");
const T = (iso: string): Date => new Date(`${iso}T12:00:00Z`);

let ctx: TestContext;
let svc: TestUser;
let userA: TestUser;
let userB: TestUser;
let profileA: string;

let appA: string;
let appB: string;
let appNoConsent: string;
let appDraft: string;
let appNoProfile: string;

let acctA1: string;
let acctA2: string;
let acctA3: string;
let acctB1: string;

async function seedApp(
	user: TestUser,
	over: Partial<typeof applications.$inferSelect> = {},
): Promise<string> {
	const [row] = await ctx.db
		.insert(applications)
		.values({
			reference: `CTX-${randomUUID().slice(0, 8)}`,
			applicantUserId: user.id,
			type: "sme",
			product: "sme_term_loan",
			status: "submitted",
			amountCents: 5_000_000,
			termMonths: 36,
			purpose: "ctx integration",
			identity: { fullName: "Ctx Case", city: "Singapore" },
			business: { companyName: "Ctx Pte Ltd", monthlyFcfCents: 100_000 },
			consents: [true, true, true],
			contextAnalysisConsent: true,
			submittedAt: AS_OF,
			...over,
		})
		.returning({ id: applications.id });
	return row.id;
}

async function seedAccount(customerId: string): Promise<string> {
	const [row] = await ctx.db
		.insert(customerAccounts)
		.values({
			customerId,
			bankName: "Demo Bank",
			accountType: "business_current",
			maskedNumber: "****4242",
			currency: "SGD",
			status: "active",
			source: "demo_seed",
		})
		.returning({ id: customerAccounts.id });
	return row.id;
}

interface TxSeed {
	accountId: string;
	postedAt: Date;
	amountCents: number;
	balanceAfterCents: number;
	counterparty?: string | null;
	category?:
		| "income"
		| "transfer"
		| "payroll"
		| "loan"
		| "fee"
		| "purchase"
		| "cash"
		| "returned_payment"
		| "other";
	returned?: boolean;
}

async function seedTxs(txs: TxSeed[]): Promise<void> {
	if (txs.length === 0) return;
	await ctx.db.insert(customerTransactions).values(
		txs.map((t) => ({
			accountId: t.accountId,
			postedAt: t.postedAt,
			amountCents: t.amountCents,
			balanceAfterCents: t.balanceAfterCents,
			currency: "SGD",
			description: "seeded-tx",
			counterparty: t.counterparty ?? null,
			category: t.category ?? "transfer",
			returned: t.returned ?? false,
			source: "demo_seed" as const,
		})),
	);
}

async function get(path: string, user: TestUser): Promise<Response> {
	const bare = path.split("?")[0] as string;
	return await ctx.app.request(path, { headers: signed(ctx, user, "GET", bare) });
}

async function auditsFor(appId: string, action: string): Promise<number> {
	const rows = await ctx.db
		.select()
		.from(auditLog)
		.where(and(eq(auditLog.applicationId, appId), eq(auditLog.action, action)));
	return rows.length;
}

beforeAll(async () => {
	const env = loadEnv();
	const { db, sql } = createDb(env.databaseUrl);
	ctx = {
		app: createApp({ db, sql, env, gateway: stubGateway(), logger: createLogger("ctx-test") }),
		db,
		sql,
		gateway: stubGateway(),
		secret: env.internalSecret,
	};
	svc = await createUser(ctx, "service");
	userA = await createUser(ctx);
	userB = await createUser(ctx);

	const [prof] = await ctx.db
		.insert(customerProfiles)
		.values({
			userId: userA.id,
			segment: "sme",
			customerSince: "2019-03-01",
			kycStatus: "verified",
			kycVerifiedAt: new Date("2025-01-01T00:00:00Z"),
			kycExpiresAt: new Date("2028-01-01T00:00:00Z"),
			identity: { fullName: "Ctx Case", city: "Singapore" },
			business: { companyName: "Ctx Pte Ltd" },
			source: "demo_seed",
		})
		.returning({ id: customerProfiles.id });
	profileA = prof.id;

	const [profB] = await ctx.db
		.insert(customerProfiles)
		.values({
			userId: userB.id,
			segment: "individual",
			customerSince: "2021-06-01",
			kycStatus: "verified",
			kycVerifiedAt: new Date("2025-01-01T00:00:00Z"),
			kycExpiresAt: new Date("2028-01-01T00:00:00Z"),
			identity: { fullName: "Other Case", city: "Johor" },
			source: "demo_seed",
		})
		.returning({ id: customerProfiles.id });

	acctA1 = await seedAccount(profileA);
	acctA2 = await seedAccount(profileA);
	acctA3 = await seedAccount(profileA);
	acctB1 = await seedAccount(profB.id);

	// Anomaly mix on A1: 3 negative EOD days, a returned payment, two
	// same-amount in/out pairs, and a 2M inflow that breaks declared FCF.
	await seedTxs([
		{
			accountId: acctA1,
			postedAt: T("2026-01-05"),
			amountCents: -50_000,
			balanceAfterCents: -50_000,
		},
		{
			accountId: acctA1,
			postedAt: T("2026-01-06"),
			amountCents: 2_000_000,
			balanceAfterCents: 1_950_000,
			category: "income",
		},
		{
			accountId: acctA1,
			postedAt: T("2026-02-05"),
			amountCents: -60_000,
			balanceAfterCents: -60_000,
		},
		{
			accountId: acctA1,
			postedAt: T("2026-02-06"),
			amountCents: 100_000,
			balanceAfterCents: 40_000,
			category: "income",
		},
		{
			accountId: acctA1,
			postedAt: T("2026-03-05"),
			amountCents: -70_000,
			balanceAfterCents: -70_000,
		},
		{
			accountId: acctA1,
			postedAt: T("2026-03-06"),
			amountCents: 120_000,
			balanceAfterCents: 50_000,
			category: "income",
		},
		{
			accountId: acctA1,
			postedAt: T("2026-04-01"),
			amountCents: -77_700,
			balanceAfterCents: 60_000,
		},
		{
			accountId: acctA1,
			postedAt: T("2026-04-02"),
			amountCents: 77_700,
			balanceAfterCents: 137_700,
		},
		{
			accountId: acctA1,
			postedAt: T("2026-04-10"),
			amountCents: 77_700,
			balanceAfterCents: 215_400,
		},
		{
			accountId: acctA1,
			postedAt: T("2026-04-12"),
			amountCents: -77_700,
			balanceAfterCents: 137_700,
		},
		{
			accountId: acctA1,
			postedAt: T("2026-05-01"),
			amountCents: -5_000,
			balanceAfterCents: 132_700,
			returned: true,
		},
	]);

	// Bulk credits on A2 for the cursor pages: unique amounts, no
	// counterparties, positive balances — paging only, no new signals.
	await seedTxs(
		Array.from({ length: 600 }, (_, i) => ({
			accountId: acctA2,
			postedAt: new Date(Date.UTC(2026, 4, 1, 0, 0, i)),
			amountCents: 1000 + i,
			balanceAfterCents: 5_000_000 + i,
			category: "transfer" as const,
		})),
	);

	appA = await seedApp(userA);
	appB = await seedApp(userB);
	appNoConsent = await seedApp(userA, { contextAnalysisConsent: false });
	appDraft = await seedApp(userA, { status: "draft" as const, submittedAt: null });
	const loner = await createUser(ctx);
	appNoProfile = await seedApp(loner);
});

afterAll(async () => {
	await ctx.sql.end();
});

describe("context gates", () => {
	it("409s drafts with CASE_NOT_SUBMITTED and audits denied", async () => {
		const res = await get(`/internal/applications/${appDraft}/context/profile`, svc);
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"CASE_NOT_SUBMITTED",
		);
		expect(await auditsFor(appDraft, "context.denied")).toBeGreaterThan(0);
	});

	it("403s without context consent and audits denied", async () => {
		const res = await get(`/internal/applications/${appNoConsent}/context/accounts`, svc);
		expect(res.status).toBe(403);
		expect(await auditsFor(appNoConsent, "context.denied")).toBeGreaterThan(0);
	});

	it("rejects non-service roles", async () => {
		const applicant = await createUser(ctx);
		expect((await get(`/internal/applications/${appA}/context/profile`, applicant)).status).toBe(
			403,
		);
		const officer = await createUser(ctx, "officer");
		expect((await get(`/internal/applications/${appA}/context/profile`, officer)).status).toBe(403);
	});

	it("404s unknown applications", async () => {
		expect((await get(`/internal/applications/${randomUUID()}/context/profile`, svc)).status).toBe(
			404,
		);
	});
});

describe("profile/accounts/financials", () => {
	it("returns the allowlisted profile slice only", async () => {
		const res = await get(`/internal/applications/${appA}/context/profile`, svc);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual({
			applicationId: appA,
			asOf: AS_OF.toISOString(),
			customer: {
				segment: "sme",
				customerSince: "2019-03-01",
				kycStatus: "verified",
				kycVerifiedAt: "2025-01-01T00:00:00.000Z",
				kycExpiresAt: "2028-01-01T00:00:00.000Z",
			},
			city: "Singapore",
		});
		expect(await auditsFor(appA, "context.read")).toBeGreaterThan(0);
	});

	it("lists owned accounts without numbers or names", async () => {
		const res = await get(`/internal/applications/${appA}/context/accounts`, svc);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			accounts: Array<{ id: string; accountType: string; currency: string; status: string }>;
		};
		expect(body.accounts.map((a) => a.id).sort()).toEqual([acctA1, acctA2, acctA3].sort());
		for (const a of body.accounts) {
			expect(Object.keys(a).sort()).toEqual(["accountType", "currency", "id", "status"]);
		}
	});

	it("returns the declared financial block", async () => {
		const res = await get(`/internal/applications/${appA}/context/financials`, svc);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			business: { monthlyFcfCents: number };
			amountCents: number;
		};
		expect(body.business.monthlyFcfCents).toBe(100_000);
		expect(body.amountCents).toBe(5_000_000);
	});
});

describe("transactions paging", () => {
	it("pages 600 rows as 500 + 100 with an opaque cursor", async () => {
		const first = await get(
			`/internal/applications/${appA}/context/transactions?accountId=${acctA2}`,
			svc,
		);
		expect(first.status).toBe(200);
		const page1 = (await first.json()) as {
			window: { from: string; to: string };
			items: Array<{ id: string; postedAt: string }>;
			nextCursor: string;
		};
		expect(page1.items).toHaveLength(500);
		expect(typeof page1.nextCursor).toBe("string");
		expect(page1.window.from).toBe("2025-12-30T00:00:00.000Z");
		expect(page1.window.to).toBe(AS_OF.toISOString());

		const second = await get(
			`/internal/applications/${appA}/context/transactions?accountId=${acctA2}&cursor=${encodeURIComponent(page1.nextCursor)}`,
			svc,
		);
		expect(second.status).toBe(200);
		const page2 = (await second.json()) as { items: unknown[]; nextCursor: string | null };
		expect(page2.items).toHaveLength(100);
		expect(page2.nextCursor).toBeNull();

		// No third page: the 2-page cap ends the listing.
		const third = await get(
			`/internal/applications/${appA}/context/transactions?accountId=${acctA2}&cursor=${encodeURIComponent(page1.nextCursor)}`,
			svc,
		);
		expect(((await third.json()) as { items: unknown[] }).items).toHaveLength(100);
	});

	it("clamps caller windows to as-of/history, never widens", async () => {
		const res = await get(
			`/internal/applications/${appA}/context/transactions?accountId=${acctA1}&from=2020-01-01&to=2030-12-31`,
			svc,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { window: { from: string; to: string }; items: unknown[] };
		expect(body.window.from).toBe("2025-12-30T00:00:00.000Z");
		expect(body.window.to).toBe(AS_OF.toISOString());
		expect(body.items).toHaveLength(11);
	});

	it("rejects tampered, cross-account, and cross-window cursors", async () => {
		const first = (await (
			await get(`/internal/applications/${appA}/context/transactions?accountId=${acctA2}`, svc)
		).json()) as { nextCursor: string };
		const cursor = first.nextCursor;
		const tampered = cursor.slice(0, -1) + (cursor.endsWith("0") ? "1" : "0");
		expect(
			(
				await get(
					`/internal/applications/${appA}/context/transactions?accountId=${acctA2}&cursor=${encodeURIComponent(tampered)}`,
					svc,
				)
			).status,
		).toBe(400);
		// Same cursor bound to A2 cannot read A1.
		expect(
			(
				await get(
					`/internal/applications/${appA}/context/transactions?accountId=${acctA1}&cursor=${encodeURIComponent(cursor)}`,
					svc,
				)
			).status,
		).toBe(400);
		// Same cursor with a narrowed window does not match its binding.
		expect(
			(
				await get(
					`/internal/applications/${appA}/context/transactions?accountId=${acctA2}&from=2026-06-01&cursor=${encodeURIComponent(cursor)}`,
					svc,
				)
			).status,
		).toBe(400);
	});

	it("rejects a signature computed over path+query (HMAC signs pathname only)", async () => {
		// The research context tools sign the bare pathname and append the
		// query to the URL; `requireInternal` verifies `c.req.path`. A
		// caller that signs path+query must fail closed with 401.
		const url = `/internal/applications/${appA}/context/transactions?accountId=${acctA1}`;
		const res = await ctx.app.request(url, {
			headers: signed(ctx, svc, "GET", url),
		});
		expect(res.status).toBe(401);
		const metricsUrl = `/internal/applications/${appA}/context/metrics?accountIds=${acctA1}`;
		const res2 = await ctx.app.request(metricsUrl, {
			headers: signed(ctx, svc, "GET", metricsUrl),
		});
		expect(res2.status).toBe(401);
	});

	it("404s cross-application and cross-customer accounts (IDOR)", async () => {
		// B1 belongs to another customer: invisible from A's case.
		const cross = await get(
			`/internal/applications/${appA}/context/transactions?accountId=${acctB1}`,
			svc,
		);
		expect(cross.status).toBe(404);
		// A1 is real but belongs to another case: invisible from B's case.
		const crossApp = await get(
			`/internal/applications/${appB}/context/transactions?accountId=${acctA1}`,
			svc,
		);
		expect(crossApp.status).toBe(404);
		expect(await auditsFor(appA, "context.denied")).toBeGreaterThan(0);
		expect((await get(`/internal/applications/${appA}/context/transactions`, svc)).status).toBe(
			400,
		);
	});
});

describe("metrics", () => {
	it("returns the seeded candidate set with evidence IDs and no text", async () => {
		const res = await get(
			`/internal/applications/${appA}/context/metrics?accountIds=${acctA1}`,
			svc,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			accountIds: string[];
			policyVersion: string;
			signals: Array<{
				type: string;
				metric: string;
				observed: number | null;
				expected: number | null;
				confidence: string;
				status: string;
				policyVersion: string;
				accountScope: string;
				evidence: Array<{ kind: string; id: string }>;
				periodStart: string;
				periodEnd: string;
			}>;
		};
		expect(body.accountIds).toEqual([acctA1]);
		expect(body.policyVersion).toBe("context-metrics-v1");
		expect(body.signals.map((s) => s.type).sort()).toEqual(
			[
				"declared_vs_observed_cashflow",
				"negative_balance",
				"returned_payment",
				"round_trip",
			].sort(),
		);
		for (const signal of body.signals) {
			expect(signal.policyVersion).toBe("context-metrics-v1");
			expect(signal.accountScope).toBe(acctA1);
			expect(signal.status).toBe("review");
			expect(Object.keys(signal).sort()).toEqual(
				[
					"accountScope",
					"confidence",
					"evidence",
					"expected",
					"metric",
					"observed",
					"periodEnd",
					"periodStart",
					"policyVersion",
					"status",
					"type",
				].sort(),
			);
		}
		const negative = body.signals.find((s) => s.type === "negative_balance");
		expect(negative).toMatchObject({ observed: 3, expected: 0 });
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("seeded-tx");
	});

	it("scopes all accounts by default and degrades to insufficient_data", async () => {
		const all = (await (
			await get(`/internal/applications/${appA}/context/metrics`, svc)
		).json()) as {
			accountIds: string[];
			signals: Array<{ accountScope: string; type: string }>;
		};
		expect(all.accountIds.sort()).toEqual([acctA1, acctA2, acctA3].sort());
		expect(all.signals.every((s) => s.accountScope === "all")).toBe(true);

		const empty = (await (
			await get(`/internal/applications/${appA}/context/metrics?accountIds=${acctA3}`, svc)
		).json()) as { signals: Array<{ type: string; status: string }> };
		expect(empty.signals).toHaveLength(1);
		expect(empty.signals[0]).toMatchObject({
			type: "insufficient_data",
			status: "insufficient_data",
		});
	});

	it("caps account IDs and rejects foreign IDs", async () => {
		const many = Array.from({ length: 11 }, () => randomUUID()).join(",");
		expect(
			(await get(`/internal/applications/${appA}/context/metrics?accountIds=${many}`, svc)).status,
		).toBe(400);
		expect(
			(await get(`/internal/applications/${appA}/context/metrics?accountIds=${acctB1}`, svc))
				.status,
		).toBe(404);
		expect(
			(await get(`/internal/applications/${appB}/context/metrics?accountIds=${acctA1}`, svc))
				.status,
		).toBe(404);
	});

	it("returns insufficient_data when the applicant has no customer profile", async () => {
		const res = await get(`/internal/applications/${appNoProfile}/context/metrics`, svc);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { signals: Array<{ type: string }> };
		expect(body.signals.map((s) => s.type)).toEqual(["insufficient_data"]);
		expect((await get(`/internal/applications/${appNoProfile}/context/profile`, svc)).status).toBe(
			404,
		);
	});
});

describe("document-findings", () => {
	it("strips quotes/expected/observed/text, keeps null-file chase, drops deleted files", async () => {
		const [live] = await ctx.db
			.insert(documentFiles)
			.values({
				applicationId: appA,
				kind: "bank_statement",
				status: "ready",
				ocrStatus: "ready",
				mimeType: "application/pdf",
				sizeBytes: 64,
				sha256: `live-${randomUUID()}`,
				keyId: "v1",
				cryptoVersion: "v1",
				uploadedBy: userA.id,
				retentionUntil: new Date("2027-01-01T00:00:00Z"),
			})
			.returning({ id: documentFiles.id });
		const [dead] = await ctx.db
			.insert(documentFiles)
			.values({
				applicationId: appA,
				kind: "id",
				status: "deleted",
				ocrStatus: "ready",
				mimeType: "application/pdf",
				sizeBytes: 64,
				sha256: `dead-${randomUUID()}`,
				keyId: "v1",
				cryptoVersion: "v1",
				uploadedBy: userA.id,
				retentionUntil: new Date("2027-01-01T00:00:00Z"),
			})
			.returning({ id: documentFiles.id });
		const [cc] = await ctx.db
			.insert(documentCrosschecks)
			.values({
				applicationId: appA,
				status: "succeeded",
				validatorVersion: "document-crosscheck-v1",
				documentsChecked: [live.id],
				findingCount: 3,
				requestedBy: userA.id,
			})
			.returning({ id: documentCrosschecks.id });
		await ctx.db.insert(documentFindings).values([
			{
				crosscheckId: cc.id,
				applicationId: appA,
				documentFileId: live.id,
				field: "account_holder_name",
				expected: "SECRET-EXPECTED-1",
				observed: "SECRET-OBSERVED-1",
				pageNumber: 2,
				quote: "SECRET-QUOTE-1",
				quoteStart: 0,
				quoteEnd: 14,
				quoteHash: "hash-1",
				confidence: "high",
				status: "mismatch",
				reason: "value_mismatch",
			},
			{
				crosscheckId: cc.id,
				applicationId: appA,
				documentFileId: null,
				field: "other",
				confidence: "low",
				status: "needs_chase",
				reason: "needs_chase_unsupported_kind",
			},
			{
				crosscheckId: cc.id,
				applicationId: appA,
				documentFileId: dead.id,
				field: "other",
				confidence: "low",
				status: "needs_chase",
				reason: "needs_chase_deleted_source",
			},
		]);

		const res = await get(`/internal/applications/${appA}/context/document-findings`, svc);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			crosscheck: { id: string; status: string };
			findings: Array<Record<string, unknown>>;
		};
		expect(body.crosscheck).toEqual({ id: cc.id, status: "succeeded" });
		expect(body.findings).toHaveLength(2);
		for (const finding of body.findings) {
			expect(Object.keys(finding).sort()).toEqual(
				[
					"confidence",
					"documentFileId",
					"expected",
					"field",
					"id",
					"observed",
					"pageNumber",
					"reason",
					"status",
				].sort(),
			);
		}
		expect(body.findings.filter((f) => f["documentFileId"] === null)).toHaveLength(1);
		const mismatch = body.findings.find((f) => f["documentFileId"] === live.id);
		expect(mismatch).toMatchObject({
			field: "account_holder_name",
			status: "mismatch",
			expected: "SECRET-EXPECTED-1",
			observed: "SECRET-OBSERVED-1",
			reason: "value_mismatch",
		});
		const chase = body.findings.find((f) => f["documentFileId"] === null);
		expect(chase).toMatchObject({
			status: "needs_chase",
			expected: null,
			observed: null,
			reason: "needs_chase_unsupported_kind",
		});
		const serialized = JSON.stringify(body);
		for (const secret of ["quote", "quoteStart", "quoteEnd", "quoteHash", "SECRET-QUOTE-1"]) {
			expect(serialized).not.toContain(`"${secret}"`);
		}
	});

	it("returns a stale marker when the latest run failed, null when never run", async () => {
		await ctx.db.insert(documentCrosschecks).values({
			applicationId: appA,
			status: "failed",
			validatorVersion: "document-crosscheck-v1",
			documentsChecked: [],
			findingCount: 0,
			requestedBy: userA.id,
			finishedAt: new Date(),
			errorCode: "INTERNAL_ERROR",
		});
		const stale = (await (
			await get(`/internal/applications/${appA}/context/document-findings`, svc)
		).json()) as { findings: unknown[]; stale: boolean };
		expect(stale.findings).toEqual([]);
		expect(stale.stale).toBe(true);

		const never = (await (
			await get(`/internal/applications/${appB}/context/document-findings`, svc)
		).json()) as { crosscheck: null; findings: unknown[] };
		expect(never.crosscheck).toBeNull();
		expect(never.findings).toEqual([]);
	});

	it("caps unbounded crosscheck text at the route boundary and never leaks quotes", async () => {
		const longExpected = `E-${"x".repeat(500)}`;
		const longObserved = `O-${"y".repeat(500)}`;
		const longReason = `R-${"z".repeat(500)}`;
		const [live] = await ctx.db
			.insert(documentFiles)
			.values({
				applicationId: appB,
				kind: "bank_statement",
				status: "ready",
				ocrStatus: "ready",
				mimeType: "application/pdf",
				sizeBytes: 64,
				sha256: `long-${randomUUID()}`,
				keyId: "v1",
				cryptoVersion: "v1",
				uploadedBy: userA.id,
				retentionUntil: new Date("2027-01-01T00:00:00Z"),
			})
			.returning({ id: documentFiles.id });
		const [cc] = await ctx.db
			.insert(documentCrosschecks)
			.values({
				applicationId: appB,
				status: "succeeded",
				validatorVersion: "document-crosscheck-v1",
				documentsChecked: [live.id],
				findingCount: 1,
				requestedBy: userA.id,
			})
			.returning({ id: documentCrosschecks.id });
		await ctx.db.insert(documentFindings).values({
			crosscheckId: cc.id,
			applicationId: appB,
			documentFileId: live.id,
			field: "account_holder_name",
			expected: longExpected,
			observed: longObserved,
			pageNumber: 2,
			quote: "SECRET-QUOTE-LONG",
			quoteStart: 0,
			quoteEnd: 17,
			quoteHash: "SECRET-HASH-LONG",
			confidence: "high",
			status: "mismatch",
			reason: longReason,
		});

		const res = await get(`/internal/applications/${appB}/context/document-findings`, svc);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			findings: Array<{ expected: string; observed: string; reason: string }>;
		};
		const row = body.findings.find((f) => f.expected?.startsWith("E-"));
		expect(row?.expected).toHaveLength(200);
		expect(row?.observed).toHaveLength(200);
		expect(row?.reason).toHaveLength(200);
		const serialized = JSON.stringify(body);
		for (const secret of ["SECRET-QUOTE-LONG", "SECRET-HASH-LONG", "quoteHash", `"quote"`]) {
			expect(serialized).not.toContain(secret);
		}
	});
});

describe("financials identity", () => {
	it("includes reference, purpose, submittedAt, and status", async () => {
		const res = await get(`/internal/applications/${appA}/context/financials`, svc);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.applicationId).toBe(appA);
		expect(body.asOf).toBe(AS_OF.toISOString());
		expect(body.reference).toMatch(/^CTX-/);
		expect(body.purpose).toBe("ctx integration");
		expect(body.submittedAt).toBe(AS_OF.toISOString());
		expect(body.status).toBe("submitted");
		expect(body.type).toBe("sme");
		expect(body.product).toBe("sme_term_loan");
		expect(body.amountCents).toBe(5_000_000);
		expect(body.termMonths).toBe(36);
	});
});

describe("applicant", () => {
	it("returns the applicant user id to service callers only", async () => {
		const res = await get(`/internal/applications/${appA}/context/applicant`, svc);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ applicationId: appA, applicantUserId: userA.id });

		const applicant = await createUser(ctx);
		expect((await get(`/internal/applications/${appA}/context/applicant`, applicant)).status).toBe(
			403,
		);
		const officer = await createUser(ctx, "officer");
		expect((await get(`/internal/applications/${appA}/context/applicant`, officer)).status).toBe(
			403,
		);
	});
});

describe("credit-history", () => {
	it("returns same-applicant priors with code-only decisions, excluding others and drafts", async () => {
		const priorSubmittedAt = T("2026-01-15");
		const priorDecidedAt = new Date("2026-02-01T00:00:00Z");
		const priorA = await seedApp(userA, {
			submittedAt: priorSubmittedAt,
			decidedAt: priorDecidedAt,
		});
		await ctx.db.insert(decisions).values({
			applicationId: priorA,
			outcome: "approved",
			decidedBy: "officer",
			approvedAmountCents: 3_000_000,
			termMonths: 24,
			reasons: [{ code: "AFFORDABILITY_OK" }, "MANUAL_REVIEW_PASS", 42, { nope: 1 }, null],
			notes: "SECRET-DECISION-NOTES",
			snapshot: { secretSnapshot: true },
			decidedAt: priorDecidedAt,
		});
		// A prior decided after the case as-of is not yet knowable: the
		// application still lists, but its decision reads null.
		const futurePrior = await seedApp(userA, { submittedAt: T("2026-03-01") });
		await ctx.db.insert(decisions).values({
			applicationId: futurePrior,
			outcome: "declined",
			decidedBy: "officer",
			reasons: [{ code: "AFFORDABILITY_FAIL" }],
			notes: "SECRET-FUTURE-NOTES",
			snapshot: {},
			decidedAt: new Date("2026-12-01T00:00:00Z"),
		});
		const otherPrior = await seedApp(userB, { submittedAt: T("2026-01-20") });
		const draftPrior = await seedApp(userA, { status: "draft" as const, submittedAt: null });
		// Mixed future: the decision predates as-of but the application row
		// was decided after it — the whole prior reads unknown, so the
		// outcome cannot leak through the unmasked decision half.
		const mixedPrior = await seedApp(userA, {
			submittedAt: T("2026-02-15"),
			decidedAt: new Date("2026-12-15T00:00:00Z"),
		});
		await ctx.db.insert(decisions).values({
			applicationId: mixedPrior,
			outcome: "approved",
			decidedBy: "officer",
			reasons: [{ code: "AFFORDABILITY_OK" }],
			notes: "SECRET-MIXED-NOTES",
			snapshot: {},
			decidedAt: new Date("2026-03-01T00:00:00Z"),
		});

		const refOf = async (id: string): Promise<string> =>
			(
				await ctx.db
					.select({ reference: applications.reference })
					.from(applications)
					.where(eq(applications.id, id))
			)[0].reference;
		const [priorRef, otherRef, draftRef, appARef] = await Promise.all(
			[priorA, otherPrior, draftPrior, appA].map(refOf),
		);

		const res = await get(`/internal/applications/${appA}/context/credit-history`, svc);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			applicationId: string;
			asOf: string;
			priorApplications: Array<{
				reference: string;
				type: string;
				product: string;
				amountCents: number;
				termMonths: number;
				status: string;
				submittedAt: string;
				decidedAt: string | null;
				decision: null | {
					outcome: string;
					approvedAmountCents: number | null;
					termMonths: number | null;
					reasons: string[];
					decidedAt: string;
				};
			}>;
		};
		expect(body.applicationId).toBe(appA);
		expect(body.asOf).toBe(AS_OF.toISOString());
		const refs = body.priorApplications.map((p) => p.reference);
		expect(refs).toContain(priorRef);
		expect(refs).not.toContain(otherRef);
		expect(refs).not.toContain(draftRef);
		expect(refs).not.toContain(appARef);
		for (const p of body.priorApplications) {
			expect(p.status).not.toBe("draft");
			expect(new Date(p.submittedAt).getTime()).toBeLessThanOrEqual(AS_OF.getTime());
			expect(Object.keys(p).sort()).toEqual(
				[
					"amountCents",
					"decidedAt",
					"decision",
					"product",
					"reference",
					"status",
					"submittedAt",
					"termMonths",
					"type",
				].sort(),
			);
		}
		// Newest first, hard cap 10.
		const times = body.priorApplications.map((p) => p.submittedAt);
		expect([...times].sort().reverse()).toEqual(times);
		expect(body.priorApplications.length).toBeLessThanOrEqual(10);

		const prior = body.priorApplications.find((p) => p.reference === priorRef);
		expect(prior?.submittedAt).toBe(priorSubmittedAt.toISOString());
		expect(prior?.status).toBe("submitted");
		expect(prior?.decidedAt).toBe(priorDecidedAt.toISOString());
		expect(prior?.decision).toEqual({
			outcome: "approved",
			approvedAmountCents: 3_000_000,
			termMonths: 24,
			reasons: ["AFFORDABILITY_OK", "MANUAL_REVIEW_PASS"],
			decidedAt: expect.any(String),
		});
		const serialized = JSON.stringify(body);
		for (const secret of [
			"SECRET-DECISION-NOTES",
			"secretSnapshot",
			"notes",
			"snapshot",
			"SECRET-MIXED-NOTES",
		]) {
			expect(serialized).not.toContain(`"${secret}"`);
		}
		// Future decision: listed but undecided as of the case date.
		const futureRef = (
			await ctx.db
				.select({ reference: applications.reference })
				.from(applications)
				.where(eq(applications.id, futurePrior))
		)[0].reference;
		const future = body.priorApplications.find((p) => p.reference === futureRef);
		expect(future?.decision).toBeNull();
		// The future outcome leaks through neither the decision, the status,
		// nor the decided timestamp.
		expect(future?.status).toBe("unknown_at_as_of");
		expect(future?.decidedAt).toBeNull();
		expect(JSON.stringify(body)).not.toContain("SECRET-FUTURE-NOTES");
		// Mixed future: decided row predates as-of, application row does not.
		const mixedRef = (
			await ctx.db
				.select({ reference: applications.reference })
				.from(applications)
				.where(eq(applications.id, mixedPrior))
		)[0].reference;
		const mixed = body.priorApplications.find((p) => p.reference === mixedRef);
		expect(mixed?.status).toBe("unknown_at_as_of");
		expect(mixed?.decidedAt).toBeNull();
		expect(mixed?.decision).toBeNull();
	});
});

describe("external-reports", () => {
	it("returns the allowlisted bureau/bank summary and no raw payload", async () => {
		await ctx.db.insert(externalReports).values([
			{
				applicationId: appA,
				provider: "mock-bureau-v1",
				kind: "bureau",
				version: "mock-bureau-v1",
				payload: {
					bureauScore: 700,
					delinquencies: 1,
					utilizationPct: 30,
					inquiries6m: 2,
					secretSsn: "999-99-9999",
					rawXml: "<report/>",
				},
			},
			{
				applicationId: appA,
				provider: "mock-bank-v1",
				kind: "bank",
				version: "mock-bank-v1",
				payload: {
					monthlyInflowCents: 500_000,
					monthlyFreeCashFlowCents: 100_000,
					accountAgeYears: 5,
					balancesCents: [1, 2, 3],
					accountNumber: "SECRET-ACC",
				},
			},
		]);

		const res = await get(`/internal/applications/${appA}/context/external-reports`, svc);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			applicationId: string;
			asOf: string;
			reports: Array<{
				kind: string;
				provider: string;
				version: string;
				fetchedAt: string;
				summary: Record<string, number>;
			}>;
		};
		expect(body.applicationId).toBe(appA);
		expect(body.asOf).toBe(AS_OF.toISOString());
		expect(body.reports).toHaveLength(2);
		for (const r of body.reports) {
			expect(Object.keys(r).sort()).toEqual(
				["fetchedAt", "kind", "provider", "summary", "version"].sort(),
			);
		}
		expect(body.reports.find((r) => r.kind === "bureau")?.summary).toEqual({
			bureauScore: 700,
			delinquencies: 1,
			utilizationPct: 30,
			inquiries6m: 2,
		});
		expect(body.reports.find((r) => r.kind === "bank")?.summary).toEqual({
			monthlyInflowCents: 500_000,
			monthlyFreeCashFlowCents: 100_000,
			accountAgeYears: 5,
		});
		const serialized = JSON.stringify(body);
		for (const secret of [
			"secretSsn",
			"rawXml",
			"balancesCents",
			"accountNumber",
			"SECRET-ACC",
			"payload",
		]) {
			expect(serialized).not.toContain(`"${secret}"`);
		}
	});
});

describe("kyc-checks", () => {
	it("returns type/status only, never details", async () => {
		await ctx.db.insert(kycChecks).values([
			{ applicationId: appA, type: "identity", status: "passed", details: { mock: true } },
			{ applicationId: appA, type: "sanctions", status: "failed", details: { mock: true } },
		]);

		const res = await get(`/internal/applications/${appA}/context/kyc-checks`, svc);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			applicationId: string;
			asOf: string;
			checks: Array<Record<string, unknown>>;
		};
		expect(body.applicationId).toBe(appA);
		expect(body.asOf).toBe(AS_OF.toISOString());
		expect(body.checks).toEqual([
			{ type: "identity", status: "passed" },
			{ type: "sanctions", status: "failed" },
		]);
		const serialized = JSON.stringify(body);
		for (const secret of ["details", "mock"]) {
			expect(serialized).not.toContain(`"${secret}"`);
		}
	});
});
