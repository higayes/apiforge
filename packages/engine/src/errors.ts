/**
 * Typed error hierarchy used across the APIFORGE engine and CLI.
 * Every error carries a stable machine-readable `code` and optional details,
 * so the CLI can map failures onto documented exit codes.
 */
export type ErrorCode =
  | 'CONFIG'
  | 'VALIDATION'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'HTTP'
  | 'REPORT'
  | 'USAGE'
  | 'INTERNAL';

export interface ApiForgeErrorOptions {
  cause?: unknown;
  details?: string[];
}

export class ApiForgeError extends Error {
  readonly code: ErrorCode;
  readonly details: string[];

  constructor(message: string, code: ErrorCode = 'INTERNAL', options: ApiForgeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.details = options.details ?? [];
  }

  /** Single-line, user-facing description including details. */
  toUserMessage(): string {
    return this.details.length === 0 ? this.message : `${this.message}\n  - ${this.details.join('\n  - ')}`;
  }
}

/** Invalid project configuration, suite file, environment file or CLI input file. */
export class ConfigError extends ApiForgeError {
  constructor(message: string, details: string[] = [], cause?: unknown) {
    super(message, 'CONFIG', { details, cause });
  }
}

/** A parsed document did not satisfy the schema (includes field-level details). */
export class ValidationError extends ApiForgeError {
  constructor(message: string, details: string[] = [], cause?: unknown) {
    super(message, 'VALIDATION', { details, cause });
  }
}

export type RequestFailureKind = 'network' | 'timeout' | 'cancelled' | 'protocol';

/** A request could not be completed (DNS, TLS, connection, timeout, cancellation). */
export class RequestError extends ApiForgeError {
  readonly kind: RequestFailureKind;

  constructor(kind: RequestFailureKind, message: string, cause?: unknown) {
    super(message, kind === 'timeout' ? 'TIMEOUT' : kind === 'cancelled' ? 'CANCELLED' : 'NETWORK', {
      cause,
    });
    this.kind = kind;
  }
}

/** A report could not be generated or written. */
export class ReportError extends ApiForgeError {
  constructor(message: string, details: string[] = [], cause?: unknown) {
    super(message, 'REPORT', { details, cause });
  }
}

/** Wrong CLI usage (unknown flag combination, missing argument, ...). */
export class UsageError extends ApiForgeError {
  constructor(message: string, details: string[] = []) {
    super(message, 'USAGE', { details });
  }
}

export function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function toApiForgeError(error: unknown): ApiForgeError {
  if (error instanceof ApiForgeError) return error;
  return new ApiForgeError(describeUnknownError(error), 'INTERNAL', { cause: error });
}
