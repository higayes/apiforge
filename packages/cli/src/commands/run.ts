import type { Command } from 'commander';
import {
  buildTestReport,
  closeHttpResources,
  renderTestReport,
  runSuite,
  type ReportFormat,
} from '@apiforge/engine';
import { EXIT_CHECKS_FAILED, EXIT_INTERRUPTED, EXIT_SUCCESS } from '../exit-codes.js';
import { createUiFromCommand } from '../lib/context.js';
import {
  assertHttpUrl,
  parseHeaders,
  parseKeyValuePairs,
  parseTimeout,
  resolveBody,
  testFromFlags,
} from '../lib/inputs.js';
import { emitReport, parseFormats } from '../lib/output.js';
import { installCancellation } from '../signals.js';
import { TOOL_INFO } from '../lib/version.js';

interface RunCommandOptions {
  method?: string;
  header?: string[];
  query?: string[];
  body?: string;
  bodyFile?: string;
  form?: string[];
  jsonBody?: boolean;
  expectStatus?: string;
  timeout?: string;
  reporter?: string;
  out?: string;
  json?: boolean;
  color?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  insecure?: boolean;
}

/** `apiforge run` executes one ad-hoc request with optional assertions. */
export function registerRunCommand(program: Command): void {
  program
    .command('run <url>')
    .description('Send a single ad-hoc HTTP request and assert on the response')
    .option('-X, --method <method>', 'HTTP method (default: GET)')
    .option('-H, --header <name=value>', 'request header (repeatable)', collect, [])
    .option('--query <key=value>', 'query parameter (repeatable)', collect, [])
    .option('-d, --body <text>', 'request body (JSON is detected automatically)')
    .option('--body-file <path>', 'read the request body from a file')
    .option('--form <key=value>', 'URL-encoded form field (repeatable)', collect, [])
    .option('--json-body', 'treat --body/--body-file content as JSON even if it does not start with { or [')
    .option('--expect-status <code>', 'assert the response status code')
    .option('--timeout <ms>', 'request timeout in milliseconds')
    .option('--reporter <formats>', 'report formats, comma separated: terminal,json,html,junit')
    .option('-o, --out <dir>', 'directory for report files')
    .option('--json', 'print the full report as JSON to stdout')
    .option('--insecure', 'do not verify TLS certificates (development only)')
    .option('-v, --verbose', 'show response body and all assertions')
    .option('-q, --quiet', 'only print the final result')
    .option('--no-color', 'disable coloured output')
    .action(async (url: string, options: RunCommandOptions) => {
      const ui = createUiFromCommand(options);
      try {
        const target = assertHttpUrl(url, 'target');
        const headers = parseHeaders(options.header);
        const query = parseKeyValuePairs(options.query, '--query');
        const body = await resolveBody({
          ...(options.body !== undefined ? { body: options.body } : {}),
          ...(options.bodyFile !== undefined ? { bodyFile: options.bodyFile } : {}),
          ...(options.form && options.form.length > 0 ? { form: options.form } : {}),
          ...(options.jsonBody === true ? { json: true } : {}),
        });
        const timeoutMs = parseTimeout(options.timeout);
        const expectStatus =
          options.expectStatus !== undefined ? Number.parseInt(options.expectStatus, 10) : undefined;
        if (expectStatus !== undefined && (!Number.isInteger(expectStatus) || expectStatus < 100 || expectStatus > 599)) {
          throw new Error(`Invalid --expect-status "${options.expectStatus}" (expected 100-599)`);
        }

        const formats: ReportFormat[] = parseFormats(
          options.reporter ? options.reporter.split(',') : undefined,
          ['terminal'],
        );
        const cancellation = installCancellation();

        try {
          const test = testFromFlags({
            method: options.method ?? 'GET',
            url: target,
            headers,
            ...(body ? { body } : {}),
            ...(expectStatus !== undefined ? { expectStatus } : {}),
          });
          const suite = {
            name: 'Ad-hoc request',
            variables: { ...query },
            tests: [
              {
                ...test,
                ...(Object.keys(query).length > 0
                  ? {
                      query: Object.fromEntries(
                        Object.entries(query).map(([key, value]) => [key, value]),
                      ),
                    }
                  : {}),
              },
            ],
          };

          const run = await runSuite(suite, {
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            ...(options.insecure === true ? { insecureTLS: true } : {}),
            signal: cancellation.signal,
          });
          const report = buildTestReport({ title: 'Ad-hoc request', suites: [run], tool: TOOL_INFO });

          if (!options.json) {
            ui.line();
            ui.block(renderTestReport(report, { color: ui.palette.enabled, verbose: options.verbose === true, showBodies: options.verbose === true }));
          }

          await emitReport(report, {
            ui,
            formats,
            ...(options.out ? { outDir: options.out } : {}),
            json: options.json === true,
            suppressTerminal: true,
            renderTerminal: () => renderTestReport(report, { color: false }),
          });

          if (options.json) {
            // The JSON report is already on stdout; keep the exit code semantic.
          }

          process.exitCode = cancellation.interrupted
            ? EXIT_INTERRUPTED
            : report.passed
              ? EXIT_SUCCESS
              : EXIT_CHECKS_FAILED;
        } finally {
          cancellation.dispose();
        }
      } finally {
        await closeHttpResources();
      }
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
