import { describe, expect, it } from "vitest";
import { applyFlags, deriveFlags } from "../lib/stack-flags.js";

const full = { lite: false, ai: true, brief: true, docs: true, policy: true };

describe("pnpm start flags", () => {
	it("turns every surface on when the keys and ClamAV are there", () => {
		const flags = deriveFlags(full);
		for (const key of [
			"DOCUMENT_FEATURE_ENABLED",
			"AGENTS_ENABLED",
			"AGENT_CASE_BRIEF_ENABLED",
			"CONTEXT_ANALYST_ENABLED",
			"POLICY_ASSIST_ENABLED",
		]) {
			expect(flags[key]).toBe("true");
		}
		expect(flags.ASSIST_MEMO_WRITER).toBe("agent");
	});

	it("keeps AI off without an OpenRouter key and everything off in lite", () => {
		expect(deriveFlags({ ...full, ai: false, brief: false, policy: false }).AGENTS_ENABLED).toBe(
			"false",
		);
		const lite = deriveFlags({ lite: true, ai: false, brief: false, docs: false, policy: false });
		expect(lite.ASSIST_ENABLED).toBe("false");
		expect(lite.DOCUMENT_FEATURE_ENABLED).toBe("false");
	});

	it("overrides values that came from .env (the Bun auto-load regression)", () => {
		const dotenv = new Map([
			["AGENTS_ENABLED", "false"],
			["DOCUMENT_FEATURE_ENABLED", "false"],
		]);
		const shell = { AGENTS_ENABLED: "false", DOCUMENT_FEATURE_ENABLED: "false", PATH: "/bin" };
		const env = applyFlags(shell, dotenv, deriveFlags(full));
		expect(env.AGENTS_ENABLED).toBe("true");
		expect(env.DOCUMENT_FEATURE_ENABLED).toBe("true");
		expect(env.PATH).toBe("/bin");
	});

	it("lets a deliberate shell export win", () => {
		const dotenv = new Map([["AGENTS_ENABLED", "false"]]);
		const env = applyFlags({ AGENT_CASE_BRIEF_ENABLED: "false" }, dotenv, deriveFlags(full));
		expect(env.AGENT_CASE_BRIEF_ENABLED).toBe("false");
		expect(env.AGENTS_ENABLED).toBe("true");
	});
});

describe("withNodeProxy", () => {
	it("enables Node's env proxy only when a proxy is configured", async () => {
		const { withNodeProxy } = await import("../lib/stack-flags.js");
		expect(withNodeProxy({ HTTPS_PROXY: "http://proxy:8080" }).NODE_USE_ENV_PROXY).toBe("1");
		expect(withNodeProxy({ https_proxy: "http://proxy:8080" }).NODE_USE_ENV_PROXY).toBe("1");
		expect(withNodeProxy({ PATH: "/bin" }).NODE_USE_ENV_PROXY).toBeUndefined();
		expect(
			withNodeProxy({ HTTPS_PROXY: "http://p", NODE_USE_ENV_PROXY: "0" }).NODE_USE_ENV_PROXY,
		).toBe("0");
	});
});
