import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const str = (def: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v));

const EnvSchema = z.object({
  DB_BACKEND: str('sqlite').pipe(z.enum(['sqlite', 'mssql'])),
  SQLITE_PATH: str('data/sample.db'),
  MSSQL_HOST: str('localhost'),
  MSSQL_PORT: int(1433, 1, 65535),
  MSSQL_DATABASE: str('SampleBusiness'),
  MSSQL_USER: str('agent_reader'),
  MSSQL_PASSWORD: str(''),
  MSSQL_ENCRYPT: bool,
  MSSQL_TRUST_SERVER_CERTIFICATE: bool,
  ROW_LIMIT_DEFAULT: int(100, 1, 10_000),
  ROW_LIMIT_MAX: int(500, 1, 10_000),
  QUERY_TIMEOUT_MS: int(5000, 50, 600_000),
  RESULT_MAX_BYTES: int(65_536, 1024, 10_000_000),
  MAX_QUERY_CHARS: int(8000, 100, 100_000),
  AUDIT_LOG_PATH: str('logs/audit.jsonl'),
  HTTP_PORT: int(4104, 1, 65535),
  LLM_PROVIDER: str('ollama').pipe(z.enum(['ollama', 'claude', 'mock'])),
  OLLAMA_BASE_URL: str('http://localhost:11434'),
  OLLAMA_MODEL: str('llama3.2'),
  OLLAMA_MODE: str('json').pipe(z.enum(['json', 'tools'])),
  ANTHROPIC_API_KEY: str(''),
  CLAUDE_MODEL: str('claude-haiku-5-5'),
  LLM_TIMEOUT_MS: int(300_000, 1000, 3_600_000),
  AGENT_MAX_STEPS: int(6, 1, 30),
  AGENT_TODAY: str(''),
});

export interface Config {
  dbBackend: 'sqlite' | 'mssql';
  sqlitePath: string;
  mssql: {
    server: string;
    port: number;
    database: string;
    user: string;
    password: string;
    encrypt: boolean;
    trustServerCertificate: boolean;
  };
  guard: {
    rowLimitDefault: number;
    rowLimitMax: number;
    queryTimeoutMs: number;
    resultMaxBytes: number;
    maxQueryChars: number;
  };
  auditLogPath: string;
  httpPort: number;
  llm: {
    provider: 'ollama' | 'claude' | 'mock';
    ollamaBaseUrl: string;
    ollamaModel: string;
    ollamaMode: 'json' | 'tools';
    anthropicApiKey: string;
    claudeModel: string;
    timeoutMs: number;
  };
  agentMaxSteps: number;
  /** YYYY-MM-DD used as "today" in the agent prompt; empty means the real date. */
  agentToday: string;
}

let envLoaded = false;

/** Reads `.env` once (if present) and validates every setting. Throws with a readable message on bad input. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (!envLoaded && env === process.env) {
    envLoaded = true;
    if (existsSync('.env')) process.loadEnvFile('.env');
  }
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const e = parsed.data;
  if (e.ROW_LIMIT_DEFAULT > e.ROW_LIMIT_MAX) throw new Error('Invalid configuration: ROW_LIMIT_DEFAULT must be <= ROW_LIMIT_MAX');
  if (e.AGENT_TODAY && !/^\d{4}-\d{2}-\d{2}$/.test(e.AGENT_TODAY)) throw new Error('Invalid configuration: AGENT_TODAY must be YYYY-MM-DD');
  return {
    dbBackend: e.DB_BACKEND,
    sqlitePath: resolve(e.SQLITE_PATH),
    mssql: {
      server: e.MSSQL_HOST,
      port: e.MSSQL_PORT,
      database: e.MSSQL_DATABASE,
      user: e.MSSQL_USER,
      password: e.MSSQL_PASSWORD,
      encrypt: e.MSSQL_ENCRYPT ?? true,
      trustServerCertificate: e.MSSQL_TRUST_SERVER_CERTIFICATE ?? true,
    },
    guard: {
      rowLimitDefault: e.ROW_LIMIT_DEFAULT,
      rowLimitMax: e.ROW_LIMIT_MAX,
      queryTimeoutMs: e.QUERY_TIMEOUT_MS,
      resultMaxBytes: e.RESULT_MAX_BYTES,
      maxQueryChars: e.MAX_QUERY_CHARS,
    },
    auditLogPath: resolve(e.AUDIT_LOG_PATH),
    httpPort: e.HTTP_PORT,
    llm: {
      provider: e.LLM_PROVIDER,
      ollamaBaseUrl: e.OLLAMA_BASE_URL.replace(/\/+$/, ''),
      ollamaModel: e.OLLAMA_MODEL,
      ollamaMode: e.OLLAMA_MODE,
      anthropicApiKey: e.ANTHROPIC_API_KEY,
      claudeModel: e.CLAUDE_MODEL,
      timeoutMs: e.LLM_TIMEOUT_MS,
    },
    agentMaxSteps: e.AGENT_MAX_STEPS,
    agentToday: e.AGENT_TODAY,
  };
}
