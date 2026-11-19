import type { Command } from 'commander';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  buildTestReport,
  closeHttpResources,
  formatDuration,
  renderTestReport,
  runSuite,
  type EnvironmentDefinition,
  type ReportFormat,
  type SuiteRun,
  type TestCaseResult,
} from '@apiforge/engine';
import { EXIT_CHECKS_FAILED, EXIT_CONFIG, EXIT_INTERRUPTED, EXIT_SUCCESS } from '../exit-codes.js';
import { createUiFromCommand } from '../lib/context.js';
import { openProject } from '../lib/project.js';
import {
  parseHeaders,
  parseKeyValuePairs,
  parseTimeout,
  resolveEnvironment,
} from '../lib/inputs.js';
import { emitReport, parseFormats } from '../lib/output.js';
import { installCancellation } from '../signals.js';
import { formatCliError } from '../errors.js';
import { ConfigError } from '@apiforge/engine';
import { TOOL_INFO } from '../lib/version.js';

interface TestCommandOptions {
  env?: string;
  envFile?: string;
  var?: string[];
  secret?: string[];
  header?: string[];
  filter?: string;
  tag?: string[];
  timeout?: string;
  reporter?: string;
  out?: string;
  json?: boolean;
  color?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  bail?: boolean;
  insecure?: boolean;
  title?: string;
}

