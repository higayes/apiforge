/**
 * Configuration schemas for suites, environments and the project file.
 *
 * YAML and JSON are both accepted; JSON is simply parsed first when the file
 * appears to be JSON. All validation errors are reported with the exact field
 * path and a human explanation.
 */
import { z } from 'zod';
import YAML from 'yaml';
import { ConfigError, ValidationError } from '../errors.js';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const httpMethod = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9-]{0,31}$/, 'Invalid HTTP method')
  .transform((value) => value.toUpperCase());

const headerValue = z.union([z.string(), z.number(), z.boolean()]).transform((value) => String(value));
/** `null` is accepted as "empty" because a YAML map with only comments parses as null. */
const headersSchema = z.preprocess((value) => value ?? {}, z.record(z.string(), headerValue));
const optionalRecord = (valueSchema: z.ZodType) =>
  z.preprocess((value) => value ?? {}, z.record(z.string(), valueSchema));
const variablesSchema = optionalRecord(z.unknown());

const scalarString = z
  .union([z.string(), z.number(), z.boolean()])
  .transform((value) => String(value));

const durationMs = z.number().int().min(0).max(600_000);

/** Normalize arbitrary JSON/YAML into a serializer-friendly value. */
function describeZodIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
  return `${path}: ${issue.message}`;
}

export function zodErrorToValidationError(error: z.ZodError, context: string): ValidationError {
  const details = error.issues.slice(0, 25).map(describeZodIssue);
  return new ValidationError(`Invalid ${context}`, details, error);
}

/* ------------------------------- Assertions ------------------------------- */

const checkKeys = [
  'equals',
  'notEquals',
  'exists',
  'type',
  'matches',
  'min',
  'max',
  'gt',
  'gte',
  'lt',
  'lte',
  'length',
  'minLength',
  'maxLength',
  'in',
  'notIn',
  'contains',
  'notContains',
  'every',
  'some',
  'schema',
] as const;

export type ValueCheck = {
  equals?: unknown;
  notEquals?: unknown;
  exists?: boolean;
  type?: 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';
  matches?: string;
  min?: number;
  max?: number;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  length?: number;
  minLength?: number;
  maxLength?: number;
  in?: unknown[];
  notIn?: unknown[];
  contains?: unknown;
  notContains?: unknown;
  every?: ValueCheck | unknown;
  some?: ValueCheck | unknown;
  schema?: Record<string, unknown>;
};

const jsonSchemaObject = z.record(z.string(), z.unknown());

const valueCheckObject: z.ZodType<ValueCheck> = z.lazy(() =>
  z.strictObject({
    equals: z.unknown().optional(),
    notEquals: z.unknown().optional(),
    exists: z.boolean().optional(),
    type: z.enum(['string', 'number', 'boolean', 'null', 'array', 'object']).optional(),
    matches: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
    length: z.number().int().nonnegative().optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    in: z.array(z.unknown()).optional(),
    notIn: z.array(z.unknown()).optional(),
    contains: z.unknown().optional(),
    notContains: z.unknown().optional(),
    every: z.unknown().optional(),
    some: z.unknown().optional(),
    schema: jsonSchemaObject.optional(),
  }),
);

/**
 * A check is either a literal (shorthand for `equals`), or an object with one
 * or more supported operators. Objects that contain no known operator are
 * treated as literal expected values (deep equality).
 */
export const valueCheckSchema: z.ZodType<ValueCheck> = z.union([
  z.string().transform((value) => ({ equals: value }) as ValueCheck),
  z.number().transform((value) => ({ equals: value }) as ValueCheck),
  z.boolean().transform((value) => ({ equals: value }) as ValueCheck),
  z.null().transform(() => ({ equals: null }) as ValueCheck),
  z.array(z.unknown()).transform((value) => ({ equals: value }) as ValueCheck),
  z.preprocess((input) => {
    if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
      const keys = Object.keys(input);
      const looksLikeCheck = keys.some((key) => (checkKeys as readonly string[]).includes(key));
      if (!looksLikeCheck) return { equals: input };
    }
    return input;
  }, valueCheckObject),
]);

