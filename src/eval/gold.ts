/**
 * Eval questions and their expected answers, computed by running each gold
 * SQL directly against the seeded SQLite database (no MCP, no LLM).
 *
 *   npm run eval:gold      prints every question with its expected answer
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const Check = z.discriminatedUnion('type', [
  z.object({ type: z.literal('number'), tolerance: z.number().min(0) }),
  z.object({ type: z.literal('names'), columns: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('month') }),
]);

const Question = z.object({
  id: z.string(),
  question: z.string(),
  gold_sql: z.string(),
  check: Check,
  comment: z.string().optional(),
});

const QuestionFile = z.object({ today: z.string(), notes: z.string().optional(), questions: z.array(Question) });

export type EvalQuestion = z.infer<typeof Question>;
export type EvalCheck = z.infer<typeof Check>;

export interface GoldQuestion extends EvalQuestion {
  goldRows: Array<Record<string, unknown>>;
}

export const QUESTIONS_PATH = fileURLToPath(new URL('../../eval/questions.json', import.meta.url));

export function loadQuestions(path = QUESTIONS_PATH): { today: string; questions: EvalQuestion[] } {
  return QuestionFile.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function computeGold(dbPath: string, questions: EvalQuestion[]): GoldQuestion[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return questions.map((q) => ({ ...q, goldRows: db.prepare(q.gold_sql).all() as Array<Record<string, unknown>> }));
  } finally {
    db.close();
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Numbers that appear in free text: "1,503,514.43", "$1.5", "79". */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, ''))).filter((n) => Number.isFinite(n));
}

/** Grades one free-text answer against the gold rows. Returns the expected value shown in reports. */
export function grade(answer: string, q: GoldQuestion): { correct: boolean; expected: string } {
  const first = q.goldRows[0] ?? {};
  const lower = answer.toLowerCase();
  switch (q.check.type) {
    case 'number': {
      const expected = Number(Object.values(first)[0]);
      const tol = q.check.tolerance;
      const ok = numbersIn(answer).some((n) => (tol === 0 ? n === expected : Math.abs(n - expected) <= Math.abs(expected) * tol));
      return { correct: ok, expected: String(expected) };
    }
    case 'names': {
      const cols = q.check.columns;
      const values = q.goldRows.flatMap((r) => cols.map((c) => String(r[c] ?? '')));
      return { correct: values.length > 0 && values.every((v) => lower.includes(v.toLowerCase())), expected: values.join(' | ') };
    }
    case 'month': {
      const ym = String(Object.values(first)[0] ?? '');
      const name = MONTHS[Number(ym.slice(5, 7)) - 1] ?? '';
      return { correct: lower.includes(ym) || (name !== '' && lower.includes(name.toLowerCase())), expected: `${ym} (${name})` };
    }
  }
}

/**
 * Grades a whole agent run. Only a real final answer can be correct: the stop
 * messages ("stopped after 6 steps ...") contain numbers that would otherwise
 * match a numeric check by accident.
 */
export function gradeRun(answer: string, stoppedReason: string, q: GoldQuestion): { correct: boolean; expected: string } {
  const g = grade(answer, q);
  return { correct: stoppedReason === 'answered' && g.correct, expected: g.expected };
}

// CLI: print the expected answers.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { loadConfig } = await import('../config.ts');
  const { questions } = loadQuestions();
  for (const q of computeGold(loadConfig().sqlitePath, questions)) {
    process.stdout.write(`${q.id.padEnd(34)} ${JSON.stringify(q.goldRows)}\n`);
  }
}
