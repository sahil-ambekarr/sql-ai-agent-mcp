import { mkdirSync, writeFileSync } from 'node:fs';
import { renderTsqlSeed } from '../src/seed/tsql.ts';

const out = 'mssql/init/01-seed.sql';
mkdirSync('mssql/init', { recursive: true });
const script = renderTsqlSeed();
writeFileSync(out, script);
process.stdout.write(`Wrote ${out} (${(script.length / 1024).toFixed(0)} KiB)\n`);
