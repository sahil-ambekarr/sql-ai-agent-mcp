import type { Config } from '../config.ts';
import type { Backend } from './types.ts';

/** Creates the configured backend. The mssql driver is only loaded when it is actually used. */
export async function createBackend(cfg: Config): Promise<Backend> {
  if (cfg.dbBackend === 'mssql') {
    const { MssqlBackend } = await import('./mssql.ts');
    return new MssqlBackend(cfg.mssql, cfg.guard.queryTimeoutMs);
  }
  const { SqliteBackend } = await import('./sqlite.ts');
  return new SqliteBackend(cfg.sqlitePath);
}
