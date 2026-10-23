// D3a unit: deterministic v1 candidate-signal boundaries, benign
// lookalikes, insufficient data, window clamping, and the HMAC cursor.
// Pure — no DB.
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../../src/context/cursor.js";
import {
	CONTEXT_METRICS_POLICY_VERSION,
	computeCandidateSignals,
	contextWindow,
	type MetricTx,
	type SignalInput,
	type SignalType,
} from "../../src/context/metrics.js";

const FROM = new Date("2026-01-01T00:00:00Z");
const TO = new Date("2026-06-30T00:00:00Z");
const ACCT = "11111111-1111-4111-8111-111111111111";
const ACCT2 = "22222222-2222-4222-8222-222222222222";

const THRESHOLDS = {
	historyMonths: 6,
	negativeBalanceDays: 3,
	revenueConcentrationPct: 40,
	cashDepositSharePct: 25,
	fcfVariancePct: 30,
};

let seq = 0;
function tx(over: Partial<MetricTx> & { postedAt: Date }): MetricTx {
	seq += 1;
	return {
		id: `tx-${seq}`,
		accountId: ACCT,
		amountCents: 1000,
		balanceAfterCents: 1_000_000,
		counterparty: null,
		category: "transfer",
		returned: false,
		...over,
	};
}

function input(over: Partial<SignalInput> = {}): SignalInput {
	return {
		transactions: [],
		window: { from: FROM, to: TO },
		declaredMonthlyFcfCents: null,
		scopeAccountIds: [ACCT],
		thresholds: THRESHOLDS,
		...over,
	};
}

function types(signals: ReturnType<typeof computeCandidateSignals>): SignalType[] {
	return signals.map((s) => s.type);
}

const day = (iso: string): Date => new Date(`${iso}T12:00:00Z`);

describe("insufficient_data", () => {
	it("is the only signal on empty input, with scope and policy version", () => {
		const signals = computeCandidateSignals(input());
		expect(signals).toHaveLength(1);
		expect(signals[0]).toMatchObject({
			type: "insufficient_data",
			metric: "usable_rows",
			observed: 0,
			status: "insufficient_data",
			confidence: "low",
			policyVersion: CONTEXT_METRICS_POLICY_VERSION,
			accountScope: ACCT,
			evidence: [],
		});
		expect(signals[0]?.periodStart).toBe("2026-01-01");
		expect(signals[0]?.periodEnd).toBe("2026-06-30");
	});

	it("uses accountScope all for multi-account scope", () => {
		const signals = computeCandidateSignals(input({ scopeAccountIds: [ACCT, ACCT2] }));
		expect(signals[0]?.accountScope).toBe("all");
	});
});

describe("negative_balance", () => {
	const negativeDay = (iso: string, n: number): MetricTx[] => [
		tx({ postedAt: day(iso), amountCents: -5000, balanceAfterCents: 900_000 - n }),
		tx({
			postedAt: new Date(`${iso}T18:00:00Z`),
			amountCents: -1000,
			balanceAfterCents: -(n * 100),
		}),
	];

	it("fires at exactly 3 end-of-day negatives", () => {
		const signals = computeCandidateSignals(
			input({
				transactions: [
					...negativeDay("2026-02-01", 1),
					...negativeDay("2026-03-01", 2),
					...negativeDay("2026-04-01", 3),
				],
			}),
		);
		expect(types(signals)).toContain("negative_balance");
		const hit = signals.find((s) => s.type === "negative_balance");
		expect(hit).toMatchObject({
			metric: "negative_eod_days",
			observed: 3,
			expected: 0,
			status: "review",
		});
		expect(hit?.evidence).toHaveLength(3);
	});

	it("stays silent at 2 negatives (benign overdraft)", () => {
		const signals = computeCandidateSignals(
			input({ transactions: [...negativeDay("2026-02-01", 1), ...negativeDay("2026-03-01", 2)] }),
		);
		expect(types(signals)).not.toContain("negative_balance");
	});

	it("ignores intraday dips recovered by end of day", () => {
		const signals = computeCandidateSignals(
			input({
				transactions: [
					tx({ postedAt: day("2026-02-01"), amountCents: -2_000_000, balanceAfterCents: -500 }),
					tx({
						postedAt: new Date("2026-02-01T18:00:00Z"),
						amountCents: 1000,
						balanceAfterCents: 500,
					}),
					tx({ postedAt: day("2026-03-01"), amountCents: -2_000_000, balanceAfterCents: -700 }),
					tx({
						postedAt: new Date("2026-03-01T18:00:00Z"),
						amountCents: 1000,
						balanceAfterCents: 300,
					}),
					tx({ postedAt: day("2026-04-01"), amountCents: -2_000_000, balanceAfterCents: -900 }),
					tx({
						postedAt: new Date("2026-04-01T18:00:00Z"),
						amountCents: 1000,
						balanceAfterCents: 100,
					}),
				],
			}),
		);
		expect(types(signals)).not.toContain("negative_balance");
	});
});

