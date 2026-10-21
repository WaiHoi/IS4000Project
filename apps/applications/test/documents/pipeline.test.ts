// pipeline unit: magic bytes, kind/size, rate limit, semaphore, error map.
import { HttpError } from "@credit/service-kit";
import { describe, expect, it } from "vitest";
import { OcrFailed } from "../../src/documents/ocr.js";
import {
	assertDetectedType,
	assertSize,
	detectFileType,
	LockTimeout,
	mapUploadError,
	mimeForType,
	OcrSemaphore,
	parseKind,
	UploadRateLimiter,
	UploadTimeout,
} from "../../src/documents/pipeline.js";
import { ScannerUnavailable } from "../../src/documents/scanner.js";

const PDF = Buffer.from("%PDF-1.4 rest");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const TEXT = Buffer.from("hello");

describe("document pipeline", () => {
	it("detects PDF/PNG/JPEG by magic bytes and ignores client MIME", () => {
		expect(detectFileType(PDF)).toBe("pdf");
		expect(detectFileType(PNG)).toBe("png");
		expect(detectFileType(JPEG)).toBe("jpeg");
		expect(detectFileType(TEXT)).toBeNull();
		expect(detectFileType(Buffer.alloc(0))).toBeNull();
		expect(mimeForType("pdf")).toBe("application/pdf");
		expect(mimeForType("png")).toBe("image/png");
		expect(mimeForType("jpeg")).toBe("image/jpeg");
		expect(assertDetectedType(PDF)).toBe("pdf");
		expect(() => assertDetectedType(TEXT)).toThrowError(
			expect.objectContaining({ status: 415, code: "UNSUPPORTED_TYPE" }),
		);
	});

	it("validates kind and size", () => {
		expect(parseKind("bank_statement")).toBe("bank_statement");
		expect(() => parseKind("passport")).toThrowError(
			expect.objectContaining({ status: 400, code: "INVALID_KIND" }),
		);
		expect(() => parseKind(undefined)).toThrowError(expect.objectContaining({ status: 400 }));
		expect(() => assertSize(Buffer.alloc(0), 10)).toThrowError(
			expect.objectContaining({ code: "EMPTY_FILE" }),
		);
		expect(() => assertSize(Buffer.alloc(11), 10)).toThrowError(
			expect.objectContaining({ status: 413, code: "FILE_TOO_LARGE" }),
		);
		assertSize(Buffer.alloc(10), 10);
	});

	it("rate-limits at 5/min per application", () => {
		const limiter = new UploadRateLimiter(5);
		for (let i = 0; i < 5; i++) limiter.check("app-1", 1000 + i);
		expect(() => limiter.check("app-1", 1005)).toThrowError(
			expect.objectContaining({ status: 429, code: "RATE_LIMITED" }),
		);
		limiter.check("app-2", 1005); // other applications unaffected
		limiter.check("app-1", 61_006); // window slid past
	});

	it("caps OCR concurrency at 2", () => {
		const sem = new OcrSemaphore(2);
		expect(sem.tryAcquire()).toBe(true);
		expect(sem.tryAcquire()).toBe(true);
		expect(sem.tryAcquire()).toBe(false);
		sem.release();
		expect(sem.tryAcquire()).toBe(true);
		sem.release();
		sem.release();
		expect(sem.tryAcquire()).toBe(true);
	});

	it("maps orchestration failures to the spec envelope", () => {
		expect(mapUploadError(new ScannerUnavailable()).code).toBe("SCANNER_UNAVAILABLE");
		expect(mapUploadError(new ScannerUnavailable()).status).toBe(503);
		expect(mapUploadError(new UploadTimeout()).code).toBe("UPLOAD_TIMEOUT");
		expect(mapUploadError(new LockTimeout()).status).toBe(409);
		expect(mapUploadError(new OcrFailed()).status).toBe(500);
		const passthrough = new HttpError(429, "OCR_BUSY", "busy");
		expect(mapUploadError(passthrough)).toBe(passthrough);
		expect(mapUploadError(new Error("boom")).code).toBe("INTERNAL_ERROR");
	});
});
