import type { Command } from 'commander';
import {
  buildSecurityReport,
  checkSchemaCompiles,
  closeHttpResources,
  parseDocument,
  parseSecurityDocument,
  renderSecurityReport,
  runSecurity,
  scoreFindings,
  ConfigError,
  type ReportFormat,
  type SecurityFinding,
  type Severity,
} from '@apiforge/engine';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EXIT_CHECKS_FAILED, EXIT_INTERRUPTED, EXIT_SUCCESS } from '../exit-codes.js';
import { createUiFromCommand } from '../lib/context.js';
import { assertHttpUrl, parseHeaders, parseTimeout, readStructuredInput } from '../lib/inputs.js';
import { emitReport, parseFormats } from '../lib/output.js';
import { installCancellation } from '../signals.js';
import { TOOL_INFO } from '../lib/version.js';

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

interface SecurityCommandOptions {
  url?: string;
  config?: string;
  header?: string[];
  threshold?: string;
  check?: string[];
  origin?: string;
  timeout?: string;
  schema?: string;
  reporter?: string;
  out?: string;
  json?: boolean;
  color?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  insecure?: boolean;
}

export function registerSecurityCommand(program: Command): void {
  program
    .command('security')
    .description('Run passive security checks against an API (authorized targets only)')
    .option('-u, --url <url>', 'target URL')
    .option('--config <path>', 'security specification file (YAML/JSON)')
    .option('-H, --header <name=value>', 'request header (repeatable)', collect, [])
    .option('--threshold <severity>', `fail on findings at or above this severity (${SEVERITIES.join(', ')})`, 'high')
    .option('--check <name>', 'run only these checks (repeatable): headers, cors, cookies, disclosure, auth, methods, tls', collect, [])
    .option('--origin <url>', 'origin to use for CORS analysis')
    .option('--schema <path>', 'validate an OpenAPI/JSON Schema document and report on it')
    .option('--timeout <ms>', 'request timeout in milliseconds')
    .option('--reporter <formats>', 'report formats, comma separated: terminal,json,html,junit')
    .option('-o, --out <dir>', 'directory for report files')
    .option('--json', 'print the full report as JSON to stdout')
    .option('--insecure', 'do not verify TLS certificates (development only)')
    .option('-v, --verbose', 'show passing and informational findings too')
    .option('-q, --quiet', 'only print the final result')
    .option('--no-color', 'disable coloured output')
    .action(async (options: SecurityCommandOptions) => {
      const ui = createUiFromCommand(options);
      const cancellation = installCancellation({
        onFirstInterrupt: () => ui.warn('Cancelling security analysis…'),
      });

      try {
        if (!options.url && !options.config) {
          throw new ConfigError('A target is required: pass --url <https://api.example.com> or --config <file>');
        }
        if (options.url && options.config) {
          throw new ConfigError('Pass either --url or --config, not both');
        }
        if (!SEVERITIES.includes((options.threshold ?? 'high') as Severity)) {
          throw new ConfigError(`Invalid --threshold "${options.threshold}"`, [`Supported severities: ${SEVERITIES.join(', ')}`]);
        }
        const threshold = options.threshold as Severity;

        const formats: ReportFormat[] = parseFormats(
          options.reporter ? options.reporter.split(',') : undefined,
          ['terminal', 'html', 'json'],
        );

        let targetUrl: string;
        let headers: Record<string, string> = parseHeaders(options.header);
        let method = 'GET';
        type CheckSelection = {
          headers?: boolean;
          cors?: boolean | { origin: string; withCredentials?: boolean };
          cookies?: boolean;
          disclosure?: boolean;
          auth?: boolean;
          methods?: boolean | { methods: string[] };
          tls?: boolean;
        };
        let checkSelection: CheckSelection | undefined;
        let timeoutMs = parseTimeout(options.timeout);

        if (options.config) {
          const document = await readStructuredInput(options.config, 'security specification');
          const spec = parseSecurityDocument(document, options.config);
          const specUrl = spec.target.url ?? spec.target.path;
          if (!specUrl) throw new ConfigError('The security specification needs `target.url`');
          targetUrl = assertHttpUrl(specUrl, 'security target');
          method = spec.target.method ?? 'GET';
          headers = { ...(spec.target.headers ?? {}), ...headers };
          timeoutMs = timeoutMs ?? 10_000;
          if (spec.checks) {
            checkSelection = spec.checks as CheckSelection;
          }
        } else {
          targetUrl = assertHttpUrl(options.url as string);
        }

        // `--check` narrows (or widens) the configured checks.
        if (options.check && options.check.length > 0) {
          const known = new Set(['headers', 'cors', 'cookies', 'disclosure', 'auth', 'methods', 'tls']);
          for (const name of options.check) {
            if (!known.has(name)) {
              throw new ConfigError(`Unknown security check "${name}"`, [`Supported checks: ${[...known].join(', ')}`]);
            }
          }
          const selection: CheckSelection = {};
          if (options.check.includes('headers')) selection.headers = true;
          if (options.check.includes('cookies')) selection.cookies = true;
          if (options.check.includes('disclosure')) selection.disclosure = true;
          if (options.check.includes('auth')) selection.auth = true;
          if (options.check.includes('tls')) selection.tls = true;
          if (options.check.includes('methods')) selection.methods = true;
          if (options.check.includes('cors')) {
            selection.cors = options.origin ? { origin: options.origin } : true;
          }
          checkSelection = selection;
        }
        if (options.origin && (!checkSelection || checkSelection.cors !== false)) {
          checkSelection = { ...(checkSelection ?? {}), cors: { origin: options.origin } };
        }
        // The security engine only supports a boolean or a methods list for
        // the methods check; normalize a config-provided value.
        if (checkSelection && checkSelection.methods === false) {
          // explicitly disabled, nothing to do
        }

        ui.banner(TOOL_INFO.version);
        ui.line(ui.palette.gray(`Passive security analysis of ${targetUrl}`));
        ui.line(ui.palette.gray('This is not a penetration test. Only analyze systems you are authorized to test.'));
        ui.startSpinner('Analyzing response headers, cookies, TLS usage and disclosures…');

        const result = await runSecurity({
          url: targetUrl,
          method,
          headers,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(checkSelection ? { checks: checkSelection } : {}),
          threshold,
          ...(cancellation.signal ? { signal: cancellation.signal } : {}),
          ...(options.insecure === true ? { insecureTLS: true } : {}),
          tool: TOOL_INFO,
        });
        ui.stopSpinner();

        const findings: SecurityFinding[] = [...result.findings];

        // Optional schema-document review (OpenAPI or plain JSON Schema).
        if (options.schema) {
          const schemaPath = resolve(options.schema);
          let schemaDocument: Record<string, unknown>;
          try {
            const content = await readFile(schemaPath, 'utf8');
            const parsed = parseDocument(content, options.schema);
            if (parsed === null || typeof parsed !== 'object') {
              throw new ConfigError(`Schema file does not contain an object: ${options.schema}`);
            }
            schemaDocument = parsed as Record<string, unknown>;
          } catch (error) {
            if (error instanceof ConfigError) throw error;
            throw new ConfigError(`Could not read schema file: ${options.schema}`, [String((error as Error).message)]);
          }

          const isOpenApi = typeof schemaDocument.openapi === 'string' || typeof schemaDocument.swagger === 'string';
          if (isOpenApi) {
            const paths = schemaDocument.paths;
            let operationCount = 0;
            if (paths && typeof paths === 'object') {
              for (const item of Object.values(paths as Record<string, unknown>)) {
                if (!item || typeof item !== 'object') continue;
                operationCount += Object.keys(item as object).filter((key) =>
                  ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(key),
                ).length;
              }
            }
            const servers = Array.isArray(schemaDocument.servers) ? schemaDocument.servers : [];
            const hasHttpsServer = servers.some((server) => {
              const candidate = server as { url?: unknown };
              return typeof candidate.url === 'string' && candidate.url.startsWith('https://');
            });
            findings.push({
              id: 'schema.openapi.operations',
              title: `OpenAPI document declares ${operationCount} operation(s)`,
              category: 'specification',
              status: 'info',
              severity: 'info',
              description: 'Structural review of the provided OpenAPI document.',
              evidence: `${options.schema}: ${operationCount} operations, ${servers.length} server(s)`,
              remediation: 'No action needed.',
            });
            if (servers.length === 0) {
              findings.push({
                id: 'schema.openapi.no-servers',
                title: 'OpenAPI document declares no servers',
                category: 'specification',
                status: 'warn',
                severity: 'low',
                description: 'Clients cannot discover the base URL without a `servers` section.',
                evidence: options.schema,
                remediation: 'Add a `servers` entry with the production base URL.',
              });
            } else if (!hasHttpsServer) {
              findings.push({
                id: 'schema.openapi.http-server',
                title: 'OpenAPI server URLs are not HTTPS',
                category: 'specification',
                status: 'warn',
                severity: 'medium',
                description: 'All declared server URLs use plain HTTP.',
                evidence: JSON.stringify(servers),
                remediation: 'Declare HTTPS server URLs.',
              });
            }
          } else {
            const problem = checkSchemaCompiles(schemaDocument);
            if (problem) {
              findings.push({
                id: 'schema.invalid',
                title: 'JSON Schema document is invalid',
                category: 'specification',
                status: 'fail',
                severity: 'medium',
                description: 'The schema cannot be compiled, so it cannot be enforced.',
                evidence: problem,
                remediation: 'Fix the schema so it validates against Draft-07.',
              });
            } else {
              findings.push({
                id: 'schema.valid',
                title: 'JSON Schema document compiles successfully',
                category: 'specification',
                status: 'pass',
                severity: 'info',
                description: 'The schema can be used for contract and response validation.',
                evidence: options.schema,
                remediation: 'No action needed.',
              });
            }
          }

          // Recompute counts, score and pass/fail so the report reflects the
          // extra specification findings.
          const counts: Record<SecurityFinding['status'], number> = { pass: 0, warn: 0, fail: 0, info: 0, skipped: 0 };
          const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
          for (const finding of findings) {
            counts[finding.status] += 1;
            if (finding.status === 'fail' || finding.status === 'warn') bySeverity[finding.severity] += 1;
          }
          const rank: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
          result.findings = findings;
          result.counts = { ...counts, bySeverity };
          result.score = scoreFindings(findings);
          result.passed = !findings.some(
            (finding) => finding.status === 'fail' && rank[finding.severity] >= rank[threshold],
          );
        }

        const report = buildSecurityReport({
          title: 'APIFORGE security report',
          target: targetUrl,
          tool: TOOL_INFO,
          result,
        });
        report.findings = findings;

        if (!options.json) {
          ui.block(renderSecurityReport(report, { color: ui.palette.enabled, verbose: options.verbose === true }));
        }

        await emitReport(report, {
          ui,
          formats,
          ...(options.out ? { outDir: options.out } : {}),
          json: options.json === true,
          suppressTerminal: true,
          renderTerminal: () => renderSecurityReport(report, { color: false }),
        });

        process.exitCode = cancellation.interrupted ? EXIT_INTERRUPTED : report.passed ? EXIT_SUCCESS : EXIT_CHECKS_FAILED;
      } finally {
        cancellation.dispose();
        await closeHttpResources();
      }
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
