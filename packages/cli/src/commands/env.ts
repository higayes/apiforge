import type { Command as CommandType } from 'commander';
import {
  loadEnvironments,
  parseDocument,
  parseEnvironmentDocument,
  maskSecretPreservingShape,
  ConfigError,
} from '@apiforge/engine';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EXIT_CONFIG, EXIT_SUCCESS } from '../exit-codes.js';
import { createUiFromCommand } from '../lib/context.js';
import { detectProject, renderEnvironmentTemplate } from '../lib/project.js';

interface EnvCommandOptions {
  json?: boolean;
  force?: boolean;
  color?: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

/**
 * `apiforge env` lists and inspects environments. Secrets are always masked.
 *
 * Note on `--no-color`: Commander applies a *negated default* for a boolean
 * `--no-*` option on any command that declares it, so declaring it on both the
 * `env` namespace and its subcommands makes the child's default override an
 * explicit `--no-color`. We therefore declare it once per leaf command and read
 * `argv` (see `createUiFromCommand`) instead of relying on parent options.
 */
export function registerEnvCommand(program: CommandType): void {
  const env = program
    .command('env')
    .description('List, create and inspect environments (secrets are always masked)');

  env
    .command('list')
    .description('List configured environments (default when no subcommand is given)')
    .option('--json', 'emit machine-readable output')
    .option('-q, --quiet', 'only print the final result')
    .option('--no-color', 'disable coloured output')
    .action(async (options: EnvCommandOptions) => {
      const ui = createUiFromCommand(options);
      const project = await detectProject(process.cwd());
      if (!project) {
        throw new ConfigError('No APIFORGE project found in this directory or its parents', [
          'Run `apiforge init` to create one.',
        ]);
      }
      const environments = await loadEnvironments(project.root, {});

      if (options.json) {
        const payload = [...environments.values()].map((entry) => ({
          name: entry.name,
          file: entry.file,
          baseUrl: entry.environment.baseUrl ?? null,
          variables: Object.keys(entry.environment.variables ?? {}),
          secrets: Object.keys(entry.environment.secrets ?? {}),
        }));
        process.stdout.write(`${JSON.stringify({ ok: true, environments: payload }, null, 2)}\n`);
        process.exitCode = EXIT_SUCCESS;
        return;
      }

      if (environments.size === 0) {
        ui.warn('No environments found. Create environments/<name>.yaml.');
        process.exitCode = EXIT_SUCCESS;
        return;
      }

      ui.section('Environments');
      for (const entry of environments.values()) {
        ui.line(
          `  ${ui.palette.cyan(entry.name)} ${ui.palette.gray(
            `· baseUrl: ${entry.environment.baseUrl ?? '(inherited)'} · ${Object.keys(entry.environment.variables ?? {}).length} variable(s) · ${Object.keys(entry.environment.secrets ?? {}).length} secret(s)`,
          )}`,
        );
      }
      process.exitCode = EXIT_SUCCESS;
    });

  env
    .command('show <name>')
    .description('Show an environment with secret values masked')
    .option('--json', 'emit machine-readable output')
    .option('-q, --quiet', 'only print the final result')
    .option('--no-color', 'disable coloured output')
    .action(async (name: string, options: EnvCommandOptions) => {
      const ui = createUiFromCommand(options);
      const project = await detectProject(process.cwd());
      if (!project)
        throw new ConfigError('No APIFORGE project found in this directory or its parents');

      const environments = await loadEnvironments(project.root, {});
      const entry = environments.get(name);
      if (!entry) {
        const available = [...environments.keys()];
        process.stderr.write(`Environment "${name}" not found.`);
        if (available.length > 0) process.stderr.write(` Available: ${available.join(', ')}`);
        process.stderr.write('\n');
        process.exitCode = EXIT_CONFIG;
        return;
      }

      const maskedSecrets: Record<string, string> = {};
      for (const [key, value] of Object.entries(entry.environment.secrets ?? {})) {
        maskedSecrets[key] = maskSecretPreservingShape(String(value));
      }

      if (options.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              ok: true,
              name: entry.name,
              file: entry.file,
              baseUrl: entry.environment.baseUrl ?? null,
              variables: entry.environment.variables ?? {},
              secrets: maskedSecrets,
            },
            null,
            2,
          )}\n`,
        );
        process.exitCode = EXIT_SUCCESS;
        return;
      }

      ui.section(`Environment: ${entry.name}`);
      ui.line(`  ${ui.palette.gray('file')}      ${entry.file}`);
      ui.line(
        `  ${ui.palette.gray('baseUrl')}   ${entry.environment.baseUrl ?? '(inherited from suites)'}`,
      );
      const variables = entry.environment.variables ?? {};
      if (Object.keys(variables).length > 0) {
        ui.line(`  ${ui.palette.gray('variables')}`);
        for (const [key, value] of Object.entries(variables)) {
          ui.line(`    ${key} = ${JSON.stringify(value)}`);
        }
      }
      if (Object.keys(maskedSecrets).length > 0) {
        ui.line(`  ${ui.palette.gray('secrets (masked)')}`);
        for (const [key, value] of Object.entries(maskedSecrets)) {
          ui.line(`    ${key} = ${value}`);
        }
      }
      process.exitCode = EXIT_SUCCESS;
    });

  env
    .command('new <name>')
    .description('Create environments/<name>.yaml from the starter template')
    .option('-f, --force', 'overwrite the file if it already exists')
    .option('--json', 'emit machine-readable output')
    .option('-q, --quiet', 'only print the final result')
    .option('--no-color', 'disable coloured output')
    .action(async (name: string, options: EnvCommandOptions) => {
      const ui = createUiFromCommand(options);
      // Validates the name (exit 2) before touching the filesystem.
      const content = renderEnvironmentTemplate(name);
      const project = await detectProject(process.cwd());
      if (!project) {
        throw new ConfigError('No APIFORGE project found in this directory or its parents', [
          'Run `apiforge init` to create one.',
        ]);
      }
      const directory = join(project.root, 'environments');
      const relative = `environments/${name}.yaml`;
      await mkdir(directory, { recursive: true });
      try {
        // 'wx' fails atomically if the file exists, unless --force is given.
        await writeFile(join(directory, `${name}.yaml`), content, {
          encoding: 'utf8',
          flag: options.force ? 'w' : 'wx',
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new ConfigError(`Environment file already exists: ${relative}`, [
            'Pass --force to overwrite it.',
          ]);
        }
        throw error;
      }

      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, name, file: relative }, null, 2)}\n`);
      } else {
        ui.success(`Created ${relative}`);
      }
      process.exitCode = EXIT_SUCCESS;
    });

  env
    .command('validate <file>')
    .description('Validate an environment file')
    .option('--json', 'emit machine-readable output')
    .option('-q, --quiet', 'only print the final result')
    .option('--no-color', 'disable coloured output')
    .action(async (file: string, options: EnvCommandOptions) => {
      const ui = createUiFromCommand(options);
      const absolute = resolve(file);
      let content: string;
      try {
        content = await readFile(absolute, 'utf8');
      } catch (error) {
        throw new ConfigError(`Could not read environment file: ${file}`, [
          String((error as Error).message),
        ]);
      }
      const environment = parseEnvironmentDocument(parseDocument(content, file), file);
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ ok: true, file, baseUrl: environment.baseUrl ?? null }, null, 2)}\n`,
        );
      } else {
        ui.success(`Environment file is valid: ${file}`);
      }
      process.exitCode = EXIT_SUCCESS;
    });

  // `apiforge env` (no subcommand) behaves like `apiforge env list`. Options are
  // tolerated (and forwarded) via pass-through so they are never registered on
  // the namespace, which would cancel child flags.
  env
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(() => {
      const known = new Set(['--json', '--no-color', '-q', '--quiet']);
      const forwarded = process.argv.filter((argument) => known.has(argument));
      env.commands
        .find((command) => command.name() === 'list')
        ?.parse(['node', 'apiforge-env-list', ...forwarded], {
          from: 'node',
        });
    });
}
