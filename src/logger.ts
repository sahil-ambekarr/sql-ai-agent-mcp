/**
 * Structured JSON logs on stderr. stdout is reserved for the MCP stdio
 * protocol (server) and for the answer (CLI), so logs never go there.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info;

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < threshold) return;
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + '\n');
}
