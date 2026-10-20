import { fileURLToPath } from "node:url";
import { createEnv } from "@t3-oss/env-core";
import dotenv from "dotenv";
import { z } from "zod";

// Root env via dotenv (Node/Vitest); compose provides real env, which wins.
dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

export const ALLOWED_MODELS = [
	"deepseek/deepseek-v4.1-flash-1017",
	"meta/muse-spark-1.3-contributor",
] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];

export const DEFAULT_MODEL: AllowedModel = "deepseek/deepseek-v4.1-flash-1017";

// Exported for the Phase 1 bootstrap test: validation must pass with only
// INTERNAL_SECRET set (dotenv fills the rest from the root .env in prod).
export const researchServerSchema = {
	// Safe local default (matches `.env.example`/compose): a Phase 1
	// checkout without this line still boots; the research DB simply has
	// no tables until `pnpm db:migrate` creates them.
	RESEARCH_DATABASE_URL: z
		.string()
		.min(1)
		.default("postgres://credit:credit@localhost:5432/credit_research"),
	INTERNAL_SECRET: z.string().min(1),
	PORT: z.coerce.number().int().min(1).max(65_535).default(4005),
	HOST: z.string().min(1).default("127.0.0.1"),
	// Hard constraint (§6.1): exactly these two IDs; unknown fails startup.
	AGENT_MODEL: z.enum(ALLOWED_MODELS).default(DEFAULT_MODEL),
	// Empty by default so tests/health boot without keys; a run fails
	// closed with config_error when the key it needs is missing.
	OPENROUTER_API_KEY: z.string().default(""),
	TAVILY_API_KEY: z.string().default(""),
	// Readiness gate (§10): model/tool keys are required only when the
	// feature is enabled; a compliant disabled deployment is healthy.
	AGENTS_ENABLED: z.string().default("false"),
	AGENT_MAX_SOURCES: z.coerce.number().int().min(1).max(20).default(6),
	AGENT_MAX_FETCHES: z.coerce.number().int().min(1).max(20).default(4),
	AGENT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(90_000),
	AGENT_MAX_COST_USD: z.coerce.number().min(0).default(0.15),
};

const parsed = createEnv({
	server: researchServerSchema,
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});

export const env = {
	databaseUrl: parsed.RESEARCH_DATABASE_URL,
	internalSecret: parsed.INTERNAL_SECRET,
	port: parsed.PORT,
	host: parsed.HOST,
	agentModel: parsed.AGENT_MODEL as AllowedModel,
	openrouterApiKey: parsed.OPENROUTER_API_KEY,
	tavilyApiKey: parsed.TAVILY_API_KEY,
	maxSources: parsed.AGENT_MAX_SOURCES,
	maxFetches: parsed.AGENT_MAX_FETCHES,
	timeoutMs: parsed.AGENT_TIMEOUT_MS,
	maxCostUsd: parsed.AGENT_MAX_COST_USD,
	agentsEnabled: parsed.AGENTS_ENABLED.trim().toLowerCase() === "true",
};

export type ResearchEnv = typeof env;

export function loadEnv(): ResearchEnv {
	return env;
}
