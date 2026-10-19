# Explainability commands

From the project root:

```sh
# Build the shared contracts package first.
cd contracts
npm ci
npm run build
cd ../explainability
npm ci

# Offline template flow, no API charges.
npm run demo -- --case healthy-business --provider mock

# Real memo and critic: set this folder's .env OpenRouter key and model first.
npm run demo -- --case healthy-business

# Another memo policy instead of policy/memo.json.
npm run demo -- --case healthy-business --provider mock --policy ./my-memo-policy.json

# Custom Phase 2/3 bundle.
npm run demo -- --input /path/to/input.json --provider mock

npm test
npm run typecheck
npm run build
npm start -- --case healthy-business --provider mock
```

Reports appear in `explainability/output/`. See `README.md` for the bundle format.
