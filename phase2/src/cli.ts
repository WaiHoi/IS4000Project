import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { config } from 'dotenv';
import { analysePhase2 } from './pipeline.js';
import { DEFAULT_DATA_DIR, listCases, loadCase, loadRubric } from './load-data.js';

async function main() {
  const { values } = parseArgs({ options: {
    case: { type: 'string' }, all: { type: 'boolean' }, list: { type: 'boolean' },
    provider: { type: 'string', default: 'openrouter' }, 'data-dir': { type: 'string' }, rubric: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('npm run demo -- --case <folder> [--provider openrouter|mock] [--rubric path]\nDefault: OpenRouter. Use --provider mock for offline tests.\nUse --list to list cases, --all to run every case, --data-dir <path> for another dataset.\n--rubric <path> uses another scoring rubric instead of policy/rubric.json.');
    return;
  }
  if (values.case && values.all) throw new Error('Choose either --case or --all.');
  if (values.provider !== 'mock' && values.provider !== 'openrouter') throw new Error('Provider must be openrouter or mock.');
  config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
  const dataDir = values['data-dir'] ? resolve(values['data-dir']) : DEFAULT_DATA_DIR;
  const cases = await listCases(dataDir);
  if (values.list) { console.log(cases.join('\n') || 'No case folders found.'); return; }
  // No business or case name is baked into the CLI: discover the data folders.
  const selected = values.all || !values.case ? cases : [values.case];
  if (!selected.length) throw new Error('No case folders found in the data directory.');
  // Load once, before any AI calls: an invalid rubric fails fast without spending credits.
  const rubric = await loadRubric(values.rubric ? resolve(values.rubric) : undefined);
  const outputDir = fileURLToPath(new URL('../output/', import.meta.url));
  await mkdir(outputDir, { recursive: true });
  for (const name of selected) {
    const input = await loadCase(name, dataDir);
    console.log(`\nAnalysing ${name} using ${values.provider}...`);
    const result = await analysePhase2(input, { provider: values.provider, rubric });
    const path = resolve(outputDir, `${name}.${values.provider}.json`);
    await writeFile(path, JSON.stringify(result, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({ business: result.businessName, provider: result.provider, status: result.status,
      score: result.score, confidence: result.confidence, redFlags: result.redFlags.length,
      dataGaps: result.dataGaps, warnings: result.warnings }, null, 2));
    console.log(`Full result: ${path}`);
    if (result.agents.some((agent) => agent.status === 'failed')) process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
