/**
 * Ollama provider. Two modes:
 *
 *  - `json` (default): the model replies with one JSON "action" object, and
 *    Ollama's structured-output `format` (a JSON Schema) constrains decoding.
 *    Replies are validated with zod; an invalid one is sent back with the
 *    error and retried (max 2 times).
 *  - `tools`: Ollama's native tool calling (`tools` in /api/chat).
 *
 * See docs/eval-results.md for why `json` is the default with llama3.2 (3B).
 */
import { z } from 'zod';
import { withRetry } from '../retry.ts';
import { ProviderError, type AssistantTurn, type ChatMessage, type LlmProvider, type ToolCall, type ToolSpec } from '../types.ts';

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  mode: 'json' | 'tools';
  timeoutMs: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  /** Called with each raw model reply (debugging and transcripts). */
  onRaw?: (raw: string) => void;
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
}

const ACTION_FORMAT = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['list_tables', 'describe_table', 'run_select', 'final_answer'] },
    query: { type: 'string' },
    table: { type: 'string' },
    answer: { type: 'string' },
  },
  required: ['action'],
} as const;

const Action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list_tables') }),
  z.object({ action: z.literal('describe_table'), table: z.string().trim().min(1) }),
  z.object({ action: z.literal('run_select'), query: z.string().trim().min(1) }),
  z.object({ action: z.literal('final_answer'), answer: z.string().trim().min(1) }),
]);
type Action = z.infer<typeof Action>;

export const JSON_PROTOCOL = `Reply with exactly ONE JSON object and nothing else. Allowed objects:
{"action": "run_select", "query": "<one SQLite SELECT statement>"}
{"action": "describe_table", "table": "<table name>"}
{"action": "list_tables"}
{"action": "final_answer", "answer": "<short answer for the user, with the key numbers and names>"}
Run a query first; give final_answer only after you have seen the rows you need.`;

export class OllamaProvider implements LlmProvider {
  readonly name: string;
  private readonly opts: OllamaOptions;
  private readonly fetchImpl: typeof fetch;
  private callSeq = 0;

  constructor(opts: OllamaOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.name = `ollama:${opts.model}:${opts.mode}`;
  }

  complete(messages: ChatMessage[], tools: ToolSpec[], signal?: AbortSignal): Promise<AssistantTurn> {
    return this.opts.mode === 'tools' ? this.completeWithTools(messages, tools, signal) : this.completeWithJson(messages, signal);
  }

  private async chat(body: Record<string, unknown>, outer?: AbortSignal): Promise<OllamaMessage> {
    return withRetry(
      async () => {
        let res: Response;
        try {
          res = await this.fetchImpl(`${this.opts.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: this.opts.model, stream: false, options: { temperature: 0, num_ctx: 8192 }, ...body }),
            signal: outer ? AbortSignal.any([outer, AbortSignal.timeout(this.opts.timeoutMs)]) : AbortSignal.timeout(this.opts.timeoutMs),
          });
        } catch (e) {
          throw new ProviderError(`Ollama request failed: ${(e as Error).message}`);
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = new ProviderError(`Ollama returned HTTP ${res.status}: ${text.slice(0, 200)}`);
          (err as ProviderError & { status?: number }).status = res.status;
          throw err;
        }
        const json = (await res.json()) as { message?: OllamaMessage };
        if (!json.message) throw new ProviderError('Ollama response had no message');
        return json.message;
      },
      {
        retries: 2,
        baseDelayMs: 1000,
        // Retry transport errors and 5xx; a 4xx (bad model name, bad request) will not fix itself.
        isRetryable: (e) => {
          if (outer?.aborted) return false;
          const status = (e as { status?: number }).status;
          return status === undefined || status >= 500;
        },
      },
    );
  }

  // ---- JSON-action protocol ----------------------------------------------

  private toJsonMessages(messages: ChatMessage[]): OllamaMessage[] {
    return messages.map((m): OllamaMessage => {
      switch (m.role) {
        case 'system':
          return { role: 'system', content: `${m.content}\n\n${JSON_PROTOCOL}` };
        case 'user':
          return { role: 'user', content: m.content };
        case 'assistant': {
          const call = m.toolCalls[0];
          const action = call ? { action: call.name, ...call.args } : { action: 'final_answer', answer: m.content };
          return { role: 'assistant', content: JSON.stringify(action) };
        }
        case 'tool':
          return { role: 'user', content: `Result of ${m.name}${m.isError ? ' (ERROR)' : ''}:\n${m.content}\n\nNext JSON action?` };
      }
    });
  }

  private async completeWithJson(messages: ChatMessage[], signal?: AbortSignal): Promise<AssistantTurn> {
    const convo = this.toJsonMessages(messages);
    let lastError = '';
    for (let attempt = 0; attempt <= 2; attempt++) {
      const reply = await this.chat({ messages: convo, format: ACTION_FORMAT }, signal);
      this.opts.onRaw?.(reply.content);
      const parsed = parseAction(reply.content);
      if (parsed.ok) return actionToTurn(parsed.action, ++this.callSeq);
      lastError = parsed.error;
      // Show the model its own invalid reply and what was wrong, then ask again.
      convo.push({ role: 'assistant', content: reply.content });
      convo.push({ role: 'user', content: `That reply was invalid (${parsed.error}). Reply again with exactly one JSON object as specified.` });
    }
    throw new ProviderError(`model did not produce a valid JSON action after 3 attempts: ${lastError}`);
  }

  // ---- native tool calling ----------------------------------------------

  private async completeWithTools(messages: ChatMessage[], tools: ToolSpec[], signal?: AbortSignal): Promise<AssistantTurn> {
    const convo: OllamaMessage[] = messages.map((m): OllamaMessage => {
      switch (m.role) {
        case 'assistant':
          return {
            role: 'assistant',
            content: m.content,
            ...(m.toolCalls.length ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })) } : {}),
          };
        case 'tool':
          return { role: 'tool', content: m.content, tool_name: m.name };
        default:
          return { role: m.role, content: m.content };
      }
    });
    const reply = await this.chat(
      {
        messages: convo,
        tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      },
      signal,
    );
    this.opts.onRaw?.(JSON.stringify(reply));
    const toolCalls: ToolCall[] = (reply.tool_calls ?? []).map((c) => ({
      id: `call_${++this.callSeq}`,
      name: c.function.name,
      args: typeof c.function.arguments === 'string' ? safeJson(c.function.arguments) : (c.function.arguments ?? {}),
    }));
    return { text: reply.content ?? '', toolCalls };
  }
}

export function parseAction(raw: string): { ok: true; action: Action } | { ok: false; error: string } {
  const json = safeJson(extractJsonObject(raw));
  if (Object.keys(json).length === 0) return { ok: false, error: 'not a JSON object' };
  const r = Action.safeParse(json);
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || 'action'}: ${i.message}`).join('; ') };
  return { ok: true, action: r.data };
}

function actionToTurn(a: Action, seq: number): AssistantTurn {
  const id = `call_${seq}`;
  switch (a.action) {
    case 'final_answer':
      return { text: a.answer, toolCalls: [] };
    case 'list_tables':
      return { text: '', toolCalls: [{ id, name: 'list_tables', args: {} }] };
    case 'describe_table':
      return { text: '', toolCalls: [{ id, name: 'describe_table', args: { table: a.table } }] };
    case 'run_select':
      return { text: '', toolCalls: [{ id, name: 'run_select', args: { query: a.query } }] };
  }
}

/** Small models sometimes wrap JSON in prose or code fences; take the outermost {...}. */
function extractJsonObject(raw: string): string {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