export function registerTestCommand(program: Command): void {
  program
    .command('test [paths...]')
    .description('Run API test suites (YAML/JSON) and evaluate their assertions')
    .option('-e, --env <name>', 'environment name from environments/<name>.yaml')
    .option('--env-file <path>', 'load an environment from an explicit file')
    .option('--var <key=value>', 'override a suite variable (repeatable)', collect, [])
    .option('--secret <NAME=value>', 'provide a secret value (repeatable)', collect, [])
    .option('--header <name=value>', 'add a header to every request (repeatable)', collect, [])
    .option('--filter <text>', 'only run tests whose name or id contains this text')
    .option('--tag <tag>', 'only run tests carrying this tag (repeatable)', collect, [])
    .option('--timeout <ms>', 'override the timeout for every request')
    .option('--reporter <formats>', 'report formats, comma separated: terminal,json,html,junit')
    .option('-o, --out <dir>', 'directory for report files (default: reports/)')
    .option('--json', 'print the full report as JSON to stdout')
    .option('--title <text>', 'report title')
    .option('--bail', 'stop after the first failing test')
    .option('--insecure', 'do not verify TLS certificates (development only)')
    .option('-v, --verbose', 'show every test and assertion')
    .option('-q, --quiet', 'only print the final result')
    .option('--no-color', 'disable coloured output')
    .action(async (paths: string[], options: TestCommandOptions) => {
      const ui = createUiFromCommand(options);

      try {
        const formats: ReportFormat[] = parseFormats(
          options.reporter ? options.reporter.split(',') : undefined,
          ['terminal', 'html', 'junit'],
        );
        const variables = parseKeyValuePairs(options.var, '--var');
        const secrets = parseKeyValuePairs(options.secret, '--secret');
        const headers = parseHeaders(options.header);
        const timeoutMs = parseTimeout(options.timeout);
        const cancellation = installCancellation({
          onFirstInterrupt: () => {
            ui.stopSpinner();
            ui.warn('Cancelling… press Ctrl+C again to exit immediately.');
          },
        });

        try {
          const project = await openProject(process.cwd(), paths);
          if (project.suites.length === 0) {
            ui.error(
              formatCliError(new ConfigError('No test suites were found'), ui, {
                json: options.json === true,
              }),
            );
            if (options.json !== true) {
              ui.error(
                ui.palette.gray(
                  '  Create one with `apiforge init`, or pass a suite file: apiforge test path/to/suite.yaml',
                ),
              );
            }
            process.exitCode = EXIT_CONFIG;
            return;
          }

          const envName = options.env ?? project.config.defaultEnvironment;
          const { environment, name: environmentName } = await resolveEnvironment(
            project.environments,
            envName,
            options.envFile,
          );

          // CLI headers apply on top of the selected environment.
          const mergedEnvironment: EnvironmentDefinition | undefined =
            Object.keys(headers).length > 0
              ? { ...(environment ?? {}), headers: { ...(environment?.headers ?? {}), ...headers } }
              : environment;

          const title = options.title ?? project.config.name ?? 'APIFORGE test report';
          ui.banner(TOOL_INFO.version);
          ui.line(
            ui.palette.gray(
              `Running ${project.suites.length} suite(s)${
                environmentName ? ` · environment: ${environmentName}` : ''
              }${options.filter ? ` · filter: "${options.filter}"` : ''}`,
            ),
          );

          const suiteRuns: SuiteRun[] = [];
          const started = performance.now();
          let bailed = false;

          for (const loaded of project.suites) {
            ui.line('');
            ui.startSpinner(`Running ${loaded.suite.name}…`);
            let finished = 0;

            const run = await runSuite(
              loaded.suite,
              {
                ...(mergedEnvironment ? { environment: mergedEnvironment } : {}),
                ...(environmentName ? { environmentName } : {}),
                variables,
                secrets,
                ...(options.filter ? { filter: options.filter } : {}),
                ...(options.tag && options.tag.length > 0 ? { tags: options.tag } : {}),
                ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                ...(options.insecure === true ? { insecureTLS: true } : {}),
                signal: cancellation.signal,
                suiteDir: dirname(loaded.file),
                shouldStop: (result: TestCaseResult) =>
                  options.bail === true &&
                  (result.status === 'failed' || result.status === 'error'),
                onTestFinished: (result: TestCaseResult) => {
                  finished += 1;
                  const icon =
                    result.status === 'passed'
                      ? ui.palette.green('✔')
                      : result.status === 'skipped'
                        ? ui.palette.yellow('○')
                        : ui.palette.red('✖');
                  ui.updateSpinner(
                    `${loaded.suite.name} — ${finished} finished · ${icon} ${result.name}`,
                  );
                },
              },
              loaded.relativeFile,
            );

            ui.stopSpinner();
            suiteRuns.push(run);

            const totals = run.totals;
            const summary = `${run.suite}: ${totals.passed}/${totals.total} passed${
              totals.failed ? `, ${totals.failed} failed` : ''
            }${totals.errored ? `, ${totals.errored} errors` : ''}${
              totals.skipped ? `, ${totals.skipped} skipped` : ''
            } (${formatDuration(run.durationMs)})`;
            if (run.passed) ui.success(summary);
            else ui.fail(summary);

            if (options.bail === true && !run.passed) {
              bailed = true;
              break;
            }
          }

          const report = buildTestReport({
            title,
            suites: suiteRuns,
            tool: TOOL_INFO,
            ...(environmentName ? { environment: environmentName } : {}),
          });

          if (!options.json) {
            ui.line();
            ui.block(
              renderTestReport(report, {
                color: ui.palette.enabled,
                verbose: options.verbose === true,
              }),
            );
          }

          const outDirOption = options.out
            ? { outDir: options.out }
            : project.config.reports?.outDir
              ? { defaultOutDir: project.config.reports.outDir }
              : {};

          await emitReport(report, {
            ui,
            formats,
            ...outDirOption,
            json: options.json === true,
            suppressTerminal: true,
            renderTerminal: () =>
              renderTestReport(report, { color: false, verbose: options.verbose === true }),
            writeLatest: true,
          });

          if (!options.json) {
            ui.line();
            ui.line(
              ui.palette.gray(
                `Total duration ${formatDuration(performance.now() - started)} · ${report.totals.total} test(s)`,
              ),
            );
          }

          if (bailed) {
            ui.warn('Stopped after the first failure (--bail).');
            process.exitCode = EXIT_CHECKS_FAILED;
          } else if (cancellation.interrupted) {
            process.exitCode = EXIT_INTERRUPTED;
          } else {
            process.exitCode = report.passed ? EXIT_SUCCESS : EXIT_CHECKS_FAILED;
          }
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
