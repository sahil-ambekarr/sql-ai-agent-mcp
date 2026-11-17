/**
 * Ask a business question in plain English:
 *
 *   npm run ask -- "Which 5 customers spent the most last quarter?"
 *
 * Spawns the MCP server, runs the agent loop with the configured provider,
 * and prints the final answer plus every SQL statement it ran.
 */
import { loadConfig } from '../config.ts';
import { runAgent } from './loop.ts';
import { SqlMcpClient } from './mcp-client.ts';
import { createProvider } from './providers/index.ts';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const question = args.filter((a) => a !== '--verbose').join(' ').trim();
if (!question) {
  console.error('usage: npm run ask -- "your question" [--verbose]');
  process.exit(2);
}

const cfg = loadConfig();
const provider = createProvider(cfg.llm, { onRaw: verbose ? (raw) => process.stderr.write(`[model] ${raw}\n`) : undefined });
const today = cfg.agentToday || new Date().toISOString().slice(0, 10);
const out = (s = '') => process.stdout.write(s + '\n');

const client = await SqlMcpClient.connect();
try {
  out(`Question: ${question}`);
  out(`Provider: ${provider.name} | backend: ${cfg.dbBackend} | today: ${today}`);
  out();
  const result = await runAgent(question, client, provider, {
    maxSteps: cfg.agentMaxSteps,
    today,
    dialect: cfg.dbBackend,
    onEvent: (e) => {
      if (e.type === 'tool_call') out(`  -> ${e.detail.length > 220 ? e.detail.slice(0, 220) + '...' : e.detail}`);
      if (e.type === 'tool_result') out(`  <- ${e.detail}`);
    },
  });
  out();
  out('SQL run:');
  if (result.sql.length === 0) out('  (none)');
  result.sql.forEach((s, i) => out(`  ${i + 1}. [${s.blocked ? 'BLOCKED' : s.ok ? 'ok' : 'error'}] ${s.query}`));
  out();
  out(`Answer: ${result.answer}`);
  out();
  out(`(${result.steps} model step(s), ${(result.durationMs / 1000).toFixed(1)} s, stopped: ${result.stoppedReason})`);
  process.exitCode = result.stoppedReason === 'answered' ? 0 : 1;
} finally {
  await client.close();
}
