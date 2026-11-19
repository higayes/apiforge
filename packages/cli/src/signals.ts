/**
 * Cooperative cancellation for long-running commands.
 *
 * The first Ctrl+C aborts in-flight work so reports can still be written and a
 * meaningful exit code returned; a second Ctrl+C exits immediately.
 */
export type InterruptReason = 'SIGINT' | 'SIGTERM';

export interface CancellationController {
  readonly signal: AbortSignal;
  readonly interrupted: boolean;
  readonly reason?: InterruptReason;
  dispose(): void;
}

export function installCancellation(options: { onFirstInterrupt?: () => void } = {}): CancellationController {
  const controller = new AbortController();
  let interrupted = false;
  let reason: InterruptReason | undefined;

  const handler = (signal: InterruptReason): void => {
    if (!interrupted) {
      interrupted = true;
      reason = signal;
      options.onFirstInterrupt?.();
      controller.abort(new Error('Cancelled by user'));
      return;
    }
    // Second signal: exit immediately; nothing else can be salvaged.
    process.exit(130);
  };

  const onSigint = (): void => handler('SIGINT');
  const onSigterm = (): void => handler('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  return {
    signal: controller.signal,
    get interrupted(): boolean {
      return interrupted;
    },
    get reason(): InterruptReason | undefined {
      return reason;
    },
    dispose(): void {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    },
  };
}
