/**
 * Performance engine.
 *
 * Safety-first design:
 *  - concurrency is capped (default 5, hard maximum 100),
 *  - a run always has a finite duration or a request cap; there is no
 *    "run until stopped" mode,
 *  - cancellation is honoured at the worker level and mid-flight requests are
 *    aborted through an AbortSignal,
 *  - statistics are computed from real measurements only (no simulation).
 */
import { Agent } from 'undici';
import type { Dispatcher } from 'undici';
import { RequestError } from '../errors.js';
import type { PerformanceReport, PerformanceStats } from '../types.js';
import { executeRequest, type HttpRequestOptions } from '../http/client.js';
import { computeLatencyStats, percentage, round } from '../util/stats.js';
import { redactUrl } from '../util/redaction.js';
import { computeThresholds } from '../test/thresholds.js';
import type { ThresholdDefinition } from '../config/schema.js';

export const MAX_CONCURRENCY = 100;
export const DEFAULT_CONCURRENCY = 5;
export const DEFAULT_DURATION_SECONDS = 10;

export interface PerformanceRunOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  query?: HttpRequestOptions['query'];
  cookies?: Record<string, string>;
  auth?: HttpRequestOptions['auth'];
  body?: HttpRequestOptions['body'];
  concurrency?: number;
  durationSeconds?: number;
  maxRequests?: number;
  timeoutMs?: number;
  thinkTimeMs?: number;
  warmupRequests?: number;
  thresholds?: ThresholdDefinition[];
  signal?: AbortSignal;
  insecureTLS?: boolean;
  /** Called with live progress, once per completed request (throttled). */
  onProgress?: (snapshot: PerformanceProgress) => void;
  /** Hard ceiling on the number of requests regardless of configuration. */
  hardMaxRequests?: number;
  title?: string;
  tool: { name: string; version: string };
}

export interface PerformanceProgress {
  completed: number;
  successes: number;
  failures: number;
  elapsedMs: number;
  currentRps: number;
  lastLatencyMs: number;
}

interface Sample {
  durationMs: number;
  status?: number;
  ok: boolean;
  errorKind?: 'timeout' | 'network' | 'cancelled' | 'http';
  bytes: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeStats(samples: Sample[], durationMs: number): PerformanceStats {
  const total = samples.length;
  const durations: number[] = [];
  const statusDistribution: Record<string, number> = {};
  const errorBreakdown: Record<string, number> = {};
  let successful = 0;
  let failed = 0;
  let timeouts = 0;
  let bytes = 0;

  for (const sample of samples) {
    durations.push(sample.durationMs);
    bytes += sample.bytes;
    if (sample.status !== undefined) {
      const key = String(sample.status);
      statusDistribution[key] = (statusDistribution[key] ?? 0) + 1;
    }
    if (sample.ok) {
      successful += 1;
    } else {
      failed += 1;
      const key = sample.errorKind ?? 'unknown';
      errorBreakdown[key] = (errorBreakdown[key] ?? 0) + 1;
      if (sample.errorKind === 'timeout') timeouts += 1;
    }
  }

  const seconds = Math.max(durationMs / 1000, 0.001);
  return {
    totalRequests: total,
    successful,
    failed,
    timeouts,
    errorRate: percentage(failed, total),
    successRate: percentage(successful, total),
    requestsPerSecond: round(total / seconds),
    latency: computeLatencyStats(durations),
    bytesReceived: bytes,
    throughputBytesPerSecond: round(bytes / seconds),
    statusDistribution,
    errorBreakdown,
    durationMs: Math.round(durationMs),
  };
}

async function warmup(options: PerformanceRunOptions, dispatcher: Dispatcher): Promise<void> {
  const count = options.warmupRequests ?? 0;
  for (let i = 0; i < count; i += 1) {
    if (options.signal?.aborted) return;
    try {
      await executeRequest({
        method: options.method,
        url: options.url,
        headers: options.headers,
        query: options.query,
        cookies: options.cookies,
        auth: options.auth,
        body: options.body,
        timeoutMs: options.timeoutMs,
        retries: 0,
        dispatcher,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.insecureTLS ? { insecureTLS: true } : {}),
      });
    } catch {
      // Warmup failures are intentionally ignored; they are not measured.
    }
  }
}

/**
 * Run a bounded load test. Resolves with a complete report; the run never
 * throws for request-level failures (they are measured and reported).
 */
