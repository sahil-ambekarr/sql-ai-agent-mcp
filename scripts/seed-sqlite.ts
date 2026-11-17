import { seedSqlite } from '../src/seed/sqlite.ts';
import { loadConfig } from '../src/config.ts';

const path = process.argv[2] ?? loadConfig().sqlitePath;
const counts = seedSqlite(path);
const total = Object.values(counts).reduce((a, b) => a + b, 0);
process.stdout.write(`Seeded ${path}\n`);
for (const [t, n] of Object.entries(counts)) process.stdout.write(`  ${t.padEnd(16)} ${n}\n`);
process.stdout.write(`  ${'total'.padEnd(16)} ${total}\n`);
