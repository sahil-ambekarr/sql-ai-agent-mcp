/** MCP server over stdio: `npm run server` (this is what MCP clients spawn). */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { log } from '../logger.ts';
import { bootstrap } from './bootstrap.ts';
import { createMcpServer } from './tools.ts';

const rt = await bootstrap();
const handle = serveStdio(() => createMcpServer(rt.service), {
  onerror: (err) => log('error', 'mcp transport error', { error: err.message }),
});
log('info', 'sql-ai-agent-mcp ready on stdio', { backend: rt.config.dbBackend, audit: rt.config.auditLogPath });

let closing = false;
async function shutdown(reason: string) {
  if (closing) return;
  closing = true;
  log('info', 'shutting down', { reason });
  await handle.close().catch(() => undefined);
  await rt.backend.close().catch(() => undefined);
  process.exit(0);
}
process.stdin.on('end', () => void shutdown('stdin closed'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
