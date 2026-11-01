// pnpm cleanup — wipe the local stack back to a clean state after you stop
// `pnpm start` (Ctrl+C). The next `pnpm start` rebuilds and reseeds
// everything from scratch.
//
// Removes: every compose container (base + services overlay, incl. ClamAV
// and Temporal UI) and their volumes — all databases, Kafka topics, and
// Temporal history — plus local runtime files: document/customer blobs
// (.data/) and e2e artifacts (e2e/test-results, e2e/logs).
// Keeps: .env (API keys + generated secrets), node_modules, eval results.
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

console.log("▶ docker: removing containers and volumes (databases, Kafka, Temporal)");
const down = spawnSync(
	"docker",
	[
		"compose",
		"-f",
		"docker-compose.yml",
		"-f",
		"compose.services.yml",
		"--profile",
		"microservices",
		"down",
		"--volumes",
		"--remove-orphans",
	],
	{ cwd: ROOT, stdio: "inherit", shell: true },
);
if (down.status !== 0) {
	console.error("✖ docker compose down failed — is Docker running?");
	process.exit(1);
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
