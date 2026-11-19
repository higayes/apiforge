import type { Command } from 'commander';
import { loadEnvironments, loadSuitesFromFiles, readTextFile, parseDocument, ConfigError } from '@apiforge/engine';
import { dirname, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { EXIT_CONFIG, EXIT_SUCCESS } from '../exit-codes.js';
import { createUiFromCommand } from '../lib/context.js';
import { detectProject } from '../lib/project.js';
import { collectSuiteFilesForValidation } from '../lib/files.js';

interface ValidateCommandOptions {
  json?: boolean;
  color?: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

export interface ValidationSummary {
  files: Array<{ file: string; ok: boolean; tests?: number; error?: string }>;
  environments: Array<{ name: string; file: string; ok: boolean; error?: string }>;
  ok: boolean;
}

/**
 * `apiforge validate` parses and schema-checks suites and environments without
 * sending any network traffic. Designed for editors and pre-commit hooks.
 */
export function registerValidateCommand(program: Command): void {
  program
    .command('validate [paths...]')
    .description('Validate suite and environment files without making any network requests')
    .option('--json', 'emit a machine-readable summary')
    .option('-q, --quiet', 'only print the final result')
    .option('-v, --verbose', 'list every validated file')
    .option('--no-color', 'disable coloured output')
    .action(async (paths: string[], options: ValidateCommandOptions) => {
      const ui = createUiFromCommand(options);
      const summary: ValidationSummary = { files: [], environments: [], ok: true };

      const targets = paths.length > 0 ? paths.map((path) => resolve(path)) : [process.cwd()];
      const suiteFiles: string[] = [];
      for (const target of targets) {
        const info = await stat(target).catch(() => undefined);
        if (!info) {
          summary.files.push({ file: target, ok: false, error: 'file not found' });
          continue;
        }
        if (info.isDirectory()) {
          const project = await detectProject(target);
          const root = project?.root ?? target;
          suiteFiles.push(...(await collectSuiteFilesForValidation(root)));
        } else {
          suiteFiles.push(target);
        }
      }

      if (suiteFiles.length === 0) {
        ui.warn('No suite files found to validate.');
      }

      for (const file of suiteFiles) {
        try {
          const loaded = await loadSuitesFromFiles([file], dirname(file));
          summary.files.push({ file, ok: true, tests: loaded[0]?.suite.tests.length ?? 0 });
        } catch (error) {
          summary.ok = false;
          summary.files.push({ file, ok: false, error: (error as Error).message });
        }
      }

      // Environments are validated by attempting to load them through the same
      // code path the runner uses.
      const project = await detectProject(process.cwd());
      if (project) {
        try {
          const environments = await loadEnvironments(project.root, {});
          for (const [name, entry] of environments) {
            summary.environments.push({ name, file: entry.file, ok: true });
          }
          if (environments.size === 0) {
            summary.environments.push({ name: '(none)', file: '—', ok: true });
          }
        } catch (error) {
          summary.ok = false;
          summary.environments.push({ name: '?', file: '—', ok: false, error: (error as Error).message });
        }
      }

      // Additional ad-hoc YAML/JSON files (e.g. apiforge.yaml) are parsed to
      // catch syntax errors early.
      for (const target of targets) {
        const info = await stat(target).catch(() => undefined);
        if (info?.isFile() && !suiteFiles.includes(target)) {
          try {
            parseDocument(await readTextFile(target, 'input file'), target);
            summary.files.push({ file: target, ok: true });
          } catch (error) {
            summary.ok = false;
            summary.files.push({ file: target, ok: false, error: (error as Error).message });
          }
        }
      }

      if (options.json) {
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      } else {
        for (const file of summary.files) {
          if (file.ok) {
            ui.line(
              `${ui.palette.green('✔')} ${file.file}${file.tests !== undefined ? ui.palette.gray(` (${file.tests} tests)`) : ''}`,
            );
          } else {
            ui.line(`${ui.palette.red('✖')} ${file.file}`);
            ui.line(ui.palette.gray(`  ${file.error}`));
          }
        }
        for (const environment of summary.environments) {
          if (environment.name === '(none)') continue;
          if (environment.ok) ui.line(`${ui.palette.green('✔')} environment: ${environment.name} ${ui.palette.gray(environment.file)}`);
          else ui.line(`${ui.palette.red('✖')} environment ${environment.name}: ${environment.error}`);
        }
        if (summary.ok) ui.success('All files are valid.');
        else ui.fail('Validation failed.');
      }

      process.exitCode = summary.ok ? EXIT_SUCCESS : EXIT_CONFIG;
    });
}

/** Re-exported for tests. */
export function assertValidSummary(summary: ValidationSummary): void {
  if (!summary.ok) throw new ConfigError('Validation failed');
}
