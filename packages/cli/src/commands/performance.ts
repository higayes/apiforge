import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  closeHttpResources,
  parsePerformanceDocument,
  renderPerformanceReport,
  runPerformance,
  ConfigError,
  type PerformanceSpec,
  type ReportFormat,
} from '@apiforge/engine';
import { EXIT_CHECKS_FAILED, EXIT_INTERRUPTED, EXIT_SUCCESS } from '../exit-codes.js';
import { createUiFromCommand } from '../lib/context.js';
import {
  assertHttpUrl,
  parseHeaders,
  parseKeyValuePairs,
  parseIntInRange,
  parseNumberInRange,
  parseTimeout,
  readStructuredInput,
  resolveBody,
} from '../lib/inputs.js';
import { emitReport, parseFormats } from '../lib/output.js';
import { installCancellation } from '../signals.js';
import { TOOL_INFO } from '../lib/version.js';

interface PerformanceCommandOptions {
  config?: string;
  method?: string;
  header?: string[];
  duration?: string;
  requests?: string;
  concurrency?: string;
  timeout?: string;
  thinkTime?: string;
  warmup?: string;
  expectP95?: string;
  expectErrorRate?: string;
  expectMinRps?: string;
  body?: string;
  bodyFile?: string;
  reporter?: string;
  out?: string;
  json?: boolean;
  color?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  insecure?: boolean;
}

