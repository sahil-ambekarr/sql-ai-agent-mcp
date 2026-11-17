/**
 * One schema description, rendered to SQLite and T-SQL DDL so both backends
 * hold the same tables, keys and data.
 */

type ColType = 'int' | 'text' | 'money' | 'date' | 'ratio';

export interface ColumnSpec {
  name: string;
  type: ColType;
  nullable?: boolean;
  pk?: boolean;
  references?: { table: string; column: string };
  /** Max length for text columns in T-SQL. */
  length?: number;
}

export interface TableSpec {
  name: string;
  columns: ColumnSpec[];
}

const fk = (table: string) => ({ table, column: 'id' });

export const TABLES: TableSpec[] = [
  {
    name: 'customers',
    columns: [
      { name: 'id', type: 'int', pk: true },
      { name: 'name', type: 'text', length: 120 },
      { name: 'email', type: 'text', length: 160 },
      { name: 'city', type: 'text', length: 80 },
      { name: 'country', type: 'text', length: 80 },
      { name: 'segment', type: 'text', length: 20 },
      { name: 'created_at', type: 'date' },
    ],
  },
  {
    name: 'products',
    columns: [
      { name: 'id', type: 'int', pk: true },
      { name: 'sku', type: 'text', length: 20 },
      { name: 'name', type: 'text', length: 120 },
      { name: 'category', type: 'text', length: 60 },
      { name: 'unit_price', type: 'money' },
      { name: 'unit_cost', type: 'money' },
      { name: 'active', type: 'int' },
    ],
  },
  {
    name: 'employees',
    columns: [
      { name: 'id', type: 'int', pk: true },
      { name: 'first_name', type: 'text', length: 60 },
      { name: 'last_name', type: 'text', length: 60 },
      { name: 'role', type: 'text', length: 60 },
      { name: 'region', type: 'text', length: 20 },
      { name: 'hire_date', type: 'date' },
      { name: 'manager_id', type: 'int', nullable: true, references: fk('employees') },
    ],
  },
  {
    name: 'orders',
    columns: [
      { name: 'id', type: 'int', pk: true },
      { name: 'customer_id', type: 'int', references: fk('customers') },
      { name: 'employee_id', type: 'int', references: fk('employees') },
      { name: 'order_date', type: 'date' },
      { name: 'status', type: 'text', length: 20 },
      { name: 'ship_country', type: 'text', length: 80 },
    ],
  },
  {
    name: 'order_items',
    columns: [
      { name: 'id', type: 'int', pk: true },
      { name: 'order_id', type: 'int', references: fk('orders') },
      { name: 'product_id', type: 'int', references: fk('products') },
      { name: 'quantity', type: 'int' },
      { name: 'unit_price', type: 'money' },
      { name: 'discount', type: 'ratio' },
    ],
  },
  {
    name: 'support_tickets',
    columns: [
      { name: 'id', type: 'int', pk: true },
      { name: 'customer_id', type: 'int', references: fk('customers') },
      { name: 'order_id', type: 'int', nullable: true, references: fk('orders') },
      { name: 'employee_id', type: 'int', references: fk('employees') },
      { name: 'opened_at', type: 'date' },
      { name: 'closed_at', type: 'date', nullable: true },
      { name: 'priority', type: 'text', length: 10 },
      { name: 'status', type: 'text', length: 10 },
      { name: 'subject', type: 'text', length: 120 },
      { name: 'body', type: 'text', length: 1000 },
    ],
  },
];

const SQLITE_TYPES: Record<ColType, string> = { int: 'INTEGER', text: 'TEXT', money: 'REAL', date: 'TEXT', ratio: 'REAL' };

export function sqliteDdl(t: TableSpec): string {
  const cols = t.columns.map((c) => {
    let s = `  ${c.name} ${SQLITE_TYPES[c.type]}`;
    if (c.pk) s += ' PRIMARY KEY';
    else if (!c.nullable) s += ' NOT NULL';
    if (c.references) s += ` REFERENCES ${c.references.table}(${c.references.column})`;
    return s;
  });
  return `CREATE TABLE ${t.name} (\n${cols.join(',\n')}\n);`;
}

function tsqlType(c: ColumnSpec): string {
  switch (c.type) {
    case 'int':
      return 'INT';
    case 'text':
      return `NVARCHAR(${c.length ?? 255})`;
    case 'money':
      return 'DECIMAL(12,2)';
    case 'ratio':
      return 'DECIMAL(4,2)';
    case 'date':
      return 'DATE';
  }
}

export function tsqlDdl(t: TableSpec): string {
  const cols = t.columns.map((c) => {
    let s = `  ${c.name} ${tsqlType(c)}`;
    s += c.nullable ? ' NULL' : ' NOT NULL';
    if (c.pk) s += ` CONSTRAINT PK_${t.name} PRIMARY KEY`;
    if (c.references) s += ` CONSTRAINT FK_${t.name}_${c.name} REFERENCES dbo.${c.references.table}(${c.references.column})`;
    return s;
  });
  return `CREATE TABLE dbo.${t.name} (\n${cols.join(',\n')}\n);`;
}
