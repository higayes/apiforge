/**
 * Public result/domain types shared by the engine, reporters and consumers
 * (CLI today, future web dashboard tomorrow).
 *
 * These types form part of the stable engine contract: every report format is a
 * rendering of these objects, never a re-implementation of the logic.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export interface ToolInfo {
  name: string;
  version: string;
}

/* -------------------------------------------------------------------------- */
/* Assertions & tests                                                          */
/* -------------------------------------------------------------------------- */

export interface AssertionResult {
  /** Stable identifier of where the assertion pointed, e.g. `status` or `$.id`. */
  target: string;
  /** Human readable assertion expression, e.g. `jsonPath $.id equals "Ada"`. */
  expression: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  /** Explanation shown when the assertion fails (includes diffs for strings/objects). */
  message?: string;
  /** Result of nested element-wise assertions (`every` / `some`). */
  children?: AssertionResult[];
}

export interface RequestSummary {
  method: string;
  /** Fully resolved URL with secret query values redacted. */
  url: string;
}

export interface ResponseSummary {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyPreview: string;
  bodyTruncated: boolean;
  sizeBytes: number;
  durationMs: number;
  redirects: RedirectHop[];
  jsonParseError?: string;
}

export interface RedirectHop {
  status: number;
  location: string;
}

export interface TestCaseResult {
  name: string;
  /** Optional user-assigned id, used by request chaining (`steps.<id>`). */
  id?: string;
  request: RequestSummary;
  status: 'passed' | 'failed' | 'skipped' | 'error';
  assertions: AssertionResult[];
  response?: ResponseSummary;
  /** Populated for `failed` (assertion failures) and `error` (request/setup errors). */
  error?: string;
  durationMs: number;
  startedAt: string;
  tags?: string[];
  /** Index of the data row for data-driven tests (0-based); absent otherwise. */
  dataRow?: number;
  skipReason?: string;
}

export type ThresholdMetric =
  | 'total'
  | 'passed'
  | 'failed'
  | 'successRate'
  | 'durationMs'
  | 'p50'
  | 'p90'
  | 'p95'
  | 'p99'
  | 'rps'
  | 'errorRate';

export interface ThresholdResult {
  metric: ThresholdMetric;
  operator: 'min' | 'max';
  limit: number;
  actual: number;
  passed: boolean;
  /** Where the threshold came from, e.g. `suite` or `performance`. */
  source: string;
}

export interface SuiteRun {
  suite: string;
  description?: string;
  file?: string;
  environment?: string;
  startedAt: string;
  durationMs: number;
  results: TestCaseResult[];
  totals: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    errored: number;
  };
  thresholds: ThresholdResult[];
  passed: boolean;
}

export interface TestReport {
  kind: 'test';
  title: string;
  generatedAt: string;
  tool: ToolInfo;
  environment?: string;
  suites: SuiteRun[];
  totals: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    errored: number;
    durationMs: number;
  };
  thresholds: ThresholdResult[];
  passed: boolean;
}

/* -------------------------------------------------------------------------- */
/* Performance                                                                 */
/* -------------------------------------------------------------------------- */

export interface LatencyStats {
  min: number;
  mean: number;
  median: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  stddev: number;
}

export interface PerformanceStats {
  totalRequests: number;
  successful: number;
  failed: number;
  timeouts: number;
  errorRate: number;
  successRate: number;
  requestsPerSecond: number;
  latency: LatencyStats;
  bytesReceived: number;
  throughputBytesPerSecond: number;
  statusDistribution: Record<string, number>;
  errorBreakdown: Record<string, number>;
  durationMs: number;
}

export interface PerformanceReport {
  kind: 'performance';
  title: string;
  generatedAt: string;
  tool: ToolInfo;
  target: { method: string; url: string };
  config: {
    concurrency: number;
    durationSeconds?: number;
    maxRequests?: number;
    timeoutMs: number;
    thinkTimeMs: number;
    warmupRequests: number;
  };
  stats: PerformanceStats;
  thresholds: ThresholdResult[];
  startedAt: string;
  endedAt: string;
  cancelled: boolean;
  passed: boolean;
}

/* -------------------------------------------------------------------------- */
/* Security                                                                    */
/* -------------------------------------------------------------------------- */

export type SecurityCheckStatus = 'pass' | 'warn' | 'fail' | 'info' | 'skipped';

export interface SecurityFinding {
  id: string;
  title: string;
  category: string;
  status: SecurityCheckStatus;
  severity: Severity;
  description: string;
  evidence?: string;
  remediation: string;
  references?: string[];
}

export interface SecurityReport {
  kind: 'security';
  title: string;
  generatedAt: string;
  tool: ToolInfo;
  target: string;
  findings: SecurityFinding[];
  counts: Record<SecurityCheckStatus, number> & { bySeverity: Record<Severity, number> };
  score: number;
  passed: boolean;
  threshold: Severity;
  startedAt: string;
  endedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Contract                                                                    */
/* -------------------------------------------------------------------------- */

export interface ShapeNode {
  type: 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object' | 'unknown';
  properties?: Record<string, ShapeNode>;
  element?: ShapeNode;
  nullable?: boolean;
}

export interface ShapeChange {
  path: string;
  change: 'added' | 'removed' | 'type-changed';
  before?: string;
  after?: string;
}

export interface ContractReport {
  kind: 'contract';
  title: string;
  generatedAt: string;
  tool: ToolInfo;
  target: string;
  baselineFile?: string;
  snapshotUpdated: boolean;
  compatible: boolean;
  changes: ShapeChange[];
  schemaValidation?: { valid: boolean; errors: string[] };
  response?: { status: number; bodyPreview: string };
  durationMs: number;
  passed: boolean;
}

export type AnyReport = TestReport | PerformanceReport | SecurityReport | ContractReport;

export interface ReportContext {
  tool: ToolInfo;
  color?: boolean;
  cwd?: string;
}