export function registerPerformanceCommand(program: Command): void {
  program
    .command('performance [url]')
    .alias('perf')
    .description('Run a bounded load test and report latency, throughput and error statistics')
    .option('--config <path>', 'performance specification file (YAML/JSON)')
    .option('-X, --method <method>', 'HTTP method (default: GET)')
    .option('-H, --header <name=value>', 'request header (repeatable)', collect, [])
    .option('-d, --duration <seconds>', 'test duration in seconds (max 3600)')
    .option('-n, --requests <count>', 'stop after this many requests (max 100000)')
    .option('-c, --concurrency <n>', 'concurrent virtual users (1-100, default 5)')
    .option('--timeout <ms>', 'per-request timeout in milliseconds')
    .option('--think-time <ms>', 'pause between requests per virtual user')
    .option('--warmup <count>', 'unmeasured warmup requests')
    .option('--expect-p95 <ms>', 'fail if p95 latency (ms) exceeds this value')
    .option('--expect-error-rate <percent>', 'fail if the error rate exceeds this percentage')
    .option('--expect-min-rps <n>', 'fail if requests/second drops below this value')
    .option('--body <text>', 'request body')
    .option('--body-file <path>', 'read the request body from a file')
    .option('--reporter <formats>', 'report formats, comma separated: terminal,json,html,junit')
    .option('-o, --out <dir>', 'directory for report files')
    .option('--json', 'print the full report as JSON to stdout')
    .option('--insecure', 'do not verify TLS certificates (development only)')
    .option('-v, --verbose', 'show extra detail')
    .option('-q, --quiet', 'only print the final result')
    .option('--no-color', 'disable coloured output')
    .action(async (url: string | undefined, options: PerformanceCommandOptions) => {
      const ui = createUiFromCommand(options);
      const cancellation = installCancellation({
        onFirstInterrupt: () => {
          ui.warn('Stopping the load test… press Ctrl+C again to exit immediately.');
        },
      });

      try {
        const formats: ReportFormat[] = parseFormats(
          options.reporter ? options.reporter.split(',') : undefined,
          ['terminal', 'html', 'json'],
        );

        let spec: PerformanceSpec;
        if (options.config) {
          // An explicit spec file wins; a positional URL is ignored with a note.
          if (url) ui.warn('Both a URL and --config were given; using the specification file.');
          const document = await readStructuredInput(options.config, 'performance specification');
          spec = parsePerformanceDocument(document, options.config);
        } else {
          if (!url) throw new ConfigError('A target URL is required (or use --config <file>)');
          const target = assertHttpUrl(url);
          const headers = parseHeaders(options.header);
          const body = await resolveBody({
            ...(options.body !== undefined ? { body: options.body } : {}),
            ...(options.bodyFile !== undefined ? { bodyFile: options.bodyFile } : {}),
          });
          spec = parsePerformanceDocument(
            {
              target: {
                method: options.method ?? 'GET',
                url: target,
                ...(Object.keys(headers).length > 0 ? { headers } : {}),
                ...(body ? { body } : {}),
              },
              ...(options.concurrency ? { concurrency: parseIntInRange(options.concurrency, '--concurrency', 1, 100) } : {}),
              ...(options.duration ? { durationSeconds: parseNumberInRange(options.duration, '--duration', 0.001, 3600) } : {}),
              ...(options.requests ? { maxRequests: parseIntInRange(options.requests, '--requests', 1, 100_000) } : {}),
              ...(options.timeout ? { timeoutMs: parseTimeout(options.timeout) } : {}),
              ...(options.thinkTime ? { thinkTimeMs: parseTimeout(options.thinkTime, '--think-time') } : {}),
              ...(options.warmup ? { warmupRequests: parseIntInRange(options.warmup, '--warmup', 0, 1000) } : {}),
            },
            'command line options',
          );

          const thresholds = [];
          if (options.expectP95) {
            thresholds.push({ metric: 'p95' as const, max: parseNumberInRange(options.expectP95, '--expect-p95', 0, 600_000) });
          }
          if (options.expectErrorRate) {
            thresholds.push({
              metric: 'errorRate' as const,
              max: parseNumberInRange(options.expectErrorRate, '--expect-error-rate', 0, 100),
            });
          }
          if (options.expectMinRps) {
            thresholds.push({ metric: 'rps' as const, min: parseNumberInRange(options.expectMinRps, '--expect-min-rps', 0, 1_000_000) });
          }
          if (thresholds.length > 0) spec = { ...spec, thresholds };
        }

        // Merge additional CLI headers on top of a file-based spec.
        const extraHeaders = parseHeaders(options.header);
        if (Object.keys(extraHeaders).length > 0) {
          spec = {
            ...spec,
            target: { ...spec.target, headers: { ...(spec.target.headers ?? {}), ...extraHeaders } },
          };
        }
        if (!spec.target.url && !spec.target.path) {
          throw new ConfigError('The performance target needs a `url` (or `path` plus a base URL)');
        }
        // Paths without a base URL are rejected explicitly rather than guessing.
        const targetUrl = spec.target.url ?? spec.target.path ?? '';
        assertHttpUrl(targetUrl, 'performance target');

        if (!spec.durationSeconds && !spec.maxRequests) {
          ui.warn(`No --duration or --requests given; running for the default of 10 seconds.`);
        }
        if (!spec.durationSeconds && spec.maxRequests && spec.maxRequests > 10_000) {
          ui.warn(`Large request limit (${spec.maxRequests}). Only run load tests against systems you own.`);
        }

        ui.banner(TOOL_INFO.version);
        ui.line(
          ui.palette.gray(
            `Load test: ${spec.concurrency} virtual users · ${
              spec.durationSeconds ? `${spec.durationSeconds}s` : `${spec.maxRequests} requests`
            } · timeout ${spec.timeoutMs}ms`,
          ),
        );
        ui.line(ui.palette.gray('Only load-test systems you are authorized to test.'));

        const spinnerLabel = (): string => {
          const elapsed = Date.now() - startedAt;
          return `Running load test… ${Math.round(elapsed / 100) / 10}s elapsed`;
        };
        const startedAt = Date.now();
        ui.startSpinner(spinnerLabel());
        const progressTimer = setInterval(() => ui.updateSpinner(spinnerLabel()), 250);
        progressTimer.unref?.();

        let report;
        try {
          report = await runPerformance({
            method: spec.target.method,
            url: targetUrl,
            ...(spec.target.headers ? { headers: spec.target.headers } : {}),
            ...(spec.target.query ? { query: spec.target.query } : {}),
            ...(spec.target.cookies ? { cookies: spec.target.cookies } : {}),
            ...(spec.target.auth ? { auth: spec.target.auth } : {}),
            ...(spec.target.body ? { body: spec.target.body } : {}),
            concurrency: spec.concurrency,
            ...(spec.durationSeconds !== undefined ? { durationSeconds: spec.durationSeconds } : {}),
            ...(spec.maxRequests !== undefined ? { maxRequests: spec.maxRequests } : {}),
            timeoutMs: spec.timeoutMs,
            thinkTimeMs: spec.thinkTimeMs,
            warmupRequests: spec.warmupRequests,
            ...(spec.thresholds ? { thresholds: spec.thresholds } : {}),
            signal: cancellation.signal,
            ...(options.insecure === true ? { insecureTLS: true } : {}),
            tool: TOOL_INFO,
            title: 'APIFORGE performance report',
          });
        } finally {
          clearInterval(progressTimer);
        }
        ui.stopSpinner();

        if (!options.json) {
          ui.block(renderPerformanceReport(report, { color: ui.palette.enabled }));
        }

        await emitReport(report, {
          ui,
          formats,
          ...(options.out ? { outDir: options.out } : {}),
          json: options.json === true,
          suppressTerminal: true,
          renderTerminal: () => renderPerformanceReport(report, { color: false }),
        });

        process.exitCode = report.cancelled
          ? EXIT_INTERRUPTED
          : report.passed
            ? EXIT_SUCCESS
            : EXIT_CHECKS_FAILED;
      } finally {
        cancellation.dispose();
        await closeHttpResources();
      }
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Exported for tests: read a performance spec file. */
export async function loadPerformanceSpec(file: string): Promise<PerformanceSpec> {
  const content = await readFile(resolve(file), 'utf8');
  const { parseDocument } = await import('@apiforge/engine');
  return parsePerformanceDocument(parseDocument(content, file), file);
}
