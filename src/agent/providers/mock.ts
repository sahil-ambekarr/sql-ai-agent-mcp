/**
 * Deterministic scripted provider for tests and CI. It replays a fixed
 * sequence of tool calls and answers; no model, network or key involved.
 */
import type { AssistantTurn, ChatMessage, LlmProvider } from '../types.ts';

export type MockStep =
  | { call: string; args: Record<string, unknown> }
  | { answer: string }
  /** Build the answer from the most recent tool result text. */
  | { answerFrom: (lastToolResult: string) => string };

export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  private readonly script: MockStep[];
  private index = 0;
  /** Every message list the provider was called with (handy in tests). */
  readonly calls: ChatMessage[][] = [];

  constructor(script: MockStep[]) {
    this.script = script;
  }

  async complete(messages: ChatMessage[]): Promise<AssistantTurn> {
    this.calls.push([...messages]);
    const step = this.script[Math.min(this.index, this.script.length - 1)];
    this.index++;
    if (!step) return { text: 'mock script is empty', toolCalls: [] };
    if ('call' in step) return { text: '', toolCalls: [{ id: `mock_${this.index}`, name: step.call, args: step.args }] };
    if ('answer' in step) return { text: step.answer, toolCalls: [] };
    const last = [...messages].reverse().find((m) => m.role === 'tool');
    return { text: step.answerFrom(last && last.role === 'tool' ? last.content : ''), toolCalls: [] };
  }
}

/** Pulls the JSON rows out of a run_select result. */
export function rowsFromToolText(text: string): Array<Record<string, unknown>> {
  const a = text.indexOf('<rows>');
  const b = text.indexOf('</rows>');
  if (a < 0 || b < 0) return [];
  try {
    return (JSON.parse(text.slice(a + 6, b)) as { rows: Array<Record<string, unknown>> }).rows;
  } catch {
    return [];
  }
}

/** Renders rows as a plain-text answer ("name: X, revenue: 1.5; ..."). */
export function rowsToAnswer(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return 'The query returned no rows.';
  return rows.map((r) => Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(', ')).join('; ');
}

/** Default script for `LLM_PROVIDER=mock npm run ask`: one query, then an answer built from its rows. */
export function defaultMockScript(): MockStep[] {
  return [
    {
      call: 'run_select',
      args: {
        query:
          "SELECT c.name, ROUND(SUM(oi.quantity * oi.unit_price * (1 - oi.discount)), 2) AS revenue FROM customers c JOIN orders o ON o.customer_id = c.id JOIN order_items oi ON oi.order_id = o.id WHERE o.status IN ('completed', 'shipped') AND o.order_date BETWEEN '2026-07-01' AND '2026-09-30' GROUP BY c.id, c.name ORDER BY revenue DESC LIMIT 5",
      },
    },
    { answerFrom: (t) => `(mock provider, scripted query) ${rowsToAnswer(rowsFromToolText(t))}` },
  ];
}
