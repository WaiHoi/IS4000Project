# Phase 3 commands

Run from the project root:

```sh
# Build the shared contracts package first.
cd contracts
npm ci
npm run build
cd ../phase3
npm ci

# All local datasets; no API key needed.
npm run demo

# One dataset.
npm run demo -- --case healthy-business

# List available datasets.
npm run demo -- --list

# Use an existing Phase 2 OpenRouter output.
npm run demo -- --phase1 ./data/healthy-business/phase1.json --phase2 ../phase2/output/healthy-business.openrouter.json

# Tests, type checking, build.
npm test
npm run typecheck
npm run build

# Run compiled code.
npm start -- --case healthy-business
```

Reports are in `phase3/output/`. On Windows use `npm.cmd` if PowerShell blocks npm.
No separate servers, agents, API credentials or database processes are required.
