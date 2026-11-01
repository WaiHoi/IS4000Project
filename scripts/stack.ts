// pnpm start — one command for the whole local stack.
//
//   pnpm start          everything your .env can support
//   pnpm start --lite   deterministic pipeline only (no AI, no documents)
//
// Steps: bootstrap .env (copy .env.example, generate any blank/placeholder
// secrets) -> docker compose (postgres, kafka, temporal, temporal-ui, plus
// ClamAV for documents) -> setup (db wait/init, kafka topics, migrate, seed
// users) -> demo fixtures -> policy corpus (AI only) -> `pnpm dev` with the
// feature flags switched on for this run.
//
// Feature flags are derived, not hand-set: AI features turn on only when
// OPENROUTER_API_KEY is in .env (the case brief also needs TAVILY_API_KEY).
// They are passed as process env, which wins over .env in every service
// (Bun --env-file and dotenv both keep existing env), so .env is never
// rewritten except to fill missing secrets. Anything you export in your
// shell before running still wins over this script.
//
// Advisory-only rule unchanged: these flags enable research/drafting
// surfaces; no flag lets model output reach a score, decision, term, or
// booking.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const lite = process.argv.includes("--lite");
// Commands run through the shell: inside a pnpm script, `pnpm` on PATH is a
// shim Bun can't exec directly (ENOEXEC), and on Windows it is pnpm.cmd.
// Every argument here is a fixed literal, so there is nothing to quote.
const pnpm = "pnpm";

// ---------- .env bootstrap ----------

const hex = (): string => randomBytes(32).toString("hex");
const b64 = (): string => randomBytes(32).toString("base64");

/** Secrets every service needs; generated once and kept in .env. */
const SECRETS: Record<string, () => string> = {
	SESSION_SECRET: hex,
	INTERNAL_SECRET: hex,
	POLICY_INTERNAL_SECRET: hex,
	POLICY_CASE_TOKEN_SECRET: hex,
	POLICY_RULE_CONTEXT_SECRET: hex,
	POLICY_CITATION_SECRET: hex,
	POLICY_AUDIT_HASH_SECRET: hex,
	DOCUMENT_ENCRYPTION_KEY: b64,
};

function parseEnv(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
		if (m) out.set(m[1]!, m[2]!.trim());
	}
	return out;
}

function bootstrapEnv(): Map<string, string> {
	if (!existsSync(ENV_PATH)) {
		copyFileSync(join(ROOT, ".env.example"), ENV_PATH);
		console.log("created .env from .env.example");
	}
	let text = readFileSync(ENV_PATH, "utf8");
	const current = parseEnv(text);
	const filled: string[] = [];
	for (const [key, gen] of Object.entries(SECRETS)) {
		const value = current.get(key) ?? "";
		if (value !== "" && !value.startsWith("change-me")) continue;
		const line = `${key}=${gen()}`;
		text = current.has(key)
			? text.replace(new RegExp(`^${key}=.*$`, "m"), line)
			: `${text.replace(/\n?$/, "\n")}${line}\n`;
		filled.push(key);
	}
	if (filled.length > 0) {
		writeFileSync(ENV_PATH, text);
		console.log(`generated secrets in .env: ${filled.join(", ")}`);
	}
	return parseEnv(text);
}

// ---------- helpers ----------

function run(label: string, cmd: string, args: string[], env?: NodeJS.ProcessEnv): boolean {
	console.log(`\n▶ ${label}`);
	const res = spawnSync(cmd, args, {
		cwd: ROOT,
		stdio: "inherit",
		env: env ?? process.env,
		shell: true,
	});
	return res.status === 0;
}

function must(label: string, cmd: string, args: string[], env?: NodeJS.ProcessEnv): void {
	if (!run(label, cmd, args, env)) {
		console.error(`\n✖ ${label} failed — fix the error above and re-run pnpm start`);
		process.exit(1);
	}
}

/** ClamAV answers PING with PONG once its signature database is loaded. */
function clamdReady(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = connect({ host: "127.0.0.1", port }, () => sock.write("PING\n"));
		let buf = "";
		sock.setTimeout(2000);
		sock.on("data", (d) => (buf += d.toString()));
		sock.on("end", () => resolve(buf.includes("PONG")));
		sock.on("timeout", () => (sock.destroy(), resolve(buf.includes("PONG"))));
		sock.on("error", () => resolve(false));
	});
}

