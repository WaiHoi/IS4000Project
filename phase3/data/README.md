# Phase 3 data

Create a case folder containing two JSON files:

```text
data/my-business/
  phase1.json
  phase2.json
```

`phase1.json` holds `{ "businessId": "...", "score": 85, "coverage": 1,
"missingFields": [] }`. Unknown financials use `score: null, coverage: 0`.

`phase2.json` is the full output of the standalone Phase 2 package. Copy a report
from `phase2/output/`, or pass its path to the CLI using `--phase2` with `--phase1`.
Both phases must refer to the same business ID. All scores must be 0–100, higher
means safer. Do not pass raw reviews/news as Phase 3 input: analyse them in Phase 2.

The included fictional `healthy-business` case pairs a sample traditional score of
85 with the live Phase 2 report (`phase2/output/healthy-business.openrouter.json`).
Files are editable and reloaded from disk on every run; no dataset is embedded in
the source code. Red-flag and no-evidence scenarios are built inside the tests.

Run `npm run demo -- --case my-business`. Local output is overwritten per case;
your backend should implement persistent audit records separately.
