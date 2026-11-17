/**
 * Claude provider (official @anthropic-ai/sdk, Messages API with tool use).
 * Enabled only when ANTHROPIC_API_KEY is set.
 *
 * NOT verified against the live API: no key was available when this repo was
 * built. tests/claude-provider.test.ts drives it through a stubbed fetch.
 */
import Anthropic from '@anthropic-ai/sdk';
import { ProviderError, type AssistantTurn, type ChatMessage, type LlmProvider, type ToolSpec } from '../types.ts';

export interface ClaudeOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Injected in tests to stub the HTTP layer. */
  fetchImpl?: typeof fetch;
  baseURL?: string;
}

export class ClaudeProvider implements LlmProvider {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: ClaudeOptions) {
    if (!opts.apiKey) throw new ProviderError('LLM_PROVIDER=claude needs ANTHROPIC_API_KEY');
    this.model = opts.model;
    this.name = `claude:${opts.model}`;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      timeout: opts.timeoutMs,
      maxRetries: 2, // the SDK retries 408/409/429/5xx and connection errors with backoff
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<AssistantTurn> {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 16000,
      system,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema })),
      messages: toClaudeMessages(messages),
    });
    if (response.stop_reason === 'refusal') throw new ProviderError('Claude declined the request (stop_reason: refusal)');
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const toolCalls = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> }));
    // Keep the full content (including any thinking blocks) so it is replayed unchanged next turn.
    return { text, toolCalls, raw: response.content };
  }
}

export function toClaudeMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  let pendingResults: Anthropic.ToolResultBlockParam[] = [];
  const flush = () => {
    if (pendingResults.length) {
      // All results for one assistant turn go back in a single user message.
      out.push({ role: 'user', content: pendingResults });
      pendingResults = [];
    }
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      pendingResults.push({ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content, is_error: m.isError });
      continue;
    }
    flush();
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (Array.isArray(m.raw)) out.push({ role: 'assistant', content: m.raw as Anthropic.ContentBlockParam[] });
    else {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      out.push({ role: 'assistant', content: blocks });
    }
  }
  flush();
  return out;
}
