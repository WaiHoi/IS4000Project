# Document workflow (T01/T02)

Applicant or assigned-officer PDF/PNG/JPEG uploads are malware-scanned
(ClamAV), encrypted at rest (AES-256-GCM), and text-extracted (PDF text layer
or image OCR) with page/offset citations. An officer-only deterministic
cross-check cites name/registration mismatches; chase requests are
**draft-only** (created after opening the original, never sent). Documents
never affect the credit decision and never appear in logs or Grafana.

The feature is behind `DOCUMENT_FEATURE_ENABLED` and is off by default. The
integrity/fraud analysis built on these documents is a separate feature; see
[document integrity](document-integrity.md).

## Enable locally

Restart the applications service afterwards.

```powershell
# .env
DOCUMENT_FEATURE_ENABLED=true
DOCUMENT_ENCRYPTION_KEY=<base64-32-bytes>  # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
DOCUMENT_STORAGE_DIR=.data/documents
CLAMAV_HOST=127.0.0.1
CLAMAV_PORT=3310
```

The scanner needs a ClamAV daemon: run one locally on `:3310`, or start the
`microservices` profile (`docker-compose.yml` runs `clamav:3310` with
`CLAMAV_HOST=clamav` plus the encrypted `documents` volume). Image OCR uses the
vendored `apps/applications/assets/tesseract/eng.traineddata.gz`; set
`DOCUMENT_OCR_DATA_DIR` only to override it (no runtime CDN). Text PDFs need no
OCR assets.

Missing key/scanner fails uploads closed (503) without affecting readiness or
decisions; the UI panel hides while the flag is off and the mock verification
checklist is untouched.

## v1 limitations

- Scanned/image-only PDFs yield `needs_chase` (no PDF-image OCR).
- ID files store bytes only (no page text, always needs-chase).
- Assigned-officer only (no specialist access — claim the case first; other
  officers see a non-leaking "not available").
- Chase drafts are never sent.
- Retention is 90 days with legal-hold blocking (full DSAR automation stays
  T16).

## Tests

`e2e/documents.spec.ts` (+ `e2e/fixtures/mismatch.pdf`) runs the full path when
the stack above is configured, otherwise it skips with the required env.

Related: [configuration](../reference/configuration.md) (`DOCUMENT_*`,
`CLAMAV_*`) · [API](../reference/api.md) ·
[data and events](../reference/data-and-events.md).
