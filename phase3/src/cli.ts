import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assessPhase3 } from './assess.js';
import { DEFAULT_DATA_DIR, listCases, loadCase, loadPolicy, readJson } from './load-data.js';

async function main() {
  const { values } = parseArgs({ options: {
    case: { type: 'string' }, list: { type: 'boolean' },
    phase1: { type: 'string' }, phase2: { type: 'string' }, policy: { type: 'string' },
    'data-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('npm run demo -- [--case folder | --phase1 path --phase2 path] [--policy path]\nUse --list to show local case folders.');
    return;
  }
  if (Boolean(values.phase1) !== Boolean(values.phase2)) throw new Error('Provide both --phase1 and --phase2.');
  if (values.phase1 && (values.case || values.list || values['data-dir'])) throw new Error('Choose file inputs or local case inputs, not both.');
  const dataDir = values['data-dir'] ? resolve(values['data-dir']) : DEFAULT_DATA_DIR;
  if (values.list) { console.log((await listCases(dataDir)).join('\n')); return; }
  const policy = await loadPolicy(values.policy ? resolve(values.policy) : undefined);
  const names = values.phase1 ? ['external'] : values.case ? [values.case] : await listCases(dataDir);
  if (!names.length) throw new Error('No case folders found.');
  const directory = fileURLToPath(new URL('../output/', import.meta.url));
  for (const name of names) {
    const input = values.phase1 ? { phase1: await readJson(resolve(values.phase1)), phase2: await readJson(resolve(values.phase2!)) }
      : await loadCase(name, dataDir);
    const result = assessPhase3(input.phase1, input.phase2, policy);
    await mkdir(directory, { recursive: true });
    const path = resolve(directory, `${name}.json`);
    await writeFile(path, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ case: name, business: result.businessName, score: result.compositeScore,
      band: result.riskBand, status: result.reviewStatus, weight: result.effectiveUnstructuredWeight,
      overrides: result.overrides, output: path }, null, 2));
  }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
