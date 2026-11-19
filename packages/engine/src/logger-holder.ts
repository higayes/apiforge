/**
 * Module-level logger access point.
 *
 * The engine takes a logger through options wherever it matters for
 * testability; this holder provides a safe default for internal debug output
 * without creating an import cycle.
 */
import type { Logger } from './util/logger.js';
import { createLogger } from './util/logger.js';

export let logger: Logger = createLogger({ level: 'silent' });

export function setLogger(next: Logger): void {
  logger = next;
}
