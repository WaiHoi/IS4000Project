# Explainability inputs

Each case directory contains `input.json`, with `assessmentId`, `assessment`
(full Phase 3 output) and `phase2` (full Phase 2 output). Business IDs must match.
All source IDs must be unique. Use a unique assessment ID for each application or
reassessment in your real backend. The demo IDs are stable for reproducibility.

Files are read on every run. Edit or replace the snapshots to experiment. The
included data is fictional. Reports are written to `output/`, never over inputs.

`healthy-business/input.json` was generated from the current pipeline: the live
Phase 2 report (`phase2/output/healthy-business.openrouter.json`) and the Phase 3
assessment of it. To regenerate it after Phase 2 or 3 changes, rerun those phases
and rebuild the bundle from their outputs. Red-flag scenarios are built inside the
tests rather than kept as separate snapshots.
