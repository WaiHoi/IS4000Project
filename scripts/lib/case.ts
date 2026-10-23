// `demo:case` library (SPEC-t17-t18 §2.5): creates the deterministic fixture
// draft per persona through the same invariants as `POST /drafts` — owner
// user lock, 3-draft cap, `demo_case` source stamping, server-derived
// profile confirmations, fixture-provenance audits — but DB-direct (no HTTP,
// no workflow/outbox/T11). Initial evidence attaches through the real D1
// reuse service; stale app copies are fixture-seeded `demo_seed` rows
// (reuse refuses stale, so BreadTalk's blockers are stale by construction).
// Re-running never overwrites a touched draft: status drift, applicant
// uploads, or scalar/consent edits all skip with a report.
import {
	generateReference,
	canonicalJson,
	CONTEXT_CONSENT_VERSION,
	DOCUMENT_CONSENT_VERSION,
} from "@credit/core";
import {
	applicationProfileConfirmations,
	applications,
	customerDocuments,
	documentFiles,
	documentPages,
	withTx,
	type Db,
} from "@credit/db/applications";
import { HttpError, writeAudit } from "@credit/service-kit";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
	CONFIRMABLE_FIELDS,
	confirmationHmac,
	deriveConfirmations,
	getConfirmableValue,
} from "../../apps/applications/src/customer/requirements.js";
import {
	getCustomerProfile,
	reuseCustomerDocuments,
	type CustomerConfig,
} from "../../apps/applications/src/customer/service.js";
import {
	CRYPTO_VERSION,
	parseEncryptionKey,
	sha256Hex,
} from "../../apps/applications/src/customer/crypto.js";
import { encryptDocument } from "../../apps/applications/src/documents/crypto.js";
import {
	deleteBlob,
	ensureStorageDir,
	storageKeyFor,
	writeEncryptedFile,
} from "../../apps/applications/src/documents/storage.js";
import { demoEvidenceBytes } from "./demo-pdf.js";
import { demoAsOfDate, personaOf, type DemoManifest, type ManifestCase } from "./manifest.js";
import type { DemoUserDirectory } from "./db-helpers.js";

export interface AppDocConfig {
	storageDir: string;
	encryptionKey: string | undefined;
	keyId: string;
	previousKeys: string | undefined;
	lockTimeoutMs: number;
	retentionDays: number;
}

export interface CaseDeps {
	appDb: Db;
	users: DemoUserDirectory;
	customerConfig: CustomerConfig;
	appDocConfig: AppDocConfig;
	confirmationKey: string;
	demoMode: boolean;
	asOf?: Date;
	now?: Date;
}

export interface CaseOutcome {
	draftId: string;
	reference: string;
	created: boolean;
	attached: string[];
	staleCopies: string[];
}

const sameValue = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

function scalarDrift(
	draft: typeof applications.$inferSelect,
	fixture: ManifestCase,
	identity: Record<string, unknown>,
	block: Record<string, unknown> | null,
): boolean {
	return (
		draft.type !== fixture.type ||
		draft.product !== fixture.product ||
		draft.amountCents !== fixture.amountCents ||
		draft.termMonths !== fixture.termMonths ||
		draft.purpose !== fixture.purpose ||
		!sameValue(draft.identity, identity) ||
		!sameValue(draft.business ?? draft.financial ?? null, block) ||
		!sameValue(draft.consents, fixture.consents) ||
		draft.documentProcessingConsent !== fixture.documentProcessingConsent ||
		draft.aiResearchConsent !== fixture.aiResearchConsent ||
		draft.contextAnalysisConsent !== fixture.contextAnalysisConsent
	);
}

/** Touched = submitted/claimed downstream, applicant uploads, or any scalar
 * or consent edit. Fixture reuse/demo_seed copies never mark touched. */
export async function isFixtureDraftTouched(
	db: Db,
	draftId: string,
	draft: typeof applications.$inferSelect,
	fixture: ManifestCase,
	identity: Record<string, unknown>,
	block: Record<string, unknown> | null,
): Promise<boolean> {
	if (draft.status !== "draft") return true;
	const uploads = await db
		.select({ id: documentFiles.id })
		.from(documentFiles)
		.where(
			and(
				eq(documentFiles.applicationId, draftId),
				eq(documentFiles.source, "upload"),
				sql`${documentFiles.status} != 'deleted'`,
			),
		)
		.limit(1);
	if (uploads.length > 0) return true;
	return scalarDrift(draft, fixture, identity, block);
}

