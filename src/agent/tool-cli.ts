/**
 * Calls one MCP tool directly, with no LLM involved. Handy for checking the
 * guardrails by hand:
 *
 *   npm run tool -- list_tables
 *   npm run tool -- describe_table orders
 *   npm run tool -- run_select "SELECT COUNT(*) FROM orders"
 *   npm run tool -- run_select "DELETE FROM customers"
 */
import { SqlMcpClient } from './mcp-client.ts';

const [tool, arg, limit] = process.argv.slice(2);
if (!tool || !['list_tables', 'describe_table', 'run_select'].includes(tool)) {
  console.error('usage: npm run tool -- <list_tables | describe_table TABLE | run_select "SQL" [LIMIT]>');
  process.exit(2);
}
const args: Record<string, unknown> =
  tool === 'describe_table' ? { table: arg ?? '' } : tool === 'run_select' ? { query: arg ?? '', ...(limit ? { limit: Number(limit) } : {}) } : {};

const client = await SqlMcpClient.connect();
try {
  process.stdout.write(`> ${tool} ${arg ? JSON.stringify(arg) : ''}\n`);
  const res = await client.call(tool, args);
  process.stdout.write((res.isError ? '[tool error] ' : '') + res.text + '\n');
  process.exitCode = res.isError ? 1 : 0;
} finally {
  await client.close();
}
