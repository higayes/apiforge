/**
 * Shared report output pipeline for all commands: terminal rendering, file
 * artifacts in every requested format, and `--json` mode for automation.
 */
import { resolve } from 'node:path';
import {
  writeReports,
  type AnyReport,
  type ReportFormat,
  type WrittenArtifact,
} from '@apiforge/engine';
import { ReportError } from '@apiforge/engine';
import { UsageError } from '@apiforge/engine';
import type { Ui } from '../ui.js';

export const ALLOWED_FORMATS: readonly ReportFormat[] = ['terminal', 'json', 'html', 'junit'];

export function parseFormats(
  values: string[] | undefined,
  fallback: ReportFormat[],
): ReportFormat[] {
  if (!values || values.length === 0) return fallback;
  const formats = new Set<ReportFormat>();
  for (const raw of values) {
    for (const part of raw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)) {
      if (!ALLOWED_FORMATS.includes(part as ReportFormat)) {
        throw new UsageError(`Unknown report format "${part}"`, [
          `Supported formats: ${ALLOWED_FORMATS.join(', ')}`,
        ]);
      }
      formats.add(part as ReportFormat);
    }
  }
  if (formats.size === 0) return fallback;
  return [...formats];
}

export interface EmitOptions {
  ui: Ui;
  /** Formats to write to disk (terminal is handled via `renderTerminal`). */
  formats: ReportFormat[];
  outDir?: string;
  /** JSON mode: print the report as JSON to stdout. */
  json: boolean;
  /** Suppress terminal rendering (e.g. `--reporter json`). */
  suppressTerminal?: boolean;
  baseName?: string;
  renderTerminal: () => string;
  /** Project-level default output directory. */
  defaultOutDir?: string;
  writeLatest?: boolean;
}

export interface EmitResult {
  artifacts: WrittenArtifact[];
  /** JSON emitted to stdout (for tests/inspection). */
  jsonPayload?: string;
}

export async function emitReport(report: AnyReport, options: EmitOptions): Promise<EmitResult> {
  const { ui } = options;
  const artifacts: WrittenArtifact[] = [];
  let jsonPayload: string | undefined;

  const wantsJsonStdout = options.json;

  if (!options.suppressTerminal && !wantsJsonStdout) {
    ui.block(options.renderTerminal());
  }

  const fileFormats = options.formats.filter((format) => format !== 'terminal');
  if (fileFormats.length > 0) {
    const outDir = resolve(options.outDir ?? options.defaultOutDir ?? 'reports');
    try {
      const written = await writeReports(report, {
        outDir,
        formats: fileFormats,
        ...(options.baseName ? { baseName: options.baseName } : {}),
        writeLatest: options.writeLatest ?? true,
      });
      artifacts.push(...written);
    } catch (error) {
      throw error instanceof ReportError
        ? error
        : new ReportError('Could not write reports', [String((error as Error).message)]);
    }
    if (!wantsJsonStdout && !ui.quiet) {
      for (const artifact of artifacts) {
        ui.detail(`report written: ${artifact.path}`);
      }
      if (artifacts.length > 0) {
        ui.info(`Reports written to ${outDir}`);
      }
    }
  }

  if (wantsJsonStdout) {
    // `--json` always writes machine-readable output to stdout, independent of
    // the `json` file format flag.
    if (!fileFormats.includes('json')) {
      const written = await writeReports(report, {
        outDir: resolve(options.outDir ?? options.defaultOutDir ?? 'reports'),
        formats: ['json'],
        ...(options.baseName ? { baseName: options.baseName } : {}),
        writeLatest: false,
      });
      artifacts.push(...written);
    }
    const jsonArtifact = artifacts.find((artifact) => artifact.format === 'json');
    if (jsonArtifact) {
      const { readFile } = await import('node:fs/promises');
      jsonPayload = await readFile(jsonArtifact.path, 'utf8');
      process.stdout.write(jsonPayload);
    }
  }

  return { artifacts, ...(jsonPayload ? { jsonPayload } : {}) };
}

/** Human summary of where reports were written. */
export function summarizeArtifacts(artifacts: WrittenArtifact[]): string {
  return artifacts.map((artifact) => `${artifact.format}: ${artifact.path}`).join('\n');
}
