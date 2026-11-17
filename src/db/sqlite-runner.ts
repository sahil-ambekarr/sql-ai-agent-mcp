/**
 * Child process that executes guarded SELECTs against SQLite.
 *
 * better-sqlite3 is synchronous and cannot be interrupted from JavaScript, so
 * a runaway query (say, an endless recursive CTE) would block whatever thread
 * runs it. Running queries here lets the parent enforce the timeout by killing
 * this process, which always works.
 */
import Database from 'better-sqlite3';
import { RowCollector } from './types.ts';

interface RunMessage {
  id: number;
  sql: string;
  rowLimit: number;
  maxBytes: number;
}

const path = process.argv[2];
if (!path) {
  console.error('sqlite-runner: missing database path');
  process.exit(2);
}

// Defence in depth: the connection itself cannot write.
const db = new Database(path, { readonly: true, fileMustExist: true });
db.pragma('query_only = ON');

process.on('message', (msg: RunMessage) => {
  try {
    const stmt = db.prepare(msg.sql);
    if (!stmt.reader) throw new Error('statement does not return rows');
    // better-sqlite3 asks SQLite whether the compiled statement can write.
    if (!stmt.readonly) throw new Error('SQLite reports that this statement can write; refused');
    const columns = stmt.columns().map((c) => c.name);
    const collector = new RowCollector(msg);
    for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
      if (!collector.add(row)) break;
    }
    process.send?.({ id: msg.id, ok: true, columns, rows: collector.rows, truncated: collector.truncated, truncatedReason: collector.truncatedReason });
  } catch (e) {
    process.send?.({ id: msg.id, ok: false, error: (e as Error).message });
  }
});

process.on('disconnect', () => process.exit(0));
process.send?.({ ready: true });
