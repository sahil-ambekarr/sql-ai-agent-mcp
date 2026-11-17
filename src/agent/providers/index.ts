import type { Config } from '../../config.ts';
import type { LlmProvider } from '../types.ts';
import { ClaudeProvider } from './claude.ts';
import { MockProvider, defaultMockScript, type MockStep } from './mock.ts';
import { OllamaProvider } from './ollama.ts';

export function createProvider(cfg: Config['llm'], opts: { mockScript?: MockStep[]; onRaw?: (raw: string) => void } = {}): LlmProvider {
  switch (cfg.provider) {
    case 'claude':
      return new ClaudeProvider({ apiKey: cfg.anthropicApiKey, model: cfg.claudeModel, timeoutMs: cfg.timeoutMs });
    case 'mock':
      return new MockProvider(opts.mockScript ?? defaultMockScript());
    case 'ollama':
      return new OllamaProvider({ baseUrl: cfg.ollamaBaseUrl, model: cfg.ollamaModel, mode: cfg.ollamaMode, timeoutMs: cfg.timeoutMs, onRaw: opts.onRaw });
  }
}