const headerCheckSchema = z.strictObject({
  equals: z.string().optional(),
  notEquals: z.string().optional(),
  contains: z.string().optional(),
  notContains: z.string().optional(),
  matches: z.string().optional(),
  exists: z.boolean().optional(),
  in: z.array(z.string()).optional(),
});

export type HeaderCheck = z.infer<typeof headerCheckSchema>;

const statusExpectation = z.union([
  z.number().int().min(100).max(599),
  z.array(z.number().int().min(100).max(599)).min(1),
  z.strictObject({ in: z.array(z.number().int().min(100).max(599)).min(1) }),
  z.strictObject({ min: z.number().int().min(100).max(599), max: z.number().int().min(100).max(599) }),
]);

const bodyExpectation = z.strictObject({
  equals: z.union([z.string(), z.unknown()]).optional(),
  notEquals: z.string().optional(),
  contains: z.string().optional(),
  notContains: z.string().optional(),
  matches: z.string().optional(),
  json: jsonSchemaObject.optional(),
  schema: jsonSchemaObject.optional(),
});

const timeExpectation = z.strictObject({
  lessThan: z.number().nonnegative().optional(),
  moreThan: z.number().nonnegative().optional(),
});

export const expectSchema = z.strictObject({
  status: statusExpectation.optional(),
  statusText: z.string().optional(),
  headers: z.record(z.string(), headerCheckSchema).optional(),
  jsonPath: z.record(z.string(), valueCheckSchema).optional(),
  body: bodyExpectation.optional(),
  time: timeExpectation.optional(),
});

export type ExpectDefinition = z.infer<typeof expectSchema>;

/* -------------------------------- Requests -------------------------------- */

const authSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('bearer'),
    token: z.string(),
  }),
  z.strictObject({
    type: z.literal('basic'),
    username: z.string(),
    password: z.string(),
  }),
  z.strictObject({
    type: z.literal('apikey'),
    in: z.enum(['header', 'query']).default('header'),
    name: z.string().min(1),
    value: z.string(),
  }),
]);

export type AuthDefinition = z.infer<typeof authSchema>;

const bodySchema = z.union([
  z.strictObject({ json: z.unknown() }),
  z.strictObject({ text: z.string() }),
  z.strictObject({ form: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) }),
  z.strictObject({ urlencoded: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) }),
  z.strictObject({ file: z.string() }),
]);

export type BodyDefinition = z.infer<typeof bodySchema>;

const captureSpec = z.union([
  z.string().transform((path) => ({ jsonPath: path })),
  z.strictObject({ jsonPath: z.string() }),
  z.strictObject({ header: z.string() }),
  z.strictObject({ status: z.boolean() }),
  z.strictObject({ body: z.boolean() }),
]);

export type CaptureDefinition = z.infer<typeof captureSpec>;

const queryValue = z.union([z.string(), z.number(), z.boolean()]);
const querySchema = z.record(z.string(), z.union([queryValue, z.array(queryValue)]));

export const requestDefaultsSchema = z.strictObject({
  headers: headersSchema.optional(),
  query: querySchema.optional(),
  timeoutMs: durationMs.optional(),
  retries: z.number().int().min(0).max(10).optional(),
  followRedirects: z.boolean().optional(),
  maxRedirects: z.number().int().min(0).max(50).optional(),
});

export type RequestDefaults = z.infer<typeof requestDefaultsSchema>;

export const testSchema = z.strictObject({
  name: z.string().min(1),
  id: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, 'Test id must start with a letter or underscore')
    .optional(),
  description: z.string().optional(),
  method: httpMethod.default('GET'),
  path: z.string().optional(),
  url: z.string().optional(),
  headers: headersSchema.optional(),
  query: querySchema.optional(),
  cookies: z.record(z.string(), z.string()).optional(),
  auth: authSchema.optional(),
  body: bodySchema.optional(),
  timeoutMs: durationMs.optional(),
  retries: z.number().int().min(0).max(10).optional(),
  followRedirects: z.boolean().optional(),
  maxRedirects: z.number().int().min(0).max(50).optional(),
  capture: z.record(z.string(), captureSpec).optional(),
  expect: expectSchema.optional(),
  skip: z.union([z.boolean(), z.string()]).optional(),
  tags: z.array(z.string()).optional(),
  data: z.array(z.record(z.string(), z.unknown())).optional(),
  dataFile: z.string().optional(),
});

