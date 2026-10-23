// Demo user directory (SPEC-t17-t18 §2.1): auth users live in credit_auth,
// the customer master in credit_applications — the user id is a plain
// cross-DB reference, never an FK. Scripts take a directory so tests can
// substitute synthetic users for the auth DB.
import { createHash } from "node:crypto";
import { customerProfiles, type Db } from "@credit/db/applications";
import { eq } from "drizzle-orm";

export interface DemoUserDirectory {
	ensureUser: (input: { email: string; fullName: string; role: string }) => Promise<string>;
	findUserByEmail: (email: string) => Promise<string>;
}

/** Deterministic synthetic id per email (sha256, UUID-shaped), so repeated
 * runs converge on the same rows exactly like the auth-DB directory does. */
export function syntheticUserId(email: string): string {
	const hex = createHash("sha256").update(email.toLowerCase(), "utf8").digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Compose-free directory: stable synthetic ids per email. */
export function memoryUserDirectory(): DemoUserDirectory & { ids: Map<string, string> } {
	const ids = new Map<string, string>();
	return {
		ids,
		ensureUser: async (input) => {
			const key = input.email.toLowerCase();
			let id = ids.get(key);
			if (!id) {
				id = syntheticUserId(key);
				ids.set(key, id);
			}
			return id;
		},
		findUserByEmail: async (email) => {
			const id = ids.get(email.toLowerCase()) ?? syntheticUserId(email);
			ids.set(email.toLowerCase(), id);
			return id;
		},
	};
}

export async function findProfileByEmail(
	db: Db,
	directory: DemoUserDirectory,
	email: string,
): Promise<typeof customerProfiles.$inferSelect | null> {
	const userId = await directory.findUserByEmail(email);
	const rows = await db
		.select()
		.from(customerProfiles)
		.where(eq(customerProfiles.userId, userId))
		.limit(1);
	return rows[0] ?? null;
}
