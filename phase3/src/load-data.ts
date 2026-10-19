import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { policySchema, type Policy } from './contracts.js';

export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));
// Relative to the package (works from src/ and dist/): the policy used when none is given.
export const DEFAULT_POLICY_PATH = fileURLToPath(new URL('../policy/default.json', import.meta.url));

/** Read and validate a policy file. An invalid policy is rejected before any assessment. */
export async function loadPolicy(path = DEFAULT_POLICY_PATH): Promise<Policy> {
  const result = policySchema.safeParse(await readJson(path));
  if (!result.success) throw new Error(`Invalid policy ${path}:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
  catch { throw new Error(`Cannot read valid JSON from ${path}.`); }
}

export async function loadCase(name: string, dataDir = DEFAULT_DATA_DIR) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error('Invalid case folder name.');
  const [phase1, phase2] = await Promise.all([
    readJson(resolve(dataDir, name, 'phase1.json')), readJson(resolve(dataDir, name, 'phase2.json')),
  ]);
  return { phase1, phase2 };
}

export async function listCases(dataDir = DEFAULT_DATA_DIR) {
  return (await readdir(dataDir, { withFileTypes: true })).filter((entry) => entry.isDirectory() &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(entry.name)).map((entry) => entry.name).sort();
}
