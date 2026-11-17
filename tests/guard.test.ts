import { describe, expect, it } from 'vitest';
import { validateSelect, type Dialect } from '../src/guard/validate.ts';

const TABLES = new Set(['customers', 'products', 'employees', 'orders', 'order_items', 'support_tickets']);
const check = (sql: unknown, dialect: Dialect = 'sqlite') => validateSelect(sql, { dialect, maxChars: 8000, allowedTables: TABLES });

// [description, sql, dialect?]
const BLOCKED: Array<[string, string, Dialect?]> = [
  ['plain DELETE', 'DELETE FROM customers'],
  ['plain UPDATE', "UPDATE customers SET name = 'x'"],
  ['plain INSERT', "INSERT INTO customers (id) VALUES (999)"],
  ['DROP TABLE', 'DROP TABLE customers'],
  ['ALTER TABLE', 'ALTER TABLE customers ADD COLUMN x INT'],
  ['CREATE TABLE AS SELECT', 'CREATE TABLE copy AS SELECT * FROM customers'],
  ['TRUNCATE (T-SQL)', 'TRUNCATE TABLE dbo.orders', 'mssql'],
  ['stacked statement after SELECT', 'SELECT 1; DROP TABLE customers'],
  ['stacked statement with trailing semicolon', 'SELECT 1; DELETE FROM orders;'],
  ['two SELECTs', 'SELECT 1; SELECT 2'],
  ['statement hidden after line comment newline', 'SELECT 1 --\n; DROP TABLE customers'],
  ['line comment at end', 'SELECT * FROM customers -- harmless?'],
  ['block comment hiding a statement', 'SELECT 1 /* ; DROP TABLE customers */'],
  ['MySQL-style executable comment', 'SELECT 1 /*! ; DROP TABLE customers */'],
  ['nested T-SQL comment trick', 'SELECT 1 /* /* */ ; DROP TABLE customers -- */', 'mssql'],
  ['unterminated comment', 'SELECT 1 /* DROP TABLE customers'],
  ['CTE that deletes (SQLite)', 'WITH gone AS (DELETE FROM customers RETURNING id) SELECT * FROM gone'],
  ['CTE followed by DELETE', 'WITH x AS (SELECT 1) DELETE FROM customers'],
  ['CTE followed by UPDATE', "WITH x AS (SELECT id FROM customers) UPDATE customers SET name = 'x' WHERE id IN (SELECT id FROM x)"],
  ['SELECT INTO (T-SQL)', 'SELECT * INTO dbo.stolen FROM customers', 'mssql'],
  ['SELECT INTO temp table (T-SQL)', 'SELECT * INTO #t FROM customers', 'mssql'],
  ['INSERT ... SELECT', 'INSERT INTO orders SELECT * FROM orders'],
  ['REPLACE INTO', "REPLACE INTO customers (id, name) VALUES (1, 'x')"],
  ['PRAGMA write', 'PRAGMA writable_schema = 1'],
  ['PRAGMA read', 'PRAGMA table_info(customers)'],
  ['ATTACH database', "ATTACH DATABASE 'evil.db' AS evil"],
  ['DETACH database', 'DETACH DATABASE main'],
  ['VACUUM INTO', "VACUUM INTO 'copy.db'"],
  ['EXEC stored procedure', "EXEC sp_configure 'xp_cmdshell', 1", 'mssql'],
  ['EXECUTE dynamic SQL', "EXECUTE('DROP TABLE customers')", 'mssql'],
  ['xp_cmdshell inside SELECT', "SELECT * FROM customers WHERE 1 = xp_cmdshell('dir')", 'mssql'],
  ['OPENROWSET file read', "SELECT * FROM OPENROWSET(BULK 'C:\\secrets.txt', SINGLE_CLOB) AS x", 'mssql'],
  ['WAITFOR DELAY', "SELECT 1 WAITFOR DELAY '00:01:00'", 'mssql'],
  ['DECLARE variable', 'DECLARE @x INT', 'mssql'],
  ['load_extension', "SELECT load_extension('/tmp/evil.so')"],
  ['writefile (sqlite shell)', "SELECT writefile('x.txt', name) FROM customers"],
  ['BEGIN transaction', 'BEGIN TRANSACTION'],
  ['SELECT ... FOR UPDATE style lock keyword', 'SELECT * FROM customers FOR UPDATE'],
  ['system table not exposed', 'SELECT * FROM sqlite_master'],
  ['unknown table', 'SELECT * FROM payroll'],
  ['bind parameter', 'SELECT * FROM customers WHERE id = ?'],
  ['T-SQL variable reference', 'SELECT @@version', 'mssql'],
  ['starts with VALUES', 'VALUES (1)'],
  ['starts with a parenthesis', '(SELECT 1)'],
  ['empty query', '   '],
  ['only a semicolon', ';'],
  ['unterminated string', "SELECT * FROM customers WHERE name = 'abc"],
  ['NUL byte smuggling', 'SELECT 1\u0000; DROP TABLE customers'],
  ['GRANT', 'GRANT SELECT ON customers TO public'],
  ['MERGE (T-SQL)', 'MERGE INTO orders AS t USING orders AS s ON t.id = s.id WHEN MATCHED THEN DELETE;', 'mssql'],
  ['DBCC', 'DBCC CHECKDB', 'mssql'],
  ['SHUTDOWN', 'SHUTDOWN WITH NOWAIT', 'mssql'],
  ['lower-case delete', 'delete from customers'],
  ['mixed-case drop after select', 'select 1; DrOp TaBlE customers'],
];

