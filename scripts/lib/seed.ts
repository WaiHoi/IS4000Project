// `demo:seed` library (SPEC-t17-t18 §2.5): idempotent, non-destructive
// upsert of fixture users/customers/accounts/transactions/evidence plus a
// `demo_meta` sentinel. Guarded by DEMO_MODE/non-production (core) and by
// manifest version/hash agreement; emits no model calls, workflow events,
// or outbox rows — it only writes customer-master tables and `demo_meta`.
// It never touches `applications` drafts: user-edited fixture drafts are
// therefore never overwritten by seed (demo:case owns the touched check).
import {
	customerAccounts,
	customerDocumentPages,
	customerDocuments,
	customerProfiles,
	customerTransactions,
	documentFiles,
	type Db,
} from "@credit/db/applications";
import { and, eq, sql } from "drizzle-orm";
import {
	createCustomerDocument,
	openCustomerDocument,
	restoreCustomerBlob,
	type CustomerConfig,
} from "../../apps/applications/src/customer/service.js";
import { deleteBlob } from "../../apps/applications/src/documents/storage.js";
import { sha256Hex } from "../../apps/applications/src/customer/crypto.js";
import { demoEvidenceBytes } from "./demo-pdf.js";
import {
	assertManifest,
	demoAsOfDate,
	type DemoManifest,
	type ManifestEvidence,
} from "./manifest.js";
import type { DemoUserDirectory } from "./db-helpers.js";

export interface SeedDeps {
	appDb: Db;
	users: DemoUserDirectory;
	customerConfig: CustomerConfig;
	now?: Date;
}

export interface SeedCounts {
	users: number;
	profilesUpserted: number;
	accountsUpserted: number;
	transactionsUpserted: number;
	evidenceCreated: number;
	evidenceSkipped: number;
}

async function ensureDemoMeta(db: Db): Promise<void> {
	await db.execute(
		sql`CREATE TABLE IF NOT EXISTS demo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`,
	);
}