export async function ensureDemoCase(
	manifest: DemoManifest,
	personaKey: string,
	deps: CaseDeps,
): Promise<CaseOutcome> {
	const persona = personaOf(manifest, personaKey);
	const fixture = persona.case;
	const asOf = deps.asOf ?? demoAsOfDate(manifest);
	const now = deps.now ?? new Date();
	const userId = await deps.users.findUserByEmail(persona.email);
	const identity = fixture.identity;
	if (String(identity.email ?? "").toLowerCase() !== persona.email.toLowerCase()) {
		throw new Error(`fixture case identity email must equal ${persona.email}`);
	}
	const block = (fixture.sme ?? fixture.individual ?? null) as Record<string, unknown> | null;

	const profile = await getCustomerProfile(deps.appDb, userId);
	if (!profile)
		throw new Error(`demo:case: no customer profile for ${persona.email} (run demo:seed)`);
	const source = deps.demoMode && profile.source === "demo_seed" ? "demo_case" : "live";

	const existing = await deps.appDb
		.select()
		.from(applications)
		.where(eq(applications.fixtureKey, fixture.fixtureKey))
		.limit(1);
	let draft = existing[0];
	let created = false;
	if (draft) {
		if (draft.applicantUserId !== userId) {
			throw new Error(`fixture draft ${fixture.fixtureKey} belongs to another applicant`);
		}
		if (await isFixtureDraftTouched(deps.appDb, draft.id, draft, fixture, identity, block)) {
			return {
				draftId: draft.id,
				reference: draft.reference,
				created: false,
				attached: [],
				staleCopies: [],
			};
		}
	} else {
		const claimed = CONFIRMABLE_FIELDS.filter(
			(field) => getConfirmableValue({ identity, sme: block }, field) !== undefined,
		).map((field) => ({ field, valueHash: "demo-fixture-advisory" }));
		draft = await withTx(deps.appDb, async (tx) => {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
			const again = await tx
				.select()
				.from(applications)
				.where(eq(applications.fixtureKey, fixture.fixtureKey))
				.limit(1);
			if (again[0]) return again[0];
			const drafts = await tx
				.select({ id: applications.id })
				.from(applications)
				.where(and(eq(applications.applicantUserId, userId), eq(applications.status, "draft")));
			if (drafts.length >= 3) {
				throw new HttpError(409, "TOO_MANY_DRAFTS", "at most 3 active drafts");
			}
			const [inserted] = await tx
				.insert(applications)
				.values({
					reference: generateReference(asOf.getUTCFullYear()),
					applicantUserId: userId,
					type: fixture.type as "individual" | "sme",
					product: fixture.product as "personal_loan" | "sme_term_loan",
					status: "draft",
					amountCents: fixture.amountCents,
					termMonths: fixture.termMonths,
					purpose: fixture.purpose,
					identity,
					financial: fixture.individual ?? null,
					business: fixture.sme ?? null,
					consents: fixture.consents,
					aiResearchConsent: fixture.aiResearchConsent,
					documentProcessingConsent: fixture.documentProcessingConsent,
					documentConsentAt: fixture.documentProcessingConsent ? now : null,
					documentConsentVersion: fixture.documentProcessingConsent
						? DOCUMENT_CONSENT_VERSION
						: null,
					contextAnalysisConsent: fixture.contextAnalysisConsent,
					contextConsentAt: fixture.contextAnalysisConsent ? now : null,
					contextConsentVersion: fixture.contextAnalysisConsent ? CONTEXT_CONSENT_VERSION : null,
					source: source as "live" | "demo_case",
					fixtureKey: fixture.fixtureKey,
					submittedAt: null,
				})
				.returning();
			const derived = deriveConfirmations({
				application: { identity, sme: block },
				profile: {
					identity: (profile.identity ?? {}) as Record<string, unknown>,
					business: (profile.business ?? null) as Record<string, unknown> | null,
				},
				claimed,
			});
			if (derived.reused.length > 0) {
				const submittedValue = (field: string): unknown =>
					getConfirmableValue({ identity, sme: block }, field);
				await tx.insert(applicationProfileConfirmations).values(
					derived.reused.map((field) => ({
						applicationId: inserted.id,
						customerProfileId: profile.id,
						field,
						valueHash: confirmationHmac(submittedValue(field), deps.confirmationKey),
					})),
				);
			}
			await writeAudit(tx, {
				applicationId: inserted.id,
				actor: userId,
				action: "customer.profile_confirmed",
				entity: "application",
				payload: { reused: derived.reused, edited: derived.edited, fixture: personaKey },
			});
			await writeAudit(tx, {
				applicationId: inserted.id,
				actor: userId,
				action: "application.draft_created",
				entity: "application",
				payload: {
					reference: inserted.reference,
					fixture: personaKey,
					fixtureKey: fixture.fixtureKey,
				},
			});
			return inserted;
		});
		created = true;
	}

	// Initial evidence: fresh fixture kinds through the real reuse service
	// (stale kinds would 409 there — they arrive as staleCopies below).
	const attached: string[] = [];
	if (fixture.attach.length > 0) {
		const docs = await deps.appDb
			.select()
			.from(customerDocuments)
			.where(eq(customerDocuments.customerId, profile.id));
		const ids = fixture.attach.map((fixtureKey) => {
			const doc = docs.find((d) => d.fixtureKey === fixtureKey);
			if (!doc)
				throw new Error(`demo:case: customer evidence ${fixtureKey} missing (run demo:seed)`);
			return doc.id;
		});
		const outcome = await reuseCustomerDocuments(
			deps.appDb,
			deps.appDocConfig,
			deps.customerConfig,
			{
				applicationId: draft.id,
				userId,
				customerDocumentIds: ids,
				asOf,
				appRetentionDays: deps.appDocConfig.retentionDays,
			},
		);
		attached.push(...(outcome.files as Array<{ id: string }>).map((f) => f.id));
	}

	// Stale app copies: fixture-seeded rows so the checklist blocks with
	// `stale` until the applicant explicitly reuses fresh evidence.
	const staleCopies: string[] = [];
	for (const fixtureKey of fixture.staleCopies) {
		const id = await ensureStaleAppCopy(deps, {
			draftId: draft.id,
			userId,
			customerId: profile.id,
			personaKey,
			manifest,
			fixtureKey,
			asOf,
			now,
		});
		if (id) staleCopies.push(id);
	}
	return { draftId: draft.id, reference: draft.reference, created, attached, staleCopies };
}

