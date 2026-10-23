// Shared wiring for the `demo:*` CLIs (SPEC-t17-t18 §2.5): root `.env`
// loading, guard values, customer/app blob configs, and the auth-DB user
// directory. Every mutating CLI asserts DEMO_MODE/non-production first.
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

import { users } from "@credit/db/auth";
import { resolveWorkspacePath } from "@credit/core";
import type { Db } from "@credit/db/applications";
import { hashPassword } from "@credit/db/password";
import { eq } from "drizzle-orm";
import type { AppDocConfig } from "./case.js";
import type { CustomerConfig } from "../../apps/applications/src/customer/service.js";
import type { DemoUserDirectory } from "./db-helpers.js";

export function cliFlags(): {
	demoMode: boolean;
	nodeEnv: string;
	demoResetAllowed: boolean;
	demoSeedVersion: string;
} {
	return {
		demoMode: process.env.DEMO_MODE === "true",
		nodeEnv: process.env.NODE_ENV ?? "development",
		demoResetAllowed: process.env.DEMO_RESET_ALLOWED === "true",
		demoSeedVersion: process.env.DEMO_SEED_VERSION ?? "1",
	};
}

export function cliCustomerConfig(): CustomerConfig {
	return {
		storageDir: resolveWorkspacePath(
			process.env.CUSTOMER_STORAGE_DIR ?? ".data/customer-documents",
		),
		encryptionKey: process.env.DOCUMENT_ENCRYPTION_KEY,
		keyId: process.env.DOCUMENT_KEY_ID ?? "v1",
		previousKeys: process.env.DOCUMENT_PREVIOUS_KEYS,
		retentionDays: Number(process.env.CUSTOMER_RETENTION_DAYS ?? 90),
		lockTimeoutMs: Number(process.env.DOCUMENT_LOCK_TIMEOUT_MS ?? 5000),
	};
}

export function cliAppDocConfig(): AppDocConfig {
	return {
		storageDir: resolveWorkspacePath(process.env.DOCUMENT_STORAGE_DIR ?? ".data/documents"),
		encryptionKey: process.env.DOCUMENT_ENCRYPTION_KEY,
		keyId: process.env.DOCUMENT_KEY_ID ?? "v1",
		previousKeys: process.env.DOCUMENT_PREVIOUS_KEYS,
		lockTimeoutMs: Number(process.env.DOCUMENT_LOCK_TIMEOUT_MS ?? 5000),
		retentionDays: Number(process.env.DOCUMENT_RETENTION_DAYS ?? 90),
	};
}

export function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`demo: ${name} is not set (root .env?)`);
	return value;
}

/** Auth-DB user directory: upsert fixture users with the demo password. */
export function dbUserDirectory(authDb: Db): DemoUserDirectory {
	return {
		ensureUser: async (input) => {
			const rows = await authDb.select().from(users).where(eq(users.email, input.email)).limit(1);
			if (rows[0]) return rows[0].id;
			const [inserted] = await authDb
				.insert(users)
				.values({
					email: input.email,
					fullName: input.fullName,
					role: input.role as "applicant" | "officer",
					passwordHash: await hashPassword("demo1234"),
				})
				.returning({ id: users.id });
			return inserted.id;
		},
		findUserByEmail: async (email) => {
			const rows = await authDb.select().from(users).where(eq(users.email, email)).limit(1);
			if (!rows[0]) throw new Error(`demo: no auth user for ${email} (run demo:seed)`);
			return rows[0].id;
		},
	};
}