async function waitForClamd(port: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	process.stdout.write("waiting for ClamAV to load signatures (first run takes a few minutes)");
	while (Date.now() < deadline) {
		if (await clamdReady(port)) {
			console.log(" ready");
			return true;
		}
		process.stdout.write(".");
		await new Promise((r) => setTimeout(r, 3000));
	}
	console.log(" timed out");
	return false;
}

// ---------- main ----------

const dotenv = bootstrapEnv();
const has = (key: string): boolean => (process.env[key] ?? dotenv.get(key) ?? "").trim() !== "";
const ai = !lite && has("OPENROUTER_API_KEY");
const brief = ai && has("TAVILY_API_KEY");
let docs = !lite;

must("docker: postgres, kafka, temporal", "docker", ["compose", "up", "-d", "--wait"]);
if (docs) {
	// ClamAV lives in the services overlay; naming it starts it without the
	// rest of that profile.
	docs = run("docker: clamav (document virus scanning)", "docker", [
		"compose",
		"-f",
		"docker-compose.yml",
		"-f",
		"compose.services.yml",
		"up",
		"-d",
		"clamav",
	]);
}
must("setup: databases, kafka topics, migrations, users", pnpm, ["run", "setup"]);
run("demo fixtures (customers, accounts, evidence)", pnpm, ["run", "demo:seed"]);
if (docs) docs = await waitForClamd(Number(dotenv.get("CLAMAV_PORT") ?? 3310), 5 * 60_000);
const policy =
	ai &&
	run("policy corpus (embeddings via OpenRouter)", pnpm, ["--filter", "@credit/policy", "seed"]);

const on = (b: boolean): string => (b ? "true" : "false");
const flags: Record<string, string> = {
	DEMO_MODE: "true",
	// Deterministic surfaces (no model).
	ASSIST_ENABLED: on(!lite),
	DOCUMENT_FEATURE_ENABLED: on(docs),
	DOCUMENT_INTEGRITY_ENABLED: on(docs),
	FRAUD_REVIEW_ENABLED: on(docs),
	// Advisory AI (OpenRouter).
	ASSIST_MEMO_WRITER: ai ? "agent" : "deterministic",
	ASSIST_POLICY_EXCEPTION_ENABLED: on(ai && policy),
	AGENTS_ENABLED: on(ai),
	CASE_ASSISTANT_ENABLED: on(ai),
	CONTEXT_ANALYST_ENABLED: on(ai),
	AGENT_CASE_BRIEF_ENABLED: on(brief),
	POLICY_ASSIST_ENABLED: on(policy),
	DOCUMENT_INTEGRITY_AGENT_ENABLED: on(ai && docs),
	DOCUMENT_INTEGRITY_TRIAGE_ENABLED: on(ai && docs),
};
// A flag you exported in your shell beats the derived value.
const env: NodeJS.ProcessEnv = { ...process.env };
for (const [key, value] of Object.entries(flags)) env[key] ??= value;

const why = (b: boolean, reason: string): string => (b ? "on " : `off  (${reason})`);
const noKey = lite ? "--lite" : "no OPENROUTER_API_KEY in .env";
console.log(`
┌ credit pipeline — ${lite ? "lite" : "full"} stack
│ pipeline (apply → score → decide → book → monitor)  on
│ documents + integrity panel + fraud review          ${why(docs, lite ? "--lite" : "ClamAV not ready")}
│ credit memo (template) + adverse-action letter      ${why(!lite, "--lite")}${!lite && !has("ASSIST_ADVERSE_CONTACT_PATH") ? "  (letter needs ASSIST_ADVERSE_CONTACT_PATH)" : ""}
│ AI: memo writer, case assistant, context analyst    ${why(ai, noKey)}
│ AI: external case brief                             ${why(brief, ai ? "no TAVILY_API_KEY in .env" : noKey)}
│ AI: policy navigator + case review + exceptions     ${why(policy, ai ? "policy corpus seed failed" : noKey)}
│ AI: document integrity analysis + triage            ${why(ai && docs, ai ? "documents off" : noKey)}
│ auto-research on every referral                     off  (spends automatically; set AGENT_AUTO_TRIGGER_ENABLED=true)
│
│ web       http://localhost:3000   (password demo1234: maria@example.com, officer@example.com, …)
│ api       http://127.0.0.1:3001/api/health
│ temporal  http://localhost:8080
└ Ctrl+C stops the app processes; \`docker compose down\` stops the containers.
`);

const dev = spawn(pnpm, ["dev"], { cwd: ROOT, stdio: "inherit", env, shell: true });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => dev.kill(sig));
dev.on("exit", (code) => process.exit(code ?? 0));
