// T18 internal context surface, D3a (SPEC-t17-t18 §2.3/§3.2/§3.3): config,
// deterministic metrics, and the HMAC page cursor. D3b (LLM agent runner)
// and D4 (T11 stage/UI) consume the internal routes; nothing here calls a
// model, the web, or writes data.
import type { ApplicationsEnv } from "../env.js";

export * from "./cursor.js";
export * from "./metrics.js";

export interface ContextConfig {
	historyMonths: number;
	negativeBalanceDays: number;
	revenueConcentrationPct: number;
	cashDepositSharePct: number;
	fcfVariancePct: number;
	cursorSecret: string;
	pageLimit: number;
	maxPages: number;
	maxAccounts: number;
}

/** Env-derived config; the cursor falls back to the internal service secret
 * when no dedicated secret is configured. Test seams override per field. */
export function resolveContextConfig(
	env: ApplicationsEnv,
	overrides: Partial<ContextConfig> = {},
): ContextConfig {
	return {
		historyMonths: env.context.historyMonths,
		negativeBalanceDays: env.context.negativeBalanceDays,
		revenueConcentrationPct: env.context.revenueConcentrationPct,
		cashDepositSharePct: env.context.cashDepositSharePct,
		fcfVariancePct: env.context.fcfVariancePct,
		cursorSecret: env.context.cursorSecret ?? env.internalSecret,
		pageLimit: env.context.pageLimit,
		maxPages: env.context.maxPages,
		maxAccounts: env.context.maxAccounts,
		...overrides,
	};
}
