// T01 ClamAV scanner (SPEC-t01-t02 §6.3): INSTREAM over node:net using
// CLAMAV_HOST/CLAMAV_PORT with a configurable timeout. Fail closed:
// any socket/protocol/timeout error is SCANNER_UNAVAILABLE (503), never a
// pass. `DOCUMENT_SCANNER=test` is honored only under NODE_ENV=test and
// returns the injected fake (tests must never touch a real daemon).
import net from "node:net";

export type ScanVerdict = "clean" | "infected";

export class ScannerUnavailable extends Error {
	constructor(message = "SCANNER_UNAVAILABLE") {
		super(message);
		this.name = "ScannerUnavailable";
	}
}

export interface ScannerAdapter {
	scan(bytes: Buffer): Promise<ScanVerdict>;
}

export interface ClamAvOptions {
	host: string;
	port: number;
	timeoutMs: number;
}

const CHUNK_MAX = 4096;

/** Real INSTREAM scan: `zINSTREAM\0`, length-prefixed chunks, `stream: OK`. */
export function createClamAvScanner(opts: ClamAvOptions): ScannerAdapter {
	return {
		async scan(bytes: Buffer): Promise<ScanVerdict> {
			return new Promise<ScanVerdict>((resolve, reject) => {
				const socket = net.connect({ host: opts.host, port: opts.port });
				let done = false;
				const fail = (err: Error): void => {
					if (done) return;
					done = true;
					socket.destroy();
					reject(err);
				};
				const timer = setTimeout(
					() => fail(new ScannerUnavailable("scan timeout")),
					opts.timeoutMs,
				);
				socket.on("connect", () => {
					try {
						socket.write("zINSTREAM\0", () => {
							for (let off = 0; off < bytes.length; off += CHUNK_MAX) {
								const chunk = bytes.subarray(off, Math.min(off + CHUNK_MAX, bytes.length));
								const len = Buffer.alloc(4);
								len.writeUInt32BE(chunk.length, 0);
								socket.write(Buffer.concat([len, chunk]));
							}
							const term = Buffer.alloc(4);
							socket.write(term);
						});
					} catch (err) {
						fail(err instanceof Error ? err : new ScannerUnavailable());
					}
				});
				let reply = "";
				socket.on("data", (data: Buffer) => {
					reply += data.toString("utf8");
					// z-prefixed replies are NUL-terminated with no newline
					// (`stream: OK\0`); plain replies end with `\n`. Either
					// ends the read — waiting for `\n` alone hangs until close.
					if (!reply.includes("\n") && !reply.includes("\0")) return;
					if (done) return;
					done = true;
					clearTimeout(timer);
					socket.end();
					if (reply.includes("FOUND")) resolve("infected");
					else if (reply.includes("OK")) resolve("clean");
					else reject(new ScannerUnavailable("unexpected scanner reply"));
				});
				socket.on("error", () => fail(new ScannerUnavailable()));
				socket.on("timeout", () => fail(new ScannerUnavailable("scan timeout")));
				socket.on("close", () => {
					if (!done) {
						done = true;
						clearTimeout(timer);
						reject(new ScannerUnavailable("scanner closed the connection"));
					}
				});
			});
		},
	};
}

/** Test-only fake: canned verdict or forced outage. */
export function createFakeScanner(
	verdict: ScanVerdict | "unavailable" = "clean",
): ScannerAdapter & { calls: number } {
	const fake = {
		calls: 0,
		async scan(_bytes: Buffer): Promise<ScanVerdict> {
			fake.calls++;
			if (verdict === "unavailable") throw new ScannerUnavailable();
			return verdict;
		},
	};
	return fake;
}

export interface ScannerConfig {
	mode: string;
	host: string;
	port: number;
	timeoutMs: number;
	testAdapter?: ScannerAdapter;
}

/** Production seam: `test` mode escapes only under NODE_ENV=test. */
export function resolveScanner(config: ScannerConfig): ScannerAdapter {
	if (config.mode === "test") {
		if (process.env.NODE_ENV !== "test") {
			throw new ScannerUnavailable("test scanner is only available under NODE_ENV=test");
		}
		// Tests/E2E may inject a verdict; the default is a clean scan.
		return config.testAdapter ?? createFakeScanner("clean");
	}
	return createClamAvScanner({ host: config.host, port: config.port, timeoutMs: config.timeoutMs });
}
