/**
 * Runs the *built* CLI binary in a child process. Tests therefore exercise the
 * real entry point, argument parsing, exit codes and output streams.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_ENTRY = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface CliRunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  stdin?: string;
}

export function runCli(args: string[], options: CliRunOptions = {}): Promise<CliResult> {
  // These tests drive the *built* bundle. Without it every assertion fails with
  // an opaque exit code, so say exactly what is wrong and how to fix it.
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      `The CLI bundle is missing at ${CLI_ENTRY}.\n` +
        'These tests run the built binary, so `pnpm build` must run first ' +
        '(it is part of `pnpm verify`).',
    );
  }
  const timeoutMs = options.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        NO_COLOR: '1',
        FORCE_COLOR: undefined,
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(
          `CLI timed out after ${timeoutMs}ms: apiforge ${args.join(' ')}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

/** Create a temporary directory with the given files. */
export async function makeTempProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'apiforge-cli-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    const segments = path.split('/');
    if (segments.length > 1) {
      await mkdir(join(dir, ...segments.slice(0, -1)), { recursive: true });
    }
    await writeFile(full, content, 'utf8');
  }
  return dir;
}

export { CLI_ENTRY };