describe("revenue_concentration", () => {
	const inflow = (iso: string, amount: number, cp: string | null): MetricTx =>
		tx({ postedAt: day(iso), amountCents: amount, counterparty: cp, category: "income" });

	it("fires at exactly 40% over 3 months", () => {
		const signals = computeCandidateSignals(
			input({
				transactions: [
					inflow("2026-01-10", 40_000, "Acme Corp"),
					inflow("2026-01-11", 60_000, "Other One"),
					inflow("2026-03-10", 40_000, "Acme Corp"),
					inflow("2026-03-11", 60_000, "Other Two"),
					inflow("2026-05-10", 40_000, "ACME corp"),
					inflow("2026-05-11", 60_000, "Other Three"),
				],
			}),
		);
		expect(types(signals)).toContain("revenue_concentration");
		const hit = signals.find((s) => s.type === "revenue_concentration");
		expect(hit).toMatchObject({ metric: "top_inflow_share", observed: 0.4, expected: 0.4 });
	});

	it("stays silent below the threshold (diversified lookalike)", () => {
		const split = (iso: string): MetricTx[] => [
			inflow(iso, 33_000, "Acme"),
			inflow(iso, 33_000, "Beta"),
			inflow(iso, 34_000, "Gamma"),
		];
		const signals = computeCandidateSignals(
			input({
				transactions: [...split("2026-01-10"), ...split("2026-03-10"), ...split("2026-05-10")],
			}),
		);
		expect(types(signals)).not.toContain("revenue_concentration");
	});

	it("needs 3 months of data even at 100% share", () => {
		const signals = computeCandidateSignals(
			input({
				transactions: [inflow("2026-05-10", 50_000, "Solo"), inflow("2026-05-11", 50_000, "Solo")],
			}),
		);
		expect(types(signals)).not.toContain("revenue_concentration");
	});

	it("ignores unattributed (null counterparty) inflows", () => {
		const signals = computeCandidateSignals(
			input({
				transactions: [
					inflow("2026-01-10", 90_000, null),
					inflow("2026-03-10", 90_000, null),
					inflow("2026-05-10", 90_000, null),
					inflow("2026-05-11", 10_000, "Named"),
				],
			}),
		);
		expect(types(signals)).not.toContain("revenue_concentration");
	});
});

describe("round_trip", () => {
	const leg = (iso: string, amount: number): MetricTx =>
		tx({ postedAt: day(iso), amountCents: amount });

	it("fires on two same-amount in/out pairs within 3 days", () => {
		const signals = computeCandidateSignals(
			input({
				transactions: [
					leg("2026-02-05", -50_000),
					leg("2026-02-06", 50_000),
					leg("2026-04-01", 50_000),
					leg("2026-04-03", -50_000),
				],
			}),
		);
		expect(types(signals)).toContain("round_trip");
		const hit = signals.find((s) => s.type === "round_trip");
		expect(hit).toMatchObject({ metric: "round_trip_pairs", observed: 2, expected: 0 });
		expect(hit?.evidence).toHaveLength(4);
	});

	it("a single pair is a benign lookalike", () => {
		const signals = computeCandidateSignals(
			input({ transactions: [leg("2026-02-05", -50_000), leg("2026-02-06", 50_000)] }),
		);
		expect(types(signals)).not.toContain("round_trip");
	});

	it("same amounts 4 days apart never pair", () => {
		const signals = computeCandidateSignals(
			input({
				transactions: [
					leg("2026-02-05", -50_000),
					leg("2026-02-09", 50_000),
					leg("2026-04-01", -50_000),
					leg("2026-04-05", 50_000),
				],
			}),
		);
		expect(types(signals)).not.toContain("round_trip");
	});

	it("same-direction repeats never pair", () => {
		const signals = computeCandidateSignals(
			input({
				transactions: [
					leg("2026-02-05", 50_000),
					leg("2026-02-06", 50_000),
					leg("2026-02-07", 50_000),
				],
			}),
		);
		expect(types(signals)).not.toContain("round_trip");
	});
});

describe("cash_deposit_share", () => {
	const cashIn = (iso: string, amount: number): MetricTx =>
		tx({ postedAt: day(iso), amountCents: amount, category: "cash", counterparty: null });
	const wireIn = (iso: string, amount: number): MetricTx =>
		tx({ postedAt: day(iso), amountCents: amount, category: "income", counterparty: "Bank" });

	it("fires at exactly 25% cash inflows", () => {
		const signals = computeCandidateSignals(
			input({ transactions: [cashIn("2026-02-01", 25_000), wireIn("2026-02-02", 75_000)] }),
		);
		expect(types(signals)).toContain("cash_deposit_share");
		expect(signals.find((s) => s.type === "cash_deposit_share")).toMatchObject({
			metric: "cash_inflow_share",
			observed: 0.25,
			expected: 0.25,
		});
	});

	it("stays silent below the threshold", () => {
		const signals = computeCandidateSignals(
			input({ transactions: [cashIn("2026-02-01", 20_000), wireIn("2026-02-02", 80_000)] }),
		);
		expect(types(signals)).not.toContain("cash_deposit_share");
	});

	it("cash outflows do not count as deposits", () => {
		const signals = computeCandidateSignals(
			input({
				transactions: [
					tx({ postedAt: day("2026-02-01"), amountCents: -90_000, category: "cash" }),
					wireIn("2026-02-02", 100_000),
				],
			}),
		);
		expect(types(signals)).not.toContain("cash_deposit_share");
	});
});

