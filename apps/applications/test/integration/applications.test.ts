// Applications-service integration (compose Postgres, fake gateway):
// signed submit + idempotency + 3-active limit, list/detail scoping,
// unsigned requests rejected with 401.
import { randomUUID } from "node:crypto";
import { generateReference } from "@credit/core";
import { applications } from "@credit/db/applications";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createUser,
	individualPayload,
	setupApp,
	signed,
	type TestContext,
	teardown,
} from "../helper.js";

let ctx: TestContext;

beforeAll(() => {
	ctx = setupApp();
});

afterAll(async () => {
	await teardown(ctx);
});

async function jsonBody<T>(res: Response): Promise<T> {
	return (await res.json()) as T;
}

async function postApplication(
	user: { id: string; email: string; role: "applicant" | "officer" | "service" },
	payload: unknown,
	key: string,
) {
	const path = "/api/applications";
	const body = JSON.stringify(payload);
	return ctx.app.request(path, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...signed(ctx, user, "POST", path, { "Idempotency-Key": key }, body),
		},
		body,
	});
}

describe("POST /api/applications", () => {
	it("signed applicant can submit; same key replays, changed payload is 409", async () => {
		const user = await createUser(ctx);
		const key = randomUUID();
		const payload = individualPayload(user.email);
		const first = await postApplication(user, payload, key);
		expect(first.status).toBe(201);
		const firstBody = await jsonBody<{ id: string; reference: string }>(first);
		expect(firstBody.reference).toMatch(/^APP-\d{4}-[A-Z2-7]{6}$/);
		expect(ctx.gateway.started).toContain(firstBody.id);

		const replay = await postApplication(user, payload, key);
		expect(replay.status).toBe(201);
		expect((await jsonBody<{ id: string }>(replay)).id).toBe(firstBody.id);

		const changed = await postApplication(user, { ...payload, amountCents: 1300000 }, key);
		expect(changed.status).toBe(409);
		expect((await jsonBody<{ error: { code: string } }>(changed)).error.code).toBe(
			"IDEMPOTENCY_CONFLICT",
		);
	});

	it("the 4th non-terminal application is 409", async () => {
		const user = await createUser(ctx);
		for (let i = 0; i < 3; i++) {
			const res = await postApplication(user, individualPayload(user.email), randomUUID());
			expect(res.status).toBe(201);
		}
		const fourth = await postApplication(user, individualPayload(user.email), randomUUID());
		expect(fourth.status).toBe(409);
		expect((await jsonBody<{ error: { code: string } }>(fourth)).error.code).toBe(
			"TOO_MANY_APPLICATIONS",
		);
	});

	it("unsigned requests are 401 and officers cannot submit", async () => {
		const user = await createUser(ctx);
		const unsigned = await ctx.app.request("/api/applications", {
			method: "POST",
			headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
			body: JSON.stringify(individualPayload(user.email)),
		});
		expect(unsigned.status).toBe(401);

		const officer = await createUser(ctx, "officer");
		const denied = await postApplication(officer, individualPayload(officer.email), randomUUID());
		expect(denied.status).toBe(403);
	});
});