async function writeMeta(db: Db, key: string, value: string): Promise<void> {
	await db.execute(
		sql`INSERT INTO demo_meta (key, value, updated_at) VALUES (${key}, ${value}, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
	);
}

export async function readMeta(db: Db): Promise<Record<string, string>> {
	let rows: Array<{ key: string; value: string }>;
	try {
		rows = (await db.execute(sql`SELECT key, value FROM demo_meta`)) as unknown as Array<{
			key: string;
			value: string;
		}>;
	} catch {
		return {};
	}
	return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Fixture retention is clocked on the manifest as-of (SPEC-t17-t18 §2.5),
 * never wall clock — the sweep tombstones fixture rows against the same
 * clock, so a fixture retention window never collapses under a later wall
 * date. */
export function fixtureRetentionUntil(asOf: Date, retentionDays: number): Date {
	return new Date(asOf.getTime() + retentionDays * 86_400_000);
}

export type FixtureEvidenceOutcome = "created" | "repaired" | "skipped";

export interface FixtureEvidenceInput {
	customerId: string;
	evidence: ManifestEvidence;
	asOf: Date;
	retentionDays: number;
}

/** Upsert + converge one fixture evidence row. Healthy rows skip by content;
 * tombstoned (retention-swept), purged, or tampered fixture-owned rows are
 * repaired in place — same ids/AAD, so live reuse references never break.
 * Only genuine fixture-content drift recreates the row, and that still
 * refuses when an application document references it. */
export async function ensureFixtureEvidence(
	db: Db,
	config: CustomerConfig,
	input: FixtureEvidenceInput,
): Promise<{ outcome: FixtureEvidenceOutcome; id: string }> {
	const { evidence, asOf } = input;
	const { bytes, text } = demoEvidenceBytes(evidence);
	const sha256 = sha256Hex(bytes);
	const rows = await db
		.select()
		.from(customerDocuments)
		.where(
			and(
				eq(customerDocuments.customerId, input.customerId),
				eq(customerDocuments.kind, evidence.kind as "id"),
				eq(customerDocuments.fixtureKey, evidence.fixtureKey),
			),
		)
		.limit(1);
	const row = rows[0];
	const create = async (): Promise<string> => {
		const created = await createCustomerDocument(db, config, {
			customerId: input.customerId,
			kind: evidence.kind,
			bytes,
			mimeType: "application/pdf",
			originalFilename: evidence.originalFilename,
			documentDate: evidence.documentDate,
			periodEnd: evidence.periodEnd,
			pages: [{ text, source: "pdf_text", confidence: 0.99 }],
			source: "demo_seed",
			fixtureKey: evidence.fixtureKey,
			asOf,
		});
		await db
			.update(customerDocuments)
			.set({ retentionUntil: fixtureRetentionUntil(asOf, input.retentionDays) })
			.where(eq(customerDocuments.id, created.id));
		return created.id;
	};
	if (!row) return { outcome: "created", id: await create() };
	if (row.source !== "demo_seed") {
		throw new Error(`seed refuses: evidence ${evidence.fixtureKey} is not fixture-owned`);
	}
	let blobOk = true;
	try {
		await openCustomerDocument(config, row);
	} catch {
		blobOk = false;
	}
	const pages = await db
		.select()
		.from(customerDocumentPages)
		.where(eq(customerDocumentPages.customerDocumentId, row.id));
	const pagesOk = pages.length === 1 && pages[0].text === text;
	const fieldsOk =
		row.status === "ready" &&
		row.scanStatus === "clean" &&
		row.documentDate === evidence.documentDate &&
		row.periodEnd === evidence.periodEnd &&
		row.sha256 === sha256 &&
		row.sizeBytes === bytes.length &&
		row.pageCount === 1 &&
		row.blobPurgedAt === null &&
		row.retentionUntil.getTime() > asOf.getTime();
	if (fieldsOk && pagesOk && blobOk) return { outcome: "skipped", id: row.id };
	if (row.sha256 === sha256) {
		// Blob drift (wiped storage root) or a sweep/tamper of a same-content
		// row: restore the ciphertext in place, reset the swept/tampered
		// columns, and replace the pages — the row id never changes.
		if (!blobOk && !(await restoreCustomerBlob(db, config, row, bytes))) {
			throw new Error(`seed refuses: evidence ${evidence.fixtureKey} blob unrestorable`);
		}
		await db
			.update(customerDocuments)
			.set({
				status: "ready",
				scanStatus: "clean",
				scannedAt: new Date(),
				originalFilename: evidence.originalFilename,
				mimeType: "application/pdf",
				sizeBytes: bytes.length,
				pageCount: 1,
				ocrStatus: "ready",
				ocrConfidence: 0.99,
				textLayerRisk: false,
				documentDate: evidence.documentDate,
				periodEnd: evidence.periodEnd,
				blobPurgedAt: null,
				retentionUntil: fixtureRetentionUntil(asOf, input.retentionDays),
			})
			.where(eq(customerDocuments.id, row.id));
		if (!pagesOk) {
			await db
				.delete(customerDocumentPages)
				.where(eq(customerDocumentPages.customerDocumentId, row.id));
			await db.insert(customerDocumentPages).values({
				customerDocumentId: row.id,
				pageNumber: 1,
				text,
				textSource: "pdf_text",
				confidence: 0.99,
				textSha256: sha256Hex(Buffer.from(text, "utf8")),
			});
		}
		return { outcome: "repaired", id: row.id };
	}
	// Fixture drift: restore the fixture, but never break a live
	// reference — reused app copies point here with RESTRICT.
	const refs = await db
		.select({ id: documentFiles.id })
		.from(documentFiles)
		.where(eq(documentFiles.reusedFromCustomerDocumentId, row.id))
		.limit(1);
	if (refs.length > 0) {
		throw new Error(
			`seed refuses: evidence ${evidence.fixtureKey} drifted and is referenced by app documents`,
		);
	}
	if (row.storageKey) await deleteBlob(config.storageDir, row.storageKey);
	await db.delete(customerDocuments).where(eq(customerDocuments.id, row.id));
	return { outcome: "created", id: await create() };
}

/** Profile identity email, lower-cased — the stable persona key across an
 * auth-DB reseed (auth user ids are random per insert, fixture profile ids
 * are not). Empty when the identity carries no email. */
function identityEmail(identity: unknown): string {
	if (typeof identity !== "object" || identity === null) return "";
	const email = (identity as Record<string, unknown>).email;
	return typeof email === "string" ? email.toLowerCase() : "";
}

export async function seedDemo(manifest: DemoManifest, deps: SeedDeps): Promise<SeedCounts> {
	const { hash } = assertManifest(manifest);
	const asOf = demoAsOfDate(manifest);
	const counts: SeedCounts = {
		users: 0,
		profilesUpserted: 0,
		accountsUpserted: 0,
		transactionsUpserted: 0,
		evidenceCreated: 0,
		evidenceSkipped: 0,
	};
	await ensureDemoMeta(deps.appDb);

	for (const [personaKey, persona] of Object.entries(manifest.personas)) {
		const userId = await deps.users.ensureUser({
			email: persona.email,
			fullName: persona.fullName,
			role: persona.role,
		});
		counts.users++;

		const existing = await deps.appDb
			.select()
			.from(customerProfiles)
			.where(eq(customerProfiles.userId, userId))
			.limit(1);
		let profile = existing[0];
		if (!profile) {
			// Auth-DB reseed drift: auth user ids are random per insert, so
			// a reseeded auth DB orphans the fixture profile under a stale
			// user_id. The persona email (in the fixture identity) is the
			// stable key: exactly one fixture-owned orphan with that email
			// is re-linked to the current auth user — accounts, transactions,
			// and evidence follow the unchanged profile id, and no row is
			// deleted. Anything else inserts fresh below.
			const orphans = await deps.appDb
				.select()
				.from(customerProfiles)
				.where(eq(customerProfiles.source, "demo_seed"));
			const mine = orphans.filter(
				(p) => p.userId !== userId && identityEmail(p.identity) === persona.email.toLowerCase(),
			);
			if (mine.length === 1) {
				const [relinked] = await deps.appDb
					.update(customerProfiles)
					.set({ userId })
					.where(eq(customerProfiles.id, mine[0].id))
					.returning();
				profile = relinked;
			} else if (mine.length > 1) {
				throw new Error(
					`seed refuses: ${mine.length} fixture-owned profiles match ${persona.email} ` +
						`(auth DB was reseeded more than once). Explicit repair: keep the profile id ` +
						`the fixture draft/applications reference and delete the other stale ` +
						`demo_seed profile rows by id (${mine.map((p) => p.id).join(", ")}), then re-run demo:seed`,
				);
			}
		}
		if (profile) {
			if (profile.source !== "demo_seed") {
				throw new Error(`seed refuses: profile for ${persona.email} is not fixture-owned`);
			}
			const [updated] = await deps.appDb
				.update(customerProfiles)
				.set({
					segment: persona.profile.segment as "individual" | "sme",
					customerSince: persona.profile.customerSince,
					kycStatus: persona.profile.kycStatus as "verified" | "expired" | "not_started",
					kycVerifiedAt: persona.profile.kycVerifiedAt
						? new Date(persona.profile.kycVerifiedAt)
						: null,
					kycExpiresAt: persona.profile.kycExpiresAt
						? new Date(persona.profile.kycExpiresAt)
						: null,
					identity: persona.profile.identity,
					business: persona.profile.business,
				})
				.where(eq(customerProfiles.id, profile.id))
				.returning();
			profile = updated;
		} else {
			const [inserted] = await deps.appDb
				.insert(customerProfiles)
				.values({
					userId,
					segment: persona.profile.segment as "individual" | "sme",
					customerSince: persona.profile.customerSince,
					kycStatus: persona.profile.kycStatus as "verified" | "expired" | "not_started",
					kycVerifiedAt: persona.profile.kycVerifiedAt
						? new Date(persona.profile.kycVerifiedAt)
						: null,
					kycExpiresAt: persona.profile.kycExpiresAt
						? new Date(persona.profile.kycExpiresAt)
						: null,
					identity: persona.profile.identity,
					business: persona.profile.business,
					source: "demo_seed",
				})
				.returning();
			profile = inserted;
		}
		counts.profilesUpserted++;

		for (const account of persona.accounts) {
			const rows = await deps.appDb
				.select()
				.from(customerAccounts)
				.where(eq(customerAccounts.id, account.id))
				.limit(1);
			const row = rows[0];
			if (row) {
				if (row.customerId !== profile.id || row.source !== "demo_seed") {
					throw new Error(`seed refuses: account ${account.id} is not fixture-owned`);
				}
				await deps.appDb
					.update(customerAccounts)
					.set({
						bankName: account.bankName,
						accountType: account.accountType as "personal_current" | "business_current" | "savings",
						maskedNumber: account.maskedNumber,
						currency: account.currency,
						openedAt: account.openedAt,
						status: account.status as "active" | "closed",
					})
					.where(eq(customerAccounts.id, account.id));
			} else {
				await deps.appDb.insert(customerAccounts).values({
					id: account.id,
					customerId: profile.id,
					bankName: account.bankName,
					accountType: account.accountType as "personal_current" | "business_current" | "savings",
					maskedNumber: account.maskedNumber,
					currency: account.currency,
					openedAt: account.openedAt,
					status: account.status as "active" | "closed",
					source: "demo_seed",
				});
			}
			counts.accountsUpserted++;
		}

		if (persona.transactions.length > 0 && persona.accounts.length === 0) {
			throw new Error(`persona ${personaKey} has transactions but no account`);
		}
		const accountId = persona.accounts[0]?.id;
		for (const txn of persona.transactions) {
			const rows = await deps.appDb
				.select()
				.from(customerTransactions)
				.where(
					and(
						eq(customerTransactions.accountId, accountId as string),
						eq(customerTransactions.source, "demo_seed"),
						eq(customerTransactions.sourceReference, txn.sourceReference),
					),
				)
				.limit(1);
			const row = rows[0];
			const values = {
				postedAt: new Date(txn.postedAt),
				amountCents: txn.amountCents,
				balanceAfterCents: txn.balanceAfterCents,
				currency: txn.currency,
				description: txn.description,
				counterparty: txn.counterparty,
				category: txn.category as
					| "income"
					| "transfer"
					| "payroll"
					| "loan"
					| "fee"
					| "purchase"
					| "cash"
					| "returned_payment"
					| "other",
				returned: txn.returned,
			};
			if (row) {
				if (row.source !== "demo_seed") {
					throw new Error(`seed refuses: transaction ${txn.sourceReference} is not fixture-owned`);
				}
				await deps.appDb
					.update(customerTransactions)
					.set(values)
					.where(eq(customerTransactions.id, row.id));
			} else {
				await deps.appDb.insert(customerTransactions).values({
					accountId: accountId as string,
					source: "demo_seed",
					sourceReference: txn.sourceReference,
					...values,
				});
			}
			counts.transactionsUpserted++;
		}

		for (const evidence of persona.evidence) {
			const { outcome } = await ensureFixtureEvidence(deps.appDb, deps.customerConfig, {
				customerId: profile.id,
				evidence,
				asOf,
				retentionDays: deps.customerConfig.retentionDays,
			});
			if (outcome === "skipped") counts.evidenceSkipped++;
			else counts.evidenceCreated++;
		}
	}

	await writeMeta(deps.appDb, "seed_version", String(manifest.version));
	await writeMeta(deps.appDb, "manifest_sha256", hash);
	await writeMeta(deps.appDb, "seeded_at", (deps.now ?? new Date()).toISOString());
	return counts;
}

/** `demo:reset` refuses to wipe a database without a prior demo seed whose
 * manifest version and hash still agree with the checked-in fixture. */
export async function assertSeedSentinel(
	db: Db,
	manifest: DemoManifest,
): Promise<{ version: string; hash: string }> {
	const { hash } = assertManifest(manifest);
	const meta = await readMeta(db);
	const version = meta.seed_version;
	const sentinelHash = meta.manifest_sha256;
	if (!version || !sentinelHash) {
		throw new Error("refusing: no demo seed sentinel (run demo:seed first)");
	}
	if (version !== String(manifest.version)) {
		throw new Error(`refusing: sentinel version ${version} != manifest ${manifest.version}`);
	}
	if (sentinelHash !== hash) {
		throw new Error("refusing: sentinel hash != manifest hash (re-run demo:seed)");
	}
	return { version, hash };
}