export type TestDefinition = z.infer<typeof testSchema>;

/* -------------------------------- Thresholds ------------------------------- */

export const thresholdMetricSchema = z.enum([
  'total',
  'passed',
  'failed',
  'successRate',
  'durationMs',
  'p50',
  'p90',
  'p95',
  'p99',
  'rps',
  'errorRate',
]);

export type ThresholdMetricName = z.infer<typeof thresholdMetricSchema>;

export const thresholdDefinitionSchema = z
  .strictObject({
    metric: thresholdMetricSchema,
    min: z.number().optional(),
    max: z.number().optional(),
    description: z.string().optional(),
  })
  .refine((value) => value.min !== undefined || value.max !== undefined, {
    message: 'A threshold needs at least one of `min` or `max`',
  });

export type ThresholdDefinition = z.infer<typeof thresholdDefinitionSchema>;

/* ---------------------------------- Suite ---------------------------------- */

export const suiteSchema = z
  .strictObject({
    name: z.string().min(1),
    description: z.string().optional(),
    baseUrl: z.string().optional(),
    variables: variablesSchema.optional(),
    secrets: variablesSchema.optional(),
    defaults: requestDefaultsSchema.optional(),
    thresholds: z.array(thresholdDefinitionSchema).optional(),
    tests: z.array(testSchema).min(1, 'A suite needs at least one test'),
  })
  .refine((suite) => suite.tests.every((test) => test.path !== undefined || test.url !== undefined), {
    message: 'Every test needs either `path` or `url`',
    path: ['tests'],
  });

export type SuiteDefinition = z.infer<typeof suiteSchema>;

/* ------------------------------- Environment ------------------------------- */

export const environmentSchema = z.strictObject({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  baseUrl: z.string().optional(),
  variables: variablesSchema.optional(),
  secrets: variablesSchema.optional(),
  timeoutMs: durationMs.optional(),
  headers: headersSchema.optional(),
});

export type EnvironmentDefinition = z.infer<typeof environmentSchema>;

/* --------------------------------- Project --------------------------------- */

const reportFormats = z.enum(['terminal', 'json', 'html', 'junit']);

