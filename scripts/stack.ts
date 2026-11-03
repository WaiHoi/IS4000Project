// pnpm start — one command for the whole local stack.
//
//   pnpm start          everything your .env can support
//   pnpm start --lite   deterministic pipeline only (no AI, no documents)
//   pnpm start --local  backend services as host processes (hot reload)
//
// By default the backend services, the pipeline worker and both agent
// workers run as containers built from apps/<service>/Dockerfile
// (docker-compose.yml, profile microservices);
// only the web app (Vite) runs on the host. --local keeps everything but the
// infra on the host via `pnpm dev`.
//
// Steps: bootstrap .env (copy .env.example, generate any blank/placeholder
// secrets) -> docker compose (postgres, kafka, temporal, temporal-ui, plus
// ClamAV for documents) -> setup (db wait/init, kafka topics, migrate, seed
// users) -> `pnpm dev` with the feature flags switched on for this run ->
// once every service is healthy, seed reference data (demo customer
// profiles + evidence, policy corpus) -> print what is on.
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
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyFlags, deriveFlags, withNodeProxy } from "./lib/stack-flags.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const lite = process.argv.includes("--lite");
const local = process.argv.includes("--local");
const COMPOSE = ["compose"];
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

// TLS-inspecting networks (corporate proxies, sandboxes) re-sign HTTPS with
// their own CA. The host trusts it via NODE_EXTRA_CA_CERTS; containers and
// image builds don't, so npm and the OpenRouter/Tavily calls would fail.
// .data/extra-ca.pem is the compose build secret (always written; empty when
// the host has no extra CA) and is mounted at /app/.data for runtime.
mkdirSync(join(ROOT, ".data"), { recursive: true });
const hostCa = process.env.NODE_EXTRA_CA_CERTS;
const hasHostCa = hostCa !== undefined && existsSync(hostCa);
if (hasHostCa) copyFileSync(hostCa, join(ROOT, ".data", "extra-ca.pem"));
else writeFileSync(join(ROOT, ".data", "extra-ca.pem"), "");

must("docker: postgres, kafka, temporal", "docker", ["compose", "up", "-d", "--wait"]);
if (docs) {
	// ClamAV sits under the services profile; naming it starts it alone.
	docs = run("docker: clamav (document virus scanning)", "docker", [
		"compose",
		"up",
		"-d",
		"clamav",
	]);
}
// Schema + login users must exist before the services boot; everything
// else is seeded once the stack is up (see seedReferenceData below).
must("setup: databases, kafka topics, migrations, users", pnpm, ["run", "setup"]);
if (docs) docs = await waitForClamd(Number(dotenv.get("CLAMAV_PORT") ?? 3310), 5 * 60_000);
const policy = ai;

const flags = deriveFlags({ lite, ai, brief, docs, policy });
// A flag you exported in your shell (different from .env) beats the derived value.
const env = withNodeProxy(applyFlags(process.env, dotenv, flags)) as NodeJS.ProcessEnv;
// Record what this stack runs with, so tools that attach to it (the e2e
// global setup) gate on the stack's real flags rather than .env's.
mkdirSync(join(ROOT, ".data"), { recursive: true });
writeFileSync(
	join(ROOT, ".data", "stack-flags.json"),
	`${JSON.stringify(Object.fromEntries(Object.keys(flags).map((key) => [key, env[key]])), null, 2)}\n`,
);

const why = (b: boolean, reason: string): string => (b ? "on " : `off  (${reason})`);
const noKey = lite ? "--lite" : "no OPENROUTER_API_KEY in .env";

async function healthy(): Promise<boolean> {
	try {
		const res = await fetch("http://127.0.0.1:3001/api/health", {
			signal: AbortSignal.timeout(3000),
		});
		const body = (await res.json()) as {
			status?: string;
			services?: Record<string, { ok?: boolean }>;
		};
		return (
			body.status === "ok" && Object.values(body.services ?? {}).every((svc) => svc.ok === true)
		);
	} catch {
		return false;
	}
}

async function waitForStack(timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await healthy()) return true;
		await new Promise((r) => setTimeout(r, 3000));
	}
	return false;
}

/**
 * Reference data, seeded against the running stack: demo customer profiles
 * (BreadTalk, Envy, alex, sparse), BreadTalk's fresh evidence so its stale
 * checklist can be cleared by Reuse, and the policy corpus. All idempotent.
 * No applications are created — cases are made live during the demo.
 */
function seedReferenceData(): { policySeeded: boolean } {
	run("seed: demo customer profiles, accounts, evidence", pnpm, ["run", "demo:seed"]);
	run("seed: BreadTalk fresh evidence (for Reuse)", pnpm, [
		"run",
		"demo:refresh-evidence",
		"--persona=breadtalk",
	]);
	const policySeeded =
		policy &&
		run("seed: policy corpus (embeddings via OpenRouter)", pnpm, [
			"--filter",
			"@credit/policy",
			"seed",
		]);
	return { policySeeded };
}