describe("list/detail scoping", () => {
	it("applicants see only their own; officers see all", async () => {
		const a = await createUser(ctx);
		const b = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const created = await postApplication(a, individualPayload(a.email), randomUUID());
		expect(created.status).toBe(201);
		const { id } = await jsonBody<{ id: string }>(created);

		const listPath = "/api/applications";
		const own = await ctx.app.request(listPath, { headers: signed(ctx, a, "GET", listPath) });
		expect(own.status).toBe(200);
		expect(
			(await jsonBody<{ items: Array<{ id: string }> }>(own)).items.map((i) => i.id),
		).toContain(id);

		const other = await ctx.app.request(listPath, { headers: signed(ctx, b, "GET", listPath) });
		expect(other.status).toBe(200);
		expect(
			(await jsonBody<{ items: Array<{ id: string }> }>(other)).items.map((i) => i.id),
		).not.toContain(id);

		const all = await ctx.app.request(listPath, { headers: signed(ctx, officer, "GET", listPath) });
		expect(all.status).toBe(200);
		expect(
			(await jsonBody<{ items: Array<{ id: string }> }>(all)).items.map((i) => i.id),
		).toContain(id);

		const unsigned = await ctx.app.request(listPath);
		expect(unsigned.status).toBe(401);
	});

	it("officer cross-read is allowed, applicant cross-read is 404, detail omits the loan", async () => {
		const a = await createUser(ctx);
		const b = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const created = await postApplication(a, individualPayload(a.email), randomUUID());
		const { id } = await jsonBody<{ id: string }>(created);
		const path = `/api/applications/${id}`;

		const cross = await ctx.app.request(path, { headers: signed(ctx, b, "GET", path) });
		expect(cross.status).toBe(404);

		const own = await ctx.app.request(path, { headers: signed(ctx, officer, "GET", path) });
		expect(own.status).toBe(200);
		const body = await jsonBody<Record<string, unknown>>(own);
		expect(body).not.toHaveProperty("loan");
		expect(body).toHaveProperty("decision");
		expect(body).toHaveProperty("timeline");
	});
});

describe("health", () => {
	it("is public and returns the {status, service, checks} shape", async () => {
		const res = await ctx.app.request("/health");
		expect(res.status).toBe(200);
		const body = await jsonBody<{
			status: string;
			service: string;
			checks: Record<string, unknown>;
		}>(res);
		expect(body.service).toBe("applications");
		expect(["ok", "degraded"]).toContain(body.status);
		expect(body.checks.db).toBeDefined();
		expect(body.checks.temporal).toBeDefined();
	});
});

const CASE_FACTS_KEYS = [
	"aiResearchConsent",
	"amountCents",
	"applicantName",
	"applicationId",
	"asOf",
	"city",
	"companyName",
	"industry",
	"product",
	"reference",
	"registrationNumber",
	"status",
	"submittedAt",
	"termMonths",
	"type",
	"yearsTrading",
].sort();

async function getCaseFacts(
	user: { id: string; email: string; role: "applicant" | "officer" | "service" },
	id: string,
) {
	const path = `/internal/applications/${id}/case-facts`;
	return ctx.app.request(path, { headers: signed(ctx, user, "GET", path) });
}

async function getResearchContext(
	user: { id: string; email: string; role: "applicant" | "officer" | "service" },
	id: string,
) {
	const path = `/internal/applications/${id}/research-context`;
	return ctx.app.request(path, { headers: signed(ctx, user, "GET", path) });
}

