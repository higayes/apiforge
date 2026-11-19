/** Presentation helpers shared by the terminal and HTML reporters. */

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 100 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

export function truncate(text: string, max: number, suffix = '…'): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - suffix.length))}${suffix}`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape a JSON payload for safe inline embedding inside a <script> tag. */
export function escapeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}

const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** Compact table renderer used by terminal output (no external deps). */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => {
    const cellWidths = rows.map((row) => stripAnsi(row[index] ?? '').length);
    return Math.max(header.length, ...cellWidths);
  });
  const formatRow = (cells: string[]): string =>
    cells
      .map((cell, index) => {
        const visible = stripAnsi(cell).length;
        return `${cell}${' '.repeat(Math.max(0, (widths[index] ?? 0) - visible))}`;
      })
      .join('  ')
      .trimEnd();
  const separator = widths.map((width) => '─'.repeat(width)).join('  ');
  return [formatRow(headers), separator, ...rows.map(formatRow)].join('\n');
}

export function toSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Filesystem-safe timestamp like 2026-11-19T10-30-00Z. */
export function fileTimestamp(date = new Date()): string {
  return date
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\.\d+Z$/, 'Z');
}
