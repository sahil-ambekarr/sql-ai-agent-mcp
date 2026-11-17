/**
 * Runs every eval question through the real agent (MCP server + provider)
 * and grades the answers against SQL-computed gold rows.
 *
 *   npm run eval                          # provider from .env (default ollama, json mode)
 *   npm run eval -- --provider mock       # scripted, used in CI
 *   npm run eval -- --mode tools          # Ollama native tool calling
 *   npm run eval -- --ids q01_customer_count,q04_revenue_2025
 *
 * Questions run one at a time (Ollama is CPU-only and shared).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { loadConfig } from '../config.ts';
import { runAgent, type AgentResult } from '../agent/loop.ts';
import { SqlMcpClient } from '../agent/mcp-client.ts';
import { createProvider } from '../agent/providers/index.ts';
import { rowsFromToolText, rowsToAnswer, type MockStep } from '../agent/providers/mock.ts';
import { computeGold, grade, loadQuestions } from './gold.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const base = loadConfig();
const providerName = (arg('provider') ?? base.llm.provider) as typeof base.llm.provider;
const mode = (arg('mode') ?? base.llm.ollamaMode) as 'json' | 'tools';
const cfg = { ...base, llm: { ...base.llm, provider: providerName, ollamaMode: mode } };
const ids = arg('ids')?.split(',');

const { today, questions: all } = loadQuestions();
const questions = computeGold(cfg.sqlitePath, ids ? all.filter((q) => ids.includes(q.id)) : all);
const out = (s = '') => process.stdout.write(s + '\n');

interface Row {
  id: string;
  question: string;
  expected: string;
  answer: string;
  correct: boolean;
  steps: number;
  latencyMs: number;
  blocked: number;
  sqlErrors: number;
  stoppedReason: AgentResult['stoppedReason'];
  sql: AgentResult['sql'];
}

const client = await SqlMcpClient.connect();
const rows: Row[] = [];
const startedAt = new Date().toISOString();
try {
  for (const [i, q] of questions.entries()) {
    // The mock provider replays the gold SQL; this checks the plumbing, not a model.
    const mockScript: MockStep[] = [{ call: 'run_select', args: { query: q.gold_sql } }, { answerFrom: (t) => rowsToAnswer(rowsFromToolText(t)) }];
    const provider = createProvider(cfg.llm, { mockScript });
    const r = await runAgent(q.question, client, provider, { maxSteps: cfg.agentMaxSteps, today, dialect: cfg.dbBackend });
    const g = grade(r.answer, q);
    const row: Row = {
      id: q.id,
      question: q.question,
      expected: g.expected,
      answer: r.answer,
      correct: g.correct,
      steps: r.steps,
      latencyMs: r.durationMs,
      blocked: r.sql.filter((s) => s.blocked).length,
      sqlErrors: r.sql.filter((s) => !s.ok && !s.blocked).length,
      stoppedReason: r.stoppedReason,
      sql: r.sql,
    };
    rows.push(row);
    out(`[${i + 1}/${questions.length}] ${row.correct ? 'PASS' : 'FAIL'} ${q.id}  steps=${row.steps}  ${(row.latencyMs / 1000).toFixed(1)}s  blocked=${row.blocked}`);
    if (!row.correct) out(`      expected: ${row.expected}\n      answer:   ${row.answer.slice(0, 300)}`);
  }
} finally {
  await client.close();
}

const n = rows.length || 1;
const summary = {
  provider: providerName === 'ollama' ? `ollama:${cfg.llm.ollamaModel}:${mode}` : providerName === 'claude' ? `claude:${cfg.llm.claudeModel}` : 'mock',
  startedAt,
  questions: rows.length,
  correct: rows.filter((r) => r.correct).length,
  accuracy: rows.filter((r) => r.correct).length / n,
  meanSteps: rows.reduce((a, r) => a + r.steps, 0) / n,
  meanLatencyMs: Math.round(rows.reduce((a, r) => a + r.latencyMs, 0) / n),
  guardrailBlocks: rows.reduce((a, r) => a + r.blocked, 0),
  sqlErrors: rows.reduce((a, r) => a + r.sqlErrors, 0),
  stoppedAtStepLimit: rows.filter((r) => r.stoppedReason === 'max_steps').length,
  providerErrors: rows.filter((r) => r.stoppedReason === 'provider_error').length,
  maxSteps: cfg.agentMaxSteps,
  hardware: `${cpus()[0]?.model ?? 'unknown CPU'}, ${Math.round(totalmem() / 2 ** 30)} GB RAM, ${process.platform}`,
};

out();
out(`Provider:          ${summary.provider}`);
out(`Accuracy:          ${summary.correct}/${summary.questions} (${(summary.accuracy * 100).toFixed(1)}%)`);
out(`Mean steps:        ${summary.meanSteps.toFixed(2)} (limit ${summary.maxSteps})`);
out(`Mean latency:      ${(summary.meanLatencyMs / 1000).toFixed(1)} s`);
out(`Guardrail blocks:  ${summary.guardrailBlocks}`);
out(`SQL errors:        ${summary.sqlErrors}`);
out(`Hit step limit:    ${summary.stoppedAtStepLimit}   provider errors: ${summary.providerErrors}`);

const file = arg('out') ?? `eval/results/${summary.provider.replace(/[:.]/g, '-')}.json`;
mkdirSync('eval/results', { recursive: true });
writeFileSync(file, JSON.stringify({ summary, rows }, null, 2) + '\n');
out(`Saved ${file}`);
if (providerName === 'mock' && summary.correct !== summary.questions) process.exitCode = 1;
