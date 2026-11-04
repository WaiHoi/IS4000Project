// Auto-memo retry policy: failures back off exponentially and stop at the cap,
// so a permanently broken case cannot burn model budget every sweep.
import { describe, expect, it } from "vitest";
import { autoMemoBackoffMs } from "../../src/assist/auto-memo.js";

describe("auto memo backoff", () => {
	it("doubles from ten minutes and caps at six hours", () => {
		expect(autoMemoBackoffMs(1)).toBe(10 * 60_000);
		expect(autoMemoBackoffMs(2)).toBe(20 * 60_000);
		expect(autoMemoBackoffMs(3)).toBe(40 * 60_000);
		expect(autoMemoBackoffMs(10)).toBe(6 * 60 * 60_000);
	});
});
