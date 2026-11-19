/**
 * @apiforge/engine — public API.
 *
 * Everything the CLI uses is exported here, and this module is the single
 * integration point for future interfaces (web dashboard, IDE extensions,
 * CI plugins). The engine is UI-agnostic: it returns plain data structures,
 * and reporters turn those into text/HTML/XML.
 */
export const ENGINE_NAME = '@apiforge/engine';
export const ENGINE_VERSION = '0.1.0';

/* Errors */
export {
  ApiForgeError,
  ConfigError,
  ValidationError,
  RequestError,
  ReportError,
  UsageError,
  describeUnknownError,
  toApiForgeError,
} from './errors.js';
export type { ErrorCode, RequestFailureKind } from './errors.js';

/* Public result types */
export type {
  AnyReport,
  AssertionResult,
  ContractReport,
  LatencyStats,
  PerformanceReport,
  PerformanceStats,
  RedirectHop,
  RequestSummary,
  ResponseSummary,
  SecurityCheckStatus,
  SecurityFinding,
  SecurityReport,
  Severity,
  ShapeChange,
  ShapeNode,
  SuiteRun,
  TestCaseResult,
  TestReport,
  ThresholdMetric,
  ThresholdResult,
  ToolInfo,
} from './types.js';
export { SEVERITY_ORDER } from './types.js';

/* Configuration */
export {
  parseSuiteDocument,
  parseSuiteFile,
  parseEnvironmentDocument,
  parseEnvironmentFile,
  parseProjectDocument,
  parseProjectFile,
  parsePerformanceDocument,
  parseSecurityDocument,
  parseContractDocument,
  parseDocument,
  stringifySuite,
  suiteSchema,
  testSchema,
  environmentSchema,
  projectSchema,
  performanceSpecSchema,
  securitySpecSchema,
  contractSpecSchema,
  expectSchema,
} from './config/schema.js';
export type {
  SuiteDefinition,
  TestDefinition,
  EnvironmentDefinition,
  ProjectConfig,
  PerformanceSpec,
  SecuritySpec,
  ContractSpec,
  ExpectDefinition,
  ValueCheck,
  ThresholdDefinition,
  BodyDefinition,
  AuthDefinition,
  HeaderCheck,
} from './config/schema.js';

/* Projects */
export {
  loadProject,
  loadSuiteFile,
  loadSuitesFromFiles,
  loadEnvironments,
  findProjectRoot,
  readTextFile,
  looksLikeSuite,
  looksLikeEnvironment,
  PROJECT_FILE_NAMES,
} from './config/project.js';
export type {
  ProjectContext,
  LoadedSuite,
  LoadedEnvironment,
  LoadProjectOptions,
} from './config/project.js';

/* HTTP */
export {
  executeRequest,
  prepareBody,
  closeHttpResources,
  summarizeOutboundRequest,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_MAX_BODY_BYTES,
} from './http/client.js';
export type { HttpRequestOptions, HttpResponseData, PreparedBody } from './http/client.js';

/* Test engine */
export {
  runSuite,
  parseCsv,
  coerceCsvScalar,
  mergeStepValues,
  BODY_PREVIEW_LIMIT,
} from './test/runner.js';
export type { RunnerOptions } from './test/runner.js';
export { buildTestReport } from './test/report.js';
export type { BuildTestReportOptions } from './test/report.js';
export { computeThresholds } from './test/thresholds.js';
export type { ThresholdInput } from './test/thresholds.js';

/* Assertions */
export { evaluateExpect } from './assertions/expect.js';
export type { AssertionContextData } from './assertions/expect.js';
export { evaluateValueCheck, evaluateJsonPathChecks } from './assertions/value-check.js';
export {
  validateJsonSchema,
  dereferenceLocalRefs,
  checkSchemaCompiles,
} from './assertions/json-schema.js';

/* Performance */
export {
  runPerformance,
  computeStats,
  MAX_CONCURRENCY,
  DEFAULT_CONCURRENCY,
} from './performance/runner.js';
export type { PerformanceRunOptions, PerformanceProgress } from './performance/runner.js';

/* Security */
export {
  runSecurity,
  checkSecurityHeaders,
  checkCors,
  checkCookies,
  checkDisclosure,
  checkAuth,
  checkTls,
  checkAdvertisedMethods,
  scoreFindings,
  passesThreshold,
} from './security/checks.js';
export type { SecurityRunOptions, SecurityRunResult } from './security/checks.js';
export { buildSecurityReport } from './security/report.js';
export type { BuildSecurityReportOptions } from './security/report.js';

/* Contract */
export { runContract, baselinePathFor, readJsonFile } from './contract/runner.js';
export type { ContractRunOptions } from './contract/runner.js';
export { inferShape, diffShapes, isCompatible } from './contract/shape.js';

/* OpenAPI */
export { importOpenApiDocument, extractJsonSchemaForOperation } from './openapi/importer.js';
export type { ImportOptions, ImportResult } from './openapi/importer.js';

/* Reporting */
export {
  renderTestReport,
  renderPerformanceReport,
  renderSecurityReport,
  renderContractReport,
} from './report/terminal.js';
export type { TerminalRenderOptions } from './report/terminal.js';
export {
  renderTestJson,
  renderPerformanceJson,
  renderSecurityJson,
  renderContractJson,
} from './report/json.js';
export { renderJUnit } from './report/junit.js';
export {
  renderTestHtml,
  renderPerformanceHtml,
  renderSecurityHtml,
  renderContractHtml,
  reportFileBase,
} from './report/html.js';
export { writeReports } from './report/writer.js';
export type { ReportFormat, WrittenArtifact, WriteReportsOptions } from './report/writer.js';
export { createPalette, detectColorSupport, severityColor } from './report/color.js';
export type { Palette } from './report/color.js';

/* Utilities useful to integrations */
export {
  renderTemplate,
  renderValue,
  resolveExpression,
  findPlaceholders,
} from './util/template.js';
export type { TemplateContext, RenderOptions } from './util/template.js';
export { getPath, setPath, hasPath, parsePath } from './util/path.js';
export {
  redactUrl,
  redactHeaders,
  redactBodyText,
  redactUnknown,
  redactKnownSecrets,
  redactSecretsInUrl,
  isSensitiveKey,
  maskSecretPreservingShape,
  REDACTED,
} from './util/redaction.js';
export { computeLatencyStats, percentile, round } from './util/stats.js';
export { unifiedDiff, diffJson, formatValue } from './util/diff.js';
export { createLogger, silentLogger } from './util/logger.js';
export type { Logger, LogLevel } from './util/logger.js';
export {
  formatDuration,
  formatBytes,
  escapeHtml,
  renderTable,
  toSlug,
  fileTimestamp,
} from './util/text.js';
export { setLogger } from './logger-holder.js';
