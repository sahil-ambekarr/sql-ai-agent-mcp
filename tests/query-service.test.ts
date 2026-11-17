import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit.ts';
import { SqliteBackend } from '../src/db/sqlite.ts';
import { QueryService } from '../src/server/query-service.ts';
import { makeTestDb, readAudit, TEST_GUARD } from './helpers.ts';

let backend: SqliteBackend;
let service: QueryService;
let auditPath: string;

beforeAll(() => {
  const t = makeTestDb();
  auditPath = t.auditPath;
  backend = new SqliteBackend(t.dbPath);
  service = new QueryService(backend, TEST_GUARD, new AuditLog(auditPath));
});
afterAll(async () => {
  await backend.close();
});

describe('row limit', () => {
  it('applies the default limit of 100 and flags truncation', async () => {
    const r = await service.runSelect('SELECT id FROM orders');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rowCount).toBe(100);
    expect(r.value.truncated).toBe(true);
    expect(r.value.truncatedReason).toBe('row_limit');
  });

  it('honours a smaller requested limit', async () => {
    const r = await service.runSelect('SELECT id FROM orders', 7);
    expect(r.ok && r.value.rowCount).toBe(7);
  });

  it('clamps a larger requested limit to the hard maximum and says so', async () => {
    const r = await service.runSelect('SELECT id FROM orders', 100_000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rowCount).toBe(TEST_GUARD.rowLimitMax);
    expect(r.value.notes.join(' ')).toContain('hard maximum');
  });

  it('does not flag truncation when everything fits', async () => {
    const r = await service.runSelect('SELECT COUNT(*) AS n FROM orders');
    expect(r.ok && r.value).toMatchObject({ rowCount: 1, truncated: false, rows: [{ n: 3000 }] });
  });

  it('rejects a non-integer or negative limit', async () => {
    expect(await service.runSelect('SELECT 1 FROM orders', -1)).toMatchObject({ ok: false, kind: 'blocked' });
    expect(await service.runSelect('SELECT 1 FROM orders', 2.5)).toMatchObject({ ok: false, kind: 'blocked' });
  });
});

describe('result size cap', () => {
  it('stops adding rows once the JSON size cap is reached', async () => {
    const small = new QueryService(backend, { ...TEST_GUARD, resultMaxBytes: 2048 }, new AuditLog(auditPath));
    const r = await small.runSelect('SELECT * FROM support_tickets', 500);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.truncatedReason).toBe('size_limit');
    expect(Buffer.byteLength(JSON.stringify(r.value.rows))).toBeLessThanOrEqual(2048);
    expect(r.value.rowCount).toBeGreaterThan(0);
  });
});

describe('timeout', () => {
  it('kills a runaway query and keeps serving afterwards', async () => {
    const t0 = Date.now();
    const r = await service.runSelect('WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT COUNT(*) FROM r');
    const elapsed = Date.now() - t0;
    expect(r).toMatchObject({ ok: false, kind: 'timeout' });
    expect(elapsed).toBeLessThan(TEST_GUARD.queryTimeoutMs + 2000);
    // A fresh runner process is started for the next query.
    const after = await service.runSelect('SELECT COUNT(*) AS n FROM customers');
    expect(after.ok && after.value.rows).toEqual([{ n: 400 }]);
  });
});

describe('database layer (defence in depth)', () => {
  it('refuses writes even if the guard is bypassed', async () => {
    await expect(backend.runSelect('DELETE FROM customers', { rowLimit: 1, timeoutMs: 2000, maxBytes: 1000 })).rejects.toThrow();
    await expect(
      backend.runSelect('WITH x AS (SELECT 1) DELETE FROM customers RETURNING id', { rowLimit: 1, timeoutMs: 2000, maxBytes: 1000 }),
    ).rejects.toThrow(/can write/);
    await expect(backend.runSelect("SELECT load_extension('nope')", { rowLimit: 1, timeoutMs: 2000, maxBytes: 1000 })).rejects.toThrow();
    const r = await backend.runSelect('SELECT COUNT(*) AS n FROM customers', { rowLimit: 1, timeoutMs: 2000, maxBytes: 1000 });
    expect(r.rows).toEqual([{ n: 400 }]);
  });
});

describe('describe_table and list_tables', () => {
  it('lists the six business tables', async () => {
    const r = await service.listTables();
    expect(r).toEqual({ ok: true, value: ['customers', 'employees', 'order_items', 'orders', 'products', 'support_tickets'] });
  });

  it('returns columns, keys and row count', async () => {
    const r = await service.describeTable('order_items');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.primaryKey).toEqual(['id']);
    expect(r.value.foreignKeys).toEqual(
      expect.arrayContaining([
        { column: 'order_id', referencesTable: 'orders', referencesColumn: 'id' },
        { column: 'product_id', referencesTable: 'products', referencesColumn: 'id' },
      ]),
    );
    expect(r.value.rowCount).toBeGreaterThan(5000);
  });

  it('rejects injection through the table name', async () => {
    expect(await service.describeTable('orders; DROP TABLE orders')).toMatchObject({ ok: false, kind: 'blocked' });
    expect(await service.describeTable('nope')).toMatchObject({ ok: false, kind: 'not_found' });
  });
});

describe('audit log', () => {
  it('records allowed, blocked and timed-out calls with the required fields', async () => {
    const before = readAudit(auditPath).length;
    await service.runSelect('SELECT name FROM products', 3);
    await service.runSelect('DROP TABLE products');
    const entries = readAudit(auditPath).slice(before);
    expect(entries).toHaveLength(2);
    const [ok, blocked] = entries;
    expect(ok).toMatchObject({ tool: 'run_select', decision: 'allowed', rows: 3, query: 'SELECT name FROM products' });
    expect(blocked).toMatchObject({ tool: 'run_select', decision: 'blocked', layer: 'lexical', query: 'DROP TABLE products' });
    for (const e of entries) {
      expect(typeof e.ts).toBe('string');
      expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
      expect(typeof e.durationMs).toBe('number');
    }
    expect(readAudit(auditPath).some((e) => e.decision === 'timeout')).toBe(true);
  });

  it('is append-only: earlier lines are never rewritten', async () => {
    const first = readAudit(auditPath);
    await service.listTables();
    const second = readAudit(auditPath);
    expect(second.slice(0, first.length)).toEqual(first);
    expect(second.length).toBe(first.length + 1);
  });
});
