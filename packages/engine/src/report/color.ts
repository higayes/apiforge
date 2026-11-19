/**
 * Minimal ANSI color support with NO_COLOR / FORCE_COLOR / TTY detection.
 * Kept dependency-free so terminal output works identically everywhere.
 */
export interface Palette {
  enabled: boolean;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  blue(text: string): string;
  magenta(text: string): string;
  cyan(text: string): string;
  gray(text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  underline(text: string): string;
}

function wrap(enabled: boolean, open: number, close: number, text: string): string {
  return enabled ? `\u001B[${open}m${text}\u001B[${close}m` : text;
}

export function detectColorSupport(stream: { isTTY?: boolean } | undefined = process.stdout): boolean {
  const env = process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR === '0') return false;
  if (env.FORCE_COLOR === '1' || env.FORCE_COLOR === '2' || env.FORCE_COLOR === '3') return true;
  if (env.TERM === 'dumb') return false;
  return stream?.isTTY === true;
}

export function createPalette(enabled: boolean): Palette {
  return {
    enabled,
    red: (text) => wrap(enabled, 31, 39, text),
    green: (text) => wrap(enabled, 32, 39, text),
    yellow: (text) => wrap(enabled, 33, 39, text),
    blue: (text) => wrap(enabled, 34, 39, text),
    magenta: (text) => wrap(enabled, 35, 39, text),
    cyan: (text) => wrap(enabled, 36, 39, text),
    gray: (text) => wrap(enabled, 90, 39, text),
    bold: (text) => wrap(enabled, 1, 22, text),
    dim: (text) => wrap(enabled, 2, 22, text),
    underline: (text) => wrap(enabled, 4, 24, text),
  };
}

export function severityColor(palette: Palette, severity: string): (text: string) => string {
  switch (severity) {
    case 'critical':
      return (text) => wrap(palette.enabled, 97, 39, wrap(palette.enabled, 41, 49, text));
    case 'high':
      return palette.red;
    case 'medium':
      return palette.yellow;
    case 'low':
      return palette.cyan;
    default:
      return palette.gray;
  }
}
