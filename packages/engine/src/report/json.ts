/**
 * JSON reporters. The JSON payload for tests is a superset of the common
 * "JUnit-ish" shape and mirrors the engine types exactly so dashboards can
 * consume it without translation.
 *
 * Secret-bearing headers and values are redacted before serialization.
 */
import type { ContractReport, PerformanceReport, SecurityReport, TestReport } from '../types.js';
import { redactHeaders, redactBodyText, REDACTED } from '../util/redaction.js';

function sanitizeNotification(report: TestReport): TestReport {
  return {
    ...report,
    suites: report.suites.map((suite) => ({
      ...suite,
      results: suite.results.map((result) => ({
        ...result,
        ...(result.response
          ? {
              response: {
                ...result.response,
                headers: redactHeaders(result.response.headers),
                bodyPreview: redactBodyText(result.response.bodyPreview),
              },
            }
          : {}),
      })),
    })),
  };
}

export function renderTestJson(report: TestReport): string {
  return `${JSON.stringify(sanitizeNotification(report), null, 2)}\n`;
}

function sanitizePerformance(report: PerformanceReport): PerformanceReport {
  return { ...report, target: { ...report.target, url: report.target.url } };
}

export function renderPerformanceJson(report: PerformanceReport): string {
  return `${JSON.stringify(sanitizePerformance(report), null, 2)}\n`;
}

function sanitizeSecurity(report: SecurityReport): SecurityReport {
  // SecurityReport carries no raw response payload; findings are already
  // evidence-based and secret-masked at detection time.
  return {
    ...report,
    findings: report.findings.map((finding) => ({
      ...finding,
      ...(finding.evidence ? { evidence: redactBodyText(finding.evidence) } : {}),
    })),
  };
}

export function renderSecurityJson(report: SecurityReport): string {
  return `${JSON.stringify(sanitizeSecurity(report), null, 2)}\n`;
}

export function renderContractJson(report: ContractReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export const REDACTION_MARKER = REDACTED;
