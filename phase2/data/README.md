# Phase 2 input data

Each subfolder is one business case. The CLI reads these files from disk on every
run. The included records are fictional examples: replace them with your supplied
dataset or add a new case directory. No source records are embedded in TypeScript.

```text
data/
  my-business/
    business.json
    reviews.json
    news.json
```

All three files are required. Use `[]` for an empty source. Folder names can use
letters, numbers, underscores and hyphens. JSON must be UTF-8.

## business.json

```json
{
  "id": "YOUR-BUSINESS-ID",
  "name": "Your business",
  "consent": true,
  "claims": ["We are opening a second outlet."]
}
```

Phase 2 does not validate these files; consent and schema checks are done by
intake in the full system. Claims are optional context for agents; this version
does not produce separate verified claim-mismatch records. Do not include personal data.

## reviews.json

```json
[
  {
    "id": "R1",
    "businessId": "YOUR-BUSINESS-ID",
    "source": "review",
    "text": "The actual review text goes here.",
    "publishedAt": "2026-10-01T10:00:00Z"
  }
]
```

## news.json

Use the same evidence shape, with `"source": "news"` and IDs such as `N1`.
`url` is optional on each evidence record. It records provenance only: the package
does not fetch it. Use ISO timestamps with a timezone and IDs unique across both
files; Phase 2 does not check these. The package uses exact supplied business-ID matches, not a real
registry lookup. Source IDs and claims must be checked by your data collection step.

Run `npm run demo -- --case my-business` from the `phase2/` folder. Inspect the
generated report in `output/my-business.openrouter.json`. For offline testing, add
`--provider mock`; that writes `output/my-business.mock.json` instead.
