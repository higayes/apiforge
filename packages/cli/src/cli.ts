/**
 * APIFORGE CLI entry point.
 *
 * Responsibilities kept deliberately small: build the Commander program,
 * register commands, and translate errors into documented exit codes.
 * All business logic lives in `@apiforge/engine` so a future web dashboard can
 * reuse it.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { closeHttpResources, toApiForgeError, UsageError } from '@apiforge/engine';
import { CLI_VERSION } from './lib/version.js';
import { EXIT_CODE_DOCS } from './exit-codes.js';
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
import {
  registerCompletionCommand,
  registerExitCodesCommand,
  registerVersionCommand,
} from './commands/meta.js';

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('apiforge')
    .description(
      'APIFORGE — test smarter. Ship with confidence.\n\nAPI testing, validation, performance and security analysis.',
    )
    .version(CLI_VERSION, '-V, --version', 'print the version and exit')
    .helpOption('-h, --help', 'display help for a command')
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
Documentation: https://github.com/higayes/apiforge
`,
    );

  // IMPORTANT: configure this *before* the subcommands are created. Commander
  // copies inherited settings (including the exit callback) at instantiation
  // time, so doing it afterwards would leave every subcommand calling
  // `process.exit()` directly and bypassing our error rendering.
  program.exitOverride((error) => {
    if (
      error.code === 'commander.helpDisplayed' ||
      error.code === 'commander.version' ||
      error.code === 'commander.help'
    ) {
      return;
    }
    throw error;
  });
  program.configureOutput({
    writeErr: (text: string) => {
      // Commander's own `error: …` echo is suppressed: `main()` renders the
      // problem exactly once, in the documented format and exit code.
      if (text.startsWith('error:')) return;
      // The suggestion is emitted as its own chunk (`(Did you mean …?)` or
      // `(Did you mean one of …?)`), possibly with a leading newline. It is
      // already rendered as a hint bullet, so drop the duplicate.
      if (/^\(?\s*Did you mean\b/m.test(text)) return;
      process.stderr.write(text);
    },
  });

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

  return program;
}

/**
 * Convert Commander's own errors into `UsageError`s with helpful hints so they
 * follow the documented exit-code contract (2 for usage problems).
 */
function normalizeCommanderError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const code = (error as { code?: string }).code ?? '';
  if (
    code === 'commander.helpDisplayed' ||
    code === 'commander.version' ||
    code === 'commander.help'
  ) {
    return { __handled: true };
  }
  if (!code.startsWith('commander.')) return error;
  const raw = error.message;
  // Extract the suggestion before stripping it from the message.
  const suggestion = /Did you mean (?!one of)(\S+?)\?/i.exec(raw)?.[1]?.replace(/[?.]+$/, '');
  const message = raw
    .replace(/^error:\s*/i, '')
    .replace(/\s*\(add --help for additional information\)\s*$/i, '')
    .replace(/\n?\s*\(Did you mean [^)]*\)\s*$/i, '')
    // Normalise quoting so messages read consistently: Unknown command "x".
    .replace(
      /^(unknown (?:command|option|argument|excess arguments?)) ['"`]([^'"`]+)['"`]/i,
      '$1 "$2"',
    )
    .trim();
  // Messages follow "✖ Error: " — capitalise so they read as sentences.
  const sentence = message.charAt(0).toUpperCase() + message.slice(1);
  const hints: string[] = [];
  if (suggestion) hints.push(`Did you mean \`${suggestion}\`?`);
  const unknownCommand = /unknown command ["']?([^"'\s]+)/i.exec(message)?.[1];
  if (unknownCommand) hints.push('Run `apiforge --help` to see the available commands.');
  if (/unknown option/i.test(message))
    hints.push('Run `apiforge <command> --help` to see supported options.');
  if (/missing required argument/i.test(message))
    hints.push('Run `apiforge <command> --help` for the required arguments.');
  return new UsageError(sentence, hints);
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  const hasJsonFlag = argv.includes('--json');

  try {
    await program.parseAsync(argv);
  } catch (error) {
    const normalized = normalizeCommanderError(error);
    if (typeof normalized === 'object' && normalized !== null && '__handled' in normalized) return;
    const fatal = toApiForgeError(normalized);
    const ui = createUiFromCommand({
      json: hasJsonFlag,
      color: argv.includes('--no-color') ? false : undefined,
    });
    if (hasJsonFlag) {
      process.stdout.write(`${formatCliError(fatal, ui, { json: true })}\n`);
    } else {
      process.stderr.write(`${formatCliError(fatal, ui, { debug: argv.includes('--debug') })}\n`);
    }
    const { exitCodeForError } = await import('./errors.js');
    process.exitCode = exitCodeForError(fatal);
  } finally {
    await closeHttpResources();
  }
}

/**
 * Execute only when invoked as a binary, never when imported by tests.
 *
 * Comparing the realpaths is the only reliable test: package managers expose
 * the binary as a symlink (`node_modules/.bin/apiforge`), so the invoked path
 * is *not* `cli.js`. A filename check silently did nothing for every real
 * install while still exiting 0.
 */
function isInvokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  void main();
}
