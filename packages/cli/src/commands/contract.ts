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
import {
  assertHttpUrl,
  parseContractSpecDocument,
  parseHeaders,
  parseKeyValuePairs,
  parseTimeout,
} from '../lib/inputs.js';
import { parseDocument, readTextFile } from '@apiforge/engine';
import { emitReport, parseFormats } from '../lib/output.js';
import { installCancellation } from '../signals.js';
import { TOOL_INFO } from '../lib/version.js';

interface ContractCommandOptions {
  config?: string;
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
    .command('contract [url]')
    .description(
      'Detect breaking response-shape changes against a stored baseline (schema regression testing)',
    )
    .option('--config <file>', 'load the target and options from a YAML/JSON contract spec')
    .option(
      '-b, --baseline <path>',
      'baseline snapshot file (default: .apiforge/contracts/<name>.json)',
    )
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
    .action(async (url: string | undefined, options: ContractCommandOptions) => {
      const ui = createUiFromCommand(options);
      const cancellation = installCancellation();

      try {
        // A spec file and a positional URL are mutually exclusive inputs.
        const spec = options.config
          ? parseContractSpecDocument(
              parseDocument(await readTextFile(options.config, 'contract spec'), options.config),
              options.config,
            )
          : undefined;
        if (spec && url) {
          ui.warn(`Ignoring the positional URL because --config ${options.config} was provided.`);
        }
        if (!spec && !url) {
          throw new ConfigError('A target URL is required (or use --config <file>)', [
            'Example: apiforge contract https://api.example.com/users',
          ]);
        }

        let target: string;
        if (spec) {
          let specUrl = spec.target.url ?? '';
          if (!specUrl) {
            const path = spec.target.path ?? '';
            if (!path)
              throw new ConfigError(
                'The contract specification needs `target.url` or `target.path`',
              );
            if (!spec.baseUrl) {
              throw new ConfigError(
                `The contract target uses a relative path ("${path}") but no base URL is configured`,
                ['Add `baseUrl: https://api.example.com` to the spec, or use a full `target.url`.'],
              );
            }
            specUrl = new URL(path, spec.baseUrl).toString();
          }
          target = assertHttpUrl(specUrl, 'contract target');
        } else {
          target = assertHttpUrl(url as string);
        }

        const headers = parseHeaders(options.header);
        const query = parseKeyValuePairs(options.query, '--query');
        const timeoutMs = parseTimeout(options.timeout);
        const formats: ReportFormat[] = parseFormats(
          options.reporter ? options.reporter.split(',') : undefined,
          ['terminal', 'html', 'json'],
        );

        const baselineFile = options.baseline
          ? options.baseline
          : spec?.baseline
            ? spec.baseline
            : baselinePathFor(
                process.cwd(),
                options.name ?? new URL(target).hostname + new URL(target).pathname,
              );

        if (options.schema === undefined && options.update !== true) {
          ui.detail(`Baseline: ${baselineFile}`);
        }

        const report = await runContract({
          url: target,
          method: options.method ?? spec?.target.method ?? 'GET',
          ...(spec?.target.headers ? { headers: { ...spec.target.headers, ...headers } } : {}),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          ...(Object.keys(query).length > 0 ? { query } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          baselineFile,
          ...(options.update === true || spec?.update === true ? { update: true } : {}),
          ...((options.schema ?? spec?.schema)
            ? { schemaFile: (options.schema ?? spec?.schema) as string }
            : {}),
          ...(cancellation.signal ? { signal: cancellation.signal } : {}),
          ...(options.insecure === true ? { insecureTLS: true } : {}),
          tool: TOOL_INFO,
        });

        if (!options.json) {
          ui.block(
            renderContractReport(report, {
              color: ui.palette.enabled,
              verbose: options.verbose === true,
            }),
          );
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
        if (
          error instanceof ConfigError &&
          /not found/i.test(error.message) &&
          /baseline/i.test(error.message)
        ) {
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
