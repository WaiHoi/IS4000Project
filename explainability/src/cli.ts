import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { config } from 'dotenv';
import { explainAssessment } from './pipeline.js';
import { loadMemoPolicy } from './policy.js';

async function main() {
  const { values } = parseArgs({ options: { case: { type: 'string' }, input: { type: 'string' },
    provider: { type: 'string', default: 'openrouter' }, policy: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { console.log('npm run demo -- --case <folder> [--provider openrouter|mock] [--policy path]\nOr --input /path/to/input.json\n--policy <path> uses another memo policy instead of policy/memo.json.'); return; }
  if (values.provider !== 'mock' && values.provider !== 'openrouter') throw new Error('Invalid provider.');
  if (Boolean(values.case) === Boolean(values.input)) throw new Error('Choose either --case folder or --input path.');
  if (values.case && !/^[\w-]+$/.test(values.case)) throw new Error('Invalid case name.');
  config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
  const path = values.input ? resolve(values.input) : fileURLToPath(new URL(`../data/${values.case}/input.json`, import.meta.url));
  const input: unknown = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  // Load before any AI call: an invalid policy fails fast without spending credits.
  const policy = await loadMemoPolicy(values.policy ? resolve(values.policy) : undefined);
  const result = await explainAssessment(input, { provider: values.provider, policy });
  const directory = fileURLToPath(new URL('../output/', import.meta.url));
  await mkdir(directory, { recursive: true });
  const output = resolve(directory, `${values.case ?? 'external'}.${values.provider}.json`);
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(result.renderedMemo);
  console.log(`\nStatus: ${result.status}; attempts: ${result.attempts.length}\nReport: ${output}`);
  if (result.status === 'warning') process.exitCode = 1;
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
