import { describe, expect, it } from 'vitest';
import { applyTopLimit, MSSQL_DESCRIBE_COLUMNS, MSSQL_FOREIGN_KEYS, MSSQL_LIST_TABLES, MSSQL_ROW_COUNT } from '../src/db/mssql-dialect.ts';
import { validateSelect } from '../src/guard/validate.ts';
import { renderTsqlSeed } from '../src/seed/tsql.ts';

describe('SQL Server TOP rewriting', () => {
  it('injects TOP after SELECT', () => {
    expect(applyTopLimit('SELECT name FROM dbo.customers ORDER BY name', 101)).toEqual({
      sql: 'SELECT TOP (101) name FROM dbo.customers ORDER BY name',
      applied: true,
    });
  });

  it('injects TOP after DISTINCT', () => {
    expect(applyTopLimit('SELECT DISTINCT country FROM customers', 10).sql).toBe('SELECT DISTINCT TOP (10) country FROM customers');
  });

  it('lowers an existing TOP that is larger than the limit', () => {
    expect(applyTopLimit('SELECT TOP 5000 * FROM orders', 101).sql).toBe('SELECT TOP (101) * FROM orders');
    expect(applyTopLimit('SELECT TOP (5000) * FROM orders', 101).sql).toBe('SELECT TOP (101) * FROM orders');
  });

  it('keeps a smaller existing TOP untouched', () => {
    const q = 'SELECT TOP 5 name FROM customers ORDER BY name';
    expect(applyTopLimit(q, 101)).toMatchObject({ sql: q, applied: true });
  });

  it('applies TOP to the outer SELECT of a CTE, not the CTE body', () => {
    const q = 'WITH x AS (SELECT customer_id, COUNT(*) AS n FROM orders GROUP BY customer_id) SELECT * FROM x ORDER BY n DESC';
    expect(applyTopLimit(q, 11).sql).toBe(
      'WITH x AS (SELECT customer_id, COUNT(*) AS n FROM orders GROUP BY customer_id) SELECT TOP (11) * FROM x ORDER BY n DESC',
    );
  });

  it('ignores SELECT keywords inside strings and subqueries', () => {
    const q = "SELECT (SELECT COUNT(*) FROM orders) AS n, 'SELECT' AS s FROM customers";
    expect(applyTopLimit(q, 3).sql).toBe("SELECT TOP (3) (SELECT COUNT(*) FROM orders) AS n, 'SELECT' AS s FROM customers");
  });

  it('does not rewrite shapes where TOP would be wrong, and says why', () => {
    expect(applyTopLimit('SELECT a FROM x UNION SELECT a FROM y', 5)).toMatchObject({ applied: false, note: expect.stringContaining('UNION') });
    expect(applyTopLimit('SELECT a FROM x ORDER BY a OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY', 5)).toMatchObject({ applied: false });
    expect(applyTopLimit('SELECT TOP 10 PERCENT * FROM orders', 5)).toMatchObject({ applied: false });
  });

  it('rejects a non-positive limit', () => {
    expect(() => applyTopLimit('SELECT 1', 0)).toThrow();
  });

  it('produces SQL that still passes the guard', () => {
    const r = applyTopLimit('SELECT name FROM customers ORDER BY name', 101);
    expect(validateSelect(r.sql, { dialect: 'mssql', maxChars: 8000, allowedTables: new Set(['customers']) })).toMatchObject({ ok: true });
  });
});

describe('SQL Server catalog queries', () => {
  it('only look at the dbo schema and take the table as a parameter', () => {
    for (const q of [MSSQL_DESCRIBE_COLUMNS, MSSQL_FOREIGN_KEYS, MSSQL_ROW_COUNT]) {
      expect(q).toContain("= 'dbo'");
      expect(q).toContain('@table');
    }
    expect(MSSQL_LIST_TABLES).toContain("= 'dbo'");
    expect(MSSQL_LIST_TABLES).not.toContain('@table');
  });

  it('read primary keys and foreign keys from sys catalog views', () => {
    expect(MSSQL_DESCRIBE_COLUMNS).toContain('is_primary_key');
    expect(MSSQL_FOREIGN_KEYS).toContain('sys.foreign_key_columns');
    expect(MSSQL_ROW_COUNT).toContain('sys.partitions');
  });
});

describe('T-SQL seed script', () => {
  const script = renderTsqlSeed();
  it('creates every table and a least-privilege reader', () => {
    for (const t of ['customers', 'products', 'employees', 'orders', 'order_items', 'support_tickets']) {
      expect(script).toContain(`CREATE TABLE dbo.${t}`);
    }
    expect(script).toContain('ALTER ROLE db_datareader ADD MEMBER agent_reader');
    expect(script).toMatch(/DENY INSERT, UPDATE, DELETE/);
  });
  it('keeps the reader password out of the file', () => {
    expect(script).toContain("PASSWORD = N'$(READER_PASSWORD)'");
  });
  it('never puts more than 1000 rows in one VALUES list', () => {
    const chunks = script.split('INSERT INTO').slice(1);
    expect(chunks.length).toBeGreaterThan(6);
    for (const c of chunks) expect(c.split('),\n(').length).toBeLessThanOrEqual(1000);
  });
});
