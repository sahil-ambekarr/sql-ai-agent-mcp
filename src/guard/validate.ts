/**
 * SELECT-only enforcement. Three independent layers run in order and any one
 * of them can reject a query:
 *
 *   1. lexical  - tokenize, refuse comments, multiple statements, a non-SELECT
 *                 first keyword, and any denylisted keyword or function
 *   2. parser   - node-sql-parser must produce exactly one `select` AST with no
 *                 INTO / FOR UPDATE, and every table must be one the server exposes
 *   3. database - the backend opens a read-only connection (outside this file)
 *
 * The layers overlap on purpose: a bug or a grammar gap in one should not be
 * enough to let a write through.
 */
import nsp from 'node-sql-parser';
import { tokenize, type LexError, type Token } from './lexer.ts';

const { Parser } = nsp;
const parser = new Parser();

export type Dialect = 'sqlite' | 'mssql';

export type GuardLayer = 'input' | 'lexical' | 'parser';

export type GuardResult =
  | { ok: true; sql: string }
  | { ok: false; layer: GuardLayer; reason: string };

export interface GuardOptions {
  dialect: Dialect;
  maxChars: number;
  /** Lower-cased table names the query may read. Omit to skip the allowlist check. */
  allowedTables?: ReadonlySet<string>;
}

/** Statement keywords and other words that never belong in a read-only query. */
export const DENIED_KEYWORDS: ReadonlySet<string> = new Set([
  // data and schema changes
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'TRUNCATE', 'DROP', 'ALTER', 'CREATE', 'RENAME',
  'INTO', 'RETURNING',
  // permissions
  'GRANT', 'REVOKE', 'DENY',
  // procedural / dynamic SQL
  'EXEC', 'EXECUTE', 'CALL', 'DECLARE', 'SET', 'USE', 'GO', 'WAITFOR', 'RECONFIGURE',
  // transactions
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'TRANSACTION',
  // SQLite engine commands
  'PRAGMA', 'ATTACH', 'DETACH', 'VACUUM', 'REINDEX', 'ANALYZE',
  // SQL Server admin and external data access
  'SHUTDOWN', 'KILL', 'DBCC', 'BACKUP', 'RESTORE', 'BULK', 'OPENROWSET', 'OPENQUERY', 'OPENDATASOURCE', 'OPENXML',
  // SQLite functions that touch the file system or load code
  'LOAD_EXTENSION', 'READFILE', 'WRITEFILE', 'FTS3_TOKENIZER',
]);

/** Name prefixes of SQL Server stored procedures (system and extended). */
const DENIED_PREFIXES = ['XP_', 'SP_'];

const reject = (layer: GuardLayer, reason: string): GuardResult => ({ ok: false, layer, reason });

