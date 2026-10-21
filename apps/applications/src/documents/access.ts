// T01 document access (SPEC-t01-t02 §8): applicant owner (implicit, from
// the application row) or the assigned officer (an active
// case_access_grants row). Anything else is a non-leaking null — callers
// 404. D1b adds claim/grant/revoke on top of this helper.
import { applications, caseAccessGrants, type Db, withTx } from "@credit/db/applications";
import { HttpError, writeAudit } from "@credit/service-kit";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { LockTimeout } from "./pipeline.js";

export type DocumentAccess = "owner" | "assigned";

/** Owner wins; assigned officer otherwise; null for everyone else
 * (cross-applicant, unassigned officer, wrong role). */
export async function resolveDocumentAccess(
	db: Db,
	applicationId: string,
	user: { id: string; role: string },
): Promise<{ access: DocumentAccess; application: typeof applications.$inferSelect } | null> {
	const rows = await db.select().from(applications).where(eq(applications.id, applicationId));
	const application = rows[0];
	if (!application) return null;
	if (user.role === "applicant" && application.applicantUserId === user.id) {
		return { access: "owner", application };
	}
	if (user.role === "officer") {
		const grants = await db
			.select({ userId: caseAccessGrants.userId })
			.from(caseAccessGrants)
			.where(
				and(
					eq(caseAccessGrants.applicationId, applicationId),
					eq(caseAccessGrants.userId, user.id),
					eq(caseAccessGrants.accessRole, "assigned_officer"),
					isNull(caseAccessGrants.revokedAt),
				),
			);
		if (grants.length > 0) return { access: "assigned", application };
	}
	return null;
}

export interface Assignment {
	id: string;
	applicationId: string;
	userId: string;
	accessRole: "assigned_officer";
	grantedAt: Date;
}

/** Per-application advisory lock shared with upload/retry/retention/holds/
 * consent (SPEC §7). Bounded: lock_timeout → LockTimeout (callers 409). */
export async function lockApplication(
	tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
	applicationId: string,
	lockTimeoutMs: number,
): Promise<void> {
	const ms = Math.max(1, Math.floor(lockTimeoutMs));
	await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${ms}`));
	try {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${applicationId}))`);
	} catch (err) {
		if (typeof err === "object" && err !== null && (err as { code?: string }).code === "55P03") {
			throw new LockTimeout();
		}
		throw err;
	}
}

function presentAssignment(row: typeof caseAccessGrants.$inferSelect): Assignment {
	return {
		id: row.id,
		applicationId: row.applicationId,
		userId: row.userId,
		accessRole: "assigned_officer",
		grantedAt: row.grantedAt,
	};
}

/** Officer self-claim (SPEC §5/§8): idempotent for self; another active
 * officer, a missing application, or a previously revoked self-grant is a
 * non-leaking 404 (a revoked officer can only be restored by service
 * grant). Success audits `access.claim` with ids only. */
export async function claimAssignedOfficer(
	db: Db,
	input: { applicationId: string; userId: string; lockTimeoutMs: number },
): Promise<{ assignment: Assignment; idempotent: boolean }> {
	return withTx(db, async (tx) => {
		await lockApplication(tx, input.applicationId, input.lockTimeoutMs);
		const apps = await tx
			.select()
			.from(applications)
			.where(eq(applications.id, input.applicationId));
		if (!apps[0]) throw new HttpError(404, "NOT_FOUND", "not found");
		const active = await tx
			.select()
			.from(caseAccessGrants)
			.where(
				and(
					eq(caseAccessGrants.applicationId, input.applicationId),
					eq(caseAccessGrants.accessRole, "assigned_officer"),
					isNull(caseAccessGrants.revokedAt),
				),
			);
		const mine = active.find((g) => g.userId === input.userId);
		if (mine) return { assignment: presentAssignment(mine), idempotent: true };
		if (active.length > 0) throw new HttpError(404, "NOT_FOUND", "not found");
		const prior = await tx
			.select({ id: caseAccessGrants.id })
			.from(caseAccessGrants)
			.where(
				and(
					eq(caseAccessGrants.applicationId, input.applicationId),
					eq(caseAccessGrants.userId, input.userId),
					eq(caseAccessGrants.accessRole, "assigned_officer"),
					isNotNull(caseAccessGrants.revokedAt),
				),
			)
			.limit(1);
		if (prior.length > 0) throw new HttpError(404, "NOT_FOUND", "not found");
		const [grant] = await tx
			.insert(caseAccessGrants)
			.values({
				applicationId: input.applicationId,
				userId: input.userId,
				accessRole: "assigned_officer",
				grantedBy: input.userId,
			})
			.returning();
		await writeAudit(tx, {
			applicationId: input.applicationId,
			actor: input.userId,
			action: "access.claim",
			entity: "case_access_grant",
			payload: { applicationId: input.applicationId, grantId: grant.id, userId: input.userId },
		});
		return { assignment: presentAssignment(grant), idempotent: false };
	});
}

