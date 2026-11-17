import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Decision = 'allowed' | 'blocked' | 'error' | 'timeout';

export interface AuditEntry {
  ts: string;
  tool: string;
  query?: string;
  table?: string;
  decision: Decision;
  reason?: string;
  layer?: string;
  rows?: number;
  truncated?: boolean;
  durationMs: number;
}

const MAX_LOGGED_QUERY = 8000;

/**
 * Append-only JSONL audit log. Each entry is one `appendFileSync` call on a
 * file opened in append mode, so lines are never rewritten and entries from
 * one process do not interleave. Nothing in this repo reads it back except
 * tests and `npm run audit:tail`-style inspection by a human.
 */
export class AuditLog {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  write(entry: Omit<AuditEntry, 'ts'>): AuditEntry {
    const full: AuditEntry = { ts: new Date().toISOString(), ...entry };
    if (full.query && full.query.length > MAX_LOGGED_QUERY) full.query = full.query.slice(0, MAX_LOGGED_QUERY) + '...[truncated]';
    appendFileSync(this.path, JSON.stringify(full) + '\n', { encoding: 'utf8', flag: 'a' });
    return full;
  }
}
