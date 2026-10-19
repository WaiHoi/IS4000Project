import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Business, Evidence, Phase2Input } from './contracts.js';

// Relative to the package, never the caller's working directory. Also works in dist/.
export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));

async function json(path: string): Promise<unknown> {
  try {
    // Accept UTF-8 files saved by Windows editors with an optional BOM.
    return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Cannot read JSON file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function listCases(dataDir = DEFAULT_DATA_DIR): Promise<string[]> {
  return (await readdir(dataDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(entry.name))
    .map((entry) => entry.name).sort();
}

// Demo disk adapter. Data is not validated here; in the full system intake validates it.
export async function loadCase(caseName: string, dataDir = DEFAULT_DATA_DIR): Promise<Phase2Input> {
  // Path safety, not data validation: stops names such as ../ escaping the data directory.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(caseName)) {
    throw new Error('Case name must contain only letters, numbers, underscores or hyphens.');
  }
  const directory = resolve(dataDir, caseName);
  const [business, reviews, news] = await Promise.all([
    json(resolve(directory, 'business.json')),
    json(resolve(directory, 'reviews.json')),
    json(resolve(directory, 'news.json')),
  ]);
  return {
    business: business as Business,
    evidence: [...(reviews as Evidence[]), ...(news as Evidence[])],
  };
}
