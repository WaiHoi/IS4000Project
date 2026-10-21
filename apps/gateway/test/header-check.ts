// Test-only signature check: verifies the gateway's signed downstream
// headers with the same function the services use to authenticate them.
// Pass the exact forwarded `body` for POSTs: the assertion also proves
// `x-body-sha256` covers those bytes (signature binds the hash, the hash
// binds the bytes), so a swapped body fails closed.
import { bodySha256Hex, resolveInternalUser, type InternalRole } from "@credit/service-kit";

export function resolveInternalHeadersForTest(
	secret: string,
	opts: { method: string; path: string; headers: Record<string, string>; body?: string | null },
): { id: string; email: string; role: InternalRole } | null {
	if (opts.body !== undefined && opts.body !== null) {
		const actual = bodySha256Hex(opts.body);
		if (opts.headers["x-body-sha256"] !== actual) return null;
	}
	return resolveInternalUser(secret, {
		method: opts.method,
		path: opts.path,
		userId: opts.headers["x-user-id"] ?? "",
		role: opts.headers["x-user-role"] ?? "",
		email: opts.headers["x-user-email"] ?? "",
		ts: opts.headers["x-internal-ts"] ?? "",
		signature: opts.headers["x-internal-signature"] ?? "",
		bodyHash: opts.headers["x-body-sha256"] ?? "",
		requestId: opts.headers["x-request-id"] ?? "",
	});
}
