// `demo:verify` library (SPEC-t17-t18 §2.5): validates the manifest, DB
// counts, every encrypted customer blob (decrypt + hash + page text),
// requirements outcomes per phase, submit side effects, and T02/T11
// expectations. Pure DB reads — no workflow, no model, no writes.
// T02 finding and T11 run presence checks compare against the manifest when
// the stack produced them (submitted + officer crosscheck + worker run);
// otherwise they report the D2b/D3 seam instead of failing.
import { dedupeApplicationSubmitted, canonicalJson } from "@credit/core";
import { agentRuns, contextSignals, type Db as ResearchDb } from "@credit/db/research";
import {
	applications,
	customerAccounts,
	customerDocumentPages,
	customerDocuments,
	customerTransactions,
	documentCrosschecks,
	documentFiles,
	documentFindings,
	outboxEvents,
	type Db,
} from "@credit/db/applications";
import { and, eq, isNull } from "drizzle-orm";
import {
	classifyCustomerDoc,
	requirementsFor,
} from "../../apps/applications/src/customer/requirements.js";
import {
	openCustomerDocument,
	readConfirmations,
	type CustomerConfig,
} from "../../apps/applications/src/customer/service.js";
import { demoEvidenceBytes } from "./demo-pdf.js";
import {
	assertManifest,
	demoAsOfDate,
	manifestHash,
	EXPECTED_MANIFEST_SHA256,
	EXPECTED_MANIFEST_VERSION,
	personaOf,
	type DemoManifest,
} from "./manifest.js";
import { findProfileByEmail, type DemoUserDirectory } from "./db-helpers.js";

export type VerifyPhase = "pre-refresh" | "post-refresh" | "post-attach" | "post-submit";

export interface VerifyDeps {
	appDb: Db;
	users: DemoUserDirectory;
	customerConfig: CustomerConfig;
	researchDb?: ResearchDb | null;
	asOf?: Date;
}

export interface VerifyCheck {
	name: string;
	ok: boolean;
	detail: string;
}

function check(checks: VerifyCheck[], name: string, ok: boolean, detail: string): void {
	checks.push({ name, ok, detail });
}

const sameJson = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Every signal type the deterministic context metrics can emit. */
const LIVE_SIGNAL_TYPES = [
	"negative_balance",
	"revenue_concentration",
	"round_trip",
	"cash_deposit_share",
	"declared_vs_observed_cashflow",
	"returned_payment",
	"insufficient_data",
] as const;

/** Pure T18 signal expectation check, gated on mode (testable without a DB).
 * `contextStatus !== 'succeeded'` (flags-off/skipped/failed/not_applicable)
 * is always a passing seam. A succeeded stub run pins exact manifest types;
 * a succeeded live run must be non-empty and use only deterministic metric
 * types (model output stays variable, so exact types are stub-pinned). */
export function checkExpectedSignals(input: {
	contextStatus: string;
	isStub: boolean;
	actual: Array<{ type: string; status: string }>;
	expected: string[];
	runShortId: string;
}): Array<{ name: string; ok: boolean; detail: string }> {
	const { contextStatus, isStub, actual, expected, runShortId } = input;
	if (contextStatus !== "succeeded") {
		return [
			{
				name: "t18 expected signals",
				ok: true,
				detail: `context ${contextStatus} — no exact signal expectation (T18 disabled/skipped/failed seam)`,
			},
		];
	}
	const out: Array<{ name: string; ok: boolean; detail: string }> = [];
	const badStatus = actual.filter(
		(s) =>
			!["review", "needs_chase", "insufficient_data"].includes(s.status) ||
			(s.type === "insufficient_data") !== (s.status === "insufficient_data"),
	);
	out.push({
		name: "t18 signal statuses",
		ok: badStatus.length === 0,
		detail:
			badStatus.length === 0
				? `${actual.length} signals`
				: `bad: ${JSON.stringify(badStatus.map((s) => ({ type: s.type, status: s.status })))}`,
	});
	if (!isStub) {
		const unknown = actual.filter(
			(s) => !(LIVE_SIGNAL_TYPES as readonly string[]).includes(s.type),
		);
		const types = actual.map((s) => s.type).join(",");
		out.push({
			name: "t18 expected signal types",
			ok: actual.length > 0 && unknown.length === 0,
			detail:
				actual.length === 0
					? "live run succeeded with no signals"
					: `live run [${types}] — deterministic metric types only`,
		});
		out.push({
			name: "t18 no fabricated signals",
			ok: unknown.length === 0,
			detail:
				unknown.length === 0
					? `${actual.length} signals, all deterministic types`
					: `fabricated: ${unknown.map((s) => s.type).join(",")}`,
		});
		return out;
	}
	const types = actual.map((s) => s.type).sort();
	const want = [...expected].sort();
	out.push({
		name: "t18 expected signal types",
		ok: sameJson(types, want),
		detail: `stub run ${runShortId} [${types.join(",")}] want [${want.join(",")}]`,
	});
	const fabricated = actual.map((s) => s.type).filter((t) => !expected.includes(t));
	out.push({
		name: "t18 no fabricated signals",
		ok: fabricated.length === 0,
		detail:
			fabricated.length === 0
				? `${actual.length} signals, all manifest-owned`
				: `fabricated: ${fabricated.join(",")}`,
	});
	return out;
}

