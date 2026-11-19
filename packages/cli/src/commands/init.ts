import type { Command } from 'commander';
import { EXIT_SUCCESS } from '../exit-codes.js';
import { runInit } from '../lib/project.js';
import { createUiFromCommand } from '../lib/context.js';

export function registerInitCommand(program: Command): void {
  program
    .command('init [directory]')
    .description('Create a starter APIFORGE project (config, environments and example suites)')
    .option('-f, --force', 'overwrite existing files')
    .option('--json', 'emit machine-readable output')
    .option('--no-color', 'disable coloured output')
    .action(
      async (
        directory: string | undefined,
        options: { force?: boolean; json?: boolean; color?: boolean },
      ) => {
        const ui = createUiFromCommand(options);
        const { created, skipped } = await runInit({
          ...(directory ? { directory } : {}),
          ...(options.force === true ? { force: true } : {}),
          ui,
        });

        if (options.json) {
          process.stdout.write(
            `${JSON.stringify({ ok: true, created, skipped, directory: directory ?? '.' }, null, 2)}\n`,
          );
          process.exitCode = EXIT_SUCCESS;
          return;
        }

        if (created.length === 0) {
          ui.warn('Nothing to create: every file already exists. Use --force to overwrite.');
        } else {
          ui.success(`Created ${created.length} file(s):`);
          for (const file of created) ui.line(`  ${ui.palette.green('+')} ${file}`);
        }
        if (skipped.length > 0) {
          ui.line();
          ui.warn(`Skipped ${skipped.length} existing file(s): ${skipped.join(', ')}`);
        }
        ui.line();
        ui.line(ui.palette.bold('Next steps'));
        ui.line('  1. Edit apiforge.yaml and environments/*.yaml for your API');
        ui.line('  2. Adjust or replace the example suites in suites/');
        ui.line(`  3. Run ${ui.palette.cyan('apiforge test')} to execute them`);
        ui.line(
          `  4. Run ${ui.palette.cyan('apiforge security --url <your-api>')} for a security review`,
        );
        process.exitCode = EXIT_SUCCESS;
      },
    );
}
