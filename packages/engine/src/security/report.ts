/**
 * Assembles a `SecurityReport` from the raw run result.
 */
import type { SecurityReport, ToolInfo } from '../types.js';
import type { SecurityRunResult } from './checks.js';

export interface BuildSecurityReportOptions {
  title: string;
  target: string;
  tool: ToolInfo;
  result: SecurityRunResult;
}

export function buildSecurityReport(options: BuildSecurityReportOptions): SecurityReport {
  return {
    kind: 'security',
    title: options.title,
    generatedAt: new Date().toISOString(),
    tool: options.tool,
    target: options.target,
    findings: options.result.findings,
    counts: options.result.counts,
    score: options.result.score,
    passed: options.result.passed,
    threshold: options.result.threshold,
    startedAt: options.result.startedAt,
    endedAt: options.result.endedAt,
  };
}