export async function verifyDemo(
	manifest: DemoManifest,
	personaKey: string,
	phase: VerifyPhase,
	deps: VerifyDeps,
): Promise<{ checks: VerifyCheck[]; failed: number }> {
	const checks: VerifyCheck[] = [];
	const asOf = deps.asOf ?? demoAsOfDate(manifest);

	try {
		const { hash } = assertManifest(manifest);
		check(checks, "manifest version+hash", true, `v${manifest.version} ${hash.slice(0, 12)}`);
	} catch (err) {
		check(checks, "manifest version+hash", false, (err as Error).message);
		return { checks, failed: 1 };
	}
	if (
		manifestHash(manifest) !== EXPECTED_MANIFEST_SHA256 ||
		manifest.version !== EXPECTED_MANIFEST_VERSION
	) {
		check(checks, "manifest code-side expectation", false, "constant mismatch");
		return { checks, failed: 1 };
	}

	const persona = personaOf(manifest, personaKey);
	const profile = await findProfileByEmail(deps.appDb, deps.users, persona.email);
	check(checks, "profile seeded", !!profile && profile.source === "demo_seed", persona.email);
	if (!profile) return { checks, failed: checks.filter((c) => !c.ok).length };

	const kycFresh =
		profile.kycStatus === "verified" &&
		profile.kycExpiresAt !== null &&
		profile.kycExpiresAt.getTime() > asOf.getTime();
	check(
		checks,
		"kyc valid",
		kycFresh,
		`${profile.kycStatus} exp ${profile.kycExpiresAt?.toISOString() ?? "null"}`,
	);

	const accounts = await deps.appDb
		.select()
		.from(customerAccounts)
		.where(eq(customerAccounts.customerId, profile.id));
	check(
		checks,
		"account count",
		accounts.length === persona.accounts.length,
		`${accounts.length}/${persona.accounts.length}`,
	);
	let txnCount = 0;
	for (const account of accounts) {
		const txns = await deps.appDb
			.select()
			.from(customerTransactions)
			.where(eq(customerTransactions.accountId, account.id));
		txnCount += txns.length;
	}
	check(
		checks,
		"transaction count",
		txnCount === persona.transactions.length,
		`${txnCount}/${persona.transactions.length}`,
	);

	const docs = await deps.appDb
		.select()
		.from(customerDocuments)
		.where(eq(customerDocuments.customerId, profile.id));
	for (const evidence of persona.evidence) {
		const row = docs.find((d) => d.fixtureKey === evidence.fixtureKey);
		check(checks, `evidence ${evidence.fixtureKey} seeded`, !!row, evidence.kind);
		if (!row) continue;
		const metaOk =
			row.status === "ready" &&
			row.scanStatus === "clean" &&
			row.documentDate === evidence.documentDate &&
			row.periodEnd === evidence.periodEnd;
		check(
			checks,
			`evidence ${evidence.fixtureKey} metadata`,
			metaOk,
			`date ${row.documentDate} period ${row.periodEnd}`,
		);
		try {
			const plaintext = await openCustomerDocument(deps.customerConfig, row);
			const { bytes, text } = demoEvidenceBytes(evidence);
			check(
				checks,
				`evidence ${evidence.fixtureKey} blob`,
				plaintext.equals(bytes),
				`${plaintext.length} bytes`,
			);
			const pages = await deps.appDb
				.select()
				.from(customerDocumentPages)
				.where(eq(customerDocumentPages.customerDocumentId, row.id));
			const stored = pages.map((p) => p.text).join("\n");
			check(
				checks,
				`evidence ${evidence.fixtureKey} page text`,
				stored === text,
				`${pages.length} pages`,
			);
		} catch (err) {
			check(checks, `evidence ${evidence.fixtureKey} blob`, false, (err as Error).message);
		}
		if (row.pageCount !== 1) {
			check(checks, `evidence ${evidence.fixtureKey} pages`, false, `pageCount ${row.pageCount}`);
		}
	}

	for (const evidence of persona.freshEvidence) {
		const row = docs.find((d) => d.fixtureKey === evidence.fixtureKey);
		const want = phase !== "pre-refresh";
		check(
			checks,
			`fresh evidence ${evidence.fixtureKey} ${want ? "present" : "absent"}`,
			want ? !!row : !row,
			evidence.kind,
		);
		if (row && want) {
			const eligibility = classifyCustomerDoc(
				{
					id: row.id,
					kind: row.kind,
					status: row.status,
					scanStatus: row.scanStatus,
					retentionUntil: row.retentionUntil,
					blobPurgedAt: row.blobPurgedAt,
					periodEnd: row.periodEnd,
					documentDate: row.documentDate,
				},
				asOf,
			);
			check(
				checks,
				`fresh evidence ${evidence.fixtureKey} reusable`,
				eligibility.eligible,
				eligibility.reason ?? "eligible",
			);
			// Service-visibility: the blob must open under the storage root
			// the running applications service reads — eligibility alone
			// never proves the bytes are there for reuse/download.
			try {
				const plaintext = await openCustomerDocument(deps.customerConfig, row);
				const { bytes } = demoEvidenceBytes(evidence);
				check(
					checks,
					`fresh evidence ${evidence.fixtureKey} blob visible`,
					plaintext.equals(bytes),
					`${plaintext.length} bytes`,
				);
			} catch (err) {
				check(
					checks,
					`fresh evidence ${evidence.fixtureKey} blob visible`,
					false,
					(err as Error).message,
				);
			}
		}
	}

	const drafts = await deps.appDb
		.select()
		.from(applications)
		.where(eq(applications.fixtureKey, persona.case.fixtureKey))
		.limit(1);
	const draft = drafts[0];
	check(checks, "draft exists", !!draft, persona.case.fixtureKey);
	if (!draft) return { checks, failed: checks.filter((c) => !c.ok).length };
	check(checks, "draft source", draft.source === "demo_case", draft.source);

	const submitted = phase === "post-submit";
	// Post-submit, the worker may already have advanced submitted →
	// processing → pending_review: any submit-adjacent status proves the
	// transition (the outbox-once check below pins exactly-once).
	check(
		checks,
		"draft status",
		submitted
			? ["submitted", "processing", "pending_review"].includes(draft.status)
			: draft.status === "draft",
		draft.status,
	);
	check(
		checks,
		"submittedAt clock",
		submitted
			? draft.submittedAt?.toISOString() === asOf.toISOString()
			: draft.submittedAt === null,
		draft.submittedAt?.toISOString() ?? "null",
	);

	const confirmed = await readConfirmations(deps.appDb, draft.id);
	const appDocs = await deps.appDb
		.select()
		.from(documentFiles)
		.where(eq(documentFiles.applicationId, draft.id));
	const liveAppDocs = appDocs.filter((d) => d.status !== "deleted");
	const checklist = requirementsFor({
		product: draft.product as "personal_loan" | "sme_term_loan",
		asOf,
		profile: {
			kycStatus: profile.kycStatus,
			kycExpiresAt: profile.kycExpiresAt,
			identity: (profile.identity ?? {}) as Record<string, unknown>,
			business: (profile.business ?? null) as Record<string, unknown> | null,
		},
		application: {
			identity: (draft.identity ?? {}) as Record<string, unknown>,
			sme: (draft.business ?? null) as Record<string, unknown> | null,
			consents: draft.consents,
			documentProcessingConsent: draft.documentProcessingConsent,
		},
		confirmedFields: confirmed,
		appDocs: liveAppDocs.map((d) => ({
			kind: d.kind,
			status: d.status,
			periodEnd: d.periodEnd,
			documentDate: d.documentDate,
			uploadedAt: d.uploadedAt,
			id: d.id,
			documentDateSource: (d as { documentDateSource?: string | null }).documentDateSource ?? null,
		})),
		customerDocs: docs.map((d) => ({
			id: d.id,
			kind: d.kind,
			status: d.status,
			scanStatus: d.scanStatus,
			retentionUntil: d.retentionUntil,
			blobPurgedAt: d.blobPurgedAt,
			periodEnd: d.periodEnd,
			documentDate: d.documentDate,
		})),
	});

	if (phase === "post-submit") {
		check(
			checks,
			"checklist ready at submit",
			checklist.readyToSubmit,
			JSON.stringify(checklist.blockers),
		);
	} else {
		// Pre/post-refresh expect the manifest blockers exactly (alex ships
		// ready with `{}`); post-attach expects ready with stale demotion.
		const expectReady =
			phase === "post-attach" || Object.keys(persona.expectedBlockers).length === 0;
		check(
			checks,
			expectReady ? "checklist ready" : "checklist blocked",
			checklist.readyToSubmit === expectReady,
			JSON.stringify(checklist.blockers),
		);
		if (!expectReady) {
			check(
				checks,
				"expected blockers",
				sameJson(checklist.blockers, persona.expectedBlockers),
				`want ${JSON.stringify(persona.expectedBlockers)}`,
			);
		} else {
			check(
				checks,
				"no blockers",
				sameJson(checklist.blockers, {}),
				JSON.stringify(checklist.blockers),
			);
		}
		if (phase === "post-attach" && persona.case.staleCopies.length > 0) {
			const staleWarnings = checklist.warnings.filter((w) => w.code === "superseded_stale");
			check(
				checks,
				"stale copies demoted to warnings",
				staleWarnings.length > 0,
				`${staleWarnings.length} warnings`,
			);
		}
	}

	const submittedEvents = await deps.appDb
		.select({ id: outboxEvents.id })
		.from(outboxEvents)
		.where(eq(outboxEvents.dedupeKey, dedupeApplicationSubmitted(draft.id)));
	if (submitted) {
		check(
			checks,
			"submit outbox once",
			submittedEvents.length === 1,
			`${submittedEvents.length} application.submitted rows`,
		);
	} else {
		check(
			checks,
			"no submit side effects",
			submittedEvents.length === 0 && draft.workflowStartedAt === null,
			`${submittedEvents.length} events`,
		);
	}

	// T11 run absence/presence (research DB only; the worker owns the run).
	// T18 expected signals ride the same query, gated on mode:
	// - no research DB / no runs: seam pass (flags-off, D2b/D3).
	// - latest contextStatus !== 'succeeded' (skipped/failed/not_applicable,
	//   e.g. T18 disabled): no exact expectation — pass with status noted.
	// - stub runs (`demo:context-stub` marker in case_facts): the manifest's
	//   expected signals must match exactly — a fabricated fallback (or any
	//   extra type) fails, and `insufficient_data` must pair type with status.
	// - live runs: the model selects candidates, so exact types remain
	//   stub-pinned; require non-empty output using only deterministic metric
	//   types (no fabricated signal kinds).
	const researchDb = deps.researchDb;
	if (!researchDb) {
		check(checks, "t11 run", true, "research DB not configured — seam for D2b/D3");
		check(checks, "t18 expected signals", true, "research DB not configured — seam for D2b/D3");
	} else {
		const runRows = await researchDb
			.select()
			.from(agentRuns)
			.where(eq(agentRuns.applicationId, draft.id));
		if (submitted) {
			check(
				checks,
				"t11 run",
				true,
				`${runRows.length} runs (worker-dependent seam — submit only guarantees the trigger event)`,
			);
		} else {
			check(checks, "no t11 run", runRows.length === 0, `${runRows.length} runs`);
		}
		if (runRows.length === 0) {
			check(checks, "t18 expected signals", true, "no runs yet — officer/D3 seam");
		} else {
			const latest = [...runRows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
			const sigRows = await researchDb
				.select()
				.from(contextSignals)
				.where(and(eq(contextSignals.runId, latest.id), isNull(contextSignals.supersededAt)));
			// Duplicated from scripts/demo-context-stub.ts (that module
			// runs CLI code on import, so verify must not import it).
			const isStub =
				(latest.caseFacts as Record<string, unknown> | null)?.["stub"] === "demo-context-stub-v1";
			for (const c of checkExpectedSignals({
				contextStatus: latest.contextStatus,
				isStub,
				actual: sigRows.map((s) => ({ type: s.type, status: s.status })),
				expected: persona.expectedSignals,
				runShortId: latest.id.slice(0, 8),
			})) {
				check(checks, c.name, c.ok, c.detail);
			}
		}
	}

	// T02 expected findings: compare only when a succeeded crosscheck exists.
	const runs = await deps.appDb
		.select()
		.from(documentCrosschecks)
		.where(eq(documentCrosschecks.applicationId, draft.id));
	const succeeded = runs.filter((r) => r.status === "succeeded");
	if (succeeded.length === 0) {
		check(checks, "t02 findings", true, "no succeeded crosscheck yet — officer/D3 seam");
	} else {
		const latest = succeeded.sort((a, b) => (a.finishedAt! < b.finishedAt! ? 1 : -1))[0];
		const findings = await deps.appDb
			.select()
			.from(documentFindings)
			.where(eq(documentFindings.crosscheckId, latest.id));
		const filesById = new Map(liveAppDocs.map((d) => [d.id, d.kind]));
		const actual = findings.map((f) => ({
			kind: f.documentFileId ? (filesById.get(f.documentFileId) ?? "?") : "?",
			field: f.field,
			status: f.status,
		}));
		const match =
			actual.length === persona.expectedFindings.length &&
			persona.expectedFindings.every((want) =>
				actual.some(
					(got) => got.kind === want.kind && got.field === want.field && got.status === want.status,
				),
			);
		check(checks, "t02 findings", match, JSON.stringify(actual));
	}

	const failed = checks.filter((c) => !c.ok).length;
	return { checks, failed };
}
