import { describe, expect, it } from 'vitest';
import {
  computeLatencyStats,
  mean,
  percentage,
  percentile,
  round,
  stddev,
} from '../../src/util/stats.js';
import { diffJson, diffLines, summarizeValueDiff, unifiedDiff } from '../../src/util/diff.js';

describe('percentile', () => {
  it('returns 0 for empty input', () => {
    expect(percentile([], 95)).toBe(0);
  });

  it('handles single values', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  it('interpolates linearly', () => {
    const values = [10, 20, 30, 40, 50];
    expect(percentile(values, 50)).toBe(30);
    expect(percentile(values, 0)).toBe(10);
    expect(percentile(values, 100)).toBe(50);
    expect(percentile(values, 25)).toBe(20);
    expect(percentile(values, 90)).toBeCloseTo(46, 5);
  });

  it('does not mutate its input', () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('mean and stddev', () => {
  it('computes the arithmetic mean', () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(mean([])).toBe(0);
  });

  it('computes sample standard deviation', () => {
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(stddev([5])).toBe(0);
  });
});

describe('round', () => {
  it('rounds safely and never returns NaN/Infinity', () => {
    expect(round(1.23456, 2)).toBe(1.23);
    expect(round(Number.NaN)).toBe(0);
    expect(round(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('percentage', () => {
  it('avoids divide-by-zero', () => {
    expect(percentage(1, 0)).toBe(0);
    expect(percentage(1, 4)).toBe(25);
    expect(percentage(1, 3)).toBe(33.33);
  });
});

describe('computeLatencyStats', () => {
  it('produces a full latency profile', () => {
    const stats = computeLatencyStats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(100);
    expect(stats.p50).toBe(55);
    expect(stats.p90).toBe(91);
    expect(stats.mean).toBe(55);
  });

  it('returns zeros for no samples', () => {
    expect(computeLatencyStats([])).toEqual({
      min: 0,
      mean: 0,
      median: 0,
      p50: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      max: 0,
      stddev: 0,
    });
  });
});

describe('diffLines / unifiedDiff', () => {
  it('detects changed lines', () => {
    const ops = diffLines('a\nb\nc', 'a\nB\nc');
    expect(ops.filter((op) => op.type === 'remove').map((op) => op.line)).toEqual(['b']);
    expect(ops.filter((op) => op.type === 'add').map((op) => op.line)).toEqual(['B']);
  });

  it('renders a unified diff with headers', () => {
    const diff = unifiedDiff('one\ntwo\nthree', 'one\nTWO\nthree');
    expect(diff).toContain('--- expected');
    expect(diff).toContain('+++ actual');
    expect(diff).toContain('-two');
    expect(diff).toContain('+TWO');
    expect(diff).toContain(' one');
  });

  it('returns an empty string for identical input', () => {
    expect(unifiedDiff('same', 'same')).toBe('');
  });
});

describe('diffJson', () => {
  it('reports differing leaf paths', () => {
    const differences = diffJson({ a: 1, b: { c: [1, 2] } }, { a: 2, b: { c: [1, 3] } });
    expect(differences).toEqual([
      { path: '$.a', expected: 1, actual: 2 },
      { path: '$.b.c[1]', expected: 2, actual: 3 },
    ]);
  });

  it('reports added and removed keys', () => {
    const differences = diffJson({ a: 1 }, { b: 2 });
    expect(differences.map((entry) => entry.path).sort()).toEqual(['$.a', '$.b']);
  });

  it('summarizes differences for humans', () => {
    const summary = summarizeValueDiff({ id: 1 }, { id: 2 });
    expect(summary).toContain('$.id');
    expect(summary).toContain('expected 1');
    expect(summary).toContain('got 2');
  });

  it('returns undefined when values are equal', () => {
    expect(summarizeValueDiff({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBeUndefined();
  });
});
