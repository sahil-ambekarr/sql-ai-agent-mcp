/** Provider-neutral chat shapes used by the agent loop. */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments, as advertised by the MCP server. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      toolCalls: ToolCall[];
      /** Provider-native content to replay unchanged (for example Claude thinking blocks). */
      raw?: unknown;
    }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError: boolean };

export interface AssistantTurn {
  text: string;
  toolCalls: ToolCall[];
  raw?: unknown;
}

export interface LlmProvider {
  readonly name: string;
  /** One model call. Returns either tool calls to run, or a final text answer (no tool calls). */
  complete(messages: ChatMessage[], tools: ToolSpec[], signal?: AbortSignal): Promise<AssistantTurn>;
}

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}