describe("case facts + consent (Phase 2 R0)", () => {
	it("persists aiResearchConsent and exposes the exact allowlist", async () => {
		const user = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const payload = { ...individualPayload(user.email), aiResearchConsent: true };
		const created = await postApplication(user, payload, randomUUID());
		expect(created.status).toBe(201);
		const { id } = await jsonBody<{ id: string }>(created);

		const res = await getCaseFacts(officer, id);
		expect(res.status).toBe(200);
		const facts = await jsonBody<Record<string, unknown>>(res);
		expect(Object.keys(facts).sort()).toEqual(CASE_FACTS_KEYS);
		expect(facts.aiResearchConsent).toBe(true);
		expect(facts.city).toBe("Demo City");
		expect(facts.asOf).toBe(facts.submittedAt);
		for (const leaked of ["dob", "nationalId", "address", "purpose", "consents"]) {
			expect(facts).not.toHaveProperty(leaked);
		}
	});

	it("defaults consent to false when omitted", async () => {
		const user = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const created = await postApplication(user, individualPayload(user.email), randomUUID());
		expect(created.status).toBe(201);
		const { id } = await jsonBody<{ id: string }>(created);

		const res = await getCaseFacts(officer, id);
		expect(res.status).toBe(200);
		expect((await jsonBody<{ aiResearchConsent: boolean }>(res)).aiResearchConsent).toBe(false);
	});

	it("application detail exposes aiResearchConsent + status for the Run gate", async () => {
		const user = await createUser(ctx);
		const payload = { ...individualPayload(user.email), aiResearchConsent: true };
		const created = await postApplication(user, payload, randomUUID());
		expect(created.status).toBe(201);
		const { id } = await jsonBody<{ id: string }>(created);
		const path = `/api/applications/${id}`;
		const res = await ctx.app.request(path, { headers: signed(ctx, user, "GET", path) });
		expect(res.status).toBe(200);
		const body = await jsonBody<{
			application: { aiResearchConsent: boolean; status: string };
		}>(res);
		expect(body.application.aiResearchConsent).toBe(true);
		expect(typeof body.application.status).toBe("string");
	});

	it("malformed rows fail typed with no PII (CASE_FACTS_INVALID, not 500)", async () => {
		const officer = await createUser(ctx, "officer");
		const applicant = await createUser(ctx);
		const [row] = await ctx.db
			.insert(applications)
			.values({
				reference: generateReference(new Date().getUTCFullYear()),
				applicantUserId: applicant.id,
				type: "individual",
				product: "personal_loan",
				amountCents: -1,
				termMonths: 48,
				purpose: "malformed row",
				identity: { fullName: "PII Probe Person" },
				consents: [true, true, true],
			})
			.returning({ id: applications.id });
		const res = await getCaseFacts(officer, row.id);
		expect(res.status).toBe(502);
		const body = await jsonBody<{ error: { code: string; message: string } }>(res);
		expect(body.error.code).toBe("CASE_FACTS_INVALID");
		expect(JSON.stringify(body)).not.toContain("PII Probe Person");
	});

	it("legacy rows return city:null; applicants get 403, unsigned 401", async () => {
		const officer = await createUser(ctx, "officer");
		const applicant = await createUser(ctx);
		const [row] = await ctx.db
			.insert(applications)
			.values({
				reference: generateReference(new Date().getUTCFullYear()),
				applicantUserId: applicant.id,
				type: "individual",
				product: "personal_loan",
				amountCents: 1200000,
				termMonths: 48,
				purpose: "legacy row",
				identity: { fullName: "Legacy Person" },
				consents: [true, true, true],
			})
			.returning({ id: applications.id });
		const res = await getCaseFacts(officer, row.id);
		expect(res.status).toBe(200);
		const facts = await jsonBody<Record<string, unknown>>(res);
		expect(facts.city).toBeNull();
		expect(facts.aiResearchConsent).toBe(false);

		const denied = await getCaseFacts(applicant, row.id);
		expect(denied.status).toBe(403);

		const unsigned = await ctx.app.request(`/internal/applications/${row.id}/case-facts`);
		expect(unsigned.status).toBe(401);
	});
});

describe("research context (T00 service-only)", () => {
	it("service gets the 16-key case facts plus applicantUserId; officer/applicant denied", async () => {
		const user = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const service = await createUser(ctx, "service");
		const created = await postApplication(
			user,
			{ ...individualPayload(user.email), aiResearchConsent: true },
			randomUUID(),
		);
		expect(created.status).toBe(201);
		const { id } = await jsonBody<{ id: string }>(created);

		const res = await getResearchContext(service, id);
		expect(res.status).toBe(200);
		const body = await jsonBody<{
			caseFacts: Record<string, unknown>;
			applicantUserId: string;
		}>(res);
		// Exactly the shared 16-key schema — plus the internal routing id
		// beside it, never inside the facts (it must not reach the prompt).
		expect(Object.keys(body.caseFacts).sort()).toEqual(CASE_FACTS_KEYS);
		expect(body.caseFacts).not.toHaveProperty("applicantUserId");
		expect(body.applicantUserId).toBe(user.id);
		for (const leaked of ["dob", "nationalId", "address", "purpose", "consents"]) {
			expect(body.caseFacts).not.toHaveProperty(leaked);
		}

		expect((await getResearchContext(officer, id)).status).toBe(403);
		expect((await getResearchContext(user, id)).status).toBe(403);
		expect((await ctx.app.request(`/internal/applications/${id}/research-context`)).status).toBe(
			401,
		);
		expect((await getResearchContext(service, randomUUID())).status).toBe(404);
		expect((await getResearchContext(service, "not-a-uuid")).status).toBe(404);
	});
});
