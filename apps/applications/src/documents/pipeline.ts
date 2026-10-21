// T01 upload pipeline pure helpers (SPEC-t01-t02 §6): magic-byte type
// detection (client MIME is ignored), size/kind validation, per-application
// rate limiting (5/min), OCR concurrency gate (2, else 429), and the
// upload→HTTP error map. DB-touching orchestration lives in service.ts.
import { HttpError } from "@credit/service-kit";
import { OcrFailed } from "./ocr.js";
import { ScannerUnavailable } from "./scanner.js";

export type DetectedType = "pdf" | "png" | "jpeg";
export type DocumentKind = "id" | "business_registration" | "bank_statement" | "other";

const KINDS: DocumentKind[] = ["id", "business_registration", "bank_statement", "other"];

export function parseKind(raw: unknown): DocumentKind {
	if (typeof raw === "string" && (KINDS as string[]).includes(raw)) return raw as DocumentKind;
	throw new HttpError(
		400,
		"INVALID_KIND",
		"kind must be id|business_registration|bank_statement|other",
	);
}

/** Magic bytes only: PDF `%PDF-`, PNG signature, JPEG SOI. */
export function detectFileType(bytes: Uint8Array): DetectedType | null {
	if (
		bytes.length >= 5 &&
		bytes[0] === 0x25 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x44 &&
		bytes[3] === 0x46 &&
		bytes[4] === 0x2d
	) {
		return "pdf"; // %PDF-
	}
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return "png";
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "jpeg";
	}
	return null;
}

export function mimeForType(type: DetectedType): string {
	return type === "pdf" ? "application/pdf" : type === "png" ? "image/png" : "image/jpeg";
}

export function assertSize(bytes: Uint8Array, maxBytes: number): void {
	if (bytes.length === 0) throw new HttpError(400, "EMPTY_FILE", "file must not be empty");
	if (bytes.length > maxBytes)
		throw new HttpError(413, "FILE_TOO_LARGE", "file exceeds the 10 MB limit");
}

export function assertDetectedType(bytes: Uint8Array): DetectedType {
	const type = detectFileType(bytes);
	if (!type)
		throw new HttpError(415, "UNSUPPORTED_TYPE", "only PDF, PNG, and JPEG files are supported");
	return type;
}

/** Sliding-window per-application upload gate. Process-local (v1 is a
 * single synchronous service; a second replica doubles the budget —
 * acceptable for the bounded v1 surface). */
// ponytail: in-memory map; move to PG advisory/rate table if multi-replica.
export class UploadRateLimiter {
	private readonly hits = new Map<string, number[]>();

	constructor(private readonly perMin: number) {}

	check(applicationId: string, now = Date.now()): void {
		const windowStart = now - 60_000;
		const prior = this.hits.get(applicationId) ?? [];
		const fresh = prior.filter((t) => t > windowStart);
		if (fresh.length >= this.perMin) {
			throw new HttpError(429, "RATE_LIMITED", "too many uploads for this application");
		}
		fresh.push(now);
		this.hits.set(applicationId, fresh);
	}
}

/** Process-wide OCR gate: 2 concurrent extractions, else 429 OCR_BUSY. */
export class OcrSemaphore {
	private active = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(private readonly limit: number) {}

	tryAcquire(): boolean {
		if (this.active >= this.limit) return false;
		this.active++;
		return true;
	}

	release(): void {
		this.active = Math.max(0, this.active - 1);
		const next = this.waiters.shift();
		next?.();
	}
}

export class UploadTimeout extends Error {
	constructor() {
		super("UPLOAD_TIMEOUT");
		this.name = "UploadTimeout";
	}
}

export class LockTimeout extends Error {
	constructor() {
		super("LOCK_TIMEOUT");
		this.name = "LockTimeout";
	}
}

/** Upload orchestration failures → the spec's HTTP envelope (§5). */
export function mapUploadError(err: unknown): HttpError {
	if (err instanceof HttpError) return err;
	if (err instanceof ScannerUnavailable) {
		return new HttpError(503, "SCANNER_UNAVAILABLE", "malware scanner is unavailable");
	}
	if (err instanceof OcrFailed) {
		// Surface OCR failure as a 201 + ocr_status=failed upstream, but any
		// unexpected throw through here is a 500 (service handles the
		// expected OCR path without throwing).
		return new HttpError(500, "EXTRACTION_FAILED", "text extraction failed");
	}
	if (err instanceof UploadTimeout) {
		return new HttpError(503, "UPLOAD_TIMEOUT", "upload exceeded the processing deadline");
	}
	if (err instanceof LockTimeout) {
		return new HttpError(409, "LOCK_TIMEOUT", "the case is busy; retry the request");
	}
	return new HttpError(500, "INTERNAL_ERROR", "internal error");
}

export function isUniqueViolation(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}
