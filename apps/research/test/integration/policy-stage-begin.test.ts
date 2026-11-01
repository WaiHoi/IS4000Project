// Regression: beginPolicyStage raised the run lease with a raw
// GREATEST(timeout_at, <js Date>) — the Date went over the wire as
// Date.toString() ("... GMT+0000 (Coordinated Universal Time)"), which
// Postgres rejects, so every live case policy review failed with
// "policy stage errored unexpectedly" before calling the policy service.
import { randomUUID } from "node:crypto";
import { agentRuns } from "@credit/db/research";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/env.js";
import { beginPolicyStage, claimRun, ensureRun } from "../../src/lifecycle.js";
import { caseFacts, setupApp, teardown } from "../helper.js";

const env = loadEnv();

describe("beginPolicyStage", () => {
	it("starts the policy stage and extends the run lease past its timeout", async () => {
		const ctx = setupApp();
		try {
			const facts = caseFacts();
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			const token = run.runToken as string;
			expect(await claimRun(ctx.db, run.id, token)).toBe(true);
			// Shrink the lease so GREATEST must pick the policy timeout.
			await ctx.db
				.update(agentRuns)
				.set({ timeoutAt: new Date(Date.now() - 60_000) })
				.where(eq(agentRuns.id, run.id));

			const started = await beginPolicyStage(ctx.db, env, run.id, token, {
				model: "test-model",
				promptVersion: "policy-v1",
				documentFindings: [],
			});
			expect(started).toBe(true);

			const [row] = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
			expect(row?.policyStatus).toBe("running");
			expect(row?.timeoutAt.getTime()).toBe(row?.policyTimeoutAt?.getTime());
			expect(row!.timeoutAt.getTime()).toBeGreaterThan(Date.now());
		} finally {
			await teardown(ctx);
		}
	});
});
