import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { computeStats, runPerformance } from '../../src/performance/runner.js';
import { closeHttpResources } from '../../src/http/client.js';
import { startMockServer, type MockServer } from '../helpers/mock-server.js';

let server: MockServer;
const tool = { name: 'apiforge', version: '0.1.0' };

beforeAll(async () => {
  server = await startMockServer();
});

afterAll(async () => {
  await server.close();
  await closeHttpResources();
});

beforeEach(() => {
  server.reset();
});

describe('computeStats', () => {
  it('computes counts, rates and latencies', () => {
    const stats = computeStats(
      [
        { durationMs: 10, status: 200, ok: true, bytes: 100 },
        { durationMs: 20, status: 200, ok: true, bytes: 100 },
        { durationMs: 30, status: 500, ok: false, bytes: 50, errorKind: 'http' },
        { durationMs: 40, ok: false, bytes: 0, errorKind: 'timeout' },
      ],
      1000,
    );
    expect(stats.totalRequests).toBe(4);
    expect(stats.successful).toBe(2);
    expect(stats.failed).toBe(2);
    expect(stats.timeouts).toBe(1);
    expect(stats.errorRate).toBe(50);
    expect(stats.successRate).toBe(50);
    expect(stats.requestsPerSecond).toBe(4);
    expect(stats.bytesReceived).toBe(250);
    expect(stats.throughputBytesPerSecond).toBe(250);
    expect(stats.statusDistribution).toEqual({ '200': 2, '500': 1 });
    expect(stats.errorBreakdown).toEqual({ http: 1, timeout: 1 });
    expect(stats.latency.p50).toBeGreaterThan(20);
  });

  it('handles empty sample sets without dividing by zero', () => {
    const stats = computeStats([], 0);
    expect(stats.totalRequests).toBe(0);
    expect(stats.errorRate).toBe(0);
    expect(stats.latency.p99).toBe(0);
    expect(Number.isFinite(stats.requestsPerSecond)).toBe(true);
  });
});

describe('runPerformance', () => {
  it('respects the request limit and reports measured latency', async () => {
    const report = await runPerformance({
      method: 'GET',
      url: `${server.url}/json`,
      maxRequests: 20,
      concurrency: 4,
      tool,
    });
    expect(report.stats.totalRequests).toBe(20);
    expect(report.stats.successful).toBe(20);
    expect(report.stats.errorRate).toBe(0);
    expect(report.stats.latency.p50).toBeGreaterThanOrEqual(0);
    expect(report.passed).toBe(true);
    expect(report.cancelled).toBe(false);
    expect(server.requests).toHaveLength(20);
  });

  it('respects the duration bound', async () => {
    const report = await runPerformance({
      method: 'GET',
      url: `${server.url}/json`,
      durationSeconds: 0.3,
      concurrency: 2,
      tool,
    });
    expect(report.stats.durationMs).toBeGreaterThanOrEqual(250);
    expect(report.stats.durationMs).toBeLessThan(5000);
    expect(report.stats.totalRequests).toBeGreaterThan(0);
  });

  it('counts HTTP error statuses as failures', async () => {
    const report = await runPerformance({
      method: 'GET',
      url: `${server.url}/status/500`,
      maxRequests: 5,
      concurrency: 1,
      tool,
    });
    expect(report.stats.failed).toBe(5);
    expect(report.stats.errorRate).toBe(100);
  });

  it('counts timeouts separately', async () => {
    const report = await runPerformance({
      method: 'GET',
      url: `${server.url}/delay/1s`,
      maxRequests: 2,
      concurrency: 1,
      timeoutMs: 100,
      tool,
    });
    expect(report.stats.timeouts).toBe(2);
    expect(report.stats.errorBreakdown.timeout).toBe(2);
  });

  it('evaluates thresholds against measured values', async () => {
    const failing = await runPerformance({
      method: 'GET',
      url: `${server.url}/json`,
      maxRequests: 5,
      concurrency: 1,
      tool,
      thresholds: [
        { metric: 'errorRate', max: 0 },
        { metric: 'p99', max: 0.00001 },
      ],
    });
    expect(failing.thresholds).toHaveLength(2);
    expect(failing.thresholds[1]?.passed).toBe(false);
    expect(failing.passed).toBe(false);

    const passing = await runPerformance({
      method: 'GET',
      url: `${server.url}/json`,
      maxRequests: 5,
      concurrency: 1,
      tool,
      thresholds: [
        { metric: 'successRate', min: 100 },
        { metric: 'p99', max: 10_000 },
      ],
    });
    expect(passing.passed).toBe(true);
  });

  it('supports cancellation mid-run', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const report = await runPerformance({
      method: 'GET',
      url: `${server.url}/delay/1s`,
      durationSeconds: 10,
      concurrency: 2,
      timeoutMs: 5000,
      signal: controller.signal,
      tool,
    });
    expect(report.cancelled).toBe(true);
    expect(report.passed).toBe(false);
    expect(report.stats.durationMs).toBeLessThan(2000);
  });

  it('performs warmup requests that are excluded from the stats', async () => {
    const report = await runPerformance({
      method: 'GET',
      url: `${server.url}/json`,
      maxRequests: 3,
      concurrency: 1,
      warmupRequests: 2,
      tool,
    });
    expect(report.stats.totalRequests).toBe(3);
    expect(server.requests.length).toBe(5);
    expect(report.config.warmupRequests).toBe(2);
  });

  it('clamps concurrency into the safe range', async () => {
    const report = await runPerformance({
      method: 'GET',
      url: `${server.url}/json`,
      maxRequests: 2,
      concurrency: 5000,
      tool,
    });
    expect(report.config.concurrency).toBe(100);
  });

  it('reports progress callbacks with real measurements', async () => {
    const snapshots: number[] = [];
    await runPerformance({
      method: 'GET',
      url: `${server.url}/json`,
      maxRequests: 30,
      concurrency: 2,
      tool,
      onProgress: (snapshot) => snapshots.push(snapshot.completed),
    });
    expect(snapshots.length).toBeGreaterThan(0);
    expect(Math.max(...snapshots)).toBeGreaterThan(0);
  });

  it('redacts credentials in the reported target URL', async () => {
    const report = await runPerformance({
      method: 'GET',
      url: `${server.url}/echo?token=secret-token-value`,
      maxRequests: 1,
      concurrency: 1,
      tool,
    });
    expect(report.target.url).not.toContain('secret-token-value');
  });
});
