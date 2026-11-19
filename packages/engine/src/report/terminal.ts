/**
 * Terminal reporters: human-friendly, information-dense, colour-aware output
 * for test, performance, security and contract results.
 */
import type {
  ContractReport,
  PerformanceReport,
  SecurityFinding,
  SecurityReport,
  SuiteRun,
  TestCaseResult,
  TestReport,
  ThresholdResult,
} from '../types.js';
import { SEVERITY_ORDER } from '../types.js';
import { type Palette, createPalette, severityColor } from './color.js';
import { formatBytes, formatDuration, renderTable, truncate } from '../util/text.js';
import { unifiedDiff } from '../util/diff.js';

export interface TerminalRenderOptions {
  color?: boolean;
  verbose?: boolean;
  /** Include response bodies of passing tests. */
  showBodies?: boolean;
  /** Width used for wrapping long values. */
  width?: number;
}

function statusBadge(palette: Palette, status: TestCaseResult['status']): string {
  switch (status) {
    case 'passed':
      return palette.green('✓ PASS');
    case 'failed':
      return palette.red('✗ FAIL');
    case 'error':
      return palette.red('✗ ERROR');
    case 'skipped':
      return palette.yellow('○ SKIP');
    default:
      return status;
  }
}

function renderThresholds(palette: Palette, thresholds: ThresholdResult[]): string[] {
  if (thresholds.length === 0) return [];
  const lines = [palette.bold('Thresholds')];
  for (const threshold of thresholds) {
    const symbol = threshold.passed ? palette.green('✓') : palette.red('✗');
    const comparator = threshold.operator === 'min' ? '≥' : '≤';
    const actual = Number.isFinite(threshold.actual) ? String(threshold.actual) : 'n/a';
    lines.push(
      `  ${symbol} ${threshold.metric} ${comparator} ${threshold.limit} (actual ${actual}) ${palette.gray(`[${threshold.source}]`)}`,
    );
  }
  return lines;
}

function renderAssertions(
  palette: Palette,
  result: TestCaseResult,
  options: TerminalRenderOptions,
): string[] {
  const lines: string[] = [];
  const failing = result.assertions.filter((assertion) => !assertion.passed);
  const shown = options.verbose ? result.assertions : failing;

  for (const assertion of shown) {
    const icon = assertion.passed ? palette.green('✓') : palette.red('✗');
    lines.push(`    ${icon} ${assertion.expression}`);
    if (!assertion.passed) {
      if (assertion.expected !== undefined || assertion.actual !== undefined) {
        if (
          typeof assertion.expected === 'string' &&
          typeof assertion.actual === 'string' &&
          (assertion.expected.includes('\n') || assertion.actual.includes('\n'))
        ) {
          const diff = unifiedDiff(assertion.expected, assertion.actual, {
            labelA: 'expected',
            labelB: 'actual',
          });
          if (diff) lines.push(...diff.split('\n').map((line) => formatDiffLine(palette, line)));
        }
      }
      if (assertion.message) {
        for (const line of assertion.message.split('\n')) lines.push(palette.dim(`      ${line}`));
      }
      for (const child of assertion.children ?? []) {
        const childIcon = child.passed ? palette.green('✓') : palette.red('✗');
        lines.push(`      ${childIcon} ${child.expression}`);
        if (child.message) lines.push(palette.dim(`        ${child.message}`));
      }
    }
  }
  if (!options.verbose && result.assertions.length > failing.length && failing.length > 0) {
    lines.push(
      palette.dim(`    … ${result.assertions.length - failing.length} more assertion(s) passed`),
    );
  }
  return lines;
}

function formatDiffLine(palette: Palette, line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return palette.gray(`      ${line}`);
  if (line.startsWith('+')) return palette.green(`      ${line}`);
  if (line.startsWith('-')) return palette.red(`      ${line}`);
  return palette.dim(`      ${line}`);
}