export function validateSelect(input: unknown, opts: GuardOptions): GuardResult {
  // --- input --------------------------------------------------------------
  if (typeof input !== 'string') return reject('input', 'query must be a string');
  const sql = input.trim();
  if (sql.length === 0) return reject('input', 'query is empty');
  if (sql.length > opts.maxChars) return reject('input', `query is longer than ${opts.maxChars} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(sql)) return reject('input', 'query contains control characters');

  // --- lexical ------------------------------------------------------------
  let tokens: Token[];
  try {
    tokens = tokenize(sql);
  } catch (e) {
    return reject('lexical', (e as LexError).message);
  }
  if (tokens.some((t) => t.kind === 'comment')) {
    // Comment syntax differs between engines (nesting, MySQL-style /*! */), so
    // comments are a way to make the guard and the database disagree. Refuse them.
    return reject('lexical', 'comments are not allowed in queries');
  }
  // Allow one trailing semicolon; anything after a semicolon is a second statement.
  let body = tokens;
  const last = body[body.length - 1];
  if (last?.kind === 'punct' && last.text === ';') body = body.slice(0, -1);
  if (body.some((t) => t.kind === 'punct' && t.text === ';')) return reject('lexical', 'multiple statements are not allowed');
  if (body.length === 0) return reject('input', 'query is empty');

  const first = body[0] as Token;
  if (first.kind !== 'word' || (first.upper !== 'SELECT' && first.upper !== 'WITH')) {
    return reject('lexical', 'only SELECT queries (optionally starting with WITH) are allowed');
  }
  for (const t of body) {
    if (t.kind !== 'word') continue;
    if (DENIED_KEYWORDS.has(t.upper)) {
      const why = t.upper === 'INTO' ? 'SELECT ... INTO and INSERT INTO write data' : 'it can change data, schema or server state';
      return reject('lexical', `keyword ${t.upper} is not allowed (${why})`);
    }
    if (DENIED_PREFIXES.some((p) => t.upper.startsWith(p))) {
      return reject('lexical', `stored procedure ${t.text} is not allowed`);
    }
  }
  if (body.some((t) => t.kind === 'variable')) {
    return reject('lexical', 'variables and bind parameters are not allowed');
  }
  const cleaned = sql.slice(0, last?.kind === 'punct' && last.text === ';' ? last.start : sql.length).trim();

  // --- parser -------------------------------------------------------------
  // node-sql-parser's SQLite grammar misses some valid syntax (OVER (ORDER BY ..),
  // FILTER, NULLS LAST), so its PostgreSQL grammar is tried second. The AST only
  // has to agree that this is ONE plain SELECT; the lexical layer and the
  // read-only connection still apply whichever grammar succeeded.
  const grammars = opts.dialect === 'mssql' ? ['transactsql'] : ['sqlite', 'postgresql'];
  let ast: unknown;
  let database = grammars[0] as string;
  let firstError = '';
  for (const g of grammars) {
    try {
      ast = parser.astify(cleaned, { database: g });
      database = g;
      break;
    } catch (e) {
      firstError ||= (e as Error).message.split('\n')[0]?.slice(0, 160) ?? 'syntax error';
    }
  }
  if (ast === undefined) {
    return reject('parser', `the SQL parser could not read this query, so it is refused (fail-closed). Simplify the SQL. Parser said: ${firstError}`);
  }
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) return reject('parser', 'multiple statements are not allowed');
  const stmt = statements[0] as Record<string, unknown>;
  if (stmt.type !== 'select') return reject('parser', `statement type ${String(stmt.type)} is not allowed`);

  const problem = findWriteNode(stmt);
  if (problem) return reject('parser', problem);

  if (opts.allowedTables) {
    let tables: string[];
    try {
      tables = parser.tableList(cleaned, { database });
    } catch {
      return reject('parser', 'could not list the tables this query reads');
    }
    const cteNames = collectCteNames(stmt);
    for (const entry of tables) {
      // entry looks like "select::dbo::customers"
      const [kind, , name = ''] = entry.split('::');
      if (kind !== 'select') return reject('parser', `query performs ${kind} on ${name}`);
      const lower = name.toLowerCase();
      if (!opts.allowedTables.has(lower) && !cteNames.has(lower)) {
        return reject('parser', `table ${name} is not exposed by this server`);
      }
    }
  }

  return { ok: true, sql: cleaned };
}

/** Walks the AST looking for anything that is not a plain read. */
function findWriteNode(node: unknown, depth = 0): string | null {
  if (depth > 200) return 'query is nested too deeply';
  if (Array.isArray(node)) {
    for (const x of node) {
      const r = findWriteNode(x, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (node === null || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  const type = typeof obj.type === 'string' ? obj.type.toLowerCase() : '';
  if (['insert', 'update', 'delete', 'replace', 'create', 'drop', 'alter', 'truncate', 'exec', 'execute', 'call', 'set', 'use', 'transaction', 'grant', 'lock'].includes(type)) {
    return `a ${type} statement is nested in the query`;
  }
  const into = obj.into as { expr?: unknown } | undefined;
  if (into && typeof into === 'object' && into.expr) return 'SELECT ... INTO is not allowed';
  if (obj.for_update) return 'SELECT ... FOR UPDATE is not allowed';
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'loc') continue;
    const r = findWriteNode(v, depth + 1);
    if (r) return r;
  }
  return null;
}

function collectCteNames(node: unknown, acc = new Set<string>(), depth = 0): Set<string> {
  if (depth > 200 || node === null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const x of node) collectCteNames(x, acc, depth + 1);
    return acc;
  }
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.with)) {
    for (const w of obj.with as Array<{ name?: { value?: unknown } | string }>) {
      const nm = typeof w.name === 'string' ? w.name : w.name?.value;
      if (typeof nm === 'string') acc.add(nm.toLowerCase());
    }
  }
  for (const v of Object.values(obj)) collectCteNames(v, acc, depth + 1);
  return acc;
}
