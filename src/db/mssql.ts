/**
 * SQL Server backend (via the `mssql` driver).
 *
 * NOT verified against a live server in this repo's build environment (no
 * Docker there). The dialect helpers it relies on are unit tested; see
 * tests/mssql-dialect.test.ts.
 */
import sql from 'mssql';
import {
  MSSQL_DESCRIBE_COLUMNS,
  MSSQL_FOREIGN_KEYS,
  MSSQL_LIST_TABLES,
  MSSQL_ROW_COUNT,
  applyTopLimit,
} from './mssql-dialect.ts';
import {
  QueryExecutionError,
  QueryTimeoutError,
  RowCollector,
  type Backend,
  type QueryResult,
  type RunOptions,
  type TableDescription,
} from './types.ts';
import type { Config } from '../config.ts';

export class MssqlBackend implements Backend {
  readonly dialect = 'mssql' as const;
  private pool: sql.ConnectionPool;
  private connecting: Promise<sql.ConnectionPool> | null = null;

  constructor(cfg: Config['mssql'], queryTimeoutMs: number) {
    this.pool = new sql.ConnectionPool({
      server: cfg.server,
      port: cfg.port,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
      requestTimeout: queryTimeoutMs,
      connectionTimeout: 15_000,
      pool: { max: 4, min: 0, idleTimeoutMillis: 30_000 },
      options: {
        encrypt: cfg.encrypt,
        trustServerCertificate: cfg.trustServerCertificate,
        // Read intent lets an availability-group listener route to a readable secondary.
        readOnlyIntent: true,
      },
    });
  }

  private connect(): Promise<sql.ConnectionPool> {
    if (this.pool.connected) return Promise.resolve(this.pool);
    this.connecting ??= this.pool.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async listTables(): Promise<string[]> {
    const pool = await this.connect();
    const res = await pool.request().query<{ name: string }>(MSSQL_LIST_TABLES);
    return res.recordset.map((r) => r.name);
  }

  async describeTable(name: string): Promise<TableDescription | null> {
    const tables = await this.listTables();
    const actual = tables.find((t) => t.toLowerCase() === name.toLowerCase());
    if (!actual) return null;
    const pool = await this.connect();
    const cols = await pool
      .request()
      .input('table', sql.NVarChar(128), actual)
      .query<{ name: string; type: string; nullable: boolean; primary_key: number; pk_ordinal: number }>(MSSQL_DESCRIBE_COLUMNS);
    const fks = await pool
      .request()
      .input('table', sql.NVarChar(128), actual)
      .query<{ column_name: string; references_table: string; references_column: string }>(MSSQL_FOREIGN_KEYS);
    const count = await pool.request().input('table', sql.NVarChar(128), actual).query<{ row_count: string | number }>(MSSQL_ROW_COUNT);
    return {
      name: actual,
      columns: cols.recordset.map((c) => ({ name: c.name, type: c.type, nullable: Boolean(c.nullable), primaryKey: c.primary_key === 1 })),
      primaryKey: cols.recordset.filter((c) => c.primary_key === 1).sort((a, b) => a.pk_ordinal - b.pk_ordinal).map((c) => c.name),
      foreignKeys: fks.recordset.map((f) => ({ column: f.column_name, referencesTable: f.references_table, referencesColumn: f.references_column })),
      rowCount: Number(count.recordset[0]?.row_count ?? 0),
    };
  }

  async runSelect(query: string, opts: RunOptions): Promise<QueryResult> {
    const pool = await this.connect();
    // Ask the server for one extra row so truncation can be detected.
    const rewrite = applyTopLimit(query, opts.rowLimit + 1);
    const request = pool.request();
    request.stream = true;
    const collector = new RowCollector(opts);
    let columns: string[] = [];
    let cancelledByUs = false;

    return new Promise<QueryResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        request.cancel();
        reject(new QueryTimeoutError(opts.timeoutMs));
      }, opts.timeoutMs + 500);
      request.on('recordset', (cols: Record<string, { name: string }>) => {
        columns = Object.values(cols).map((c) => c.name);
      });
      request.on('row', (row: Record<string, unknown>) => {
        if (cancelledByUs) return;
        if (!collector.add(row)) {
          // Streaming cap: stop reading as soon as a limit is hit, TOP rewrite or not.
          cancelledByUs = true;
          request.cancel();
        }
      });
      request.on('error', (err: Error & { code?: string }) => {
        if (cancelledByUs && err.code === 'ECANCEL') return;
        clearTimeout(timer);
        if (err.code === 'ETIMEOUT') reject(new QueryTimeoutError(opts.timeoutMs));
        else reject(new QueryExecutionError(err.message));
      });
      request.on('done', () => {
        clearTimeout(timer);
        resolve({ columns, rows: collector.rows, truncated: collector.truncated, truncatedReason: collector.truncatedReason });
      });
      request.query(rewrite.sql);
    });
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}
