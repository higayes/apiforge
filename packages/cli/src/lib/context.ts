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

export function createUiFromCommand(options: CommonUiOptions = {}): Ui {
  return new Ui({
    ...(options.color !== undefined ? { color: options.color } : {}),
    json: options.json === true,
    quiet: options.quiet === true,
    verbose: options.verbose === true,
  });
}
