/** The optional streamable HTTP transport, on 127.0.0.1:4104. */
import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { makeTestDb } from './helpers.ts';

const PORT = 4104;
let server: ChildProcess;

beforeAll(async () => {
  const t = makeTestDb();
  server = spawn(process.execPath, ['src/server/http.ts'], {
    env: { ...process.env, HTTP_PORT: String(PORT), SQLITE_PATH: t.dbPath, AUDIT_LOG_PATH: t.auditPath, LOG_LEVEL: 'info' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('http server did not start')), 15_000);
    server.stderr?.on('data', (d: Buffer) => {
      if (d.toString().includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once('exit', (code) => reject(new Error(`http server exited with ${code}`)));
  });
});
afterAll(() => {
  server?.kill();
});

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'http-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

describe('MCP server over streamable HTTP', () => {
  it('lists the tools and runs a guarded query', async () => {
    await withClient(async (c) => {
      const tools = await c.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(['describe_table', 'list_tables', 'run_select']);
      const ok = await c.callTool({ name: 'run_select', arguments: { query: 'SELECT COUNT(*) AS n FROM products' } });
      expect(JSON.stringify(ok.content)).toContain('\\"n\\":60');
      const blocked = await c.callTool({ name: 'run_select', arguments: { query: 'DROP TABLE products' } });
      expect(blocked.isError).toBe(true);
    });
  });

  it('rejects a request with a foreign Host header (DNS rebinding guard)', async () => {
    // fetch() will not let us override Host, so use node:http directly.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
  });
});
