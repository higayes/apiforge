/**
 * Report writer: renders every requested format, writes files atomically and
 * returns the list of artifacts. Failures to write are surfaced as
 * `ReportError` — silently missing reports would be worse than an error.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ReportError } from '../errors.js';
import type { AnyReport, ContractReport, PerformanceReport, SecurityReport, TestReport } from '../types.js';
import { renderTestJson, renderPerformanceJson, renderSecurityJson, renderContractJson } from './json.js';
import { renderJUnit } from './junit.js';
import {
  renderContractHtml,
  renderPerformanceHtml,
  renderSecurityHtml,
  renderTestHtml,
  reportFileBase,
} from './html.js';

export type ReportFormat = 'terminal' | 'json' | 'html' | 'junit';

export interface WrittenArtifact {
  format: Exclude<ReportFormat, 'terminal'>;
  path: string;
  bytes: number;
}

export interface WriteReportsOptions {
  outDir: string;
  formats: ReportFormat[];
  /** Base file name (without extension). Defaults to `kind-timestamp`. */
  baseName?: string;
  /** Also write a stable `latest.<ext>` copy for dashboards. */
  writeLatest?: boolean;
}

function serializeHtml(report: AnyReport): string {
  switch (report.kind) {
    case 'test':
      return renderTestHtml(report);
    case 'performance':
      return renderPerformanceHtml(report);
    case 'security':
      return renderSecurityHtml(report);
    case 'contract':
      return renderContractHtml(report);
  }
}

function serializeJson(report: AnyReport): string {
  switch (report.kind) {
    case 'test':
      return renderTestJson(report as TestReport);
    case 'performance':
      return renderPerformanceJson(report as PerformanceReport);
    case 'security':
      return renderSecurityJson(report as SecurityReport);
    case 'contract':
      return renderContractJson(report as ContractReport);
  }
}

async function writeAtomic(path: string, content: string): Promise<number> {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temp, content, 'utf8');
    await rename(temp, path);
    return Buffer.byteLength(content, 'utf8');
  } catch (error) {
    throw new ReportError(`Could not write report file: ${path}`, [String((error as Error).message)], error);
  }
}

export async function writeReports(report: AnyReport, options: WriteReportsOptions): Promise<WrittenArtifact[]> {
  const formats = options.formats.filter((format): format is Exclude<ReportFormat, 'terminal'> => format !== 'terminal');
  if (formats.length === 0) return [];

  const outDir = resolve(options.outDir);
  try {
    await mkdir(outDir, { recursive: true });
  } catch (error) {
    throw new ReportError(`Could not create report directory: ${outDir}`, [String((error as Error).message)], error);
  }

  const base = options.baseName ?? reportFileBase(report.title, report.kind, new Date(report.generatedAt));
  const artifacts: WrittenArtifact[] = [];

  for (const format of formats) {
    const extension = format === 'junit' ? 'xml' : format;
    const content = format === 'json' ? serializeJson(report) : format === 'junit' ? renderJUnit(report as TestReport) : serializeHtml(report);
    const path = join(outDir, `${base}.${extension}`);
    const bytes = await writeAtomic(path, content);
    artifacts.push({ format, path, bytes });
    if (options.writeLatest) {
      await writeAtomic(join(outDir, `latest.${extension}`), content);
    }
  }

  return artifacts;
}
