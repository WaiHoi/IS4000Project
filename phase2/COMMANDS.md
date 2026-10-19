# Phase 2 commands (Windows and macOS)

From the project root:

```sh
# Build the shared contracts package first.
cd contracts
npm ci
npm run build
cd ../phase2
npm ci
```

Edit `phase2/.env` with `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`.
Only OpenRouter credentials are required.

```sh
# Real AI through OpenRouter: one case.
npm run demo -- --case healthy-business

# Real AI: all data folders (API usage charges may apply).
npm run demo

# Offline analysis: no key or charges.
npm run demo -- --provider mock

# List case folders.
npm run demo -- --list

# Offline tests, type checking and build.
npm test
npm run typecheck
npm run build

# Run compiled code through OpenRouter.
npm start -- --case healthy-business
```

Reports are in `phase2/output/`. On Windows use `npm.cmd` if PowerShell blocks
`npm`. See `README.md` for integration and `data/README.md` for input formats.
