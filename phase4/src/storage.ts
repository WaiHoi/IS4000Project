import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { digest } from '@credit-copilot/explainability';
import { prepareReview } from './review.js';
import type { DecisionRecord } from './contracts.js';

export const DEFAULT_DB = fileURLToPath(new URL('../storage/decisions.db', import.meta.url));

function connect(path: string) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  const db = new DatabaseSync(absolute);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY, submission_id TEXT NOT NULL UNIQUE,
      assessment_id TEXT NOT NULL, input_digest TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS decisions_no_update BEFORE UPDATE ON decisions
      BEGIN SELECT RAISE(ABORT, 'Decisions are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS decisions_no_delete BEFORE DELETE ON decisions
      BEGIN SELECT RAISE(ABORT, 'Decisions are append-only'); END;`);
  return db;
}

export function recordDecision(rawExplanation: unknown, rawDecision: unknown, options: { dbPath?: string } = {}): DecisionRecord {
  const { explanation, decision } = prepareReview(rawExplanation, rawDecision);
  const inputDigest = digest({ explanation, decision });
  const db = connect(options.dbPath ?? DEFAULT_DB);
  try {
    db.exec('BEGIN IMMEDIATE');
    const existing = db.prepare('SELECT input_digest, payload FROM decisions WHERE submission_id=?').get(decision.submissionId);
    if (existing) {
      if (existing.input_digest !== inputDigest) throw new Error('Submission ID already used for different decision data. Use a new submissionId for a new record.');
      db.exec('COMMIT');
      return JSON.parse(existing.payload as string) as DecisionRecord;
    }
    const record: DecisionRecord = { id: randomUUID(), recordedAt: new Date().toISOString(),
      assessmentId: explanation.assessmentId, businessId: explanation.businessId,
      assessmentDigest: explanation.assessmentDigest, inputDigest, decision, aiAssessment: explanation };
    db.prepare('INSERT INTO decisions VALUES (?, ?, ?, ?, ?)').run(record.id, decision.submissionId,
      record.assessmentId, inputDigest, JSON.stringify(record));
    db.exec('COMMIT');
    return record;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
}

export function listDecisions(options: { dbPath?: string; assessmentId?: string } = {}): DecisionRecord[] {
  const db = connect(options.dbPath ?? DEFAULT_DB);
  try {
    const rows = options.assessmentId ? db.prepare('SELECT payload FROM decisions WHERE assessment_id=? ORDER BY rowid').all(options.assessmentId)
      : db.prepare('SELECT payload FROM decisions ORDER BY rowid').all();
    return rows.map((row) => JSON.parse(row.payload as string) as DecisionRecord);
  } finally { db.close(); }
}
