import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSqlite } from '../src/seed/sqlite.ts';
import type { AuditEntry } from '../src/audit.ts';
import type { Config } from '../src/config.ts';

/** Seeds a throwaway SQLite database and returns paths for it and an audit log. */
export function makeTestDb(): { dir: string; dbPath: string; auditPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sql-mcp-test-'));
  const dbPath = join(dir, 'sample.db');
  seedSqlite(dbPath);
  return { dir, dbPath, auditPath: join(dir, 'audit.jsonl') };
}

export function readAudit(path: string): AuditEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditEntry);
}

export const TEST_GUARD: Config['guard'] = {
  rowLimitDefault: 100,
  rowLimitMax: 500,
  queryTimeoutMs: 1500,
  resultMaxBytes: 65_536,
  maxQueryChars: 8000,
};
