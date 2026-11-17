import type { Dialect } from '../guard/validate.ts';

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

export interface ForeignKeyInfo {
  column: string;
  referencesTable: string;
  referencesColumn: string;
}

export interface TableDescription {
  name: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKeyInfo[];
  rowCount: number;
}

export interface RunOptions {
  /** Maximum rows to return; the backend reads one extra row to detect truncation. */
  rowLimit: number;
  timeoutMs: number;
  /** Stop adding rows once their JSON size passes this many bytes. */
  maxBytes: number;
}

export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
  truncatedReason?: 'row_limit' | 'size_limit';
}

export interface Backend {
  readonly dialect: Dialect;
  listTables(): Promise<string[]>;
  /** Returns null when the table does not exist (or is not exposed). */
  describeTable(name: string): Promise<TableDescription | null>;
  /** Runs SQL that has ALREADY passed the guard. Backends add their own read-only protection on top. */
  runSelect(sql: string, opts: RunOptions): Promise<QueryResult>;
  close(): Promise<void>;
}

export class QueryTimeoutError extends Error {
  constructor(ms: number) {
    super(`query exceeded the ${ms} ms timeout and was cancelled`);
    this.name = 'QueryTimeoutError';
  }
}

export class QueryExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryExecutionError';
  }
}

/** Shared row collector so both backends apply the row and size caps the same way. */
export class RowCollector {
  readonly rows: Array<Record<string, unknown>> = [];
  truncated = false;
  truncatedReason?: 'row_limit' | 'size_limit';
  private bytes = 2;

  private readonly opts: Pick<RunOptions, 'rowLimit' | 'maxBytes'>;

  constructor(opts: Pick<RunOptions, 'rowLimit' | 'maxBytes'>) {
    this.opts = opts;
  }

  /** Returns false when the caller should stop reading rows. */
  add(row: Record<string, unknown>): boolean {
    if (this.rows.length >= this.opts.rowLimit) {
      this.truncated = true;
      this.truncatedReason = 'row_limit';
      return false;
    }
    const clean = normaliseRow(row);
    const size = Buffer.byteLength(JSON.stringify(clean)) + 1;
    if (this.bytes + size > this.opts.maxBytes) {
      this.truncated = true;
      this.truncatedReason = 'size_limit';
      return false;
    }
    this.bytes += size;
    this.rows.push(clean);
    return true;
  }
}

function normaliseRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'bigint') out[k] = Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
    else if (Buffer.isBuffer(v) || v instanceof Uint8Array) out[k] = `<binary ${v.length} bytes>`;
    else if (v instanceof Date) out[k] = v.toISOString().slice(0, 10);
    else out[k] = v;
  }
  return out;
}
