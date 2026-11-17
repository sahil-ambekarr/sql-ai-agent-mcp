import { AuditLog } from '../audit.ts';
import { loadConfig, type Config } from '../config.ts';
import { createBackend } from '../db/index.ts';
import type { Backend } from '../db/types.ts';
import { QueryService } from './query-service.ts';

export interface Runtime {
  config: Config;
  backend: Backend;
  service: QueryService;
}

export async function bootstrap(config: Config = loadConfig()): Promise<Runtime> {
  const backend = await createBackend(config);
  const audit = new AuditLog(config.auditLogPath);
  return { config, backend, service: new QueryService(backend, config.guard, audit) };
}
