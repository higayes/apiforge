/**
 * Self-contained HTML report.
 *
 * Design constraints:
 *  - zero external requests (works offline and inside sandboxed previews),
 *  - responsive down to mobile widths, prints cleanly,
 *  - WCAG-conscious: semantic landmarks, skip link, focus styles, AA contrast,
 *    `aria-live` region for the filter result count, no colour-only signalling,
 *  - every piece of user data is HTML-escaped.
 */
import type {
  ContractReport,
  PerformanceReport,
  SecurityFinding,
  SecurityReport,
  TestCaseResult,
  TestReport,
} from '../types.js';
import { escapeHtml, formatBytes, formatDuration } from '../util/text.js';

const BASE_STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9; --surface: #ffffff; --surface-2: #f0f2f5; --border: #d9dee5;
  --text: #14181f; --muted: #5a6472; --accent: #2450d8; --accent-soft: #e6ecff;
  --pass: #156d3a; --pass-bg: #e3f5e9; --fail: #a9191f; --fail-bg: #fde8e8;
  --warn: #8a5a00; --warn-bg: #fdf3d7; --info: #14567a; --info-bg: #e4f1f8;
  --code-bg: #10151c; --code-text: #e6edf3;
  --radius: 10px; --shadow: 0 1px 2px rgba(16,24,40,.06), 0 8px 24px rgba(16,24,40,.06);
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1218; --surface: #161c24; --surface-2: #1d2530; --border: #2b3542;
    --text: #e7ecf2; --muted: #9aa6b4; --accent: #7d9bff; --accent-soft: #1b2540;
    --pass: #4ade80; --pass-bg: #10251a; --fail: #f87171; --fail-bg: #2a1214;
    --warn: #fbbf24; --warn-bg: #2a2110; --info: #7dd3fc; --info-bg: #0f2230;
    --code-bg: #0a0e13; --code-text: #e6edf3; --shadow: none;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 var(--font); }
