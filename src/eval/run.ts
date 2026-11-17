/**
 * Runs every eval question through the real agent (MCP server + provider)
 * and grades the answers against SQL-computed gold rows.
 *
 *   npm run eval                          # provider from .env (default ollama, json mode)
 *   npm run eval -- --provider mock       # scripted, used in CI
 *   npm run eval -- --mode tools          # Ollama native tool calling
 *   npm run eval -- --ids q01_customer_count,q04_revenue_2025
 *   npm run eval -- --budget-min 45       # whole-run wall-clock budget
 *   npm run eval -- --question-min 6      # per-question wall-clock cap
 *
 * Questions run one at a time (Ollama is CPU-only and shared). The results
 * file is rewritten after every question, so an interrupted run keeps what
 * it finished. A question that runs past its cap (or past the end of the
budget) is aborted mid-call and graded as 'time_limit'; questions not started
inside the budget are listed as skipped.
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
const budgetMs = arg('budget-min') ? Number(arg('budget-min')) * 60_000 : Infinity;
if (Number.isNaN(budgetMs) || budgetMs <= 0) throw new Error('--budget-min must be a positive number');
const questionMs = arg('question-min') ? Number(arg('question-min')) * 60_000 : Infinity;
if (Number.isNaN(questionMs) || questionMs <= 0) throw new Error('--question-min must be a positive number');

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

let client = await SqlMcpClient.connect();
const rows: Row[] = [];
const skipped: string[] = [];
const startedAt = new Date().toISOString();
const t0 = Date.now();
const provider = providerName === 'ollama' ? `ollama:${cfg.llm.ollamaModel}:${mode}` : providerName === 'claude' ? `claude:${cfg.llm.claudeModel}` : 'mock';
const file = arg('out') ?? `eval/results/${provider.replace(/[:.]/g, '-')}.json`;
mkdirSync('eval/results', { recursive: true });

function summarize() {
  const n = rows.length || 1;
  return {
    provider,
    startedAt,
    wallClockMs: Date.now() - t0,
    questions: rows.length,
    skipped,
    correct: rows.filter((r) => r.correct).length,
    accuracy: rows.filter((r) => r.correct).length / n,
    meanSteps: rows.reduce((a, r) => a + r.steps, 0) / n,
    meanLatencyMs: Math.round(rows.reduce((a, r) => a + r.latencyMs, 0) / n),
    guardrailBlocks: rows.reduce((a, r) => a + r.blocked, 0),
    sqlErrors: rows.reduce((a, r) => a + r.sqlErrors, 0),
    stoppedAtStepLimit: rows.filter((r) => r.stoppedReason === 'max_steps').length,
    providerErrors: rows.filter((r) => r.stoppedReason === 'provider_error').length,
    stoppedAtTimeLimit: rows.filter((r) => r.stoppedReason === 'time_limit').length,
    budgetMs: Number.isFinite(budgetMs) ? budgetMs : null,
    questionCapMs: Number.isFinite(questionMs) ? questionMs : null,
    maxSteps: cfg.agentMaxSteps,
    llmTimeoutMs: cfg.llm.timeoutMs,
    hardware: `${cpus()[0]?.model ?? 'unknown CPU'}, ${Math.round(totalmem() / 2 ** 30)} GB RAM, ${process.platform}`,
  };
}
const save = () => writeFileSync(file, JSON.stringify({ summary: summarize(), rows }, null, 2) + '\n');

try {
  for (const [i, q] of questions.entries()) {
    if (Date.now() - t0 > budgetMs) {
      skipped.push(...questions.slice(i).map((s) => s.id));
      out(`Time budget reached; skipped ${questions.length - i} question(s): ${skipped.join(', ')}`);
      break;
    }
    // The mock provider replays the gold SQL; this checks the plumbing, not a model.
    const mockScript: MockStep[] = [{ call: 'run_select', args: { query: q.gold_sql } }, { answerFrom: (t) => rowsToAnswer(rowsFromToolText(t)) }];
    const llm = createProvider(cfg.llm, { mockScript });
    let r: AgentResult;
    try {
      const capMs = Math.min(questionMs, budgetMs - (Date.now() - t0));
      const signal = Number.isFinite(capMs) ? AbortSignal.timeout(Math.max(1, capMs)) : undefined;
      r = await runAgent(q.question, client, llm, { maxSteps: cfg.agentMaxSteps, today, dialect: cfg.dbBackend, signal });
    } catch (e) {
      // A lost MCP connection should cost one question, not the whole run.
      const message = (e as Error).message;
      r = { question: q.question, answer: `(run error: ${message})`, stoppedReason: 'provider_error', error: message, steps: 0, toolCalls: [], sql: [], durationMs: 0 };
      await client.close();
      client = await SqlMcpClient.connect();
    }
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
    save();
  }
} finally {
  await client.close();
}

save();
const summary = summarize();

out();
out(`Provider:          ${summary.provider}`);
out(`Accuracy:          ${summary.correct}/${summary.questions} (${(summary.accuracy * 100).toFixed(1)}%)${skipped.length ? `, ${skipped.length} skipped` : ''}`);
out(`Wall clock:        ${(summary.wallClockMs / 60_000).toFixed(1)} min`);
out(`Mean steps:        ${summary.meanSteps.toFixed(2)} (limit ${summary.maxSteps})`);
out(`Mean latency:      ${(summary.meanLatencyMs / 1000).toFixed(1)} s`);
out(`Guardrail blocks:  ${summary.guardrailBlocks}`);
out(`SQL errors:        ${summary.sqlErrors}`);
out(`Hit step limit:    ${summary.stoppedAtStepLimit}   time limit: ${summary.stoppedAtTimeLimit}   provider errors: ${summary.providerErrors}`);

out(`Saved ${file}`);
if (providerName === 'mock' && summary.correct !== summary.questions) process.exitCode = 1;
