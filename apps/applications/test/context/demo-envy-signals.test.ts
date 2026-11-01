// The Envy demo persona's seeded transactions must trip every deterministic
// context signal, so the live context analyst has real evidence to cite.
// Pins the fixture (fixtures/demo/manifest.json) against the production
// metric rules and default thresholds.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeCandidateSignals, contextWindow } from "../../src/context/metrics.js";

const manifest = JSON.parse(
	readFileSync(new URL("../../../../fixtures/demo/manifest.json", import.meta.url), "utf8"),
) as {
	demoAsOf: string;
	personas: Record<
		string,
		{
			accounts: Array<{ id: string }>;
			profile: { business: { monthlyFcfCents: number } | null };
			transactions: Array<{
				sourceReference: string;
				postedAt: string;
				amountCents: number;
				balanceAfterCents: number;
				counterparty: string | null;
				category: string;
				returned: boolean;
			}>;
			expectedSignals: string[];
		}
	>;
};

describe("Envy demo persona", () => {
	it("trips every deterministic context signal", () => {
		const envy = manifest.personas.envy!;
		const accountId = envy.accounts[0]!.id;
		const window = contextWindow(new Date(`${manifest.demoAsOf}T00:00:00Z`), 6);
		const signals = computeCandidateSignals({
			transactions: envy.transactions.map((t) => ({
				id: t.sourceReference,
				accountId,
				postedAt: new Date(t.postedAt),
				amountCents: t.amountCents,
				balanceAfterCents: t.balanceAfterCents,
				counterparty: t.counterparty,
				category: t.category,
				returned: t.returned,
			})),
			window,
			declaredMonthlyFcfCents: envy.profile.business!.monthlyFcfCents,
			scopeAccountIds: [accountId],
			// .env.example defaults (CONTEXT_* thresholds).
			thresholds: {
				historyMonths: 6,
				negativeBalanceDays: 3,
				revenueConcentrationPct: 40,
				cashDepositSharePct: 25,
				fcfVariancePct: 30,
			},
		});
		const types = signals.map((s) => s.type).sort();
		expect(types).toEqual([...envy.expectedSignals].sort());
	});
});