describe("declared_vs_observed_cashflow", () => {
	// Window is 180 days → 6.0 months; net 4,200,000 ⇒ observed 700,000.
	const flatNet = (net: number): MetricTx[] => [
		tx({ postedAt: day("2026-01-15"), amountCents: net, category: "income", counterparty: null }),
	];

	it("fires at a 30% variance (boundary inclusive)", () => {
		const signals = computeCandidateSignals(
			input({ transactions: flatNet(4_200_000), declaredMonthlyFcfCents: 1_000_000 }),
		);
		const hit = signals.find((s) => s.type === "declared_vs_observed_cashflow");
		expect(hit).toMatchObject({
			metric: "monthly_fcf_variance",
			observed: 700_000,
			expected: 1_000_000,
		});
		// Evidence-attached: the variance cites window transactions so the
		// D3b evidence bar is satisfiable for this candidate.
		expect(hit?.evidence.length).toBeGreaterThan(0);
		expect(hit?.evidence.every((e) => e.kind === "transaction")).toBe(true);
	});

	it("stays silent under the threshold", () => {
		const signals = computeCandidateSignals(
			input({ transactions: flatNet(4_260_000), declaredMonthlyFcfCents: 1_000_000 }),
		);
		expect(types(signals)).not.toContain("declared_vs_observed_cashflow");
	});

	it("skips when nothing is declared (e.g. individual applicants)", () => {
		const signals = computeCandidateSignals(
			input({ transactions: flatNet(60_000_000), declaredMonthlyFcfCents: null }),
		);
		expect(types(signals)).not.toContain("declared_vs_observed_cashflow");
	});

	it("zero declared with zero observed is agreement, not anomaly", () => {
		const signals = computeCandidateSignals(
			input({ transactions: flatNet(0), declaredMonthlyFcfCents: 0 }),
		);
		expect(types(signals)).not.toContain("declared_vs_observed_cashflow");
	});
});

describe("returned_payment", () => {
	it("fires on the returned flag", () => {
		const signals = computeCandidateSignals(
			input({ transactions: [tx({ postedAt: day("2026-02-01"), returned: true })] }),
		);
		expect(types(signals)).toContain("returned_payment");
		expect(signals.find((s) => s.type === "returned_payment")).toMatchObject({
			metric: "returned_count",
			observed: 1,
			expected: 0,
			confidence: "high",
		});
	});

	it("fires on the returned_payment category", () => {
		const signals = computeCandidateSignals(
			input({
				transactions: [tx({ postedAt: day("2026-02-01"), category: "returned_payment" })],
			}),
		);
		expect(types(signals)).toContain("returned_payment");
	});
});

describe("window bounds", () => {
	it("ignores rows outside the window", () => {
		const signals = computeCandidateSignals(
			input({
				transactions: [
					tx({ postedAt: new Date("2025-06-01T12:00:00Z"), balanceAfterCents: -100 }),
					tx({ postedAt: new Date("2025-07-01T12:00:00Z"), balanceAfterCents: -200 }),
					tx({ postedAt: new Date("2025-08-01T12:00:00Z"), balanceAfterCents: -300 }),
					tx({ postedAt: day("2026-02-01"), balanceAfterCents: -400 }),
				],
			}),
		);
		// Only one in-window negative EOD: no signal, no insufficient_data.
		expect(signals).toHaveLength(0);
	});

	it("contextWindow subtracts calendar months from as-of", () => {
		const window = contextWindow(new Date("2026-06-30T00:00:00Z"), 6);
		expect(window.from.toISOString()).toBe("2025-12-30T00:00:00.000Z");
		expect(window.to.toISOString()).toBe("2026-06-30T00:00:00.000Z");
	});
});

describe("context cursor", () => {
	const secret = "test-cursor-secret-0123456789abcdef";
	const cursor = {
		app: "11111111-1111-4111-8111-111111111111",
		acct: "22222222-2222-4222-8222-222222222222",
		from: "2026-01-01",
		to: "2026-06-30",
		off: 500,
	};

	it("round-trips", () => {
		expect(decodeCursor(secret, encodeCursor(secret, cursor))).toEqual(cursor);
	});

	it("fails closed on tampering, wrong secret, and bad shapes", () => {
		const token = encodeCursor(secret, cursor);
		const [raw, sig] = token.split(".") as [string, string];
		expect(decodeCursor(secret, `${raw}.${"0".repeat(sig.length)}`)).toBeNull();
		expect(decodeCursor("wrong-secret", token)).toBeNull();
		expect(decodeCursor(secret, "not-a-cursor")).toBeNull();
		expect(decodeCursor(secret, encodeCursor(secret, { ...cursor, off: -1 }))).toBeNull();
		expect(decodeCursor(secret, encodeCursor(secret, { ...cursor, app: "nope" }))).toBeNull();
	});
});
