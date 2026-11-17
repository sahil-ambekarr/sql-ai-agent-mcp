/**
 * Pure SQL Server helpers: row-limit rewriting and the catalog queries the
 * backend uses. Kept free of any driver import so they can be unit tested
 * without a live server.
 */
import { tokenize, type Token } from '../guard/lexer.ts';

export interface TopRewrite {
  sql: string;
  /** False when the query shape makes TOP unsafe to inject; the streaming row cap still applies. */
  applied: boolean;
  note?: string;
}

/**
 * Injects or tightens `TOP (n)` on the outermost SELECT.
 *
 * T-SQL does not allow ORDER BY inside a derived table, so wrapping the query
 * (`SELECT TOP n * FROM (<q>) x`) breaks ordered queries. Rewriting the outer
 * SELECT keeps ORDER BY working.
 */
export function applyTopLimit(sql: string, limit: number): TopRewrite {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  const tokens = tokenize(sql);
  const at = findOuterSelect(tokens);
  if (at === -1) return { sql, applied: false, note: 'no outer SELECT found' };

  // A set operator at depth 0 means TOP on the first branch would not limit the whole result.
  if (hasTopLevelSetOperator(tokens, at)) return { sql, applied: false, note: 'top-level UNION/EXCEPT/INTERSECT; relying on streaming cap' };
  if (hasTopLevelOffset(tokens, at)) return { sql, applied: false, note: 'OFFSET/FETCH present; relying on streaming cap' };

  let i = at + 1;
  const tok = (k: number) => tokens[k];
  if (tok(i)?.kind === 'word' && (tok(i)?.upper === 'DISTINCT' || tok(i)?.upper === 'ALL')) i++;

  const insertPos = tok(i)?.start ?? sql.length;
  if (tok(i)?.kind === 'word' && tok(i)?.upper === 'TOP') {
    // TOP n | TOP (n), optionally PERCENT / WITH TIES
    const open = tok(i + 1)?.text === '(';
    const numTok = tok(i + (open ? 2 : 1));
    const after = tok(i + (open ? 4 : 2));
    if (numTok?.kind !== 'number' || (open && tok(i + 3)?.text !== ')')) {
      return { sql, applied: false, note: 'TOP with an expression; relying on streaming cap' };
    }
    if (after?.kind === 'word' && after.upper === 'PERCENT') return { sql, applied: false, note: 'TOP PERCENT; relying on streaming cap' };
    const existing = Number(numTok.text);
    if (existing <= limit) return { sql, applied: true, note: 'existing TOP is already within the limit' };
    const startTop = tok(i)?.start as number;
    const endTop = open ? (tok(i + 3) as Token).start + 1 : numTok.start + numTok.text.length;
    return { sql: `${sql.slice(0, startTop)}TOP (${limit})${sql.slice(endTop)}`, applied: true };
  }
  return { sql: `${sql.slice(0, insertPos)}TOP (${limit}) ${sql.slice(insertPos)}`, applied: true };
}

/** Index of the outer query's first SELECT token (after any CTE list), or -1. */
function findOuterSelect(tokens: Token[]): number {
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.text === '(') depth++;
    else if (t.text === ')') depth--;
    else if (depth === 0 && t.kind === 'word' && t.upper === 'SELECT') return i;
  }
  return -1;
}

function scanTopLevel(tokens: Token[], from: number, words: string[]): boolean {
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.text === '(') depth++;
    else if (t.text === ')') depth--;
    else if (depth === 0 && t.kind === 'word' && words.includes(t.upper)) return true;
  }
  return false;
}
const hasTopLevelSetOperator = (t: Token[], from: number) => scanTopLevel(t, from, ['UNION', 'EXCEPT', 'INTERSECT']);
const hasTopLevelOffset = (t: Token[], from: number) => scanTopLevel(t, from, ['OFFSET', 'FETCH']);

/** Base tables in the dbo schema (the only schema this server exposes). */
export const MSSQL_LIST_TABLES = `
SELECT t.name AS name
FROM sys.tables AS t
WHERE SCHEMA_NAME(t.schema_id) = 'dbo' AND t.is_ms_shipped = 0
ORDER BY t.name`;

/** Columns with type, nullability and primary-key flag. Parameter: @table. */
export const MSSQL_DESCRIBE_COLUMNS = `
SELECT c.name AS name,
       TYPE_NAME(c.user_type_id) +
         CASE WHEN TYPE_NAME(c.user_type_id) IN ('nvarchar','nchar') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')'
              WHEN TYPE_NAME(c.user_type_id) IN ('varchar','char') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(10)) END + ')'
              WHEN TYPE_NAME(c.user_type_id) IN ('decimal','numeric') THEN '(' + CAST(c.precision AS varchar(5)) + ',' + CAST(c.scale AS varchar(5)) + ')'
              ELSE '' END AS type,
       c.is_nullable AS nullable,
       CASE WHEN ic.column_id IS NULL THEN 0 ELSE 1 END AS primary_key,
       ISNULL(ic.key_ordinal, 0) AS pk_ordinal
FROM sys.columns AS c
JOIN sys.tables AS t ON t.object_id = c.object_id
LEFT JOIN sys.indexes AS i ON i.object_id = t.object_id AND i.is_primary_key = 1
LEFT JOIN sys.index_columns AS ic ON ic.object_id = t.object_id AND ic.index_id = i.index_id AND ic.column_id = c.column_id
WHERE SCHEMA_NAME(t.schema_id) = 'dbo' AND t.name = @table
ORDER BY c.column_id`;

/** Foreign keys declared on a table. Parameter: @table. */
export const MSSQL_FOREIGN_KEYS = `
SELECT pc.name AS column_name, rt.name AS references_table, rc.name AS references_column
FROM sys.foreign_key_columns AS fkc
JOIN sys.tables AS pt ON pt.object_id = fkc.parent_object_id
JOIN sys.columns AS pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
JOIN sys.tables AS rt ON rt.object_id = fkc.referenced_object_id
JOIN sys.columns AS rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
WHERE SCHEMA_NAME(pt.schema_id) = 'dbo' AND pt.name = @table
ORDER BY fkc.constraint_column_id`;

/** Row count from partition metadata (cheap; no table scan). Parameter: @table. */
export const MSSQL_ROW_COUNT = `
SELECT CAST(ISNULL(SUM(p.rows), 0) AS bigint) AS row_count
FROM sys.partitions AS p
JOIN sys.tables AS t ON t.object_id = p.object_id
WHERE SCHEMA_NAME(t.schema_id) = 'dbo' AND t.name = @table AND p.index_id IN (0, 1)`;
