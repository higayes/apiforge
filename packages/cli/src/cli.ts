/**
 * APIFORGE CLI entry point.
 *
 * Responsibilities kept deliberately small: build the Commander program,
 * register commands, and translate errors into documented exit codes.
 * All business logic lives in `@apiforge/engine` so a future web dashboard can
 * reuse it.
 */
import { Command } from 'commander';
import { closeHttpResources, toApiForgeError, UsageError } from '@apiforge/engine';
import { CLI_VERSION } from './lib/version.js';
import { EXIT_CODE_DOCS, EXIT_USAGE } from './exit-codes.js';
import { formatCliError } from './errors.js';
import { createUiFromCommand } from './lib/context.js';
import { registerInitCommand } from './commands/init.js';
import { registerTestCommand } from './commands/test.js';
import { registerRunCommand } from './commands/run.js';
import { registerPerformanceCommand } from './commands/performance.js';
import { registerSecurityCommand } from './commands/security.js';
import { registerContractCommand } from './commands/contract.js';
import { registerReportCommand } from './commands/report.js';
import { registerImportCommand } from './commands/import.js';
import { registerValidateCommand } from './commands/validate.js';
import { registerEnvCommand } from './commands/env.js';
import { registerCompletionCommand, registerExitCodesCommand, registerVersionCommand } from './commands/meta.js';

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('apiforge')
    .description('APIFORGE — test smarter. Ship with confidence.\n\nAPI testing, validation, performance and security analysis.')
    .version(CLI_VERSION, '-V, --version', 'print the version and exit')
    .helpOption('-h, --help', 'display help for a command')
    .showHelpAfterError('(add --help for additional information)')
    .showSuggestionAfterError(true)
    .configureHelp({ sortSubcommands: false })
    .addHelpText(
      'after',
      `
${''}Examples:
  $ apiforge init                         Scaffold a project in the current directory
  $ apiforge test                         Run every suite in the project
  $ apiforge test api.suite.yaml -e dev   Run one suite against an environment
  $ apiforge run https://api.example.com/health
  $ apiforge performance https://api.example.com -d 10 -c 5
  $ apiforge security --url https://api.example.com --threshold medium
  $ apiforge contract https://api.example.com/users
  $ apiforge import openapi.yaml
  $ apiforge validate
  $ apiforge report reports/latest.json -f html

Exit codes: ${EXIT_CODE_DOCS.map((entry) => `${entry.code}=${entry.meaning.toLowerCase()}`).join(', ')}
Documentation: https://github.com/apiforge/apiforge
`,
    );

  registerInitCommand(program);
  registerTestCommand(program);
  registerRunCommand(program);
  registerPerformanceCommand(program);
  registerSecurityCommand(program);
  registerContractCommand(program);
  registerReportCommand(program);
  registerImportCommand(program);
  registerValidateCommand(program);
  registerEnvCommand(program);
  registerVersionCommand(program);
  registerExitCodesCommand(program);
  registerCompletionCommand(program);

  // Unknown commands should fail with a usage error, not a stack trace.
  program.on('command:*', (operands: string[]) => {
    const ui = createUiFromCommand({});
    const unknown = operands[0] ?? '';
    process.stderr.write(formatCliError(new UsageError(`Unknown command "${unknown}"`), ui));
    process.stderr.write('\n');
    process.exit(EXIT_USAGE);
  });

  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  const hasJsonFlag = argv.includes('--json');

  try {
    await program.parseAsync(argv);
  } catch (error) {
    const fatal = toApiForgeError(error);
    const ui = createUiFromCommand({ json: hasJsonFlag, color: argv.includes('--no-color') ? false : undefined });
    if (hasJsonFlag) {
      process.stdout.write(`${formatCliError(fatal, ui, { json: true })}\n`);
    } else {
      process.stderr.write(`${formatCliError(fatal, ui, { debug: argv.includes('--debug') })}\n`);
      if (fatal instanceof UsageError) process.stderr.write('\nRun `apiforge --help` for usage.\n');
    }
    const { exitCodeForError } = await import('./errors.js');
    process.exitCode = exitCodeForError(fatal);
  } finally {
    await closeHttpResources();
  }
}

// Execute only when invoked as a binary (not when imported by tests).
const invokedDirectly =
  process.argv[1] !== undefined && /(?:^|[\\/])cli(?:\.js|\.ts)?$/.test(process.argv[1].replace(/\.map$/, ''));

if (invokedDirectly) {
  void main();
}
