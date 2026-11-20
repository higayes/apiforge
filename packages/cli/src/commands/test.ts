import type { Command } from 'commander';
import { dirname, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  buildTestReport,
  closeHttpResources,
  findProjectRoot,
  formatDuration,
  renderTestReport,
  runSuite,
  type EnvironmentDefinition,
  type ReportFormat,
  type SuiteRun,
  type TestCaseResult,
  toApiForgeError,
  UsageError,
} from '@apiforge/engine';
import {
  EXIT_CHECKS_FAILED,
  EXIT_CONFIG,
  EXIT_INTERRUPTED,
  EXIT_NETWORK,
  EXIT_SUCCESS,
} from '../exit-codes.js';
import { createFileWatcher, type FileWatcher, type WatchFn } from '../lib/watch.js';
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
  watch?: boolean;
}

/**
 * Test seam: lets tests replace the OS file watcher. Not part of the CLI
 * surface; production code always uses `node:fs.watch`.
 */
export interface TestCommandHooks {
  watch?: WatchFn;
  debounceMs?: number;
}

export function registerTestCommand(program: Command, hooks: TestCommandHooks = {}): void {
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
    .option('-w, --watch', 're-run when a suite, environment or data file changes')
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
        if (options.watch === true && options.json === true) {
          throw new UsageError('--watch cannot be combined with --json', [
            'Watch mode re-runs continuously, so stdout cannot be a single JSON document.',
            'Drop --json, or write reports with --reporter json to a directory instead.',
          ]);
        }

        let watcher: FileWatcher | undefined;
        let running = false;
        const cancellation = installCancellation({
          onFirstInterrupt: () => {
            ui.stopSpinner();
            if (options.watch === true) {
              // Idle: nothing to cancel, leave quietly. Running: abort the run.
              watcher?.close();
              if (running) ui.warn('Cancelling…');
              return;
            }
            ui.warn('Cancelling… press Ctrl+C again to exit immediately.');
          },
        });

        // Directories a run writes into; the watcher must not react to them.
        const ignoredDirectories: string[] = [resolve(options.out ?? 'reports')];

        // One full run. Sets `process.exitCode`; throws on configuration errors.
        const executeOnce = async (): Promise<void> => {
          const project = await openProject(process.cwd(), paths);
          if (project.config.reports?.outDir) {
            ignoredDirectories.push(resolve(project.config.reports.outDir));
          }
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
          } else if (report.passed) {
            process.exitCode = EXIT_SUCCESS;
          } else {
            // Mirrors `apiforge run`: when the target could not be reached at all,
            // that is a network failure (4) which CI can retry, not a failed
            // assertion (1). A single real assertion failure keeps exit 1.
            const allResults = report.suites.flatMap((entry) => entry.results);
            const onlyNetworkErrors =
              report.totals.failed === 0 &&
              report.totals.errored > 0 &&
              allResults.every(
                (result) =>
                  result.status !== 'error' ||
                  /network error|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|getaddrinfo/i.test(
                    result.error ?? '',
                  ),
              );
            process.exitCode = onlyNetworkErrors ? EXIT_NETWORK : EXIT_CHECKS_FAILED;
          }
        };

        try {
          if (options.watch !== true) {
            await executeOnce();
          } else {
            const root = (await findProjectRoot(process.cwd())) ?? process.cwd();
            const envFileDirectory = options.envFile
              ? dirname(resolve(options.envFile))
              : undefined;
            const outsideRoot =
              envFileDirectory !== undefined && relative(root, envFileDirectory).startsWith('..');
            watcher = createFileWatcher({
              root,
              ignore: ignoredDirectories,
              ...(outsideRoot && envFileDirectory ? { extraDirectories: [envFileDirectory] } : {}),
              ...(hooks.watch ? { watch: hooks.watch } : {}),
              ...(hooks.debounceMs !== undefined ? { debounceMs: hooks.debounceMs } : {}),
            });

            let changed: string[] | undefined = [];
            while (changed !== undefined && !cancellation.interrupted) {
              if (changed.length > 0) {
                // Clear a real terminal; otherwise (pipes, CI logs) delimit the run.
                if (process.stdout.isTTY === true)
                  process.stdout.write('\u001B[2J\u001B[3J\u001B[H');
                else ui.line(`\n──── Re-running: ${changed.join(', ')} ────`);
              }
              running = true;
              try {
                await executeOnce();
              } catch (error) {
                // A broken suite must not end the session: show it and keep waiting.
                if (cancellation.interrupted) break;
                ui.stopSpinner();
                ui.error(formatCliError(toApiForgeError(error), ui, {}));
                process.exitCode = EXIT_CONFIG;
              } finally {
                running = false;
              }
              if (cancellation.interrupted) break;
              ui.line();
              ui.line(ui.palette.gray('Watching for changes… press Ctrl+C to exit.'));
              changed = await watcher.next();
            }
            watcher.close();
            process.exitCode = EXIT_INTERRUPTED;
          }
        } finally {
          watcher?.close();
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
