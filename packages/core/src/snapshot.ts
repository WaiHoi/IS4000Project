// Decision snapshots (SPEC FR-10.6). Timestamps are injected by the caller —
// core never reads the clock. inputHash covers the canonical inputs only.
import { hashCanonical } from "./canonical.js";
import { type Grade, POLICY_VERSION, SCORECARD_VERSION } from "./constants.js";
import type { Factor } from "./factors.js";
import type { PolicyReason } from "./reasons.js";
import type { ResearchBundle } from "./schemas.js";

export interface CreditSnapshotInputs {
	inputs: unknown;
	score: number;
	grade: Grade;
	factors: Factor[];
	rateBps: number;
	monthlyPaymentCents: number;
	reasons: PolicyReason[];
	actor: string;
	/** Frozen research bundle, copied at decision time (optional). */
	research?: ResearchBundle;
	/** ISO-8601 UTC timestamp of the decision (not part of inputHash). */
	decidedAt: string;
}

export interface CreditSnapshot extends CreditSnapshotInputs {
	kind: "credit";
	scorecardVersion: string;
	policyVersion: string;
	inputHash: string;
}

export function buildCreditSnapshot(args: CreditSnapshotInputs): CreditSnapshot {
	return {
		kind: "credit",
		...args,
		scorecardVersion: SCORECARD_VERSION,
		policyVersion: POLICY_VERSION,
		inputHash: hashCanonical(args.inputs),
	};
}

export interface CheckOnlySnapshotInputs {
	checks: { type: string; status: "passed" | "failed" }[];
	reasons: PolicyReason[];
	actor: string;
	research?: ResearchBundle;
	decidedAt: string;
}

export interface CheckOnlySnapshot extends CheckOnlySnapshotInputs {
	kind: "check_only";
	inputHash: string;
}

export function buildCheckOnlySnapshot(
	args: CheckOnlySnapshotInputs & { inputs: unknown },
): CheckOnlySnapshot {
	const { inputs, ...rest } = args;
	return { kind: "check_only", ...rest, inputHash: hashCanonical(inputs) };
}
