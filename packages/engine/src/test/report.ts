/**
 * Assembles `TestReport` objects from one or more suite runs.
 */
import type { SuiteRun, TestReport, ThresholdResult, ToolInfo } from '../types.js';

export interface BuildTestReportOptions {
  title: string;
  suites: SuiteRun[];
  tool: ToolInfo;
  environment?: string;
  /** Project-level thresholds applied across all suites. */
  projectThresholds?: ThresholdResult[];
}

export function buildTestReport(options: BuildTestReportOptions): TestReport {
  const suites = options.suites;
  const totals = suites.reduce(
    (acc, suite) => ({
      total: acc.total + suite.totals.total,
      passed: acc.passed + suite.totals.passed,
      failed: acc.failed + suite.totals.failed,
      skipped: acc.skipped + suite.totals.skipped,
      errored: acc.errored + suite.totals.errored,
      durationMs: acc.durationMs + suite.durationMs,
    }),
    { total: 0, passed: 0, failed: 0, skipped: 0, errored: 0, durationMs: 0 },
  );

  const thresholds = [
    ...suites.flatMap((suite) => suite.thresholds),
    ...(options.projectThresholds ?? []),
  ];

  return {
    kind: 'test',
    title: options.title,
    generatedAt: new Date().toISOString(),
    tool: options.tool,
    ...(options.environment ? { environment: options.environment } : {}),
    suites,
    totals,
    thresholds,
    passed:
      totals.failed === 0 &&
      totals.errored === 0 &&
      thresholds.every((threshold) => threshold.passed) &&
      suites.every((suite) => suite.passed),
  };
}
