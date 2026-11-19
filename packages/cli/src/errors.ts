/**
 * CLI error handling: maps engine errors to documented exit codes and prints
 * actionable diagnostics, including hints for the most common mistakes.
 */
import {
  ApiForgeError,
  ConfigError,
  ReportError,
  RequestError,
  UsageError,
  ValidationError,
  describeUnknownError,
} from '@apiforge/engine';
import { EXIT_CONFIG, EXIT_INTERRUPTED, EXIT_NETWORK, EXIT_USAGE } from './exit-codes.js';
import type { Ui } from './ui.js';

export function exitCodeForError(error: unknown): number {
  if (error instanceof UsageError) return EXIT_USAGE;
  if (error instanceof ValidationError || error instanceof ConfigError || error instanceof ReportError) return EXIT_CONFIG;
  if (error instanceof RequestError) {
    return error.kind === 'cancelled' ? EXIT_INTERRUPTED : EXIT_NETWORK;
  }
  if (error instanceof ApiForgeError) return error.code === 'CANCELLED' ? EXIT_INTERRUPTED : EXIT_CONFIG;
  return 1;
}

function hintsFor(error: unknown): string[] {
  const hints: string[] = [];
  if (error instanceof ConfigError) {
    if (/not found/i.test(error.message) && /suite/i.test(error.message)) {
      hints.push('Run `apiforge init` to create a starter project, or pass the suite path explicitly.');
    }
  }
  if (error instanceof RequestError) {
    if (error.kind === 'network') {
      hints.push('Check the target URL, your network connection, and any proxy configuration.');
      hints.push('For self-signed certificates during local development, pass `--insecure` (never in production).');
    }
    if (error.kind === 'timeout') {
      hints.push('Increase the timeout with `--timeout <ms>` or the `timeoutMs` suite option.');
    }
  }
  if (error instanceof UsageError && error.message.includes('unknown') ) {
    hints.push('Run `apiforge --help` or `apiforge <command> --help` to see supported options.');
  }
  return hints;
}

/** Render an error for humans (or machine-readable JSON) and return free-form text. */
export function formatCliError(error: unknown, ui: Ui, options: { json?: boolean; debug?: boolean } = {}): string {
  const code = exitCodeForError(error);
  const isKnown = error instanceof ApiForgeError;
  const message = isKnown ? error.message : describeUnknownError(error);
  const details = isKnown ? error.details : [];
  const hints = hintsFor(error);

  if (options.json) {
    return JSON.stringify(
      {
        ok: false,
        error: {
          message,
          code: isKnown ? error.code : 'INTERNAL',
          exitCode: code,
          ...(details.length > 0 ? { details } : {}),
          ...(hints.length > 0 ? { hints } : {}),
        },
      },
      null,
      2,
    );
  }

  const lines: string[] = [];
  lines.push(`${ui.palette.red(ui.palette.bold('✖ Error:'))} ${message}`);
  for (const detail of details) lines.push(ui.palette.gray(`  • ${detail}`));
  for (const hint of hints) lines.push(`${ui.palette.cyan('→')} ${hint}`);
  if (options.debug && error instanceof Error && error.cause) {
    lines.push(ui.palette.gray(`  cause: ${describeUnknownError(error.cause)}`));
  }
  if (options.debug && error instanceof Error && error.stack) {
    lines.push(ui.palette.gray(error.stack.split('\n').slice(1, 6).map((line) => `  ${line.trim()}`).join('\n')));
  }
  return lines.join('\n');
}

export { formatCliError as formatError };