/** Service-only grant (SPEC §5): revokes any other active officer, then
 * inserts the new one (idempotent when that officer already holds the
 * case). Missing application → 404. Audits `access.grant`, ids only. */
export async function grantAssignedOfficer(
	db: Db,
	input: { applicationId: string; userId: string; grantedBy: string; lockTimeoutMs: number },
): Promise<{ assignment: Assignment; idempotent: boolean }> {
	return withTx(db, async (tx) => {
		await lockApplication(tx, input.applicationId, input.lockTimeoutMs);
		const apps = await tx
			.select()
			.from(applications)
			.where(eq(applications.id, input.applicationId));
		if (!apps[0]) throw new HttpError(404, "NOT_FOUND", "not found");
		const active = await tx
			.select()
			.from(caseAccessGrants)
			.where(
				and(
					eq(caseAccessGrants.applicationId, input.applicationId),
					eq(caseAccessGrants.accessRole, "assigned_officer"),
					isNull(caseAccessGrants.revokedAt),
				),
			);
		const mine = active.find((g) => g.userId === input.userId);
		if (mine) return { assignment: presentAssignment(mine), idempotent: true };
		const now = new Date();
		for (const other of active) {
			await tx
				.update(caseAccessGrants)
				.set({ revokedAt: now })
				.where(eq(caseAccessGrants.id, other.id));
		}
		const [grant] = await tx
			.insert(caseAccessGrants)
			.values({
				applicationId: input.applicationId,
				userId: input.userId,
				accessRole: "assigned_officer",
				grantedBy: input.grantedBy,
			})
			.returning();
		await writeAudit(tx, {
			applicationId: input.applicationId,
			actor: input.grantedBy,
			action: "access.grant",
			entity: "case_access_grant",
			payload: { applicationId: input.applicationId, grantId: grant.id, userId: input.userId },
		});
		return { assignment: presentAssignment(grant), idempotent: false };
	});
}

/** Service-only revoke: 404 on a missing application or no active grant
 * for that user. Audits `access.revoke`, ids only. */
export async function revokeAssignedOfficer(
	db: Db,
	input: { applicationId: string; userId: string; actor: string; lockTimeoutMs: number },
): Promise<{ assignment: Assignment }> {
	return withTx(db, async (tx) => {
		await lockApplication(tx, input.applicationId, input.lockTimeoutMs);
		const apps = await tx
			.select()
			.from(applications)
			.where(eq(applications.id, input.applicationId));
		if (!apps[0]) throw new HttpError(404, "NOT_FOUND", "not found");
		const active = await tx
			.select()
			.from(caseAccessGrants)
			.where(
				and(
					eq(caseAccessGrants.applicationId, input.applicationId),
					eq(caseAccessGrants.userId, input.userId),
					eq(caseAccessGrants.accessRole, "assigned_officer"),
					isNull(caseAccessGrants.revokedAt),
				),
			)
			.limit(1);
		const grant = active[0];
		if (!grant) throw new HttpError(404, "NOT_FOUND", "not found");
		const [revoked] = await tx
			.update(caseAccessGrants)
			.set({ revokedAt: new Date() })
			.where(eq(caseAccessGrants.id, grant.id))
			.returning();
		await writeAudit(tx, {
			applicationId: input.applicationId,
			actor: input.actor,
			action: "access.revoke",
			entity: "case_access_grant",
			payload: { applicationId: input.applicationId, grantId: grant.id, userId: input.userId },
		});
		return { assignment: presentAssignment(revoked) };
	});
}