function renderTestResult(
  palette: Palette,
  result: TestCaseResult,
  options: TerminalRenderOptions,
): string[] {
  const lines: string[] = [];
  const duration = palette.gray(`(${formatDuration(result.durationMs)})`);
  const rowSuffix =
    result.dataRow !== undefined ? palette.gray(` [data row ${result.dataRow + 1}]`) : '';
  const idSuffix = result.id ? palette.gray(` [${result.id}]`) : '';
  lines.push(
    `  ${statusBadge(palette, result.status)} ${result.name}${idSuffix}${rowSuffix} ${duration}`,
  );

  if (result.status === 'skipped') {
    lines.push(palette.yellow(`      ${result.skipReason ?? 'skipped'}`));
    return lines;
  }

  if (result.error) {
    for (const line of result.error.split('\n')) lines.push(palette.red(`      ${line}`));
  }

  if (result.response) {
    const { response } = result;
    const summary = `${result.request.method} ${truncate(result.request.url, Math.max(40, (options.width ?? 100) - 40))} → ${response.status} ${response.statusText} · ${formatBytes(response.sizeBytes)}`;
    lines.push(palette.gray(`      ${summary}`));
    if (response.redirects.length > 0) {
      lines.push(
        palette.gray(
          `      redirects: ${response.redirects.map((hop) => `${hop.status} → ${hop.location}`).join(' → ')}`,
        ),
      );
    }
    if (response.bodyTruncated) lines.push(palette.gray('      body preview truncated'));
    if (options.showBodies && response.bodyPreview) {
      for (const line of response.bodyPreview.split('\n').slice(0, 40))
        lines.push(palette.dim(`      │ ${line}`));
    }
  }

  if (result.assertions.length > 0) lines.push(...renderAssertions(palette, result, options));
  return lines;
}

export function renderSuite(
  palette: Palette,
  suite: SuiteRun,
  options: TerminalRenderOptions = {},
): string {
  const lines: string[] = [];
  const heading = palette.bold(palette.cyan(`▸ ${suite.suite}`));
  const meta = palette.gray(
    `${suite.totals.total} tests · ${suite.totals.passed} passed · ${suite.totals.failed} failed${
      suite.totals.errored ? ` · ${suite.totals.errored} errors` : ''
    }${suite.totals.skipped ? ` · ${suite.totals.skipped} skipped` : ''} · ${formatDuration(suite.durationMs)}${
      suite.file ? ` · ${suite.file}` : ''
    }`,
  );
  lines.push('', heading, meta);
  if (suite.description) lines.push(palette.dim(suite.description));

  const failing = suite.results.filter(
    (result) => result.status !== 'passed' && result.status !== 'skipped',
  );
  const passing = suite.results.filter((result) => result.status === 'passed');
  for (const result of failing) lines.push(...renderTestResult(palette, result, options));
  if (options.verbose) {
    for (const result of passing) lines.push(...renderTestResult(palette, result, options));
  } else if (passing.length > 0) {
    lines.push(
      palette.gray(
        `  ✓ ${passing.length} test(s) passed${failing.length > 0 ? ' (use --verbose to list them)' : ''}`,
      ),
    );
    for (const result of passing) {
      const duration = palette.gray(`(${formatDuration(result.durationMs)})`);
      lines.push(
        `  ${palette.green('✓')} ${result.name}${result.id ? palette.gray(` [${result.id}]`) : ''} ${duration}`,
      );
    }
  }
  const skipped = suite.results.filter((result) => result.status === 'skipped');
  if (options.verbose) {
    for (const result of skipped) lines.push(...renderTestResult(palette, result, options));
  }

  const thresholdLines = renderThresholds(palette, suite.thresholds);
  if (thresholdLines.length > 0) lines.push('', ...thresholdLines.map((line) => `  ${line}`));
  return lines.join('\n');
}

export function renderTestReport(report: TestReport, options: TerminalRenderOptions = {}): string {
  const palette = createPalette(options.color ?? true);
  const lines: string[] = [];
  for (const suite of report.suites) lines.push(renderSuite(palette, suite, options));

  const totals = report.totals;
  const parts: string[] = [
    `${totals.total} total`,
    palette.green(`${totals.passed} passed`),
    totals.failed > 0 ? palette.red(`${totals.failed} failed`) : '0 failed',
    totals.errored > 0 ? palette.red(`${totals.errored} errors`) : '0 errors',
    `${totals.skipped} skipped`,
    formatDuration(totals.durationMs),
  ];
  lines.push('', palette.bold('Summary'), `  ${parts.join(' · ')}`);
  const thresholdLines = renderThresholds(palette, report.thresholds);
  if (thresholdLines.length > 0) lines.push('', ...thresholdLines.map((line) => `  ${line}`));
  lines.push(
    '',
    report.passed
      ? palette.green(palette.bold('✔ All checks passed'))
      : palette.red(palette.bold('✖ Some checks failed')),
  );
  return lines.join('\n');
}

