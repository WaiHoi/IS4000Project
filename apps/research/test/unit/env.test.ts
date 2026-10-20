// Phase 1 bootstrap: `pnpm dev` starts research, so env validation must
// pass without RESEARCH_DATABASE_URL (safe local default instead).
import { createEnv } from "@t3-oss/env-core";
import { describe, expect, it } from "vitest";
import { researchServerSchema } from "../../src/env.js";

describe("research env Phase 1 bootstrap", () => {
	it("validates with only INTERNAL_SECRET set, defaulting the database URL", () => {
		const parsed = createEnv({
			server: researchServerSchema,
			runtimeEnv: { INTERNAL_SECRET: "test-secret" },
			emptyStringAsUndefined: true,
		});
		expect(parsed.RESEARCH_DATABASE_URL).toBe(
			"postgres://credit:credit@localhost:5432/credit_research",
		);
		expect(parsed.PORT).toBe(4005);
	});
});