export const projectSchema = z.strictObject({
  name: z.string().optional(),
  description: z.string().optional(),
  defaultEnvironment: z.string().optional(),
  environmentsDir: z.string().optional(),
  suites: z.array(z.string()).optional(),
  reports: z
    .strictObject({
      formats: z.array(reportFormats).optional(),
      outDir: z.string().optional(),
      title: z.string().optional(),
      open: z.boolean().optional(),
    })
    .optional(),
  defaults: z
    .strictObject({
      environment: z.string().optional(),
      timeoutMs: durationMs.optional(),
      headers: headersSchema.optional(),
      retries: z.number().int().min(0).max(10).optional(),
      followRedirects: z.boolean().optional(),
    })
    .optional(),
  performance: z
    .strictObject({
      concurrency: z.number().int().min(1).max(100).optional(),
      durationSeconds: z.number().positive().max(3600).optional(),
      maxRequests: z.number().int().min(1).max(100_000).optional(),
      timeoutMs: durationMs.optional(),
      thinkTimeMs: durationMs.optional(),
      warmupRequests: z.number().int().min(0).max(1000).optional(),
      thresholds: z.array(thresholdDefinitionSchema).optional(),
    })
    .optional(),
  security: z
    .strictObject({
      threshold: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      checks: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  thresholds: z.array(thresholdDefinitionSchema).optional(),
});

export type ProjectConfig = z.infer<typeof projectSchema>;

/* ------------------------------- Performance ------------------------------- */

export const performanceTargetSchema = z.strictObject({
  method: httpMethod.default('GET'),
  url: z.string().optional(),
  path: z.string().optional(),
  headers: headersSchema.optional(),
  query: querySchema.optional(),
  cookies: z.record(z.string(), z.string()).optional(),
  auth: authSchema.optional(),
  body: bodySchema.optional(),
});

export const performanceSpecSchema = z.strictObject({
  target: performanceTargetSchema,
  concurrency: z.number().int().min(1).max(100).default(5),
  durationSeconds: z.number().positive().max(3600).optional(),
  maxRequests: z.number().int().min(1).max(100_000).optional(),
  timeoutMs: durationMs.default(10_000),
  thinkTimeMs: durationMs.default(0),
  warmupRequests: z.number().int().min(0).max(1000).default(0),
  thresholds: z.array(thresholdDefinitionSchema).optional(),
});

export type PerformanceSpec = z.infer<typeof performanceSpecSchema>;

/* --------------------------------- Security -------------------------------- */

export const securitySpecSchema = z.strictObject({
  target: performanceTargetSchema.pick({ url: true, path: true, headers: true, method: true }),
  threshold: z.enum(['critical', 'high', 'medium', 'low']).default('high'),
  checks: z
    .strictObject({
      headers: z.boolean().optional(),
      cors: z.union([z.boolean(), z.strictObject({ origin: z.string(), withCredentials: z.boolean().optional() })]).optional(),
      cookies: z.boolean().optional(),
      disclosure: z.boolean().optional(),
      auth: z.boolean().optional(),
      methods: z.union([z.boolean(), z.strictObject({ methods: z.array(httpMethod).min(1) })]).optional(),
      tls: z.boolean().optional(),
    })
    .optional(),
});

export type SecuritySpec = z.infer<typeof securitySpecSchema>;

/* -------------------------------- Contract --------------------------------- */

export const contractSpecSchema = z.strictObject({
  target: performanceTargetSchema,
  baseline: z.string().optional(),
  update: z.boolean().optional(),
  schema: z.string().optional(),
});

export type ContractSpec = z.infer<typeof contractSpecSchema>;

/* -------------------------------- Parsing ---------------------------------- */

export interface ParseOptions {
  /** Label used in error messages, usually the file path. */
  context?: string;
}

export function parseDocument(content: string, context = 'document'): unknown {
  const trimmed = content.replace(/^\uFEFF/, '').trimStart();
  if (trimmed === '') throw new ConfigError(`${context} is empty`);
  try {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return JSON.parse(trimmed) as unknown;
    }
    const parsed: unknown = YAML.parse(content, { strict: true, uniqueKeys: true });
    if (parsed === null || parsed === undefined) throw new Error('document is empty');
    return parsed;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Could not parse ${context}`, [message], error);
  }
}

function validateWith<T>(schema: z.ZodType<T>, document: unknown, context: string): T {
  const result = schema.safeParse(document);
  if (!result.success) throw zodErrorToValidationError(result.error, context);
  return result.data;
}

export function parseSuiteDocument(document: unknown, context = 'suite'): SuiteDefinition {
  return validateWith(suiteSchema, document, context);
}

export function parseSuiteFile(content: string, context = 'suite'): SuiteDefinition {
  return parseSuiteDocument(parseDocument(content, context), context);
}

export function parseEnvironmentDocument(document: unknown, context = 'environment'): EnvironmentDefinition {
  return validateWith(environmentSchema, document, context);
}

export function parseEnvironmentFile(content: string, context = 'environment'): EnvironmentDefinition {
  return parseEnvironmentDocument(parseDocument(content, context), context);
}

export function parseProjectDocument(document: unknown, context = 'project configuration'): ProjectConfig {
  return validateWith(projectSchema, document, context);
}

export function parseProjectFile(content: string, context = 'project configuration'): ProjectConfig {
  return parseProjectDocument(parseDocument(content, context), context);
}

export function parsePerformanceDocument(document: unknown, context = 'performance specification'): PerformanceSpec {
  return validateWith(performanceSpecSchema, document, context);
}

export function parseSecurityDocument(document: unknown, context = 'security specification'): SecuritySpec {
  return validateWith(securitySpecSchema, document, context);
}

export function parseContractDocument(document: unknown, context = 'contract specification'): ContractSpec {
  return validateWith(contractSpecSchema, document, context);
}

/** Serialize a suite back to YAML (used by `apiforge init` and importers). */
export function stringifySuite(suite: SuiteDefinition): string {
  return YAML.stringify(suite, { lineWidth: 100 });
}
