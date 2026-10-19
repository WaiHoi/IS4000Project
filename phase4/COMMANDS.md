# Phase 4 commands

First build its sibling dependency from the project root:

```sh
cd explainability
npm ci
npm run build
cd ../phase4
npm ci
```

Then:

```sh
# Record the editable sample analyst decision.
npm run demo -- --case healthy-business

# View recorded decisions.
npm run history

# Review a generated explainability report.
npm run demo -- --explanation ../explainability/output/healthy-business.mock.json --decision ./data/healthy-business/decision.json

# Alternate database (also supported by --history).
npm run demo -- --case healthy-business --db ./storage/another.db

npm test
npm run typecheck
npm run build
npm start -- --case healthy-business
```

Use Node.js 22.13+. On Windows use `npm.cmd` if needed. Edit `decision.json` to
change the action/reason, and use a new submissionId when appending a new decision.
Repeated identical requests are idempotent. No API key is required.
