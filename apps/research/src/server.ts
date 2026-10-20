// Research service entry (Node 22+; the Agents/Grafana SDKs are
// Node-only — never Bun). Stdlib http + app.fetch, no extra server dep.
import { createDb } from "@credit/db/research";
import { createLogger } from "@credit/service-kit";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createLlmSupportJudge } from "./support.js";
import { createLlmLanguageRepair } from "./repair.js";
import { createRealRunner, OPENROUTER_BASE_URL } from "./agent.js";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { reapStaleRuns } from "./lifecycle.js";
import { getObservability } from "./observability.js";
import OpenAI from "openai";
import { createTavilyClient } from "./tavily.js";

const env = loadEnv();
const logger = createLogger("research");
const { db, sql } = createDb(env.databaseUrl);

const tavily = createTavilyClient({ apiKey: env.tavilyApiKey });
const openai = new OpenAI({
	apiKey: env.openrouterApiKey || "unconfigured",
	baseURL: OPENROUTER_BASE_URL,
});
// Same cached instance createApp defaults to: direct repair/judge calls join
// the run conversation without a second pipeline.
const observability = getObservability();
const app = createApp({
	db,
	sql,
	env,
	logger,
	runner: createRealRunner({ env, tavily, openai }),
	judge: createLlmSupportJudge(openai, env.agentModel, { observability }),
	repair: createLlmLanguageRepair(openai, env.agentModel, { observability }),
});

const MAX_BODY_BYTES = 1_000_000;

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			size += (chunk as Buffer).length;
			if (size > MAX_BODY_BYTES) {
				res.writeHead(413, { "content-type": "application/json" });
				res.end(
					JSON.stringify({ error: { code: "BODY_TOO_LARGE", message: "request body too large" } }),
				);
				req.resume();
				return;
			}
			chunks.push(chunk as Buffer);
		}
		const body = Buffer.concat(chunks);
		const host = req.headers.host ?? `${env.host}:${env.port}`;
		const request = new Request(`http://${host}${req.url ?? "/"}`, {
			method: req.method ?? "GET",
			headers: req.headers as Record<string, string>,
			body: body.length > 0 ? new Uint8Array(body) : undefined,
			duplex: "half",
		});
		const out = await app.fetch(request);
		res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
		if (out.body) {
			for await (const chunk of out.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
		}
		res.end();
	} catch (err) {
		logger.error({ err }, "unhandled error");
		res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "internal error" } }));
	}
}

const server = createServer((req, res) => void handle(req, res));
server.listen(env.port, env.host, () => {
	console.log(`research listening on http://${env.host}:${env.port}`);
});

// Crash recovery on boot + periodic sweep; SKIP LOCKED, never touches live runs.
try {
	const ids = await reapStaleRuns(db);
	if (ids.length > 0) logger.info({ count: ids.length }, "reaped stale runs on boot");
} catch (err: unknown) {
	logger.error({ err }, "boot reaper failed");
}
const reaper = setInterval(() => {
	void (async () => {
		try {
			await reapStaleRuns(db);
		} catch (err: unknown) {
			logger.error({ err }, "reaper failed");
		}
	})();
}, 30_000);
reaper.unref();

let shuttingDown = false;
const shutdown = (): void => {
	if (shuttingDown) return;
	shuttingDown = true;
	clearInterval(reaper);
	server.close(() => void sql.end());
	setTimeout(() => process.exit(0), 2500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
