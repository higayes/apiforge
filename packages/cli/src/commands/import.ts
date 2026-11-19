import type { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { importOpenApiDocument, parseDocument, stringifySuite, type ImportOptions } from '@apiforge/engine';
import { EXIT_SUCCESS } from '../exit-codes.js';
import { createUiFromCommand } from '../lib/context.js';
import { TOOL_INFO } from '../lib/version.js';

interface ImportCommandOptions {
  out?: string;
  baseUrl?: string;
  tag?: string[];
  path?: string;
  schemas?: boolean;
  json?: boolean;
  color?: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

/** `apiforge import` converts OpenAPI 3.x / Swagger 2.0 into a runnable suite. */
export function registerImportCommand(program: Command): void {
  program
    .command('import <spec>')
    .description('Import an OpenAPI 3.x or Swagger 2.0 document as an APIFORGE test suite')
    .option('-o, --out <path>', 'output suite file (default: <spec-name>.suite.yaml)')
    .option('--base-url <url>', 'override the base URL from the specification')
    .option('--tag <tag>', 'only import operations with this tag (repeatable)', collect, [])
    .option('--path <regex>', 'only import paths matching this regular expression')
    .option('--schemas', 'include response JSON Schema assertions where available')
    .option('--json', 'emit a summary as JSON')
    .option('-q, --quiet', 'only print the final result')
    .option('-v, --verbose', 'show import warnings')
    .option('--no-color', 'disable coloured output')
    .action(async (specPath: string, options: ImportCommandOptions) => {
      const ui = createUiFromCommand(options);
      const absolute = resolve(specPath);
      let content: string;
      try {
        const { readFile } = await import('node:fs/promises');
        content = await readFile(absolute, 'utf8');
      } catch (error) {
        const { ConfigError } = await import('@apiforge/engine');
        const code = (error as { code?: string }).code;
        throw new ConfigError(code === 'ENOENT' ? `Specification not found: ${specPath}` : `Could not read specification: ${specPath}`, [
          String((error as Error).message),
        ]);
      }

      const document = parseDocument(content, specPath);
      const importOptions: ImportOptions = {
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.tag && options.tag.length > 0 ? { tags: options.tag } : {}),
        ...(options.path ? { pathPattern: options.path } : {}),
        ...(options.schemas === true ? { includeSchemas: true } : {}),
      };

      const result = importOpenApiDocument(document, importOptions);
      const outPath = resolve(options.out ?? `${basename(specPath).replace(/\.(ya?ml|json)$/i, '')}.suite.yaml`);
      await writeFile(outPath, stringifySuite(result.suite), 'utf8');

      for (const warning of result.warnings) ui.warn(warning);

      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ ok: true, suite: result.suite.name, operations: result.operationCount, out: outPath, warnings: result.warnings }, null, 2)}\n`,
        );
        process.exitCode = EXIT_SUCCESS;
        return;
      }

      ui.banner(TOOL_INFO.version);
      ui.success(`Imported ${result.operationCount} operation(s) as "${result.suite.name}"`);
      ui.line(`  ${ui.palette.green('+')} ${outPath}`);
      if (options.verbose) {
        for (const warning of result.warnings) ui.detail(warning);
      }
      ui.line();
      ui.line(`Next: review the generated suite, adjust variables/secrets, then run ${ui.palette.cyan(`apiforge test ${outPath}`)}`);
      process.exitCode = EXIT_SUCCESS;
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
