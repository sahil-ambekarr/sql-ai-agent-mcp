import Database from 'better-sqlite3';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateSampleData, type SampleData } from './generate.ts';
import { TABLES, sqliteDdl } from './schema.ts';

/** Builds a fresh SQLite file from the deterministic generator. Returns row counts. */
export function seedSqlite(path: string, data: SampleData = generateSampleData()): Record<string, number> {
  mkdirSync(dirname(path), { recursive: true });
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    if (existsSync(path + suffix)) rmSync(path + suffix);
  }
  const db = new Database(path);
  try {
    db.pragma('foreign_keys = ON');
    const counts: Record<string, number> = {};
    db.transaction(() => {
      for (const t of TABLES) {
        db.exec(sqliteDdl(t));
        const cols = t.columns.map((c) => c.name);
        const insert = db.prepare(`INSERT INTO ${t.name} (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`);
        const rows = data[t.name as keyof SampleData] as unknown as Array<Record<string, unknown>>;
        for (const row of rows) insert.run(row);
        counts[t.name] = rows.length;
      }
      db.exec(`
        CREATE INDEX ix_orders_customer ON orders(customer_id);
        CREATE INDEX ix_orders_date ON orders(order_date);
        CREATE INDEX ix_items_order ON order_items(order_id);
        CREATE INDEX ix_items_product ON order_items(product_id);
        CREATE INDEX ix_tickets_customer ON support_tickets(customer_id);
      `);
    })();
    return counts;
  } finally {
    db.close();
  }
}
