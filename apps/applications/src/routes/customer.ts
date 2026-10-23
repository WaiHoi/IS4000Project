// T17 customer self-service reads (SPEC-t17-t18 §2.3): owner-only profile
// (prefill, masked accounts, KYC freshness) and reusable-evidence metadata.
// Freshness uses the profile fixture clock so pre-draft and draft views
// agree. Never storage keys, nonces, tags, page text, or full numbers.
import { customerAccounts, customerDocuments, withTx, type Db } from "@credit/db/applications";
import { HttpError, writeAudit, type ServiceApp } from "@credit/service-kit";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { effectiveAsOf } from "../customer/requirements.js";
import { getCustomerProfile, presentCustomerDocument } from "../customer/service.js";

export interface CustomerRouteDeps {
	db: Db;
	demoMode: boolean;
	demoAsOf: Date;
}

export function customerRoutes(deps: CustomerRouteDeps): ServiceApp {
	const app: ServiceApp = new Hono();
	const { db } = deps;

	const asOfForProfile = (profile: { source: "demo_seed" | "customer_master" }): Date =>
		effectiveAsOf({
			appSource: null,
			profileSource: profile.source,
			demoMode: deps.demoMode,
			demoAsOf: deps.demoAsOf,
		});

	const loadOwned = async (userId: string) => {
		const profile = await getCustomerProfile(db, userId);
		if (!profile) throw new HttpError(404, "NOT_FOUND", "not found");
		return profile;
	};

	app.get("/api/customer/profile", async (c) => {
		const me = c.var.user;
		if (me.role !== "applicant") throw new HttpError(403, "FORBIDDEN", "applicants only");
		const profile = await loadOwned(me.id);
		const asOf = asOfForProfile(profile);
		const [accounts, docs] = await Promise.all([
			db.select().from(customerAccounts).where(eq(customerAccounts.customerId, profile.id)),
			db.select().from(customerDocuments).where(eq(customerDocuments.customerId, profile.id)),
		]);
		const kycFresh =
			profile.kycStatus === "verified" &&
			profile.kycExpiresAt !== null &&
			profile.kycExpiresAt.getTime() > asOf.getTime();
		await withTx(db, async (tx) => {
			await writeAudit(tx, {
				actor: me.id,
				action: "customer.read",
				entity: "customer_profile",
				payload: { customerId: profile.id },
			});
		});
		return c.json({
			profile: {
				id: profile.id,
				segment: profile.segment,
				customerSince: profile.customerSince,
				kycStatus: profile.kycStatus,
				kycVerifiedAt: profile.kycVerifiedAt?.toISOString() ?? null,
				kycExpiresAt: profile.kycExpiresAt?.toISOString() ?? null,
				kycFresh,
				identity: profile.identity,
				business: profile.business,
				source: profile.source,
			},
			accounts: accounts.map((a) => ({
				id: a.id,
				bankName: a.bankName,
				accountType: a.accountType,
				maskedNumber: a.maskedNumber,
				currency: a.currency,
				openedAt: a.openedAt,
				status: a.status,
			})),
			documents: docs.map((d) => presentCustomerDocument(d, asOf)),
			asOf: asOf.toISOString(),
		});
	});

	app.get("/api/customer/documents", async (c) => {
		const me = c.var.user;
		if (me.role !== "applicant") throw new HttpError(403, "FORBIDDEN", "applicants only");
		const profile = await loadOwned(me.id);
		const asOf = asOfForProfile(profile);
		const docs = await db
			.select()
			.from(customerDocuments)
			.where(eq(customerDocuments.customerId, profile.id));
		await withTx(db, async (tx) => {
			await writeAudit(tx, {
				actor: me.id,
				action: "customer.read",
				entity: "customer_document",
				payload: { customerId: profile.id, documentCount: docs.length },
			});
		});
		return c.json({
			documents: docs.map((d) => presentCustomerDocument(d, asOf)),
			asOf: asOf.toISOString(),
		});
	});

	return app;
}
