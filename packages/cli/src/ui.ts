/**
 * Terminal UI helpers: colours, symbols, progress spinner, tables and the
 * banner. Everything degrades gracefully when output is not a TTY, when
 * `NO_COLOR` is set, or in JSON mode.
 */
import { createPalette, detectColorSupport, type Palette } from '@apiforge/engine';

export interface UiOptions {
  color?: boolean;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  /** Stream used for non-error output (injectable for tests). */
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

export class Ui {
  readonly palette: Palette;
  readonly json: boolean;
  readonly quiet: boolean;
  readonly verbose: boolean;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  private spinnerTimer: NodeJS.Timeout | undefined;
  private spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private spinnerIndex = 0;
  private spinnerLabel = '';
  private isTTY: boolean;

  constructor(options: UiOptions = {}) {
    this.stdout = (options.stdout ?? process.stdout) as NodeJS.WriteStream;
    this.stderr = (options.stderr ?? process.stderr) as NodeJS.WriteStream;
    this.json = options.json ?? false;
    this.quiet = options.quiet ?? false;
    this.verbose = options.verbose ?? false;
    const colorEnabled = options.color ?? detectColorSupport(this.stdout);
    this.palette = createPalette(colorEnabled && !this.json);
    this.isTTY = this.stdout.isTTY === true && !this.json;
  }

  get interactive(): boolean {
    return this.isTTY;
  }

  write(text: string): void {
    this.stdout.write(text);
  }

  line(text = ''): void {
    if (this.quiet) return;
    this.stdout.write(`${text}\n`);
  }

  error(text: string): void {
    this.stderr.write(`${text}\n`);
  }

  banner(version?: string): void {
    if (this.quiet || this.json) return;
    const p = this.palette;
    this.line();
    this.line(
      `  ${p.bold(p.cyan('APIFORGE'))}${version ? ` ${p.gray(`v${version}`)}` : ''}  ${p.gray('Test smarter. Ship with confidence.')}`,
    );
    this.line();
  }

  section(title: string): void {
    if (this.quiet) return;
    this.line(this.palette.bold(title));
  }

  startSpinner(label: string): void {
    if (!this.interactive || this.quiet) {
      if (!this.quiet) this.line(`${this.palette.gray('▸')} ${label}`);
      return;
    }
    this.spinnerLabel = label;
    this.spinnerIndex = 0;
    this.renderSpinner();
    this.spinnerTimer = setInterval(() => {
      this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerFrames.length;
      this.renderSpinner();
    }, 80);
    this.spinnerTimer.unref?.();
  }

  private renderSpinner(): void {
    const frame = this.spinnerFrames[this.spinnerIndex] ?? '⠋';
    this.stdout.write(`\r\u001B[2K${this.palette.cyan(frame)} ${this.spinnerLabel}`);
  }

  updateSpinner(label: string): void {
    this.spinnerLabel = label;
    if (this.interactive && this.spinnerTimer) this.renderSpinner();
  }

  stopSpinner(finalLine?: string): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
      this.stdout.write('\r\u001B[2K');
    }
    if (finalLine !== undefined && !this.quiet) this.line(finalLine);
  }

  success(message: string): void {
    if (this.quiet) return;
    this.line(`${this.palette.green('✔')} ${message}`);
  }

  fail(message: string): void {
    if (this.quiet) return;
    this.line(`${this.palette.red('✖')} ${message}`);
  }

  warn(message: string): void {
    if (this.quiet) return;
    this.line(`${this.palette.yellow('▲')} ${message}`);
  }

  info(message: string): void {
    if (this.quiet) return;
    this.line(`${this.palette.blue('●')} ${message}`);
  }

  detail(message: string): void {
    if (this.quiet || !this.verbose) return;
    this.line(this.palette.gray(`  ${message}`));
  }

  /** Print a block of already-formatted text (e.g. a rendered report). */
  block(text: string): void {
    if (this.quiet) return;
    this.stdout.write(`${text.endsWith('\n') ? text : `${text}\n`}`);
  }
}
