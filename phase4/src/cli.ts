import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { recordDecision, listDecisions } from './storage.js';

async function read(path: string): Promise<unknown> { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
async function main() {
  const { values } = parseArgs({ options: {
    case: { type: 'string' }, explanation: { type: 'string' }, decision: { type: 'string' },
    db: { type: 'string' }, history: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { console.log('npm run demo -- --case folder\nOr --explanation path --decision path. Use --history to list records; --db path selects a database.'); return; }
  const dbPath = values.db ? resolve(values.db) : undefined;
  if (values.history) { console.log(JSON.stringify(listDecisions({ dbPath }), null, 2)); return; }
  if (values.case && (values.explanation || values.decision)) throw new Error('Choose case folder or explicit files.');
  if (!values.case && (!values.explanation || !values.decision)) throw new Error('Provide --case folder or both --explanation and --decision.');
  if (values.case && !/^[\w-]+$/.test(values.case)) throw new Error('Invalid case folder name.');
  const directory = values.case ? fileURLToPath(new URL(`../data/${values.case}/`, import.meta.url)) : '';
  const explanation = await read(values.explanation ? resolve(values.explanation) : resolve(directory, 'explanation.json'));
  const decision = await read(values.decision ? resolve(values.decision) : resolve(directory, 'decision.json'));
  console.log(JSON.stringify(recordDecision(explanation, decision, { dbPath }), null, 2));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
