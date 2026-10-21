import type { Db } from "@credit/db";
import type { Sql } from "postgres";
import {
	checkDb,
	checkOutbox,
	checkTemporal,
	createService,
	type Logger,
	type ServiceApp,
	type WorkflowGateway,
} from "@credit/service-kit";
import type { ApplicationsEnv } from "./env.js";
import {
	buildDocumentService,
	configFromEnv,
	documentRoutes,
	type DocumentAdapters,
} from "./documents/index.js";
import { applicationsRoutes } from "./routes/applications.js";
import { internalRoutes } from "./routes/internal.js";

export interface ApplicationsDeps {
	db: Db;
	sql: Sql;
	env: ApplicationsEnv;
	gateway: WorkflowGateway;
	logger: Logger;
	/** Test seam: fake scanner/OCR + config overrides without touching env. */
	documents?: DocumentAdapters;
}

/** Test seam: pass fakes for gateway/db; the production server wires the real ones. */
export function createApp(deps: ApplicationsDeps): ServiceApp {
	const documentConfig = { ...configFromEnv(deps.env), ...deps.documents?.config };
	const routes: ServiceApp = applicationsRoutes({
		db: deps.db,
		gateway: deps.gateway,
		logger: deps.logger,
		documentsEnabled: documentConfig.featureEnabled,
	});
	routes.route(
		"/",
		internalRoutes({
			db: deps.db,
			sql: deps.sql,
			documents: {
				storageDir: documentConfig.storageDir,
				lockTimeoutMs: documentConfig.lockTimeoutMs,
			},
		}),
	);
	const documentService = buildDocumentService(deps.db, documentConfig, deps.documents ?? {});
	routes.route(
		"/",
		documentRoutes({
			db: deps.db,
			config: documentConfig,
			service: documentService,
			logger: deps.logger,
		}),
	);
	return createService({
		name: "applications",
		secret: deps.env.internalSecret,
		logger: deps.logger,
		routes,
		// T01 upload path only (multipart 10 MB + overhead); every other
		// route keeps service-kit's 100 KB JSON bound.
		bodyLimitOverrides: [
			{
				method: "POST",
				pathPattern: /^\/api\/applications\/[^/]+\/documents$/,
				maxBytes: deps.env.documentUploadMaxBytes,
			},
		],
		health: async () => ({
			db: await checkDb(() => deps.sql`SELECT 1`),
			temporal: await checkTemporal(deps.env.temporalAddress),
			outbox: await checkOutbox(
				() =>
					deps.sql`SELECT count(*) FILTER (WHERE dead_lettered_at IS NULL)::int AS backlog,
					count(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead
					FROM outbox_events WHERE published_at IS NULL` as Promise<
						Array<{ backlog: number; dead: number }>
					>,
			),
		}),
	});
}
