# Shared contracts

The agreement between Phase 2 (writes the report) and Phase 3 (reads it):
finding kinds, adverse (red-flag) kinds and the Phase 2 report types. Change a
kind or a report field here once, and both phases pick it up.

Constants and types only, with no runtime dependencies. Each phase builds its
own zod schemas from these lists. Phase 3 has a compile-time check that its
schema accepts this report type, so a mismatch fails `npm run typecheck`.
Severity policy is not shared: it is data in `phase3/policy/default.json`.

## Build first

Phase 2 and Phase 3 depend on this folder as `file:../contracts`. Keep the
sibling folders together and build this package before installing them:

```sh
cd contracts
npm ci
npm run build
```

Rebuild after editing `src/index.ts`, then rerun the phases' typecheck and tests.
