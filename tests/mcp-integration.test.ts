/**
 * Spawns the real MCP server over stdio and talks to it with the official
 * MCP client SDK, exactly as an MCP host would.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqlMcpClient } from '../src/agent/mcp-client.ts';
import { makeTestDb, readAudit } from './helpers.ts';

let client: SqlMcpClient;
let auditPath: string;

beforeAll(async () => {
  const t = makeTestDb();
  auditPath = t.auditPath;
  client = await SqlMcpClient.connect({ DB_BACKEND: 'sqlite', SQLITE_PATH: t.dbPath, AUDIT_LOG_PATH: t.auditPath, QUERY_TIMEOUT_MS: '1500', LOG_LEVEL: 'error' });
});
afterAll(async () => {
  await client?.close();
});

describe('MCP server over stdio', () => {
  it('advertises exactly the three read-only tools', async () => {
    const tools = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['describe_table', 'list_tables', 'run_select']);
    const run = tools.find((t) => t.name === 'run_select');
    expect(JSON.stringify(run?.inputSchema)).toContain('query');
  });

  it('list_tables returns the business tables', async () => {
    const r = await client.call('list_tables', {});
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).tables).toContain('orders');
  });

  it('describe_table returns keys and row count', async () => {
    const r = await client.call('describe_table', { table: 'orders' });
    const d = JSON.parse(r.text);
    expect(d.primaryKey).toEqual(['id']);
    expect(d.rowCount).toBe(3000);
  });

  it('run_select returns rows wrapped in an untrusted-data notice', async () => {
    const r = await client.call('run_select', { query: 'SELECT COUNT(*) AS n FROM customers' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('untrusted data');
    const json = r.text.slice(r.text.indexOf('<rows>') + 6, r.text.indexOf('</rows>'));
    expect(JSON.parse(json).rows).toEqual([{ n: 400 }]);
  });

  it('run_select blocks a write and reports it as a tool error', async () => {
    const r = await client.call('run_select', { query: 'SELECT 1; DROP TABLE customers' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/BLOCKED by lexical guardrail/);
    // The table is still there.
    const check = await client.call('run_select', { query: 'SELECT COUNT(*) AS n FROM customers' });
    expect(check.text).toContain('"n":400');
  });

  it('run_select times out a runaway query', async () => {
    const r = await client.call('run_select', { query: 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT COUNT(*) FROM r' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^TIMEOUT/);
  });

  it('rejects arguments that fail the input schema', async () => {
    const r = await client.call('run_select', { query: 'SELECT 1 FROM customers', limit: 0 });
    expect(r.isError).toBe(true);
  });

  it('writes every call to the audit log', () => {
    const entries = readAudit(auditPath);
    expect(entries.some((e) => e.decision === 'blocked' && e.query?.includes('DROP TABLE'))).toBe(true);
    expect(entries.some((e) => e.decision === 'timeout')).toBe(true);
    expect(entries.some((e) => e.tool === 'describe_table' && e.table === 'orders')).toBe(true);
  });
});
