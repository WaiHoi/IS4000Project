// Pino logger factory (SPEC FR-11.7): same PII redaction the monolith used —
// national IDs (last 4 only in app code), credentials, contact and financial
// fields are censored wherever they appear in logged objects. Request logs
// carry request id + method/path/status/ms only — never bodies or queries.
import pino, { type Logger } from "pino";

export type { Logger };

export function createLogger(service: string): Logger {
	return pino({
		level: process.env.LOG_LEVEL ?? "info",
		base: { service },
		redact: {
			paths: [
				"*.nationalId",
				"*.national_id",
				"*.registrationNumber",
				"*.registration_number",
				"*.dob",
				"*.email",
				"*.phone",
				"*.address",
				"*.password",
				"*.passwordHash",
				"*.password_hash",
				"*.income*",
				"*.revenue*",
				"*.identity",
				"*.financial",
				"*.business",
				// T01 document content (SPEC-t01-t02 §8): page text, quotes,
				// filenames, and crosscheck expected/observed values must
				// never reach logs/traces. Document failures log
				// {documentFileId, errorCode} only.
				"*.text",
				"*.quote",
				"*.originalFilename",
				"*.original_filename",
				"*.body",
				"*.observed",
				"*.expected",
				"req.headers.cookie",
				"req.headers.authorization",
			],
			censor: "[REDACTED]",
		},
	});
}