async function ensureStaleAppCopy(
	deps: CaseDeps,
	input: {
		draftId: string;
		userId: string;
		customerId: string;
		personaKey: string;
		manifest: DemoManifest;
		fixtureKey: string;
		asOf: Date;
		now: Date;
	},
): Promise<string | null> {
	const { manifest, personaKey, fixtureKey } = input;
	const persona = personaOf(manifest, personaKey);
	const evidence = persona.evidence.find((e) => e.fixtureKey === fixtureKey);
	if (!evidence) throw new Error(`stale fixture evidence ${fixtureKey} not in manifest`);
	const staleDoc = (
		await deps.appDb
			.select()
			.from(customerDocuments)
			.where(
				and(
					eq(customerDocuments.customerId, input.customerId),
					eq(customerDocuments.fixtureKey, fixtureKey),
				),
			)
			.limit(1)
	)[0];
	if (!staleDoc) throw new Error(`demo:case: stale evidence ${fixtureKey} missing (run demo:seed)`);
	const { bytes, text } = demoEvidenceBytes(evidence);
	const sha256 = sha256Hex(bytes);
	const same = await deps.appDb
		.select({ id: documentFiles.id })
		.from(documentFiles)
		.where(
			and(
				eq(documentFiles.applicationId, input.draftId),
				eq(documentFiles.kind, staleDoc.kind),
				eq(documentFiles.sha256, sha256),
				sql`${documentFiles.status} != 'deleted'`,
			),
		)
		.limit(1);
	if (same[0]) return null;

	let appKey: Buffer;
	try {
		appKey = parseEncryptionKey(deps.appDocConfig.encryptionKey);
	} catch {
		throw new HttpError(503, "ENCRYPTION_UNAVAILABLE", "document encryption is unavailable");
	}
	const fileId = randomUUID();
	const storageKey = storageKeyFor(input.draftId, fileId);
	const encrypted = encryptDocument({
		plaintext: bytes,
		fileId,
		applicationId: input.draftId,
		key: appKey,
		keyId: deps.appDocConfig.keyId,
	});
	await ensureStorageDir(deps.appDocConfig.storageDir);
	await writeEncryptedFile(deps.appDocConfig.storageDir, storageKey, encrypted.ciphertext);
	try {
		return await withTx(deps.appDb, async (tx) => {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.draftId}))`);
			const [inserted] = await tx
				.insert(documentFiles)
				.values({
					id: fileId,
					applicationId: input.draftId,
					kind: staleDoc.kind,
					status: "ready",
					ocrStatus: "ready",
					textLayerRisk: false,
					originalFilename: evidence.originalFilename,
					mimeType: "application/pdf",
					sizeBytes: bytes.length,
					sha256,
					storageKey,
					encryptionNonce: encrypted.nonceB64,
					encryptionTag: encrypted.tagB64,
					keyId: deps.appDocConfig.keyId,
					cryptoVersion: CRYPTO_VERSION,
					pageCount: 1,
					ocrConfidence: 0.99,
					uploadedBy: input.userId,
					uploadedAt: input.now,
					retentionUntil: new Date(
						input.now.getTime() + deps.appDocConfig.retentionDays * 86_400_000,
					),
					source: "demo_seed",
					reusedFromCustomerDocumentId: staleDoc.id,
					documentDate: staleDoc.documentDate,
					periodEnd: staleDoc.periodEnd,
					documentDateSource: "reused",
				})
				.returning({ id: documentFiles.id });
			await tx.insert(documentPages).values({
				documentFileId: inserted.id,
				pageNumber: 1,
				text,
				textSource: "pdf_text",
				confidence: 0.99,
				textSha256: sha256Hex(Buffer.from(text, "utf8")),
			});
			await writeAudit(tx, {
				applicationId: input.draftId,
				actor: input.userId,
				action: "document.reused",
				entity: "document_file",
				payload: {
					documentFileId: inserted.id,
					customerDocumentId: staleDoc.id,
					kind: staleDoc.kind,
					fixture: personaKey,
				},
			});
			return inserted.id;
		});
	} catch (err) {
		await deleteBlob(deps.appDocConfig.storageDir, storageKey);
		throw err;
	}
}
