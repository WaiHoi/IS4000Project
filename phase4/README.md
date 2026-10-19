# Phase 4 — analyst review and decision audit

Standalone TypeScript review service and file-based CLI. It accepts an
explainability report, validates an analyst decision, and appends a SQLite record.
It does not call an LLM, automatically approve applicants, or provide a web UI.
Your friend's frontend can call these exported functions through backend routes.

## Setup and demo (Windows/macOS)

Node.js **22.13+** is required for built-in SQLite. From the project root:

```sh
cd explainability
npm ci
npm run build
cd ../phase4
npm ci
npm run demo -- --case healthy-business
npm run history
```

Explainability is a local dependency (`file:../explainability`): keep the sibling
folders together and build explainability before using Phase 4. It shares runtime
schemas and hashing code rather than duplicating that contract. No API key or
database server is needed. SQLite may print an experimental-feature notice on
Node 22. Records are stored in `phase4/storage/decisions.db` (git-ignored).

The demo reads `data/<case>/explanation.json` and `decision.json`. The included
fictional requests ask for more information; they do not approve a real applicant.
Run the demo again with unchanged files and its submission ID returns the same
record, preventing duplicates. Change the submission ID to append a new decision.

## Your own explanation report

```sh
npm run demo -- --explanation ../explainability/output/healthy-business.openrouter.json --decision ./data/healthy-business/decision.json
```

Edit the decision file first. A decision has:

```json
{
  "submissionId": "unique-request-id",
  "analystId": "analyst-123",
  "action": "request_information",
  "reason": "Please clarify the reported dispute.",
  "override": false,
  "acknowledgeWarnings": true
}
```

Allowed actions: `approve`, `decline`, `request_information`. An override uses an
explicit final action plus `override: true` and a nonempty `overrideReason`. Every
decision requires an analyst and reason. Review warnings, manual-review states,
failed memos and mock output require explicit acknowledgement. An analyst can
still decide after reviewing warnings; the system records that accountability.

Phase 3 produces a risk band and review status, not an approve/decline instruction.
Therefore an override is explicitly declared by the analyst rather than inferred
from a mapping of Low risk to approval. The backend must supply analystId from
authenticated identity in a real deployment. The local CLI uses a self-reported ID.

## Persistence and audit behaviour

- Stores UUID, UTC time, assessment ID/digest, complete assessment/memo snapshot,
  final action, rationale, override details and acknowledgement.
- Rechecks business identity, the assessment digest, memo citations/metrics and
  rendered text before accepting the report.
- SQLite update/delete triggers enforce append-only writes through normal SQL.
- Submission IDs are unique. Same ID and same payload returns the prior record;
  a changed payload with the same ID is rejected. New decisions append records.
- Inserts run in a transaction; busy timeout accommodates concurrent writers.

This is local prototype audit storage, not a tamper-proof external ledger. A local
database owner can change the schema/file. Digests detect mismatches, not malicious
forgery; trusted server storage and authentication remain integration tasks.
The review service checks reported critic outcomes but does not rerun AI critique.

## Import into the backend

Keep this package and its sibling explainability package together. Build both,
then install Phase 4 as a local dependency:

```ts
import { recordDecision, listDecisions } from '@credit-copilot/phase4';

const record = recordDecision(explanationReport, analystDecision, {
  dbPath: '/path/to/persistent/decisions.db',
});
const history = listDecisions({
  dbPath: '/path/to/persistent/decisions.db', assessmentId,
});
```

Use persistent filesystem storage, not a temporary serverless directory. The
service is synchronous and suits a small local prototype; larger deployments
should adapt storage and authorisation to their backend.

## Tests and build

```sh
npm test
npm run typecheck
npm run build
npm start -- --case healthy-business
```

Tests use temporary databases. They cover idempotency, conflicting submissions,
override validation, warning acknowledgement, digest/citation checks, failure
handoffs, history filtering and append-only triggers. No live API calls.

See [COMMANDS.md](COMMANDS.md) for history and alternate database commands.
