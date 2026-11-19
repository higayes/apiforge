import type { LatencyStats } from '../types.js';

/** Linear-interpolated percentile over unsorted input (p is 0-100). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const clamped = Math.min(100, Math.max(0, p));
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] as number;
  const rank = (clamped / 100) * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sorted[lowerIndex] as number;
  const upper = sorted[upperIndex] as number;
  if (lowerIndex === upperIndex) return lower;
  return lower + (upper - lower) * (rank - lowerIndex);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

export function stddev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  let acc = 0;
  for (const value of values) acc += (value - avg) ** 2;
  return Math.sqrt(acc / (values.length - 1));
}

/** Round to at most `decimals` places without trailing zeros issues. */
export function round(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function computeLatencyStats(durations: readonly number[]): LatencyStats {
  if (durations.length === 0) {
    return { min: 0, mean: 0, median: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0, stddev: 0 };
  }
  return {
    min: round(Math.min(...durations)),
    mean: round(mean(durations)),
    median: round(percentile(durations, 50)),
    p50: round(percentile(durations, 50)),
    p90: round(percentile(durations, 90)),
    p95: round(percentile(durations, 95)),
    p99: round(percentile(durations, 99)),
    max: round(Math.max(...durations)),
    stddev: round(stddev(durations)),
  };
}

/** Percentage helper that never divides by zero. */
export function percentage(part: number, total: number, decimals = 2): number {
  if (total <= 0) return 0;
  return round((part / total) * 100, decimals);
}
