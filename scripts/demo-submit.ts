// pnpm demo:submit --persona <key> — calls the real submit endpoint only
// (SPEC-t17-t18 §2.5): gateway login as the fixture applicant, then
// POST /api/applications/:id/submit with a fresh Idempotency-Key. No direct
// event, outbox, or workflow writes — the server gate decides (409 while
// blockers remain, one transition when ready).
import { assertDemoMutable } from "@credit/core";
import { createDb, applications } from "@credit/db/applications";
import { eq } from "drizzle-orm";
import { assertFixtureClock, assertManifest, loadManifest, personaOf } from "./lib/manifest.js";
import { cliFlags, requireEnv } from "./lib/env.js";

const personaKey = process.argv.find((a) => a.startsWith("--persona="))?.slice("--persona=".length);
if (!personaKey) throw new Error("usage: bun scripts/demo-submit.ts --persona=<key>");

const flags = cliFlags();
assertDemoMutable(flags);
const manifest = loadManifest();
assertFixtureClock(manifest.demoAsOf, process.env.DEMO_AS_OF);
assertManifest(manifest);
const persona = personaOf(manifest, personaKey);

const apiBase = process.env.API_BASE ?? "http://127.0.0.1:3001";
const { db: appDb, sql } = createDb(requireEnv("APPLICATIONS_DATABASE_URL"));
try {
	const drafts = await appDb
		.select({ id: applications.id, status: applications.status })
		.from(applications)
		.where(eq(applications.fixtureKey, persona.case.fixtureKey))
		.limit(1);
	const draft = drafts[0];
	if (!draft) throw new Error(`demo:submit: no draft for ${personaKey} (run demo:case)`);

	const login = await fetch(`${apiBase}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email: persona.email, password: "demo1234" }),
	});
	if (!login.ok)
		throw new Error(`demo:submit: login failed for ${persona.email}: HTTP ${login.status}`);
	const session = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
	if (!session.startsWith("session=")) throw new Error("demo:submit: no session cookie");

	const submit = await fetch(`${apiBase}/api/applications/${draft.id}/submit`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			cookie: session,
			"Idempotency-Key": crypto.randomUUID(),
		},
		body: JSON.stringify({}),
	});
	const body = (await submit.json().catch(() => null)) as {
		id?: string;
		reference?: string;
		error?: { code?: string; message?: string; fields?: unknown };
	} | null;
	if (!submit.ok) {
		console.log(
			`demo:submit: persona=${personaKey} draft=${draft.id} blocked HTTP ${submit.status} ${body?.error?.code ?? ""} ${JSON.stringify(body?.error?.fields ?? {})}`,
		);
		process.exit(2);
	}
	console.log(
		`demo:submit: persona=${personaKey} draft=${draft.id} submitted ref=${body?.reference ?? ""}`,
	);
} finally {
	await sql.end();
}