const ALLOWED: Array<[string, string, Dialect?]> = [
  ['simple select', 'SELECT * FROM customers'],
  ['trailing semicolon', 'SELECT COUNT(*) FROM orders;'],
  ['join with aggregate', 'SELECT c.name, SUM(oi.quantity * oi.unit_price) AS total FROM customers c JOIN orders o ON o.customer_id = c.id JOIN order_items oi ON oi.order_id = o.id GROUP BY c.id, c.name ORDER BY total DESC LIMIT 5'],
  ['CTE', 'WITH rev AS (SELECT customer_id, COUNT(*) AS n FROM orders GROUP BY customer_id) SELECT c.name, rev.n FROM rev JOIN customers c ON c.id = rev.customer_id'],
  ['recursive CTE (timeout handles runaway ones)', 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 10) SELECT * FROM r'],
  ['denylisted word inside a string literal', "SELECT * FROM support_tickets WHERE body LIKE '%DROP TABLE%'"],
  ['semicolon inside a string literal', "SELECT * FROM customers WHERE name = 'a; DELETE FROM customers'"],
  ['comment marker inside a string literal', "SELECT * FROM customers WHERE name = 'x -- y /* z */'"],
  ['quoted identifier', 'SELECT "name" FROM "customers"'],
  ['replace() function is a read', "SELECT replace(name, 'Ltd', '') FROM customers"],
  ['subquery in FROM', 'SELECT t.n FROM (SELECT COUNT(*) AS n FROM orders) t'],
  ['EXISTS subquery', 'SELECT name FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)'],
  ['date functions', "SELECT strftime('%Y-%m', order_date) AS month, COUNT(*) FROM orders WHERE order_date >= date('2026-11-17', '-3 months') GROUP BY month"],
  ['UNION', "SELECT name FROM customers WHERE country = 'India' UNION SELECT name FROM customers WHERE country = 'Germany'"],
  ['window function', 'SELECT name, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM customers'],
  ['FILTER clause (parsed by the fallback grammar)', "SELECT COUNT(*) FILTER (WHERE status = 'open') FROM support_tickets"],
  ['NULLS LAST', 'SELECT name FROM products ORDER BY unit_price DESC NULLS LAST'],
  ['T-SQL TOP', 'SELECT TOP 5 name FROM dbo.customers ORDER BY name', 'mssql'],
  ['T-SQL OFFSET FETCH', 'SELECT name FROM customers ORDER BY name OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY', 'mssql'],
  ['T-SQL CTE', 'WITH x AS (SELECT customer_id FROM orders) SELECT COUNT(*) FROM x', 'mssql'],
];

describe('guard: queries that must be blocked', () => {
  it.each(BLOCKED)('%s', (_desc, sql, dialect) => {
    const r = check(sql, dialect ?? 'sqlite');
    expect(r.ok, JSON.stringify(r)).toBe(false);
  });

  it('has a substantial blocked suite', () => {
    expect(BLOCKED.length).toBeGreaterThanOrEqual(30);
  });
});

describe('guard: legitimate queries that must pass', () => {
  it.each(ALLOWED)('%s', (_desc, sql, dialect) => {
    const r = check(sql, dialect ?? 'sqlite');
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  });
});

describe('guard: details', () => {
  it('rejects non-string input', () => {
    expect(check(42)).toMatchObject({ ok: false, layer: 'input' });
    expect(check(null)).toMatchObject({ ok: false, layer: 'input' });
  });

  it('rejects queries over the length cap', () => {
    const r = validateSelect('SELECT ' + '1,'.repeat(100) + '1', { dialect: 'sqlite', maxChars: 50 });
    expect(r).toMatchObject({ ok: false, layer: 'input' });
  });

  it('strips one trailing semicolon from the SQL it returns', () => {
    expect(check('SELECT 1 FROM customers;')).toEqual({ ok: true, sql: 'SELECT 1 FROM customers' });
  });

  it('names the layer and the keyword when blocking', () => {
    expect(check('SELECT * INTO x FROM customers', 'mssql')).toMatchObject({ ok: false, layer: 'lexical', reason: expect.stringContaining('INTO') });
    expect(check('SELECT 1 -- hi')).toMatchObject({ ok: false, reason: expect.stringContaining('comments') });
  });

  it('fails closed when the parser cannot read valid-looking SQL', () => {
    // Valid SQLite that neither the SQLite nor the PostgreSQL grammar accepts: refused, not waved through.
    const r = check("SELECT COUNT(*) FILTER (WHERE status = 'open') FROM support_tickets WHERE subject LIKE '%a%' COLLATE NOCASE");
    expect(r).toMatchObject({ ok: false, layer: 'parser' });
  });

  it('allows any table when no allowlist is given', () => {
    expect(validateSelect('SELECT * FROM anything', { dialect: 'sqlite', maxChars: 1000 })).toMatchObject({ ok: true });
  });
});
