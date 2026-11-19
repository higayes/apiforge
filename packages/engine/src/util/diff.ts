/**
 * Line-based unified diff plus JSON structural diffing. Reporters use these to
 * produce actionable failure messages instead of "expected X, got Y".
 */

const MAX_DIFF_LINES = 400;

export interface DiffOptions {
  labelA?: string;
  labelB?: string;
  contextLines?: number;
  maxLines?: number;
}

interface LineDiff {
  type: 'equal' | 'add' | 'remove';
  line: string;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.replace(/\r\n/g, '\n').split('\n');
}

/** LCS-based line diff; falls back to a coarse summary for very large inputs. */
export function diffLines(a: string, b: string): LineDiff[] {
  const linesA = splitLines(a);
  const linesB = splitLines(b);
  if (linesA.length > 2000 || linesB.length > 2000) {
    return [
      ...linesA.map((line) => ({ type: 'remove' as const, line })),
      ...linesB.map((line) => ({ type: 'add' as const, line })),
    ];
  }

  const n = linesA.length;
  const m = linesB.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = table[i] as number[];
    const nextRow = table[i + 1] as number[];
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] =
        linesA[i] === linesB[j]
          ? (nextRow[j + 1] as number) + 1
          : Math.max(nextRow[j] as number, row[j + 1] as number);
    }
  }

  const out: LineDiff[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (linesA[i] === linesB[j]) {
      out.push({ type: 'equal', line: linesA[i] as string });
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      out.push({ type: 'remove', line: linesA[i] as string });
      i += 1;
    } else {
      out.push({ type: 'add', line: linesB[j] as string });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ type: 'remove', line: linesA[i] as string });
    i += 1;
  }
  while (j < m) {
    out.push({ type: 'add', line: linesB[j] as string });
    j += 1;
  }
  return out;
}

/** Render a unified diff (`--- a`, `+++ b`, `@@` hunks) with context. */
export function unifiedDiff(a: string, b: string, options: DiffOptions = {}): string {
  const labelA = options.labelA ?? 'expected';
  const labelB = options.labelB ?? 'actual';
  const context = Math.max(0, options.contextLines ?? 2);
  const maxLines = options.maxLines ?? MAX_DIFF_LINES;
  const ops = diffLines(a, b);
  const changedIndexes = ops
    .map((op, index) => (op.type === 'equal' ? -1 : index))
    .filter((index) => index >= 0);
  if (changedIndexes.length === 0) return '';

  const keep = new Set<number>();
  for (const index of changedIndexes) {
    for (let k = index - context; k <= index + context; k += 1) {
      if (k >= 0 && k < ops.length) keep.add(k);
    }
  }

  const lines: string[] = [`--- ${labelA}`, `+++ ${labelB}`];
  let lastKept = -2;
  let emitted = 0;
  for (let index = 0; index < ops.length; index += 1) {
    if (!keep.has(index)) continue;
    if (emitted >= maxLines) {
      lines.push(`… diff truncated after ${maxLines} lines`);
      break;
    }
    if (index !== lastKept + 1) {
      const previous = ops[index - 1];
      const oldStart = index + 1;
      lines.push(`@@ -${oldStart},${context} +${oldStart},${context} @@`);
      if (previous && previous.type === 'equal') lines.push(` ${previous.line}`);
    }
    const op = ops[index] as LineDiff;
    const prefix = op.type === 'equal' ? ' ' : op.type === 'add' ? '+' : '-';
    lines.push(`${prefix}${op.line}`);
    emitted += 1;
    lastKept = index;
  }
  return lines.join('\n');
}

export interface ValueDifference {
  path: string;
  expected: unknown;
  actual: unknown;
}

const MAX_VALUE_DIFFS = 25;

/** Structural JSON diff returning the first N differing leaf paths. */
export function diffJson(
  expected: unknown,
  actual: unknown,
  basePath = '$',
  out: ValueDifference[] = [],
): ValueDifference[] {
  if (out.length >= MAX_VALUE_DIFFS) return out;

  if (expected === actual) return out;
  if (
    typeof expected === 'number' &&
    typeof actual === 'number' &&
    Number.isNaN(expected) &&
    Number.isNaN(actual)
  ) {
    return out;
  }

  const expectedIsObject = expected !== null && typeof expected === 'object';
  const actualIsObject = actual !== null && typeof actual === 'object';

  if (expectedIsObject && actualIsObject) {
    if (Array.isArray(expected) !== Array.isArray(actual)) {
      out.push({ path: basePath, expected, actual });
      return out;
    }
    if (Array.isArray(expected) && Array.isArray(actual)) {
      const length = Math.max(expected.length, actual.length);
      for (let i = 0; i < length; i += 1) {
        diffJson(expected[i], actual[i], `${basePath}[${i}]`, out);
        if (out.length >= MAX_VALUE_DIFFS) return out;
      }
      return out;
    }
    const expectedObj = expected as Record<string, unknown>;
    const actualObj = actual as Record<string, unknown>;
    const keys = new Set([...Object.keys(expectedObj), ...Object.keys(actualObj)]);
    for (const key of keys) {
      diffJson(expectedObj[key], actualObj[key], `${basePath}.${key}`, out);
      if (out.length >= MAX_VALUE_DIFFS) return out;
    }
    return out;
  }

  out.push({ path: basePath, expected, actual });
  return out;
}

export function summarizeValueDiff(expected: unknown, actual: unknown): string | undefined {
  const differences = diffJson(expected, actual);
  if (differences.length === 0) return undefined;
  const lines = differences.slice(0, 5).map((difference) => {
    return `${difference.path}: expected ${formatValue(difference.expected)}, got ${formatValue(difference.actual)}`;
  });
  if (differences.length > 5) lines.push(`… ${differences.length - 5} more difference(s)`);
  return lines.join('\n');
}

export function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try {
      const text = JSON.stringify(value);
      return text.length > 300 ? `${text.slice(0, 300)}…` : text;
    } catch {
      return String(value);
    }
  }
  return String(value);
}
