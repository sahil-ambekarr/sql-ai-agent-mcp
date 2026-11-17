/**
 * Optional streamable HTTP transport: `npm run server:http`.
 * Binds to 127.0.0.1 only and validates Host/Origin headers, because a
 * local MCP endpoint is otherwise reachable from any web page via DNS rebinding.
 * Stateless: a fresh McpServer per request, sharing one QueryService.
 */
import { createServer } from 'node:http';
import { localhostHostValidation, localhostOriginValidation, NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { log } from '../logger.ts';
import { bootstrap } from './bootstrap.ts';
import { createMcpServer } from './tools.ts';

const rt = await bootstrap();
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const httpServer = createServer(async (req, res) => {
  if (!validateHost(req, res) || !validateOrigin(req, res)) return;
  if (!req.url?.startsWith('/mcp')) {
    res.writeHead(404).end();
    return;
  }
  try {
    const server = createMcpServer(rt.service);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    res.on('close', () => void server.close());
    await transport.handleRequest(req, res);
  } catch (e) {
    log('error', 'http request failed', { error: (e as Error).message });
    if (!res.headersSent) res.writeHead(500).end();
  }
});

httpServer.listen(rt.config.httpPort, '127.0.0.1', () => {
  log('info', 'sql-ai-agent-mcp listening', { url: `http://127.0.0.1:${rt.config.httpPort}/mcp`, backend: rt.config.dbBackend });
});

const shutdown = () => {
  httpServer.close();
  void rt.backend.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
