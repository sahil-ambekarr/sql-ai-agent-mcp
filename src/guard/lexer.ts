/**
 * A small SQL tokenizer that knows where strings, quoted identifiers and
 * comments start and end. The keyword denylist runs over its output, so a
 * word inside a string literal ('please DROP me') is never mistaken for a
 * keyword, and a keyword hidden in a comment is never missed.
 */

export type TokenKind = 'word' | 'quoted_ident' | 'string' | 'number' | 'comment' | 'punct' | 'variable';

export interface Token {
  kind: TokenKind;
  /** Raw text as written. */
  text: string;
  /** Upper-cased text for `word` tokens, otherwise the raw text. */
  upper: string;
  start: number;
}

export class LexError extends Error {}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_CHAR = /[A-Za-z0-9_$\u0080-￿]/;

export function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = sql.length;
  const push = (kind: TokenKind, start: number, end: number) => {
    const text = sql.slice(start, end);
    out.push({ kind, text, upper: kind === 'word' ? text.toUpperCase() : text, start });
  };

  while (i < n) {
    const ch = sql[i] as string;
    const next = sql[i + 1];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    // -- line comment
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      push('comment', i, stop);
      i = stop;
      continue;
    }
    // /* block comment */ (T-SQL allows nesting, so track depth to find the true end)
    if (ch === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      if (depth > 0) throw new LexError('unterminated block comment');
      push('comment', i, j);
      i = j;
      continue;
    }
    // 'string' with '' escapes
    if (ch === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new LexError('unterminated string literal');
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      push('string', i, j + 1);
      i = j + 1;
      continue;
    }
    // "ident", `ident`, [ident]
    if (ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new LexError('unterminated quoted identifier');
        if (sql[j] === close) {
          if (sql[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      push('quoted_ident', i, j + 1);
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && next !== undefined && /[0-9]/.test(next))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j] as string)) {
        // exponent sign, e.g. 1e-5
        if ((sql[j] === 'e' || sql[j] === 'E') && (sql[j + 1] === '-' || sql[j + 1] === '+')) j++;
        j++;
      }
      push('number', i, j);
      i = j;
      continue;
    }
    // @var, @@var (T-SQL), :name, $1, ?NNN (SQLite parameters)
    if (ch === '@' || ch === ':' || ch === '$' || ch === '?') {
      let j = i + 1;
      while (j < n && (WORD_CHAR.test(sql[j] as string) || sql[j] === '@')) j++;
      if (j > i + 1 || ch === '?') {
        push('variable', i, j);
        i = j;
        continue;
      }
    }
    if (WORD_START.test(ch)) {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(sql[j] as string)) j++;
      push('word', i, j);
      i = j;
      continue;
    }
    push('punct', i, i + 1);
    i++;
  }
  return out;
}
