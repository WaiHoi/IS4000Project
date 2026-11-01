// pnpm cleanup — wipe the local stack back to a clean state after you stop
// `pnpm start` (Ctrl+C). The next `pnpm start` rebuilds and reseeds
// everything from scratch.
//
// Removes: every compose container (base + services overlay, incl. ClamAV
// and Temporal UI) and their volumes — all databases, Kafka topics, and
// Temporal history — plus local runtime files: document/customer blobs
// (.data/) and e2e artifacts (e2e/test-results, e2e/logs).
// Keeps: .env (API keys + generated secrets), node_modules, eval results,
// and the service images + build cache, so the next start doesn't rebuild
// the workspace install from scratch.
//
// Refuses while the app is still running (gateway :3001 or web :3000
// answering), so it never yanks the databases out from under live
// processes. `--force` skips that check.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const force = process.argv.includes("--force");

function listening(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = connect({ host: "127.0.0.1", port }, () => {
			sock.destroy();
			resolve(true);
		});
		sock.setTimeout(1000, () => (sock.destroy(), resolve(false)));
		sock.on("error", () => resolve(false));
	});
}

if (!force) {
	const busy: number[] = [];
	for (const port of [3000, 3001, 4001, 4002, 4003, 4004, 4005, 4006]) {
		if (await listening(port)) busy.push(port);
	}
	if (busy.length > 0) {
		console.error(
			`✖ the app is still running (ports ${busy.join(", ")}). Stop \`pnpm start\` with Ctrl+C first, ` +
				"or run `pnpm cleanup --force`.",
		);
		process.exit(1);
	}
}

const COMPOSE = ["compose", "--profile", "microservices"];
/** Volumes that hold no app state (none today; images and the build cache
 * are kept by Docker itself, so the next start stays fast). */
const KEEP_VOLUMES = new Set<string>();

console.log("▶ docker: removing containers");
const down = spawnSync("docker", [...COMPOSE, "down", "--remove-orphans"], {
	cwd: ROOT,
	stdio: "inherit",
	shell: true,
});
if (down.status !== 0) {
	console.error("✖ docker compose down failed — is Docker running?");
	process.exit(1);
}

// Data volumes (databases, Kafka, Temporal history) by compose project label.
const config = spawnSync("docker", [...COMPOSE, "config", "--format", "json"], {
	cwd: ROOT,
	encoding: "utf8",
	shell: true,
});
const project = (JSON.parse(config.stdout || "{}") as { name?: string }).name ?? "";
const listed = spawnSync(
	"docker",
	["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`],
	{ cwd: ROOT, encoding: "utf8", shell: true },
);
const volumes = (listed.stdout ?? "")
	.split(/\s+/)
	.filter((v) => v !== "" && !KEEP_VOLUMES.has(v.slice(project.length + 1)));
if (project === "" || listed.status !== 0) {
	console.error("✖ could not list the project's docker volumes");
	process.exit(1);
}
if (volumes.length > 0) {
	console.log(`▶ docker: removing volumes ${volumes.join(", ")}`);
	const rm = spawnSync("docker", ["volume", "rm", ...volumes], {
		cwd: ROOT,
		stdio: "inherit",
		shell: true,
	});
	if (rm.status !== 0) {
		console.error("✖ docker volume rm failed");
		process.exit(1);
	}
}

const removed: string[] = [];
for (const rel of [".data", "e2e/test-results", "e2e/logs"]) {
	const abs = join(ROOT, rel);
	if (!existsSync(abs)) continue;
	rmSync(abs, { recursive: true, force: true });
	removed.push(rel);
}
console.log(
	removed.length > 0 ? `▶ removed ${removed.join(", ")}` : "▶ no local runtime files to remove",
);
console.log("✔ clean. .env kept (API keys + secrets). Run `pnpm start` to bring everything back.");