export async function runPerformance(options: PerformanceRunOptions): Promise<PerformanceReport> {
  const concurrency = clamp(Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY), 1, MAX_CONCURRENCY);
  const deadline = options.durationSeconds ?? (options.maxRequests ? undefined : DEFAULT_DURATION_SECONDS);
  const hardMax = options.hardMaxRequests ?? 1_000_000;
  const limit = Math.min(options.maxRequests ?? hardMax, hardMax);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const thinkTimeMs = Math.max(0, options.thinkTimeMs ?? 0);

  const agent = new Agent({
    connections: concurrency + 4,
    keepAliveTimeout: 10_000,
    ...(options.insecureTLS ? { connect: { rejectUnauthorized: false } } : {}),
  });

  const internalController = new AbortController();
  const forwardAbort = (): void => internalController.abort();
  options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const signal = internalController.signal;

  await warmup(options, agent);

  const samples: Sample[] = [];
  let issued = 0;
  const startedAt = new Date();
  const started = performance.now();
  let elapsed = 0;

  const shouldStop = (): boolean => {
    if (signal.aborted) return true;
    elapsed = performance.now() - started;
    if (deadline !== undefined && elapsed >= deadline * 1000) return true;
    return issued >= limit;
  };

  let lastProgressAt = 0;
  const reportProgress = (sample: Sample): void => {
    if (!options.onProgress) return;
    const now = performance.now();
    if (now - lastProgressAt < 250) return;
    lastProgressAt = now;
    const successes = samples.filter((entry) => entry.ok).length;
    const failures = samples.length - successes;
    options.onProgress({
      completed: samples.length,
      successes,
      failures,
      elapsedMs: Math.round(now - started),
      currentRps: round(samples.length / Math.max((now - started) / 1000, 0.001)),
      lastLatencyMs: sample.durationMs,
    });
  };

  const worker = async (): Promise<void> => {
    while (!shouldStop()) {
      issued += 1;
      const requestStarted = performance.now();
      try {
        const response = await executeRequest({
          method: options.method,
          url: options.url,
          headers: options.headers,
          query: options.query,
          cookies: options.cookies,
          auth: options.auth,
          body: options.body,
          timeoutMs,
          retries: 0,
          dispatcher: agent,
          signal,
          ...(options.insecureTLS ? { insecureTLS: true } : {}),
        });
        const sample: Sample = {
          durationMs: Math.round(performance.now() - requestStarted),
          status: response.status,
          ok: response.status < 400,
          bytes: response.bodyBytes,
          ...(response.status >= 400 ? { errorKind: 'http' as const } : {}),
        };
        samples.push(sample);
        reportProgress(sample);
      } catch (error) {
        if (signal.aborted) {
          // Cancelled requests are not counted as failures.
          break;
        }
        const kind = error instanceof RequestError ? error.kind : 'network';
        if (kind === 'cancelled') break;
        const sample: Sample = {
          durationMs: Math.round(performance.now() - requestStarted),
          ok: false,
          bytes: 0,
          errorKind: kind === 'timeout' ? 'timeout' : kind === 'network' ? 'network' : 'http',
        };
        samples.push(sample);
        reportProgress(sample);
      }
      if (thinkTimeMs > 0 && !shouldStop()) {
        await new Promise<void>((resolve) => setTimeout(resolve, thinkTimeMs));
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } finally {
    options.signal?.removeEventListener('abort', forwardAbort);
    await agent.close().catch(() => undefined);
  }

  const totalElapsed = performance.now() - started;
  const endedAt = new Date();
  const stats = computeStats(samples, totalElapsed);
  const cancelled = options.signal?.aborted === true;

  const thresholdInput = {
    total: stats.totalRequests,
    successRate: stats.successRate,
    errorRate: stats.errorRate,
    rps: stats.requestsPerSecond,
    durationMs: stats.durationMs,
    p50: stats.latency.p50,
    p90: stats.latency.p90,
    p95: stats.latency.p95,
    p99: stats.latency.p99,
  };
  const thresholds = computeThresholds(options.thresholds, thresholdInput, 'performance');
  const passed = !cancelled && thresholds.every((threshold) => threshold.passed);

  return {
    kind: 'performance',
    title: options.title ?? 'APIFORGE performance report',
    generatedAt: new Date().toISOString(),
    tool: options.tool,
    target: { method: options.method.toUpperCase(), url: redactUrl(options.url) },
    config: {
      concurrency,
      ...(deadline !== undefined ? { durationSeconds: deadline } : {}),
      ...(options.maxRequests !== undefined ? { maxRequests: limit } : {}),
      timeoutMs,
      thinkTimeMs,
      warmupRequests: options.warmupRequests ?? 0,
    },
    stats,
    thresholds,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    cancelled,
    passed,
  };
}
