/**
 * The three tool operations with every guardrail applied and every call
 * audited. The MCP layer (tools.ts) is a thin wrapper over this class, which
 * keeps the guardrails testable without a transport.
 */
import { validateSelect } from '../guard/validate.ts';
import { QueryTimeoutError, type Backend, type QueryResult, type TableDescription } from '../db/types.ts';
import type { AuditLog } from '../audit.ts';
import type { Config } from '../config.ts';

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'blocked' | 'error' | 'timeout' | 'not_found'; message: string };

export interface SelectOutput extends QueryResult {
  sql: string;
  rowLimit: number;
  rowCount: number;
  durationMs: number;
  notes: string[];
}

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export class QueryService {
  private readonly backend: Backend;
  private readonly guard: Config['guard'];
  private readonly audit: AuditLog;
  private tablesCache: Promise<string[]> | null = null;

  constructor(backend: Backend, guard: Config['guard'], audit: AuditLog) {
    this.backend = backend;
    this.guard = guard;
    this.audit = audit;
  }

  get limits(): Config['guard'] {
    return this.guard;
  }

  private tables(): Promise<string[]> {
    this.tablesCache ??= this.backend.listTables().catch((e: unknown) => {
      this.tablesCache = null;
      throw e;
    });
    return this.tablesCache;
  }

  async listTables(): Promise<ServiceResult<string[]>> {
    const t0 = performance.now();
    try {
      const tables = await this.tables();
      this.audit.write({ tool: 'list_tables', decision: 'allowed', rows: tables.length, durationMs: ms(t0) });
      return { ok: true, value: tables };
    } catch (e) {
      this.audit.write({ tool: 'list_tables', decision: 'error', reason: (e as Error).message, durationMs: ms(t0) });
      return { ok: false, kind: 'error', message: (e as Error).message };
    }
  }

  async describeTable(name: unknown): Promise<ServiceResult<TableDescription>> {
    const t0 = performance.now();
    const table = typeof name === 'string' ? name.trim() : '';
    if (!TABLE_NAME.test(table)) {
      this.audit.write({ tool: 'describe_table', table: String(name).slice(0, 200), decision: 'blocked', reason: 'invalid table name', durationMs: ms(t0) });
      return { ok: false, kind: 'blocked', message: 'table name must be a plain identifier (letters, digits, underscore)' };
    }
    try {
      const desc = await this.backend.describeTable(table);
      if (!desc) {
        this.audit.write({ tool: 'describe_table', table, decision: 'error', reason: 'table not found', durationMs: ms(t0) });
        const known = await this.tables();
        return { ok: false, kind: 'not_found', message: `table "${table}" does not exist. Known tables: ${known.join(', ')}` };
      }
      this.audit.write({ tool: 'describe_table', table, decision: 'allowed', rows: desc.columns.length, durationMs: ms(t0) });
      return { ok: true, value: desc };
    } catch (e) {
      this.audit.write({ tool: 'describe_table', table, decision: 'error', reason: (e as Error).message, durationMs: ms(t0) });
      return { ok: false, kind: 'error', message: (e as Error).message };
    }
  }

  async runSelect(query: unknown, requestedLimit?: unknown): Promise<ServiceResult<SelectOutput>> {
    const t0 = performance.now();
    const q = typeof query === 'string' ? query : String(query);
    const notes: string[] = [];

    let rowLimit = this.guard.rowLimitDefault;
    if (requestedLimit !== undefined && requestedLimit !== null) {
      if (typeof requestedLimit !== 'number' || !Number.isInteger(requestedLimit) || requestedLimit < 1) {
        this.audit.write({ tool: 'run_select', query: q, decision: 'blocked', layer: 'input', reason: 'invalid row limit', durationMs: ms(t0) });
        return { ok: false, kind: 'blocked', message: 'limit must be a positive integer' };
      }
      rowLimit = requestedLimit;
      if (rowLimit > this.guard.rowLimitMax) {
        notes.push(`requested limit ${rowLimit} was lowered to the hard maximum ${this.guard.rowLimitMax}`);
        rowLimit = this.guard.rowLimitMax;
      }
    }

    let allowed: Set<string>;
    try {
      allowed = new Set((await this.tables()).map((t) => t.toLowerCase()));
    } catch (e) {
      this.audit.write({ tool: 'run_select', query: q, decision: 'error', reason: (e as Error).message, durationMs: ms(t0) });
      return { ok: false, kind: 'error', message: (e as Error).message };
    }

    const verdict = validateSelect(query, { dialect: this.backend.dialect, maxChars: this.guard.maxQueryChars, allowedTables: allowed });
    if (!verdict.ok) {
      this.audit.write({ tool: 'run_select', query: q, decision: 'blocked', layer: verdict.layer, reason: verdict.reason, durationMs: ms(t0) });
      return { ok: false, kind: 'blocked', message: `BLOCKED by ${verdict.layer} guardrail: ${verdict.reason}` };
    }

    try {
      const res = await this.backend.runSelect(verdict.sql, { rowLimit, timeoutMs: this.guard.queryTimeoutMs, maxBytes: this.guard.resultMaxBytes });
      if (res.truncatedReason === 'row_limit') notes.push(`result truncated to ${rowLimit} rows; aggregate or filter in SQL instead of paging`);
      if (res.truncatedReason === 'size_limit') notes.push(`result truncated at ${this.guard.resultMaxBytes} bytes; select fewer columns or rows`);
      const durationMs = ms(t0);
      this.audit.write({ tool: 'run_select', query: verdict.sql, decision: 'allowed', rows: res.rows.length, truncated: res.truncated, durationMs });
      return { ok: true, value: { ...res, sql: verdict.sql, rowLimit, rowCount: res.rows.length, durationMs, notes } };
    } catch (e) {
      const timeout = e instanceof QueryTimeoutError;
      // A database-level refusal (read-only connection, permissions) is also logged here.
      this.audit.write({ tool: 'run_select', query: verdict.sql, decision: timeout ? 'timeout' : 'error', layer: timeout ? 'timeout' : 'database', reason: (e as Error).message, durationMs: ms(t0) });
      return { ok: false, kind: timeout ? 'timeout' : 'error', message: (e as Error).message };
    }
  }
}

function ms(t0: number): number {
  return Math.round(performance.now() - t0);
}
