// `demo:refresh-evidence` library (SPEC-t17-t18 §2.5): adds the persona's
// `freshEvidence` variants as customer evidence only. It never attaches
// anything to the application — the checklist stays blocked until the
// applicant explicitly reuses the fresh documents. Idempotent by fixture key.
import type { Db } from "@credit/db/applications";
import type { CustomerConfig } from "../../apps/applications/src/customer/service.js";
import { demoAsOfDate, personaOf, type DemoManifest } from "./manifest.js";
import { findProfileByEmail, type DemoUserDirectory } from "./db-helpers.js";
import { ensureFixtureEvidence } from "./seed.js";

export interface RefreshDeps {
	appDb: Db;
	users: DemoUserDirectory;
	customerConfig: CustomerConfig;
	asOf?: Date;
}

export async function refreshDemoEvidence(
	manifest: DemoManifest,
	personaKey: string,
	deps: RefreshDeps,
): Promise<{ created: string[]; skipped: string[] }> {
	const persona = personaOf(manifest, personaKey);
	const asOf = deps.asOf ?? demoAsOfDate(manifest);
	const profile = await findProfileByEmail(deps.appDb, deps.users, persona.email);
	if (!profile) throw new Error(`demo:refresh-evidence: no profile for ${persona.email}`);
	const created: string[] = [];
	const skipped: string[] = [];
	for (const evidence of persona.freshEvidence) {
		const { outcome } = await ensureFixtureEvidence(deps.appDb, deps.customerConfig, {
			customerId: profile.id,
			evidence,
			asOf,
			retentionDays: deps.customerConfig.retentionDays,
		});
		// Repair counts as a write: a swept/tampered fresh row becomes
		// reusable again, exactly like a fresh insert.
		if (outcome === "skipped") skipped.push(evidence.fixtureKey);
		else created.push(evidence.fixtureKey);
	}
	return { created, skipped };
}
