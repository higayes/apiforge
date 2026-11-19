/**
 * Documented exit codes. CI pipelines can branch on these; they are part of
 * the public CLI contract and covered by tests.
 */
export const EXIT_SUCCESS = 0;
export const EXIT_CHECKS_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_CONFIG = 3;
export const EXIT_NETWORK = 4;
export const EXIT_INTERRUPTED = 130;

export const EXIT_CODE_DOCS: ReadonlyArray<{ code: number; meaning: string }> = [
  { code: EXIT_SUCCESS, meaning: 'All checks passed' },
  {
    code: EXIT_CHECKS_FAILED,
    meaning: 'Tests, thresholds, performance, security or contract checks failed',
  },
  { code: EXIT_USAGE, meaning: 'Invalid command-line usage' },
  { code: EXIT_CONFIG, meaning: 'Configuration, suite, environment or input-file error' },
  { code: EXIT_NETWORK, meaning: 'Unrecoverable network/setup failure (e.g. unreachable target)' },
  { code: EXIT_INTERRUPTED, meaning: 'Interrupted (Ctrl+C)' },
];
