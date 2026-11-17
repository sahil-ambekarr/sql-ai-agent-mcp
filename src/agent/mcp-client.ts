/**
 * Connects to the SQL MCP server as a real MCP client: spawns
 * `node src/server/stdio.ts` and talks JSON-RPC over its stdin/stdout.
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';

const SERVER_ENTRY = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../server/stdio.ts' : '../server/stdio.js', import.meta.url));

export interface ToolCallOutcome {
  text: string;
  isError: boolean;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class SqlMcpClient {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;

  private constructor(client: Client, transport: StdioClientTransport) {
    this.client = client;
    this.transport = transport;
  }

  /** Spawns the server with the given extra environment (merged over the current one). */
  static async connect(env: Record<string, string> = {}): Promise<SqlMcpClient> {
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') merged[k] = v;
    Object.assign(merged, env);
    // The server logs JSON to stderr; keep the CLI's output clean unless asked.
    merged.LOG_LEVEL ??= 'warn';
    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], env: merged, stderr: 'inherit' });
    const client = new Client({ name: 'sql-agent-cli', version: '0.1.0' });
    await client.connect(transport);
    return new SqlMcpClient(client, transport);
  }

  async listTools(): Promise<McpToolInfo[]> {
    const res = await this.client.listTools();
    return res.tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema as Record<string, unknown> }));
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome> {
    const res = await this.client.callTool({ name, arguments: args });
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
    return { text, isError: Boolean(res.isError) };
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
    await this.transport.close().catch(() => undefined);
  }
}
