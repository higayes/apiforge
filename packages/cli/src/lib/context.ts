/**
 * Builds the `Ui` instance from Commander options consistently for every
 * command (`--no-color`, `--json`, `--quiet`, `--verbose`).
 */
import { Ui } from '../ui.js';

export interface CommonUiOptions {
  color?: boolean;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

/**
 * Commander applies a *negated default* to `--no-*` flags: when a `--no-color`
 * option is declared without the user passing it, the parsed value is
 * `{ color: true }`, and a nested command can therefore report colour as
 * enabled even though the user asked for `--no-color`. Rather than depending on
 * where the flag was declared, honour it straight from `argv` — it is a global
 * concern and this keeps every command consistent.
 */
function argvDisablesColor(argv: readonly string[] = process.argv): boolean {
  return argv.includes('--no-color');
}

export function createUiFromCommand(options: CommonUiOptions = {}): Ui {
  // Only an explicit "no" is trusted. An affirmative value can be the negated
  // default described above, so we defer to TTY/env detection instead.
  const color = argvDisablesColor() || options.color === false ? false : undefined;
  return new Ui({
    ...(color !== undefined ? { color } : {}),
    json: options.json === true,
    quiet: options.quiet === true,
    verbose: options.verbose === true,
  });
}
