/**
 * Runs the real CLI commands for the demo and saves their exact output to
 * docs/demo/*.txt. render-gif.ts then turns those transcripts into a GIF, so
 * every character in the GIF came from an actual run.
 *
 *   npm run demo:capture                 (needs Ollama for the first transcript)
 *   npm run demo:capture -- blocked      (only captures whose file name contains "blocked")
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

interface Capture {
  file: string;
  display: string;
  args: string[];
  env?: Record<string, string>;
}

const captures: Capture[] = [
  {
    file: 'docs/demo/ask.txt',
    display: 'npm run ask -- "How many orders were cancelled last quarter?"',
    args: ['src/agent/cli.ts', 'How many orders were cancelled last quarter?'],
    env: { AGENT_TODAY: '2026-11-17' },
  },
  {
    file: 'docs/demo/blocked.txt',
    display: 'npm run tool -- run_select "SELECT 1; DROP TABLE customers"',
    args: ['src/agent/tool-cli.ts', 'run_select', 'SELECT 1; DROP TABLE customers'],
  },
  {
    file: 'docs/demo/blocked-cte.txt',
    display: 'npm run tool -- run_select "WITH x AS (SELECT 1) DELETE FROM orders"',
    args: ['src/agent/tool-cli.ts', 'run_select', 'WITH x AS (SELECT 1) DELETE FROM orders'],
  },
];

const only = process.argv[2];
mkdirSync('docs/demo', { recursive: true });
for (const c of captures.filter((x) => !only || x.file.includes(only))) {
  process.stderr.write(`capturing: ${c.display}\n`);
  const r = spawnSync(process.execPath, c.args, {
    env: { ...process.env, LOG_LEVEL: 'warn', ...c.env },
    encoding: 'utf8',
    timeout: 30 * 60_000,
  });
  const text = `$ ${c.display}\n${r.stdout}`;
  writeFileSync(c.file, text);
  process.stderr.write(`  -> ${c.file} (exit ${r.status})\n`);
}
