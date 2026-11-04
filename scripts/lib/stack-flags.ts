// Feature-flag derivation for `pnpm start` (scripts/stack.ts), kept pure so
// it is unit-tested. Flags follow the keys in .env; a shell export wins only
// when it differs from .env, so values that leaked in from .env (Bun
// auto-loads .env unless run with --no-env-file) can never pass for
// deliberate overrides.

export interface StackCapabilities {
	lite: boolean;
	ai: boolean;
	brief: boolean;
	docs: boolean;
	policy: boolean;
}

export function deriveFlags(c: StackCapabilities): Record<string, string> {
	const on = (b: boolean): string => (b ? "true" : "false");
	return {
		DEMO_MODE: "true",
		// Deterministic surfaces (no model).
		ASSIST_ENABLED: on(!c.lite),
		DOCUMENT_FEATURE_ENABLED: on(c.docs),
		DOCUMENT_INTEGRITY_ENABLED: on(c.docs),
		FRAUD_REVIEW_ENABLED: on(c.docs),
		// Advisory AI (OpenRouter).
		ASSIST_MEMO_WRITER: c.ai ? "agent" : "deterministic",
		ASSIST_MEMO_AUTO_ENABLED: on(c.ai),
		ASSIST_POLICY_EXCEPTION_ENABLED: on(c.ai && c.policy),
		AGENTS_ENABLED: on(c.ai),
		CASE_ASSISTANT_ENABLED: on(c.ai),
		CONTEXT_ANALYST_ENABLED: on(c.ai),
		AGENT_CASE_BRIEF_ENABLED: on(c.brief),
		POLICY_ASSIST_ENABLED: on(c.policy),
		AGENT_AUTO_TRIGGER_ENABLED: on(c.ai),
		DOCUMENT_INTEGRITY_AGENT_ENABLED: on(c.ai && c.docs),
		DOCUMENT_INTEGRITY_TRIAGE_ENABLED: on(c.ai && c.docs),
	};
}

/**
 * True when .env's values are already in `shell` (Bun auto-loads .env unless
 * run with --no-env-file). Detected via SESSION_SECRET: generated into .env
 * by pnpm start and never exported by hand.
 */
export function dotenvLeaked(
	shell: Record<string, string | undefined>,
	dotenv: ReadonlyMap<string, string>,
): boolean {
	const secret = dotenv.get("SESSION_SECRET");
	return secret !== undefined && secret !== "" && shell.SESSION_SECRET === secret;
}

/**
 * The env the services start with: derived flags, except where the shell
 * exported a flag deliberately. With a clean shell any exported value is
 * deliberate; if .env leaked into the shell, only values that differ from
 * .env count (a leaked .env default must never pass for an override).
 */
export function applyFlags(
	shell: Record<string, string | undefined>,
	dotenv: ReadonlyMap<string, string>,
	flags: Record<string, string>,
): Record<string, string | undefined> {
	const leaked = dotenvLeaked(shell, dotenv);
	const env = { ...shell };
	for (const [key, value] of Object.entries(flags)) {
		const exported = shell[key];
		const override = exported !== undefined && (!leaked || exported !== dotenv.get(key));
		if (!override) env[key] = value;
	}
	return env;
}

/**
 * Behind an HTTPS proxy (corporate networks, sandboxes) Node's built-in
 * fetch ignores HTTPS_PROXY, so the Node services (research, agent workers)
 * can't reach OpenRouter/Tavily while Bun services can. Node >= 22.21 honours
 * the proxy env when NODE_USE_ENV_PROXY=1; NO_PROXY keeps localhost direct.
 * No proxy configured, or an explicit NODE_USE_ENV_PROXY: unchanged.
 */
export function withNodeProxy(
	env: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const proxied = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].some(
		(key) => (env[key] ?? "").trim() !== "",
	);
	if (!proxied || env.NODE_USE_ENV_PROXY !== undefined) return env;
	return { ...env, NODE_USE_ENV_PROXY: "1" };
}
