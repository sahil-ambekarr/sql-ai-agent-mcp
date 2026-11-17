import Database from 'better-sqlite3';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  QueryExecutionError,
  QueryTimeoutError,
  type Backend,
  type QueryResult,
  type RunOptions,
  type TableDescription,
} from './types.ts';

type RunnerReply =
  | { id: number; ok: true; columns: string[]; rows: Array<Record<string, unknown>>; truncated: boolean; truncatedReason?: 'row_limit' | 'size_limit' }
  | { id: number; ok: false; error: string };

// Works both from source (.ts, run by Node's type stripping) and from the built dist (.js).
const RUNNER_PATH = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './sqlite-runner.ts' : './sqlite-runner.js', import.meta.url));

export class SqliteBackend implements Backend {
  readonly dialect = 'sqlite' as const;
  private readonly meta: Database.Database;
  private runner: ChildProcess | null = null;
  private runnerReady: Promise<void> | null = null;
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (!existsSync(path)) throw new Error(`SQLite database not found at ${path}. Run "npm run seed" first.`);
    // Metadata connection: read-only, used only for the fixed schema queries below.
    this.meta = new Database(path, { readonly: true, fileMustExist: true });
    this.meta.pragma('query_only = ON');
  }

  async listTables(): Promise<string[]> {
    const rows = this.meta
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  async describeTable(name: string): Promise<TableDescription | null> {
    const tables = await this.listTables();
    const actual = tables.find((t) => t.toLowerCase() === name.toLowerCase());
    if (!actual) return null;
    // Name comes from our own table list, so quoting it is safe.
    const quoted = `"${actual.replace(/"/g, '""')}"`;
    const cols = this.meta.prepare(`SELECT name, type, "notnull" AS nn, pk FROM pragma_table_info(?)`).all(actual) as Array<{
      name: string;
      type: string;
      nn: number;
      pk: number;
    }>;
    const fks = this.meta.prepare(`SELECT "from" AS col, "table" AS ref, "to" AS refcol FROM pragma_foreign_key_list(?)`).all(actual) as Array<{
      col: string;
      ref: string;
      refcol: string;
    }>;
    const count = this.meta.prepare(`SELECT COUNT(*) AS n FROM ${quoted}`).get() as { n: number };
    return {
      name: actual,
      columns: cols.map((c) => ({ name: c.name, type: c.type, nullable: c.nn === 0 && c.pk === 0, primaryKey: c.pk > 0 })),
      primaryKey: cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name),
      foreignKeys: fks.map((f) => ({ column: f.col, referencesTable: f.ref, referencesColumn: f.refcol })),
      rowCount: count.n,
    };
  }

  runSelect(sql: string, opts: RunOptions): Promise<QueryResult> {
    // One query at a time per runner; the timeout clock starts when the query does.
    const job = this.queue.then(() => this.execute(sql, opts));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private startRunner(): Promise<void> {
    if (this.runner && this.runnerReady) return this.runnerReady;
    const child = fork(RUNNER_PATH, [this.path], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    this.runner = child;
    this.runnerReady = new Promise<void>((resolve, reject) => {
      const onMsg = (m: { ready?: boolean }) => {
        if (m?.ready) {
          child.off('message', onMsg);
          resolve();
        }
      };
      child.on('message', onMsg);
      child.once('exit', (code) => {
        if (this.runner === child) {
          this.runner = null;
          this.runnerReady = null;
        }
        reject(new QueryExecutionError(`query runner exited (code ${code})`));
      });
    });
    return this.runnerReady;
  }

  private async execute(sql: string, opts: RunOptions): Promise<QueryResult> {
    await this.startRunner();
    const child = this.runner as ChildProcess;
    const id = this.nextId++;
    return new Promise<QueryResult>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off('message', onMsg);
        child.off('exit', onExit);
      };
      const timer = setTimeout(() => {
        cleanup();
        // Killing the process is the only reliable way to stop a running SQLite step.
        child.kill('SIGKILL');
        if (this.runner === child) {
          this.runner = null;
          this.runnerReady = null;
        }
        reject(new QueryTimeoutError(opts.timeoutMs));
      }, opts.timeoutMs);
      const onMsg = (m: RunnerReply) => {
        if (m?.id !== id) return;
        cleanup();
        if (m.ok) resolve({ columns: m.columns, rows: m.rows, truncated: m.truncated, truncatedReason: m.truncatedReason });
        else reject(new QueryExecutionError(m.error));
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new QueryExecutionError(`query runner exited unexpectedly (code ${code})`));
      };
      child.on('message', onMsg);
      child.once('exit', onExit);
      child.send({ id, sql, rowLimit: opts.rowLimit, maxBytes: opts.maxBytes });
    });
  }

  async close(): Promise<void> {
    const child = this.runner;
    this.runner = null;
    this.runnerReady = null;
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.disconnect();
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 1000).unref();
      });
    }
    this.meta.close();
  }
}
