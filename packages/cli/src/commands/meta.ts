import type { Command } from 'commander';
import { EXIT_CODE_DOCS, EXIT_SUCCESS } from '../exit-codes.js';
import { CLI_VERSION } from '../lib/version.js';
import { createUiFromCommand } from '../lib/context.js';

/**
 * Quote a value for safe use inside a single-quoted fish string.
 *
 * Fish honours exactly two escapes inside `'...'`: `\'` and `\\`. Everything
 * else, including `$` and backticks, is literal. Passing a raw description
 * through therefore breaks the script as soon as it ends with a backslash
 * (`'path C:\'` leaves the quote unbalanced) or contains `\` before a quote.
 *
 * Backslashes must be doubled *first*, otherwise `\'` from the apostrophe pass
 * would be re-escaped into `\\'`, which fish reads as an escaped backslash
 * followed by a closing quote. CodeQL js/incomplete-sanitization.
 */
export function escapeFishSingleQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Quote a value for safe use inside a single-quoted zsh string.
 *
 * The zsh completion previously interpolated `'${name}:${description}'` with no
 * escaping at all, so a description containing an apostrophe produced a broken
 * script. `'` cannot be escaped inside a single-quoted zsh word at all, so the
 * canonical form is to close the quote, emit an escaped quote, and reopen it:
 * `it's` becomes `'it'\''s'`.
 */
export function escapeZshSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote a value for safe use in a bash `compgen -W` word list.
 *
 * Command names are the only input, and they are plain identifiers, but quoting
 * them keeps the generated script robust if a future command ever adds a
 * character that bash would word-split.
 */
export function escapeBashWordList(values: string[]): string {
  return values.map((value) => `'${value.replace(/'/g, `'\\''`)}'`).join(' ');
}

/** `apiforge version` — same payload as `--version`, plus environment details. */
export function registerVersionCommand(program: Command): void {
  program
    .command('version')
    .description('Print version and environment information')
    .option('--json', 'emit machine-readable output')
    .option('--no-color', 'disable coloured output')
    .action((options: { json?: boolean; color?: boolean }) => {
      const info = {
        name: 'apiforge',
        version: CLI_VERSION,
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
      };
      if (options.json) {
        process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
      } else {
        const ui = createUiFromCommand(options);
        ui.line(`${info.name} ${ui.palette.bold(info.version)}`);
        ui.line(ui.palette.gray(`node ${info.node} · ${info.platform}`));
      }
      process.exitCode = EXIT_SUCCESS;
    });
}

/** `apiforge exit-codes` — documents the exit-code contract. */
export function registerExitCodesCommand(program: Command): void {
  program
    .command('exit-codes')
    .description('Document the exit codes returned by APIFORGE commands')
    .option('--json', 'emit machine-readable output')
    .option('--no-color', 'disable coloured output')
    .action((options: { json?: boolean; color?: boolean }) => {
      if (options.json) {
        process.stdout.write(`${JSON.stringify(EXIT_CODE_DOCS, null, 2)}\n`);
        process.exitCode = EXIT_SUCCESS;
        return;
      }
      const ui = createUiFromCommand(options);
      ui.section('Exit codes');
      for (const entry of EXIT_CODE_DOCS) {
        ui.line(`  ${String(entry.code).padStart(3)}  ${entry.meaning}`);
      }
      process.exitCode = EXIT_SUCCESS;
    });
}

/**
 * Shell completion is deliberately simple and portable: it prints the command
 * and option list so users can wire it into bash/zsh/fish themselves.
 */
export function registerCompletionCommand(program: Command): void {
  program
    .command('completion [shell]')
    .description('Print a completion script for bash, zsh or fish')
    .option('--no-color', 'disable coloured output (accepted for consistency)')
    .action((shell: string | undefined) => {
      const target = (shell ?? 'bash').toLowerCase();
      const names = program.commands.map((command) => command.name());
      if (target === 'bash') {
        // `compgen -W` takes a single word-list argument, so every entry is
        // quoted individually instead of relying on the names being bare words.
        const commands = escapeBashWordList(names);
        process.stdout.write(
          `_apiforge_completions() {\n  local cur=\${COMP_WORDS[COMP_CWORD]}\n  if [ "$COMP_CWORD" -eq 1 ]; then\n    COMPREPLY=( $(compgen -W "${commands}" -- "$cur") )\n  else\n    COMPREPLY=( $(compgen -f -- "$cur") )\n  fi\n}\ncomplete -F _apiforge_completions apiforge\n`,
        );
      } else if (target === 'zsh') {
        process.stdout.write(
          `#compdef apiforge\n_apiforge() {\n  local -a commands\n  commands=(${program.commands
            .map(
              (command) => `${escapeZshSingleQuoted(`${command.name()}:${command.description()}`)}`,
            )
            .join(' ')})\n  _describe 'command' commands\n}\n_apiforge "$@"\n`,
        );
      } else if (target === 'fish') {
        process.stdout.write(
          program.commands
            .map(
              (command) =>
                `complete -c apiforge -n '__fish_use_subcommand' -a ${command.name()} -d '${escapeFishSingleQuoted(command.description())}'`,
            )
            .join('\n') + '\n',
        );
      } else {
        process.stderr.write(`Unsupported shell "${target}". Supported: bash, zsh, fish\n`);
        process.exitCode = 2;
        return;
      }
      process.exitCode = EXIT_SUCCESS;
    });
}