function summary(stackUp: boolean, policySeeded: boolean): string {
	return `
┌ credit pipeline — ${lite ? "lite" : "full"} stack ${stackUp ? "ready" : "NOT healthy (see logs above)"}
│ pipeline (apply → score → decide → book → monitor)  on
│ documents + integrity panel + fraud review          ${why(docs, lite ? "--lite" : "ClamAV not ready")}
│ credit memo (template) + adverse-action letter      ${why(!lite, "--lite")}${!lite && !has("ASSIST_ADVERSE_CONTACT_PATH") ? "  (letter needs ASSIST_ADVERSE_CONTACT_PATH)" : ""}
│ AI: memo writer, case assistant, context analyst    ${why(ai, noKey)}
│ AI: external case brief                             ${why(brief, ai ? "no TAVILY_API_KEY in .env" : noKey)}
│ AI: policy navigator + case review + exceptions     ${why(policySeeded, ai ? "policy corpus seed failed" : noKey)}
│ AI: document integrity analysis + triage            ${why(ai && docs, ai ? "documents off" : noKey)}
│ auto-research on every referral                     ${why(env.AGENT_AUTO_TRIGGER_ENABLED === "true", ai ? "AGENT_AUTO_TRIGGER_ENABLED=false" : noKey)}
│
│ web       http://localhost:3000   (password demo1234)
│           maria@example.com · breadtalk@example.com · envy@example.com · officer@example.com
│ api       http://127.0.0.1:3001/api/health
│ temporal  http://localhost:8080
│ services  ${local ? "host processes (pnpm dev)" : "containers (docker compose --profile microservices)"}
└ Ctrl+C stops the app; \`pnpm cleanup\` then wipes everything back to a clean state.
`;
}

if (local) {
	const dev = spawn(pnpm, ["dev"], { cwd: ROOT, stdio: "inherit", env, shell: true });
	for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => dev.kill(sig));
	dev.on("exit", (code) => process.exit(code ?? 0));
} else {
	// Containers read the derived flags from this file (svc-base env_file);
	// compose also interpolates the explicit `environment:` entries from env.
	const containerEnv = Object.keys(flags).map((key) => `${key}=${env[key] ?? ""}`);
	// Shell exports of .env settings (e.g. a rotated OPENROUTER_API_KEY) win
	// for host processes; give containers the same: stack.env loads after
	// .env. Run with --no-env-file, so these are deliberate exports only.
	for (const key of dotenv.keys()) {
		const value = process.env[key];
		if (value !== undefined && !(key in flags)) containerEnv.push(`${key}=${value}`);
	}
	if (hasHostCa) containerEnv.push("NODE_EXTRA_CA_CERTS=/app/.data/extra-ca.pem");
	writeFileSync(join(ROOT, ".data", "stack.env"), `${containerEnv.join("\n")}\n`);
	must(
		"docker: build + start backend services and workers (first build: several minutes)",
		"docker",
		[...COMPOSE, "--profile", "microservices", "up", "-d", "--build", "--remove-orphans"],
		env,
	);
	const web = spawn(pnpm, ["--filter", "@credit/web", "dev"], {
		cwd: ROOT,
		stdio: "inherit",
		env,
		shell: true,
	});
	const stopServices = (): void => {
		// Ctrl+C stops the web app and the service containers; infra stays up
		// (`pnpm cleanup` removes everything).
		const listed = spawnSync(
			"docker",
			[...COMPOSE, "--profile", "microservices", "config", "--services"],
			{
				cwd: ROOT,
				encoding: "utf8",
				shell: true,
			},
		);
		const infra = new Set(["postgres", "kafka", "temporal", "temporal-ui"]);
		const services = (listed.stdout ?? "")
			.split(/\s+/)
			.filter((name) => name !== "" && !infra.has(name));
		console.log("\n▶ stopping service containers (infra keeps running)");
		spawnSync("docker", [...COMPOSE, "--profile", "microservices", "stop", ...services], {
			cwd: ROOT,
			stdio: "inherit",
			shell: true,
		});
	};
	let stopping = false;
	for (const sig of ["SIGINT", "SIGTERM"] as const) {
		process.on(sig, () => {
			if (stopping) return;
			stopping = true;
			web.kill(sig);
			stopServices();
			process.exit(0);
		});
	}
	web.on("exit", (code) => {
		if (!stopping) process.exit(code ?? 0);
	});
}

console.log("\n▶ waiting for the gateway and every service to report healthy");
// First container run installs the workspace in the deps container.
const stackUp = await waitForStack((local ? 5 : 15) * 60_000);
const { policySeeded } = stackUp ? seedReferenceData() : { policySeeded: false };
console.log(summary(stackUp, policySeeded));
