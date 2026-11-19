/**
 * Secret masking. Nothing sensitive should ever reach a report, terminal log or
 * JSON export. Redaction happens at serialization boundaries, on copies only.
 */

const SENSITIVE_KEY_PATTERN =
  /(^|[._-])(authorization|auth|api[-_]?key|x-api-key|secret|client[-_]?secret|token|access[-_]?token|refresh[-_]?token|password|passwd|pwd|session[-_]?id|cookie|set-cookie|private[-_]?key|credential|signature|sig)($|[._-])/i;

const SIMPLE_SENSITIVE_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'apikey',
  'api-key',
  'token',
  'access_token',
  'accesstoken',
  'refresh_token',
  'password',
  'passwd',
  'secret',
]);

export const REDACTED = '[REDACTED]';

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  if (SIMPLE_SENSITIVE_KEYS.has(normalized)) return true;
  return SENSITIVE_KEY_PATTERN.test(normalized);
}

/** Mask a sensitive header value while keeping its scheme (`Bearer …`). */
export function maskHeaderValue(name: string, value: string): string {
  if (!isSensitiveKey(name)) return value;
  const schemeMatch = /^(Bearer|Basic|Digest|Token|ApiKey)\s+/i.exec(value);
  if (schemeMatch) return `${schemeMatch[1]} ${REDACTED}`;
  return REDACTED;
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = maskHeaderValue(key, value);
  }
  return out;
}

/**
 * Mask any occurrence of known secret *values* inside a string. This is the
 * last line of defence for secrets interpolated into URLs or headers under
 * non-obvious parameter names (`?t=`, `?sig=`, custom headers...).
 */
export function redactKnownSecrets(text: string, secrets: readonly string[]): string {
  if (!text || secrets.length === 0) return text;
  // Longest first so a secret containing another is masked whole.
  const ordered = [...new Set(secrets.filter((secret) => secret.length >= 3))].sort(
    (a, b) => b.length - a.length,
  );
  let out = text;
  for (const secret of ordered) {
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** Mask matching secret values inside an already-encoded URL component form. */
export function redactSecretsInUrl(rawUrl: string, secrets: readonly string[]): string {
  if (secrets.length === 0) return rawUrl;
  const encoded = secrets.flatMap((secret) => {
    const variants = [
      secret,
      encodeURIComponent(secret),
      new URLSearchParams({ v: secret }).toString().slice(2),
    ];
    return variants.filter((variant) => variant.length >= 3);
  });
  return redactKnownSecrets(rawUrl, encoded);
}

/** Mask values of sensitive query parameters so URLs can be shared safely. */
export function redactUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Relative or malformed URL: mask obvious inline secrets via regex.
    return rawUrl.replace(
      /((?:token|api[-_]?key|apikey|secret|password)=)[^&\s]+/gi,
      (_match, prefix: string) => `${prefix}${REDACTED}`,
    );
  }
  for (const key of [...url.searchParams.keys()]) {
    if (isSensitiveKey(key)) {
      url.searchParams.set(key, REDACTED);
    }
  }
  if (url.username || url.password) {
    url.username = url.username ? REDACTED : '';
    url.password = url.password ? REDACTED : '';
  }
  return url.toString();
}

const MAX_REDACTION_DEPTH = 32;

/** Recursively mask object properties whose keys look sensitive. */
export function redactUnknown(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACTION_DEPTH) return '[MAX_DEPTH]';
  if (Array.isArray(value)) return value.map((entry) => redactUnknown(entry, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactUnknown(entry, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Redact a response body preview: JSON is redacted structurally, plain text is
 * passed through (truncate it before calling this).
 */
export function redactBodyText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return JSON.stringify(redactUnknown(parsed), null, 2);
    } catch {
      // Not valid JSON, fall through to the textual masking below.
    }
  }
  return text.replace(
    /("?(?:token|api[_-]?key|secret|password|authorization)"?\s*[:=]\s*)("[^"]*"|[^\s,;]+)/gi,
    (_match, prefix: string) => `${prefix}${REDACTED}`,
  );
}

/** Show enough of a secret to verify which value is configured, without leaking it. */
export function maskSecretPreservingShape(secret: string, visible = 3): string {
  if (!secret) return '';
  if (secret.length <= visible * 2) return '*'.repeat(secret.length);
  return `${secret.slice(0, visible)}…${secret.slice(-visible)}`;
}
