/**
 * JUnit XML reporter (consumable by GitHub Actions, GitLab, Jenkins, Azure
 * DevOps and most CI test-summary tools).
 *
 * Mapping:
 *  - each suite file becomes a <testsuite>,
 *  - each test case becomes a <testcase>,
 *  - failed assertions become <failure> elements (one per test case, with all
 *    failing assertions in the message), request errors become <error>,
 *  - skipped tests become <skipped>.
 */
import type { TestReport, TestCaseResult } from '../types.js';
import { stripAnsi } from '../util/text.js';

function escapeXml(text: string): string {
  // Strip characters that are not legal in XML 1.0 documents.
  const cleaned = stripAnsi(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return cleaned
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function failureDetail(result: TestCaseResult): string {
  const failing = result.assertions.filter((assertion) => !assertion.passed);
  const lines = failing.map((assertion) => {
    const head = `Assertion failed: ${assertion.expression}`;
    const detail = assertion.message ? `\n  ${assertion.message.split('\n').join('\n  ')}` : '';
    return `${head}${detail}`;
  });
  if (result.response) {
    lines.push(`Response: HTTP ${result.response.status} ${result.response.statusText}`);
  }
  return lines.join('\n\n');
}

function testCaseXml(result: TestCaseResult, className: string): string {
  const name = escapeXml(result.name);
  const time = (result.durationMs / 1000).toFixed(4);
  const classAttr = escapeXml(className);
  const openTag = `    <testcase name="${name}" classname="${classAttr}" time="${time}"`;

  if (result.status === 'skipped') {
    return `${openTag}>\n      <skipped message="${escapeXml(result.skipReason ?? 'skipped')}"/>\n    </testcase>`;
  }
  if (result.status === 'error') {
    return `${openTag}>\n      <error message="${escapeXml(result.error ?? 'Request error')}" type="RequestError"/>${
      result.response ? `\n      <system-out>${escapeXml(result.response.bodyPreview)}</system-out>` : ''
    }\n    </testcase>`;
  }
  if (result.status === 'failed') {
    const failing = result.assertions.filter((assertion) => !assertion.passed);
    const message = failing.map((assertion) => assertion.expression).join('; ') || 'Assertion failed';
    const body = escapeXml(failureDetail(result));
    return `${openTag}>\n      <failure message="${escapeXml(message)}" type="AssertionError">${body}</failure>\n    </testcase>`;
  }
  return `${openTag}/>`;
}

export function renderJUnit(report: TestReport): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const failures = report.totals.failed;
  const errors = report.totals.errored;
  const skipped = report.totals.skipped;
  const time = (report.totals.durationMs / 1000).toFixed(4);

  lines.push(
    `<testsuites name="${escapeXml(report.title)}" tests="${report.totals.total}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time}">`,
  );

  for (const suite of report.suites) {
    lines.push(
      `  <testsuite name="${escapeXml(suite.suite)}" tests="${suite.totals.total}" failures="${suite.totals.failed}" errors="${suite.totals.errored}" skipped="${suite.totals.skipped}" time="${(suite.durationMs / 1000).toFixed(4)}">`,
    );
    if (suite.description) lines.push(`    <properties><property name="description" value="${escapeXml(suite.description)}"/></properties>`);
    for (const result of suite.results) lines.push(testCaseXml(result, suite.suite));
    lines.push('  </testsuite>');
  }

  lines.push('</testsuites>');
  return `${lines.join('\n')}\n`;
}

export { escapeXml };
