// T01 upload pipeline pure helpers (SPEC-t01-t02 §6): magic-byte type
// detection (client MIME is ignored), size/kind validation, per-application
// rate limiting (5/min), OCR concurrency gate (2, else 429), and the
// upload→HTTP error map. DB-touching orchestration lives in service.ts.
import { HttpError } from "@credit/service-kit";
import { OcrFailed } from "./ocr.js";
import { ScannerUnavailable } from "./scanner.js";

export type DetectedType = "pdf" | "png" | "jpeg";
export type DocumentKind =
	| "id"
	| "business_registration"
	| "bank_statement"
	| "payslip"
	| "financial_statements"
	| "other";

const KINDS: DocumentKind[] = [
	"id",
	"business_registration",
	"bank_statement",
	"payslip",
	"financial_statements",
	"other",
];

export function parseKind(raw: unknown): DocumentKind {
	if (typeof raw === "string" && (KINDS as string[]).includes(raw)) return raw as DocumentKind;
	throw new HttpError(
		400,
		"INVALID_KIND",
		"kind must be id|business_registration|bank_statement|payslip|financial_statements|other",
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

// --- Server-side statement dating (SPEC-t17-t18 §2.2). Uploaded
// bank_statement/financial_statements never carry client dates, so the
// period end is extracted here from server-side page text
// (`Statement Period`/`Period` labels or a date range). Anything
// unparseable, inconsistent, or future-dated is unknown (nulls) — the
// requirements engine treats unknown as a blocker, never fresh. ---

export interface StatementDates {
	periodEnd: string | null;
	documentDate: string | null;
	dateSource: "server_ocr" | null;
}

const MONTHS: Record<string, number> = {
	jan: 1,
	feb: 2,
	mar: 3,
	apr: 4,
	may: 5,
	jun: 6,
	jul: 7,
	aug: 8,
	sep: 9,
	oct: 10,
	nov: 11,
	dec: 12,
};

const ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const DMY_RE = /\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})\b/g;
const DMON_RE =
	/\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{4})\b/gi;
const MOND_RE =
	/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\b/gi;
const MONY_RE =
	/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{4})\b/gi;

function isoDay(y: number, m: number, d: number): string | null {
	if (m < 1 || m > 12 || d < 1 || d > 31) return null;
	const dt = new Date(Date.UTC(y, m - 1, d));
	if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
		return null;
	}
	return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function lastDayOfMonth(y: number, m: number): string | null {
	if (m < 1 || m > 12 || y < 1900 || y > 9999) return null;
	return isoDay(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate());
}

/** Every calendar-valid day-precision date in `text`, in scan order (day-first numeric). */
function findDayDates(text: string): string[] {
	const out: string[] = [];
	const push = (iso: string | null): void => {
		if (iso && !out.includes(iso)) out.push(iso);
	};
	for (const m of text.matchAll(ISO_RE)) {
		push(isoDay(Number(m[1]), Number(m[2]), Number(m[3])));
	}
	for (const m of text.matchAll(DMY_RE)) {
		push(isoDay(Number(m[3]), Number(m[2]), Number(m[1])));
	}
	for (const m of text.matchAll(DMON_RE)) {
		push(isoDay(Number(m[3]), MONTHS[m[2].slice(0, 3).toLowerCase()] ?? 0, Number(m[1])));
	}
	for (const m of text.matchAll(MOND_RE)) {
		push(isoDay(Number(m[3]), MONTHS[m[1].slice(0, 3).toLowerCase()] ?? 0, Number(m[2])));
	}
	return out;
}

/** Month-year spans (`March 2026`) resolve to the month's last day. */
function findMonthDates(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(MONY_RE)) {
		const iso = lastDayOfMonth(Number(m[2]), MONTHS[m[1].slice(0, 3).toLowerCase()] ?? 0);
		if (iso && !out.includes(iso)) out.push(iso);
	}
	return out;
}

/** Syntactic day-precision date present, even if calendrically invalid. */
function hasDaySyntax(text: string): boolean {
	// Global regexes carry lastIndex: reset before each stateful test.
	for (const re of [ISO_RE, DMY_RE, DMON_RE, MOND_RE]) {
		re.lastIndex = 0;
		if (re.test(text)) {
			for (const r of [ISO_RE, DMY_RE, DMON_RE, MOND_RE]) r.lastIndex = 0;
			return true;
		}
	}
	for (const r of [ISO_RE, DMY_RE, DMON_RE, MOND_RE]) r.lastIndex = 0;
	return false;
}

/**
 * Latest defensible period end in one labeled span or range half-pair:
 * valid day-precision dates win; month-year is the fallback only when no
 * day-precision date was even attempted (an explicit `30 Feb` stays
 * unknown instead of degrading to its month).
 */
function spanEnd(dates: string[], monthFallback: string[], labeled: string): string | null {
	if (dates.length > 0) return dates.sort().at(-1) as string;
	if (monthFallback.length > 0 && !hasDaySyntax(labeled)) {
		return monthFallback.sort().at(-1) as string;
	}
	return null;
}

/**
 * Latest defensible period end for a statement kind from extracted page
 * text. Labeled `Statement Period`/`Period`/`Statement Date` wins; a bare
 * date range is the fallback. For statements the document date is the
 * period end. Future-dated or dateless text stays unknown (nulls).
 */
export function extractStatementDates(
	kind: DocumentKind,
	pageTexts: string[],
	now: Date = new Date(),
): StatementDates {
	const unknown: StatementDates = { periodEnd: null, documentDate: null, dateSource: null };
	if (kind !== "bank_statement" && kind !== "financial_statements") return unknown;
	const text = pageTexts.join("\n");
	const nowDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const accept = (iso: string | null): string | null => {
		if (!iso) return null;
		return new Date(`${iso}T00:00:00Z`).getTime() <= nowDay.getTime() ? iso : null;
	};
	const labeled =
		text.match(/statement\s+period\s*[:\-–—]?\s*([^\n]{1,120})/i)?.[1] ??
		text.match(/[^a-z]period\s*[:\-–—]\s*([^\n]{1,120})/i)?.[1] ??
		text.match(/statement\s+date\s*[:\-–—]?\s*([^\n]{1,120})/i)?.[1];
	if (labeled) {
		const span = `${labeled}`;
		const dates = findDayDates(span)
			.map(accept)
			.filter((d): d is string => d !== null);
		const months = findMonthDates(span)
			.map(accept)
			.filter((d): d is string => d !== null);
		const periodEnd = spanEnd(dates, months, span);
		if (periodEnd) {
			return { periodEnd, documentDate: periodEnd, dateSource: "server_ocr" };
		}
		if (findDayDates(span).length > 0 || findMonthDates(span).length > 0) return unknown;
	}
	// Fallback: a bare range anywhere (`<date> - <date>` or `<date> to <date>`).
	const range = text.match(/([^\n]{0,60}?)\s*(?:[–—]|\bto\b|-)\s*([^\n]{0,60})/i);
	if (range) {
		const halves = `${range[1]}\n${range[2]}`;
		if (findDayDates(range[1]).length > 0 && findDayDates(range[2]).length > 0) {
			const dates = findDayDates(halves)
				.map(accept)
				.filter((d): d is string => d !== null);
			const months = findMonthDates(halves)
				.map(accept)
				.filter((d): d is string => d !== null);
			const periodEnd = spanEnd(dates, months, halves);
			if (periodEnd) {
				return { periodEnd, documentDate: periodEnd, dateSource: "server_ocr" };
			}
		}
	}
	return unknown;
}
