import type { Command } from 'commander';
import {
  baselinePathFor,
  closeHttpResources,
  renderContractReport,
  runContract,
  ConfigError,
  type ReportFormat,
} from '@apiforge/engine';
import { EXIT_CHECKS_FAILED, EXIT_INTERRUPTED, EXIT_SUCCESS } from '../exit-codes.js';
import { createUiFromCommand } from '../lib/context.js';
import { assertHttpUrl, parseHeaders, parseKeyValuePairs, parseTimeout } from '../lib/inputs.js';
import { emitReport, parseFormats } from '../lib/output.js';
import { installCancellation } from '../signals.js';
import { TOOL_INFO } from '../lib/version.js';

interface ContractCommandOptions {
  baseline?: string;
  update?: boolean;
  schema?: string;
  method?: string;
  header?: string[];
  query?: string[];
  timeout?: string;
  name?: string;
  reporter?: string;
  out?: string;
  json?: boolean;
  color?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  insecure?: boolean;
}

export function registerContractCommand(program: Command): void {
  program
    .command('contract <url>')
    .description('Detect breaking response-shape changes against a stored baseline (schema regression testing)')
    .option('-b, --baseline <path>', 'baseline snapshot file (default: .apiforge/contracts/<name>.json)')
    .option('-u, --update', 'accept the current response shape as the new baseline')
    .option('--schema <path>', 'additionally validate the response against a JSON Schema file')
    .option('-X, --method <method>', 'HTTP method (default: GET)')
    .option('-H, --header <name=value>', 'request header (repeatable)', collect, [])
    .option('--query <key=value>', 'query parameter (repeatable)', collect, [])
    .option('--name <slug>', 'baseline name when --baseline is omitted')
    .option('--timeout <ms>', 'request timeout in milliseconds')
    .option('--reporter <formats>', 'report formats, comma separated: terminal,json,html,junit')
    .option('-o, --out <dir>', 'directory for report files')
    .option('--json', 'print the full report as JSON to stdout')
    .option('--insecure', 'do not verify TLS certificates (development only)')
    .option('-v, --verbose', 'show the response body preview')
    .option('-q, --quiet', 'only print the final result')
    .option('--no-color', 'disable coloured output')
    .action(async (url: string, options: ContractCommandOptions) => {
      const ui = createUiFromCommand(options);
      const cancellation = installCancellation();

      try {
        const target = assertHttpUrl(url);
        const headers = parseHeaders(options.header);
        const query = parseKeyValuePairs(options.query, '--query');
        const timeoutMs = parseTimeout(options.timeout);
        const formats: ReportFormat[] = parseFormats(
          options.reporter ? options.reporter.split(',') : undefined,
          ['terminal', 'html', 'json'],
        );

        const baselineFile = options.baseline
          ? options.baseline
          : baselinePathFor(process.cwd(), options.name ?? new URL(target).hostname + new URL(target).pathname);

        if (options.schema === undefined && options.update !== true) {
          ui.detail(`Baseline: ${baselineFile}`);
        }

        const report = await runContract({
          url: target,
          ...(options.method ? { method: options.method } : {}),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          ...(Object.keys(query).length > 0 ? { query } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          baselineFile,
          ...(options.update === true ? { update: true } : {}),
          ...(options.schema ? { schemaFile: options.schema } : {}),
          ...(cancellation.signal ? { signal: cancellation.signal } : {}),
          ...(options.insecure === true ? { insecureTLS: true } : {}),
          tool: TOOL_INFO,
        });

        if (!options.json) {
          ui.block(renderContractReport(report, { color: ui.palette.enabled, verbose: options.verbose === true }));
        }

        await emitReport(report, {
          ui,
          formats,
          ...(options.out ? { outDir: options.out } : {}),
          json: options.json === true,
          suppressTerminal: true,
          renderTerminal: () => renderContractReport(report, { color: false }),
        });

        if (report.snapshotUpdated) {
          ui.info(`Baseline saved to ${baselineFile} — commit it to detect future regressions.`);
        }

        process.exitCode = cancellation.interrupted
          ? EXIT_INTERRUPTED
          : report.passed
            ? EXIT_SUCCESS
            : EXIT_CHECKS_FAILED;
      } catch (error) {
        if (error instanceof ConfigError && /not found/i.test(error.message) && /baseline/i.test(error.message)) {
          throw new ConfigError(error.message, [
            'Run the command once without --update to create a baseline from the current response.',
          ]);
        }
        throw error;
      } finally {
        cancellation.dispose();
        await closeHttpResources();
      }
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