a { color: var(--accent); }
a:focus-visible, button:focus-visible, input:focus-visible, summary:focus-visible {
  outline: 3px solid var(--accent); outline-offset: 2px; border-radius: 4px;
}
.skip-link { position: absolute; left: -999px; top: 8px; background: var(--accent); color: #fff; padding: 8px 14px; border-radius: 6px; z-index: 10; }
.skip-link:focus { left: 8px; }
.wrap { max-width: 1120px; margin: 0 auto; padding: 0 20px 64px; }
header.site { background: var(--surface); border-bottom: 1px solid var(--border); padding: 26px 0 22px; }
.brand { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.brand h1 { margin: 0; font-size: 26px; letter-spacing: -.02em; }
.brand .tag { color: var(--muted); font-size: 14px; }
.meta { color: var(--muted); font-size: 13px; margin-top: 6px; display: flex; gap: 16px; flex-wrap: wrap; }
.meta code { font-family: var(--mono); }
.badges { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
.badge { border-radius: 999px; padding: 5px 12px; font-size: 13px; font-weight: 600; border: 1px solid var(--border); background: var(--surface-2); }
.badge.pass { color: var(--pass); background: var(--pass-bg); border-color: color-mix(in srgb, var(--pass) 30%, transparent); }
.badge.fail { color: var(--fail); background: var(--fail-bg); border-color: color-mix(in srgb, var(--fail) 30%, transparent); }
.badge.warn { color: var(--warn); background: var(--warn-bg); }
.badge.info { color: var(--info); background: var(--info-bg); }
section { margin-top: 28px; }
h2 { font-size: 19px; margin: 0 0 12px; letter-spacing: -.01em; }
h3 { font-size: 16px; margin: 0; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
.grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }
.stat { padding: 16px 18px; }
.stat .value { font-size: 26px; font-weight: 700; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.stat .label { color: var(--muted); font-size: 13px; margin-top: 2px; }
.stat.pass .value { color: var(--pass); } .stat.fail .value { color: var(--fail); } .stat.warn .value { color: var(--warn); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
td.num { font-variant-numeric: tabular-nums; text-align: right; font-family: var(--mono); font-size: 13px; }
tr:last-child td { border-bottom: 0; }
.table-scroll { overflow-x: auto; }
details.test { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); margin-bottom: 10px; overflow: hidden; }
details.test > summary { cursor: pointer; list-style: none; padding: 12px 16px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
details.test > summary::-webkit-details-marker { display: none; }
.pill { border-radius: 999px; padding: 2px 10px; font-size: 12px; font-weight: 700; letter-spacing: .02em; }
.pill.passed { color: var(--pass); background: var(--pass-bg); }
.pill.failed { color: var(--fail); background: var(--fail-bg); }
.pill.error { color: var(--fail); background: var(--fail-bg); }
.pill.skipped { color: var(--warn); background: var(--warn-bg); }
.pill.fail { color: var(--fail); background: var(--fail-bg); }
.pill.warn { color: var(--warn); background: var(--warn-bg); }
.pill.pass { color: var(--pass); background: var(--pass-bg); }
.pill.info { color: var(--info); background: var(--info-bg); }
.pill.skipped-sev { color: var(--muted); background: var(--surface-2); }
.test-name { font-weight: 600; }
.muted { color: var(--muted); }
.mono { font-family: var(--mono); font-size: 13px; }
.test-body { padding: 4px 16px 16px; border-top: 1px solid var(--border); }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; font-size: 13px; margin: 12px 0; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; overflow-wrap: anywhere; font-family: var(--mono); font-size: 12.5px; }
ul.assertions { list-style: none; margin: 0; padding: 0; font-size: 13.5px; }
ul.assertions li { padding: 6px 0 6px 26px; position: relative; border-top: 1px dashed var(--border); }
ul.assertions li::before { position: absolute; left: 4px; font-weight: 700; }
ul.assertions li.ok::before { content: "✓"; color: var(--pass); }
ul.assertions li.bad::before { content: "✗"; color: var(--fail); }
.assertion-msg { color: var(--fail); white-space: pre-wrap; margin-top: 4px; font-family: var(--mono); font-size: 12.5px; }
pre.body { background: var(--code-bg); color: var(--code-text); padding: 14px; border-radius: 8px; overflow: auto; max-height: 320px; font: 12.5px/1.55 var(--mono); margin: 10px 0; }
pre.diff { background: var(--code-bg); color: var(--code-text); padding: 14px; border-radius: 8px; overflow: auto; font: 12.5px/1.5 var(--mono); margin: 8px 0 0; }
pre.diff .add { color: #7ee2a8; } pre.diff .del { color: #ff9d9d; }
.finding { padding: 16px; border-left: 4px solid var(--border); }
.finding.fail { border-left-color: var(--fail); }
.finding.warn { border-left-color: var(--warn); }
.finding.pass { border-left-color: var(--pass); }
.finding.info { border-left-color: var(--info); }
.finding + .finding { border-top: 1px solid var(--border); }
.finding h4 { margin: 8px 0 4px; font-size: 15px; }
.finding p { margin: 4px 0; color: var(--muted); font-size: 13.5px; }
.evidence { background: var(--surface-2); border-radius: 6px; padding: 8px 10px; font: 12.5px/1.5 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0; }
.toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 14px; }
.toolbar input[type="search"] { flex: 1 1 260px; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); font: inherit; }
.toolbar label { font-size: 13px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
.status-msg { font-size: 13px; color: var(--muted); }
footer { margin-top: 40px; padding-top: 18px; border-top: 1px solid var(--border); color: var(--muted); font-size: 13px; }
.scorebar { height: 10px; border-radius: 999px; background: var(--surface-2); overflow: hidden; margin-top: 8px; }
.scorebar > span { display: block; height: 100%; background: var(--pass); }
.scorebar.low > span { background: var(--fail); } .scorebar.mid > span { background: var(--warn); }
@media (max-width: 620px) {
  .kv { grid-template-columns: 1fr; }
  .stat .value { font-size: 22px; }
}
@media print {
  details.test { break-inside: avoid; }
  details.test > summary { cursor: default; }
  body { background: #fff; }
}
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

function head(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>${BASE_STYLES}</style>
</head>
<body>
<a class="skip-link" href="#main">Skip to results</a>`;
}

function header(title: string, tagline: string, metaLines: Array<[string, string]>, badges: string): string {
  return `<header class="site"><div class="wrap">
  <div class="brand"><h1>${escapeHtml(title)}</h1><span class="tag">${escapeHtml(tagline)}</span></div>
  <div class="meta">${metaLines.map(([label, value]) => `<span>${escapeHtml(label)}: <code>${escapeHtml(value)}</code></span>`).join('')}</div>
  <div class="badges">${badges}</div>
</div></header>`;
}

function footer(tool: { name: string; version: string }): string {
  return `<footer><div class="wrap">Generated by <strong>${escapeHtml(tool.name)}</strong> v${escapeHtml(tool.version)} · <a href="https://github.com/apiforge/apiforge">github.com/apiforge/apiforge</a> · Reports contain no credentials; secrets are redacted.</div></footer>`;
}

function assertionList(result: TestCaseResult): string {
  if (result.assertions.length === 0) return '<p class="muted">No assertions were configured for this request.</p>';
  const items = result.assertions
    .map((assertion) => {
      const cls = assertion.passed ? 'ok' : 'bad';
      const status = assertion.passed ? 'passed' : 'failed';
      const children = (assertion.children ?? [])
        .map(
          (child) =>
            `<div class="assertion-msg">${escapeHtml(`${child.passed ? '✓' : '✗'} ${child.expression}${child.message ? ` — ${child.message}` : ''}`)}</div>`,
        )
        .join('');
      return `<li class="${cls}"><span class="mono">${escapeHtml(assertion.expression)}</span> <span class="muted">(${status})</span>${
        !assertion.passed && assertion.message ? `<div class="assertion-msg">${escapeHtml(assertion.message)}</div>` : ''
      }${children}</li>`;
    })
    .join('');
  return `<ul class="assertions">${items}</ul>`;
}

function testDetails(suiteName: string, result: TestCaseResult): string {
  const searchKey = `${suiteName} ${result.name} ${result.tags?.join(' ') ?? ''}`.toLowerCase();
  const response = result.response
    ? `<dl class="kv">
        <dt>Response</dt><dd>HTTP ${result.response.status} ${escapeHtml(result.response.statusText)} · ${formatBytes(result.response.sizeBytes)} · ${formatDuration(result.response.durationMs)}</dd>
        <dt>Request</dt><dd>${escapeHtml(result.request.method)} ${escapeHtml(result.request.url)}</dd>
        ${
          result.response.redirects.length > 0
            ? `<dt>Redirects</dt><dd>${result.response.redirects.map((hop) => `${hop.status} → ${escapeHtml(hop.location)}`).join('<br>')}</dd>`
            : ''
        }
        ${
          result.response.jsonParseError
            ? `<dt>JSON error</dt><dd>${escapeHtml(result.response.jsonParseError)}</dd>`
            : ''
        }
      </dl>
      ${result.response.bodyPreview ? `<pre class="body" tabindex="0" aria-label="Response body preview">${escapeHtml(result.response.bodyPreview)}${result.response.bodyTruncated ? '\n… (truncated)' : ''}</pre>` : ''}`
    : '';
  const error = result.error ? `<p class="assertion-msg">${escapeHtml(result.error)}</p>` : '';
  const skip = result.skipReason ? `<p class="muted">${escapeHtml(result.skipReason)}</p>` : '';
  return `<details class="test" data-status="${result.status}" data-search="${escapeHtml(searchKey)}">
  <summary>
    <span class="pill ${result.status}">${result.status.toUpperCase()}</span>
    <span class="test-name">${escapeHtml(result.name)}</span>
    ${result.dataRow !== undefined ? `<span class="muted mono">data row ${result.dataRow + 1}</span>` : ''}
    <span class="muted" style="margin-left:auto">${formatDuration(result.durationMs)}</span>
  </summary>
  <div class="test-body">${error}${skip}${response}${assertionList(result)}</div>
</details>`;
}

function suiteSection(report: TestReport): string {
  return report.suites
    .map((suite) => {
      const rows = suite.results.map((result) => testDetails(suite.suite, result)).join('\n');
      const thresholds =
        suite.thresholds.length === 0
          ? ''
          : `<div class="table-scroll card" style="margin-top:12px"><table><caption class="muted" style="text-align:left;padding:10px 12px 0">Suite thresholds</caption><thead><tr><th scope="col">Metric</th><th scope="col">Rule</th><th scope="col">Actual</th><th scope="col">Result</th></tr></thead><tbody>${suite.thresholds
              .map(
                (threshold) =>
                  `<tr><td>${escapeHtml(threshold.metric)}</td><td>${threshold.operator === 'min' ? '≥' : '≤'} ${threshold.limit}</td><td class="num">${Number.isFinite(threshold.actual) ? threshold.actual : 'n/a'}</td><td><span class="pill ${threshold.passed ? 'pass' : 'fail'}">${threshold.passed ? 'PASS' : 'FAIL'}</span></td></tr>`,
              )
              .join('')}</tbody></table></div>`;
      return `<section aria-labelledby="suite-${escapeHtml(suite.suite)}">
  <h2 id="suite-${escapeHtml(suite.suite)}">${escapeHtml(suite.suite)}</h2>
  <p class="muted">${suite.totals.total} tests · ${suite.totals.passed} passed · ${suite.totals.failed} failed${suite.totals.errored ? ` · ${suite.totals.errored} errors` : ''}${suite.totals.skipped ? ` · ${suite.totals.skipped} skipped` : ''} · ${formatDuration(suite.durationMs)}${suite.file ? ` · <span class="mono">${escapeHtml(suite.file)}</span>` : ''}</p>
  ${rows || '<p class="muted">This suite contains no tests.</p>'}
  ${thresholds}
</section>`;
    })
    .join('\n');
}

const FILTER_SCRIPT = `
(function () {
  var input = document.getElementById('test-filter');
  var status = document.getElementById('filter-status');
  var onlyFailed = document.getElementById('only-failed');
  if (!input) return;
  var items = Array.prototype.slice.call(document.querySelectorAll('details.test'));
  function apply() {
    var q = input.value.trim().toLowerCase();
    var failedOnly = onlyFailed && onlyFailed.checked;
    var shown = 0;
    items.forEach(function (item) {
      var match = (!q || (item.getAttribute('data-search') || '').indexOf(q) !== -1);
      if (failedOnly) match = match && item.getAttribute('data-status') !== 'passed';
      item.hidden = !match;
      if (match) shown += 1;
    });
    if (status) status.textContent = shown + ' of ' + items.length + ' tests shown';
  }
  input.addEventListener('input', apply);
  if (onlyFailed) onlyFailed.addEventListener('change', apply);
  apply();
})();
`;

export function renderTestHtml(report: TestReport): string {
  const totals = report.totals;
  const badges = [
    `<span class="badge ${report.passed ? 'pass' : 'fail'}">${report.passed ? 'PASSED' : 'FAILED'}</span>`,
    `<span class="badge">${totals.total} tests</span>`,
    `<span class="badge pass">${totals.passed} passed</span>`,
    `<span class="badge ${totals.failed > 0 ? 'fail' : ''}">${totals.failed} failed</span>`,
    totals.errored > 0 ? `<span class="badge fail">${totals.errored} errors</span>` : '',
    totals.skipped > 0 ? `<span class="badge warn">${totals.skipped} skipped</span>` : '',
    `<span class="badge info">${formatDuration(totals.durationMs)}</span>`,
  ]
    .filter(Boolean)
    .join('');

  const metaLines: Array<[string, string]> = [['Generated', report.generatedAt]];
  if (report.environment) metaLines.push(['Environment', report.environment]);

  return `${head(report.title)}
${header(report.title, 'Test smarter. Ship with confidence.', metaLines, badges)}
<main id="main" class="wrap">
  <section aria-labelledby="summary-heading">
    <h2 id="summary-heading">Summary</h2>
    <div class="grid">
      <div class="card stat"><div class="value">${totals.total}</div><div class="label">Total tests</div></div>
      <div class="card stat pass"><div class="value">${totals.passed}</div><div class="label">Passed</div></div>
      <div class="card stat ${totals.failed > 0 ? 'fail' : ''}"><div class="value">${totals.failed}</div><div class="label">Failed</div></div>
      <div class="card stat ${totals.errored > 0 ? 'fail' : ''}"><div class="value">${totals.errored}</div><div class="label">Errors</div></div>
      <div class="card stat"><div class="value">${totals.skipped}</div><div class="label">Skipped</div></div>
      <div class="card stat"><div class="value">${formatDuration(totals.durationMs)}</div><div class="label">Duration</div></div>
    </div>
  </section>
  <section aria-labelledby="tests-heading">
    <h2 id="tests-heading">Tests</h2>
    <div class="toolbar">
      <label for="test-filter">Filter</label>
      <input id="test-filter" type="search" placeholder="Filter by test name, suite or tag" aria-describedby="filter-status">
      <label><input id="only-failed" type="checkbox"> Only failures</label>
      <span class="status-msg" id="filter-status" role="status" aria-live="polite"></span>
    </div>
    ${suiteSection(report)}
  </section>
</main>
${footer(report.tool)}
<script>${FILTER_SCRIPT}</script>
</body>
</html>
`;
}

export function renderPerformanceHtml(report: PerformanceReport): string {
  const { stats } = report;
  const badges = [
    `<span class="badge ${report.cancelled ? 'warn' : report.passed ? 'pass' : 'fail'}">${report.cancelled ? 'CANCELLED' : report.passed ? 'THRESHOLDS MET' : 'THRESHOLDS NOT MET'}</span>`,
    `<span class="badge info">${stats.totalRequests} requests</span>`,
    `<span class="badge">${stats.requestsPerSecond} req/s</span>`,
    `<span class="badge ${stats.errorRate > 0 ? 'warn' : 'pass'}">${stats.errorRate}% errors</span>`,
  ].join('');
  const latencyRows: Array<[string, number]> = [
    ['min', stats.latency.min],
    ['mean', stats.latency.mean],
    ['p50', stats.latency.p50],
    ['p90', stats.latency.p90],
    ['p95', stats.latency.p95],
    ['p99', stats.latency.p99],
    ['max', stats.latency.max],
  ];
  const maxLatency = Math.max(stats.latency.max, 1);
  const latencyTable = latencyRows
    .map(([label, value]) => {
      const pct = (value / maxLatency) * 100;
      return `<tr><th scope="row">${label}</th><td class="num">${value} ms</td><td style="width:55%"><div class="scorebar ${pct > 80 ? 'mid' : ''}" aria-hidden="true"><span style="width:${pct.toFixed(1)}%"></span></div></td></tr>`;
    })
    .join('');
  const statusRows = Object.entries(stats.statusDistribution)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([status, count]) => `<tr><td class="mono">${escapeHtml(status)}</td><td class="num">${count}</td><td><span class="pill ${Number(status) < 400 ? 'pass' : 'fail'}">${Number(status) < 400 ? 'OK' : 'ERROR'}</span></td></tr>`)
    .join('');
  const errorRows = Object.entries(stats.errorBreakdown)
    .map(([kind, count]) => `<tr><td>${escapeHtml(kind)}</td><td class="num">${count}</td></tr>`)
    .join('');
  const thresholdRows = report.thresholds
    .map((threshold) => `<tr><td>${escapeHtml(threshold.metric)}</td><td>${threshold.operator === 'min' ? '≥' : '≤'} ${threshold.limit}</td><td class="num">${Number.isFinite(threshold.actual) ? threshold.actual : 'n/a'}</td><td><span class="pill ${threshold.passed ? 'pass' : 'fail'}">${threshold.passed ? 'PASS' : 'FAIL'}</span></td></tr>`)
    .join('');

  return `${head(report.title)}
${header(report.title, 'Performance results', [
  ['Target', `${report.target.method} ${report.target.url}`],
  ['Started', report.startedAt],
  ['Ended', report.endedAt],
], badges)}
<main id="main" class="wrap">
  <section aria-labelledby="summary-heading">
    <h2 id="summary-heading">Summary</h2>
    <div class="grid">
      <div class="card stat"><div class="value">${stats.totalRequests}</div><div class="label">Requests</div></div>
      <div class="card stat pass"><div class="value">${stats.successRate}%</div><div class="label">Success rate</div></div>
      <div class="card stat ${stats.errorRate > 0 ? 'fail' : ''}"><div class="value">${stats.errorRate}%</div><div class="label">Error rate</div></div>
      <div class="card stat ${stats.timeouts > 0 ? 'warn' : ''}"><div class="value">${stats.timeouts}</div><div class="label">Timeouts</div></div>
      <div class="card stat"><div class="value">${stats.requestsPerSecond}</div><div class="label">Requests / second</div></div>
      <div class="card stat"><div class="value">${formatBytes(stats.throughputBytesPerSecond)}/s</div><div class="label">Throughput</div></div>
    </div>
  </section>
  <section aria-labelledby="latency-heading">
    <h2 id="latency-heading">Latency distribution</h2>
    <div class="card table-scroll"><table><caption class="muted" style="text-align:left;padding:10px 12px 0">All values in milliseconds · ${formatDuration(stats.durationMs)} measured</caption>
      <thead><tr><th scope="col">Statistic</th><th scope="col">Value</th><th scope="col"><span class="muted">Relative</span></th></tr></thead>
      <tbody>${latencyTable}</tbody></table></div>
  </section>
  <section aria-labelledby="status-heading">
    <h2 id="status-heading">Response statuses</h2>
    ${statusRows ? `<div class="card table-scroll"><table><thead><tr><th scope="col">Status</th><th scope="col">Count</th><th scope="col">Class</th></tr></thead><tbody>${statusRows}</tbody></table></div>` : '<p class="muted">No responses were recorded.</p>'}
  </section>
  ${
    errorRows
      ? `<section aria-labelledby="errors-heading"><h2 id="errors-heading">Failure breakdown</h2><div class="card table-scroll"><table><thead><tr><th scope="col">Kind</th><th scope="col">Count</th></tr></thead><tbody>${errorRows}</tbody></table></div></section>`
      : ''
  }
  <section aria-labelledby="config-heading">
    <h2 id="config-heading">Run configuration</h2>
    <div class="card"><dl class="kv" style="padding:14px 16px">
      <dt>Concurrency</dt><dd>${report.config.concurrency}</dd>
      <dt>Duration</dt><dd>${report.config.durationSeconds ? `${report.config.durationSeconds}s` : 'until request limit'}</dd>
      <dt>Request limit</dt><dd>${report.config.maxRequests ?? 'none (time-bound)'}</dd>
      <dt>Timeout</dt><dd>${report.config.timeoutMs}ms</dd>
      <dt>Think time</dt><dd>${report.config.thinkTimeMs}ms</dd>
      <dt>Warmup</dt><dd>${report.config.warmupRequests} requests</dd>
    </dl></div>
  </section>
  ${
    thresholdRows
      ? `<section aria-labelledby="threshold-heading"><h2 id="threshold-heading">Thresholds</h2><div class="card table-scroll"><table><thead><tr><th scope="col">Metric</th><th scope="col">Rule</th><th scope="col">Actual</th><th scope="col">Result</th></tr></thead><tbody>${thresholdRows}</tbody></table></div></section>`
      : ''
  }
</main>
${footer(report.tool)}
</body>
</html>
`;
}

function severityClass(finding: SecurityFinding): string {
  return finding.status === 'fail' ? 'fail' : finding.status === 'warn' ? 'warn' : finding.status === 'pass' ? 'pass' : 'info';
}

export function renderSecurityHtml(report: SecurityReport): string {
  const badges = [
    `<span class="badge ${report.passed ? 'pass' : 'fail'}">${report.passed ? 'PASSED' : 'FAILED'}</span>`,
    `<span class="badge info">Score ${report.score}/100</span>`,
    `<span class="badge ${report.counts.fail > 0 ? 'fail' : ''}">${report.counts.fail} fail</span>`,
    `<span class="badge ${report.counts.warn > 0 ? 'warn' : ''}">${report.counts.warn} warn</span>`,
    `<span class="badge pass">${report.counts.pass} pass</span>`,
    `<span class="badge">${report.counts.info} info</span>`,
  ].join('');
  const scoreClass = report.score >= 80 ? '' : report.score >= 50 ? 'mid' : 'low';
  const findings = report.findings
    .map(
      (finding) => `<article class="finding ${severityClass(finding)}">
      <span class="pill ${severityClass(finding)}">${finding.status.toUpperCase()}</span>
      <span class="pill ${finding.status === 'skipped' ? 'skipped-sev' : 'info'}">${escapeHtml(finding.severity.toUpperCase())}</span>
      <h4>${escapeHtml(finding.title)}</h4>
      <p>${escapeHtml(finding.description)}</p>
      ${finding.evidence ? `<div class="evidence">${escapeHtml(finding.evidence)}</div>` : ''}
      <p><strong>Remediation:</strong> ${escapeHtml(finding.remediation)}</p>
      <p class="muted">Check: <span class="mono">${escapeHtml(finding.id)}</span> · Category: ${escapeHtml(finding.category)}</p>
    </article>`,
    )
    .join('');

  return `${head(report.title)}
${header(report.title, 'Security analysis', [
  ['Target', report.target],
  ['Started', report.startedAt],
  ['Threshold', `${report.threshold} and above`],
], badges)}
<main id="main" class="wrap">
  <section aria-labelledby="score-heading">
    <h2 id="score-heading">Security score</h2>
    <div class="card" style="padding:16px 18px">
      <div style="display:flex;justify-content:space-between;align-items:baseline"><strong style="font-size:24px">${report.score}/100</strong><span class="muted">Passive configuration review — not a penetration test</span></div>
      <div class="scorebar ${scoreClass}" role="img" aria-label="Security score ${report.score} out of 100"><span style="width:${report.score}%"></span></div>
    </div>
  </section>
  <section aria-labelledby="findings-heading">
    <h2 id="findings-heading">Findings</h2>
    <div class="card">${findings || '<p class="muted" style="padding:16px">No findings.</p>'}</div>
  </section>
  <section aria-labelledby="scope-heading">
    <h2 id="scope-heading">Scope and limitations</h2>
    <div class="card" style="padding:16px 18px"><p class="muted" style="margin:0">This analysis inspects response headers, cookies, TLS usage and body content for defensive misconfiguration. It does not attempt exploitation, injection, fuzzing or denial-of-service testing. Only run it against systems you are authorized to test.</p></div>
  </section>
</main>
${footer(report.tool)}
</body>
</html>
`;
}

export function renderContractHtml(report: ContractReport): string {
  const badges = [
    `<span class="badge ${report.passed ? 'pass' : 'fail'}">${report.passed ? 'COMPATIBLE' : 'BREAKING CHANGES'}</span>`,
    `<span class="badge info">${report.changes.length} change(s)</span>`,
    report.snapshotUpdated ? '<span class="badge warn">SNAPSHOT UPDATED</span>' : '',
  ]
    .filter(Boolean)
    .join('');
  const rows = report.changes
    .map((change) => {
      const breaking = change.change === 'removed' || change.change === 'type-changed';
      return `<tr><td class="mono">${escapeHtml(change.path)}</td><td><span class="pill ${breaking ? 'fail' : 'warn'}">${escapeHtml(change.change)}</span></td><td class="mono">${escapeHtml(change.before ?? '—')}</td><td class="mono">${escapeHtml(change.after ?? '—')}</td></tr>`;
    })
    .join('');

  return `${head(report.title)}
${header(report.title, 'Contract regression check', [['Target', report.target], ['Generated', report.generatedAt]], badges)}
<main id="main" class="wrap">
  <section aria-labelledby="changes-heading">
    <h2 id="changes-heading">Shape changes</h2>
    ${
      rows
        ? `<div class="card table-scroll"><table><thead><tr><th scope="col">Path</th><th scope="col">Change</th><th scope="col">Before</th><th scope="col">After</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<p class="muted">The response shape matches the stored baseline.</p>'
    }
  </section>
  ${
    report.schemaValidation
      ? `<section aria-labelledby="schema-heading"><h2 id="schema-heading">Schema validation</h2><div class="card" style="padding:16px 18px">${
          report.schemaValidation.valid
            ? '<p><span class="pill pass">PASS</span> The response validates against the provided schema.</p>'
            : `<p><span class="pill fail">FAIL</span> The response does not validate against the provided schema.</p><ul>${report.schemaValidation.errors.map((error) => `<li class="mono">${escapeHtml(error)}</li>`).join('')}</ul>`
        }</div></section>`
      : ''
  }
  ${
    report.response
      ? `<section aria-labelledby="response-heading"><h2 id="response-heading">Response preview</h2><pre class="body" tabindex="0" aria-label="Response body preview">${escapeHtml(report.response.bodyPreview)}</pre></section>`
      : ''
  }
</main>
${footer(report.tool)}
</body>
</html>
`;
}

/** Human-readable file base name for a report title. */
export function reportFileBase(title: string, kind: string, date = new Date()): string {
  const stamp = date.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || kind}-${stamp}`;
}
