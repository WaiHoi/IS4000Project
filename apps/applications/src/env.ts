import { fileURLToPath } from "node:url";
import { MAX_UPLOAD_BYTES } from "@credit/service-kit";
import { createEnv } from "@t3-oss/env-core";
import dotenv from "dotenv";
import { z } from "zod";

// Root env is passed by the Bun dev script (`--env-file=../../.env`);
// dotenv covers Node/Vitest imports. t3-env validates and types it.
dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

const parsed = createEnv({
	server: {
		APPLICATIONS_DATABASE_URL: z.string().min(1),
		TEMPORAL_ADDRESS: z.string().min(1).default("localhost:7233"),
		INTERNAL_SECRET: z.string().min(1),
		PORT: z.coerce.number().int().min(1).max(65_535).default(4001),
		HOST: z.string().min(1).default("127.0.0.1"),
		// T01 document workflow (SPEC-t01-t02 §10). Everything carries a
		// safe default; the feature flag stays off until D1 lands. The
		// encryption key is optional here so the service still boots (and
		// stays gateway-healthy) without it — document uploads fail
		// closed later when the key is missing.
		DOCUMENT_FEATURE_ENABLED: z.enum(["true", "false"]).default("false"),
		DOCUMENT_STORAGE_DIR: z.string().min(1).default(".data/documents"),
		DOCUMENT_ENCRYPTION_KEY: z.string().min(1).optional(),
		DOCUMENT_KEY_ID: z.string().min(1).default("v1"),
		DOCUMENT_PREVIOUS_KEYS: z.string().min(1).optional(),
		DOCUMENT_MAX_BYTES: z.coerce.number().int().positive().default(10_485_760),
		DOCUMENT_MAX_PAGES: z.coerce.number().int().positive().default(20),
		DOCUMENT_MAX_PAGE_TEXT_BYTES: z.coerce.number().int().positive().default(262_144),
		DOCUMENT_MAX_TOTAL_TEXT_BYTES: z.coerce.number().int().positive().default(2_097_152),
		DOCUMENT_MAX_PIXELS: z.coerce.number().int().positive().default(16_000_000),
		DOCUMENT_UPLOAD_DEADLINE_MS: z.coerce.number().int().positive().default(35_000),
		DOCUMENT_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
		DOCUMENT_SCAN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
		DOCUMENT_OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
		DOCUMENT_OCR_CONCURRENCY: z.coerce.number().int().positive().default(2),
		DOCUMENT_UPLOAD_RATE_PER_MIN: z.coerce.number().int().positive().default(5),
		DOCUMENT_OCR_DATA_DIR: z.string().min(1).optional(),
		DOCUMENT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
		DOCUMENT_SCANNER: z.string().min(1).default("clamd"),
		CLAMAV_HOST: z.string().min(1).default("127.0.0.1"),
		CLAMAV_PORT: z.coerce.number().int().min(1).max(65_535).default(3310),
		DOCUMENT_CROSSCHECK_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),
		// HTTP body cap for the multipart upload path only (10 MB file +
		// overhead); every other /api/* route keeps the 100 KB JSON bound.
		DOCUMENT_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(MAX_UPLOAD_BYTES),
	},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});

export const env = {
	databaseUrl: parsed.APPLICATIONS_DATABASE_URL,
	temporalAddress: parsed.TEMPORAL_ADDRESS,
	internalSecret: parsed.INTERNAL_SECRET,
	port: parsed.PORT,
	host: parsed.HOST,
	documentUploadMaxBytes: parsed.DOCUMENT_UPLOAD_MAX_BYTES,
	documents: {
		featureEnabled: parsed.DOCUMENT_FEATURE_ENABLED === "true",
		storageDir: parsed.DOCUMENT_STORAGE_DIR,
		encryptionKey: parsed.DOCUMENT_ENCRYPTION_KEY,
		keyId: parsed.DOCUMENT_KEY_ID,
		previousKeys: parsed.DOCUMENT_PREVIOUS_KEYS,
		maxBytes: parsed.DOCUMENT_MAX_BYTES,
		maxPages: parsed.DOCUMENT_MAX_PAGES,
		maxPageTextBytes: parsed.DOCUMENT_MAX_PAGE_TEXT_BYTES,
		maxTotalTextBytes: parsed.DOCUMENT_MAX_TOTAL_TEXT_BYTES,
		maxPixels: parsed.DOCUMENT_MAX_PIXELS,
		uploadDeadlineMs: parsed.DOCUMENT_UPLOAD_DEADLINE_MS,
		lockTimeoutMs: parsed.DOCUMENT_LOCK_TIMEOUT_MS,
		scanTimeoutMs: parsed.DOCUMENT_SCAN_TIMEOUT_MS,
		ocrTimeoutMs: parsed.DOCUMENT_OCR_TIMEOUT_MS,
		ocrConcurrency: parsed.DOCUMENT_OCR_CONCURRENCY,
		uploadRatePerMin: parsed.DOCUMENT_UPLOAD_RATE_PER_MIN,
		ocrDataDir: parsed.DOCUMENT_OCR_DATA_DIR,
		retentionDays: parsed.DOCUMENT_RETENTION_DAYS,
		scanner: parsed.DOCUMENT_SCANNER,
		clamavHost: parsed.CLAMAV_HOST,
		clamavPort: parsed.CLAMAV_PORT,
		crosscheckMinConfidence: parsed.DOCUMENT_CROSSCHECK_MIN_CONFIDENCE,
	},
};

export type ApplicationsEnv = typeof env;

export function loadEnv(): ApplicationsEnv {
	return env;
}
