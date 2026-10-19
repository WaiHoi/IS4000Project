import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { memoPolicySchema, type MemoPolicy } from './contracts.js';

// Relative to the package (works from src/ and dist/): the policy used when none is given.
export const DEFAULT_MEMO_POLICY_PATH = fileURLToPath(new URL('../policy/memo.json', import.meta.url));

/** Read and validate a memo policy file. An invalid policy is rejected before any AI call. */
export async function loadMemoPolicy(path = DEFAULT_MEMO_POLICY_PATH): Promise<MemoPolicy> {
  let raw: unknown;
  try { raw = JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, '')); }
  catch { throw new Error(`Cannot read valid JSON from ${path}.`); }
  const result = memoPolicySchema.safeParse(raw);
  if (!result.success) throw new Error(`Invalid memo policy ${path}:\n${z.prettifyError(result.error)}`);
  return result.data;
}