export function renderPerformanceReport(
  report: PerformanceReport,
  options: TerminalRenderOptions = {},
): string {
  const palette = createPalette(options.color ?? true);
  const { stats } = report;
  const lines: string[] = [];
  lines.push(
    '',
    palette.bold(palette.cyan('▸ Performance results')),
    palette.gray(`${report.target.method} ${report.target.url}`),
  );
  lines.push(
    palette.gray(
      `concurrency ${report.config.concurrency} · ${
        report.config.durationSeconds
          ? `${report.config.durationSeconds}s`
          : `${report.config.maxRequests ?? 0} requests`
      } · timeout ${report.config.timeoutMs}ms${report.config.thinkTimeMs ? ` · think time ${report.config.thinkTimeMs}ms` : ''}`,
    ),
  );

  const rows: string[][] = [
    ['Requests', String(stats.totalRequests)],
    ['Successful', `${stats.successful} (${stats.successRate}%)`],
    ['Failed', `${stats.failed} (${stats.errorRate}%)`],
    ['Timed out', String(stats.timeouts)],
    ['Requests/sec', String(stats.requestsPerSecond)],
    ['Duration', formatDuration(stats.durationMs)],
    ['Throughput', `${formatBytes(stats.throughputBytesPerSecond)}/s`],
    ['Latency min', `${stats.latency.min}ms`],
    ['Latency mean', `${stats.latency.mean}ms`],
    ['Latency p50', `${stats.latency.p50}ms`],
    ['Latency p90', `${stats.latency.p90}ms`],
    ['Latency p95', `${stats.latency.p95}ms`],
    ['Latency p99', `${stats.latency.p99}ms`],
    ['Latency max', `${stats.latency.max}ms`],
    ['Std. deviation', `${stats.latency.stddev}ms`],
  ];
  lines.push(
    '',
    renderTable(['Metric', 'Value'], rows)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n'),
  );

  const statuses = Object.entries(stats.statusDistribution).sort(([a], [b]) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  if (statuses.length > 0) {
    lines.push('', palette.bold('Status distribution'));
    for (const [status, count] of statuses) {
      const ok = Number(status) < 400;
      lines.push(`  ${ok ? palette.green('●') : palette.red('●')} ${status}: ${count}`);
    }
  }
  const errors = Object.entries(stats.errorBreakdown);
  if (errors.length > 0) {
    lines.push('', palette.bold('Error breakdown'));
    for (const [kind, count] of errors) lines.push(`  ${palette.red('●')} ${kind}: ${count}`);
  }

  const thresholdLines = renderThresholds(palette, report.thresholds);
  if (thresholdLines.length > 0) lines.push('', ...thresholdLines.map((line) => `  ${line}`));

  lines.push(
    '',
    report.cancelled
      ? palette.yellow(palette.bold('■ Run cancelled before completion'))
      : report.passed
        ? palette.green(palette.bold('✔ Performance thresholds met'))
        : palette.red(palette.bold('✖ Performance thresholds not met')),
  );
  return lines.join('\n');
}

export function renderSecurityReport(
  report: SecurityReport,
  options: TerminalRenderOptions = {},
): string {
  const palette = createPalette(options.color ?? true);
  const lines: string[] = [];
  lines.push('', palette.bold(palette.cyan('▸ Security analysis')), palette.gray(report.target));
  const scoreColor =
    report.score >= 80 ? palette.green : report.score >= 50 ? palette.yellow : palette.red;
  lines.push(
    palette.gray(
      `score ${scoreColor(String(report.score))}/100 · ${report.counts.fail} fail · ${report.counts.warn} warn · ${report.counts.pass} pass · ${report.counts.info} info${
        report.counts.skipped ? ` · ${report.counts.skipped} skipped` : ''
      } · threshold ${report.threshold}`,
    ),
  );

  const order = (finding: SecurityFinding): number => {
    const statusRank =
      finding.status === 'fail'
        ? 0
        : finding.status === 'warn'
          ? 1
          : finding.status === 'info'
            ? 2
            : finding.status === 'pass'
              ? 3
              : 4;
    return statusRank * 10 + SEVERITY_ORDER.indexOf(finding.severity);
  };
  const visible = options.verbose
    ? [...report.findings].sort((a, b) => order(a) - order(b))
    : report.findings.filter((finding) => finding.status === 'fail' || finding.status === 'warn');

  if (visible.length === 0) {
    lines.push('', palette.green('✔ No warnings or failures were found by the enabled checks.'));
  }

  for (const finding of visible) {
    const color = severityColor(palette, finding.severity);
    const badge =
      finding.status === 'fail'
        ? palette.red('FAIL')
        : finding.status === 'warn'
          ? palette.yellow('WARN')
          : finding.status === 'pass'
            ? palette.green('PASS')
            : finding.status === 'skipped'
              ? palette.gray('SKIP')
              : palette.blue('INFO');
    lines.push(
      '',
      `  ${badge} ${color(`[${finding.severity.toUpperCase()}]`)} ${palette.bold(finding.title)} ${palette.gray(`(${finding.category})`)}`,
    );
    lines.push(palette.dim(`    ${finding.description}`));
    if (options.verbose || finding.status === 'fail' || finding.status === 'warn') {
      if (finding.evidence) {
        for (const line of finding.evidence.split('\n').slice(0, 6))
          lines.push(palette.gray(`      evidence: ${line}`));
      }
      lines.push(palette.gray(`      remediation: ${finding.remediation}`));
    }
  }

  lines.push(
    '',
    report.passed
      ? palette.green(palette.bold(`✔ No findings at or above "${report.threshold}" severity`))
      : palette.red(
          palette.bold(`✖ Findings at or above "${report.threshold}" severity require attention`),
        ),
  );
  return lines.join('\n');
}

export function renderContractReport(
  report: ContractReport,
  options: TerminalRenderOptions = {},
): string {
  const palette = createPalette(options.color ?? true);
  const lines: string[] = [];
  lines.push('', palette.bold(palette.cyan('▸ Contract check')), palette.gray(report.target));
  if (report.snapshotUpdated) {
    lines.push(
      palette.blue(
        `  Snapshot ${report.baselineFile ? 'written' : 'created'}${report.baselineFile ? `: ${report.baselineFile}` : ''}`,
      ),
    );
  }
  if (report.changes.length === 0) {
    lines.push(palette.green('  ✔ Response shape matches the baseline'));
  } else {
    lines.push(palette.bold(`  ${report.changes.length} shape change(s) detected`));
    for (const change of report.changes) {
      const breaking = change.change === 'removed' || change.change === 'type-changed';
      const icon = breaking ? palette.red('✖') : palette.yellow('＋');
      lines.push(
        `  ${icon} ${change.path} ${palette.gray(`(${change.change}${change.before ? `: ${change.before}` : ''}${change.after ? ` → ${change.after}` : ''})`)}`,
      );
    }
  }
  if (report.schemaValidation) {
    if (report.schemaValidation.valid)
      lines.push(palette.green('  ✔ Response validates against the provided schema'));
    else {
      lines.push(palette.red('  ✖ Response does not validate against the provided schema'));
      for (const error of report.schemaValidation.errors.slice(0, 10))
        lines.push(palette.gray(`    • ${error}`));
    }
  }
  if (options.verbose && report.response) {
    lines.push('', palette.bold('  Response preview'));
    for (const line of report.response.bodyPreview.split('\n').slice(0, 40))
      lines.push(palette.dim(`  │ ${line}`));
  }
  lines.push(
    '',
    report.passed
      ? palette.green(palette.bold('✔ Contract is compatible'))
      : palette.red(palette.bold('✖ Contract check failed')),
  );
  return lines.join('\n');
}
