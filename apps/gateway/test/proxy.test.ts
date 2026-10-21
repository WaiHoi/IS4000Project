// Binary-safe proxy forwarding (SPEC-t01-t02 §3): PDF bytes must survive
// the gateway untouched, with only the allowlisted headers preserved.
// Compose-free: forwardResponse runs inside a minimal Hono app.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { forwardResponse } from "../src/proxy.js";

function serve(upstream: Response): Hono {
	const app = new Hono();
	app.all("/doc", (c) => forwardResponse(c, upstream));
	return app;
}

describe("forwardResponse", () => {
	it("preserves PDF bytes byte-for-byte with download headers", async () => {
		// High bytes + NUL: any text decoding would corrupt these.
		const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x80, 0x01, 0x0a]);
		const upstream = new Response(pdf, {
			status: 200,
			headers: {
				"content-type": "application/pdf",
				"content-length": String(pdf.length),
				"content-disposition": 'attachment; filename="doc.pdf"',
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
				"x-internal-signature": "must-not-leak",
				"set-cookie": "session=abc",
			},
		});
		const res = await serve(upstream).request("/doc");
		expect(res.status).toBe(200);
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(pdf);
		expect(res.headers.get("content-type")).toBe("application/pdf");
		expect(res.headers.get("content-length")).toBe(String(pdf.length));
		expect(res.headers.get("content-disposition")).toBe('attachment; filename="doc.pdf"');
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("x-internal-signature")).toBeNull();
		expect(res.headers.get("set-cookie")).toBeNull();
	});

	it("still forwards JSON bodies and non-200 statuses untouched", async () => {
		const body = JSON.stringify({ error: { code: "MALWARE_DETECTED", message: "infected" } });
		const upstream = new Response(body, {
			status: 422,
			headers: { "content-type": "application/json" },
		});
		const res = await serve(upstream).request("/doc", { method: "POST" });
		expect(res.status).toBe(422);
		expect(await res.json()).toEqual({
			error: { code: "MALWARE_DETECTED", message: "infected" },
		});
	});
});
