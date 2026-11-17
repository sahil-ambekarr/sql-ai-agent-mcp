import { describe, expect, it } from 'vitest';
import { ClaudeProvider, toClaudeMessages } from '../src/agent/providers/claude.ts';
import { OllamaProvider, parseAction } from '../src/agent/providers/ollama.ts';
import type { ChatMessage, ToolSpec } from '../src/agent/types.ts';

const TOOLS: ToolSpec[] = [{ name: 'run_select', description: 'run a select', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }];
const HISTORY: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'How many customers?' },
];

/** A fetch stub that returns queued JSON bodies and records requests. */
function stubFetch(responses: Array<{ status?: number; body: unknown }>) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    const next = responses.shift();
    if (!next) throw new Error('no more stubbed responses');
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, requests };
}

const ollama = (mode: 'json' | 'tools', fetchImpl: typeof fetch) =>
  new OllamaProvider({ baseUrl: 'http://ollama.test', model: 'llama3.2', mode, timeoutMs: 5000, fetchImpl });

describe('Ollama JSON-action protocol', () => {
  it('aborts an in-flight call on the caller signal and does not retry it', async () => {
    let calls = 0;
    const hang = ((_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }) as typeof fetch;
    const ctrl = new AbortController();
    const pending = ollama('json', hang).complete(HISTORY, TOOLS, ctrl.signal);
    setTimeout(() => ctrl.abort(), 20);
    await expect(pending).rejects.toThrow(/aborted/);
    expect(calls).toBe(1);
  });

  it('parses a valid action into a tool call and sends a JSON-schema format', async () => {
    const { impl, requests } = stubFetch([{ body: { message: { role: 'assistant', content: '{"action":"run_select","query":"SELECT COUNT(*) FROM customers"}' } } }]);
    const turn = await ollama('json', impl).complete(HISTORY, TOOLS);
    expect(turn.toolCalls).toEqual([{ id: 'call_1', name: 'run_select', args: { query: 'SELECT COUNT(*) FROM customers' } }]);
    expect(requests[0]?.url).toBe('http://ollama.test/api/chat');
    expect(requests[0]?.body.format).toMatchObject({ type: 'object', required: ['action'] });
    expect(JSON.stringify(requests[0]?.body.messages)).toContain('final_answer');
  });

  it('retries with the validation error when the reply is invalid', async () => {
    const { impl, requests } = stubFetch([
      { body: { message: { role: 'assistant', content: '{"action":"run_select"}' } } },
      { body: { message: { role: 'assistant', content: '{"action":"final_answer","answer":"400 customers"}' } } },
    ]);
    const turn = await ollama('json', impl).complete(HISTORY, TOOLS);
    expect(turn).toEqual({ text: '400 customers', toolCalls: [] });
    const retryMsgs = requests[1]?.body.messages as Array<{ content: string }>;
    expect(retryMsgs.at(-1)?.content).toMatch(/invalid \(query/);
  });

  it('gives up after three invalid replies', async () => {
    const bad = { body: { message: { role: 'assistant', content: 'I think the answer is 400' } } };
    const { impl } = stubFetch([bad, bad, bad]);
    await expect(ollama('json', impl).complete(HISTORY, TOOLS)).rejects.toThrow(/valid JSON action/);
  });

  it('retries transport 5xx errors with backoff but not 4xx', async () => {
    const ok = { body: { message: { role: 'assistant', content: '{"action":"final_answer","answer":"ok"}' } } };
    const a = stubFetch([{ status: 503, body: { error: 'busy' } }, ok]);
    await expect(ollama('json', a.impl).complete(HISTORY, TOOLS)).resolves.toMatchObject({ text: 'ok' });
    const b = stubFetch([{ status: 404, body: { error: 'model not found' } }, ok]);
    await expect(ollama('json', b.impl).complete(HISTORY, TOOLS)).rejects.toThrow(/HTTP 404/);
  }, 15_000);

  it('extracts JSON wrapped in prose or code fences', () => {
    expect(parseAction('Sure!\n```json\n{"action":"list_tables"}\n```')).toEqual({ ok: true, action: { action: 'list_tables' } });
    expect(parseAction('{"action":"drop_table"}')).toMatchObject({ ok: false });
  });
});

describe('Ollama native tool calling', () => {
  it('maps tool_calls and sends tools in OpenAI function format', async () => {
    const { impl, requests } = stubFetch([
      { body: { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'run_select', arguments: { query: 'SELECT 1' } } }] } } },
    ]);
    const turn = await ollama('tools', impl).complete(HISTORY, TOOLS);
    expect(turn.toolCalls).toEqual([{ id: 'call_1', name: 'run_select', args: { query: 'SELECT 1' } }]);
    expect(requests[0]?.body.tools).toEqual([{ type: 'function', function: { name: 'run_select', description: 'run a select', parameters: TOOLS[0]?.parameters } }]);
  });
});

describe('Claude provider (stubbed HTTP, not verified against the live API)', () => {
  it('sends tools and system, and maps tool_use blocks to tool calls', async () => {
    const { impl, requests } = stubFetch([
      {
        body: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-5-5',
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'toolu_1', name: 'run_select', input: { query: 'SELECT COUNT(*) FROM customers' } },
          ],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]);
    const p = new ClaudeProvider({ apiKey: 'test-key', model: 'claude-haiku-5-5', timeoutMs: 5000, fetchImpl: impl, baseURL: 'http://claude.test' });
    const turn = await p.complete(HISTORY, TOOLS);
    expect(turn.toolCalls).toEqual([{ id: 'toolu_1', name: 'run_select', args: { query: 'SELECT COUNT(*) FROM customers' } }]);
    expect(turn.text).toBe('Let me check.');
    const body = requests[0]?.body ?? {};
    expect(requests[0]?.url).toBe('http://claude.test/v1/messages');
    expect(body).toMatchObject({ model: 'claude-haiku-5-5', system: 'sys' });
    expect(body.tools).toEqual([{ name: 'run_select', description: 'run a select', input_schema: TOOLS[0]?.parameters }]);
    expect(body).not.toHaveProperty('temperature');
  });

  it('throws on a refusal stop reason', async () => {
    const { impl } = stubFetch([
      { body: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: 'refusal', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    ]);
    const p = new ClaudeProvider({ apiKey: 'k', model: 'claude-haiku-5-5', timeoutMs: 5000, fetchImpl: impl, baseURL: 'http://claude.test' });
    await expect(p.complete(HISTORY, TOOLS)).rejects.toThrow(/refusal/);
  });

  it('refuses to start without an API key', () => {
    expect(() => new ClaudeProvider({ apiKey: '', model: 'm', timeoutMs: 1000 })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('groups all tool results for one turn into a single user message and replays raw content', () => {
    const raw = [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'a', name: 'run_select', input: {} }, { type: 'tool_use', id: 'b', name: 'run_select', input: {} }];
    const msgs = toClaudeMessages([
      ...HISTORY,
      { role: 'assistant', content: 'hi', toolCalls: [], raw },
      { role: 'tool', toolCallId: 'a', name: 'run_select', content: 'r1', isError: false },
      { role: 'tool', toolCallId: 'b', name: 'run_select', content: 'r2', isError: true },
    ]);
    expect(msgs).toHaveLength(3);
    expect(msgs[1]).toEqual({ role: 'assistant', content: raw });
    expect(msgs[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'r1', is_error: false },
        { type: 'tool_result', tool_use_id: 'b', content: 'r2', is_error: true },
      ],
    });
  });
});
