import { describe, expect, it } from 'vitest';
import { grade, gradeRun, numbersIn, type GoldQuestion } from '../src/eval/gold.ts';

const base = { id: 'x', question: 'q', gold_sql: 'SELECT 1' };
const days: GoldQuestion = { ...base, check: { type: 'number', tolerance: 0.02 }, goldRows: [{ days: 5.92 }] };
const names: GoldQuestion = { ...base, check: { type: 'names', columns: ['name'] }, goldRows: [{ name: 'Granite Design' }, { name: 'Maple Labs' }] };
const month: GoldQuestion = { ...base, check: { type: 'month' }, goldRows: [{ m: '2025-12' }] };

describe('eval grading', () => {
  it('reads numbers with thousands separators and decimals', () => {
    expect(numbersIn('Revenue was $1,503,514.43 from 79 orders')).toEqual([1503514.43, 79]);
  });

  it('accepts a number within the relative tolerance and rejects one outside it', () => {
    expect(grade('About 5.95 days', days).correct).toBe(true);
    expect(grade('About 7 days', days).correct).toBe(false);
  });

  it('needs every expected name and accepts a month by name or YYYY-MM', () => {
    expect(grade('Granite Design and Maple Labs', names).correct).toBe(true);
    expect(grade('Granite Design only', names).correct).toBe(false);
    expect(grade('December was best', month).correct).toBe(true);
    expect(grade('2025-12', month).correct).toBe(true);
  });

  it('never counts a run that stopped without a final answer, even if a number matches', () => {
    const stop = '(stopped after 6 steps without a final answer)';
    expect(grade(stop, days).correct).toBe(true); // the raw check is fooled by the "6"
    expect(gradeRun(stop, 'max_steps', days).correct).toBe(false);
    expect(gradeRun('About 5.95 days', 'answered', days).correct).toBe(true);
  });
});
