/**
 * File watching for `apiforge test --watch`.
 *
 * The OS watcher is injected (`WatchFn`) so tests can drive change detection
 * with fake events instead of depending on real filesystem notifications.
 */
import { watch as fsWatch } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

/** Extensions of files that can influence a run: suites, environments, data. */
const WATCHED_EXTENSIONS = new Set(['.yaml', '.yml', '.json', '.csv']);

/** Directories that never hold inputs and may be written to by a run. */
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', '.apiforge']);

export interface WatchHandle {
  close(): void;
}

/** Subscribe to changes below `directory`; `filename` is relative to it. */
export type WatchFn = (
  directory: string,
  listener: (filename: string | null) => void,
) => WatchHandle;

/** Default `WatchFn`, backed by `node:fs.watch` (recursive, no dependency). */
export const nodeWatch: WatchFn = (directory, listener) => {
  const watcher = fsWatch(directory, { recursive: true }, (_event, filename) => {
    listener(filename === null ? null : String(filename));
  });
  // A directory removed while watching must not crash the process.
  watcher.on('error', () => undefined);
  return { close: () => watcher.close() };
};

export interface WatchFilterOptions {
  /** Directory the reported file names are relative to. */
  root: string;
  /** Directories to ignore, e.g. the report output directory. */
  ignore?: string[];
}

/**
 * True when a change to `filename` should trigger a re-run: a suite,
 * environment or data file outside ignored directories.
 */
export function isRelevantChange(filename: string, options: WatchFilterOptions): boolean {
  const absolute = isAbsolute(filename) ? filename : resolve(options.root, filename);
  if (!WATCHED_EXTENSIONS.has(extname(absolute).toLowerCase())) return false;

  const segments = relative(options.root, absolute).split(sep);
  if (segments.some((segment) => IGNORED_DIRECTORIES.has(segment))) return false;

  for (const directory of options.ignore ?? []) {
    const inside = relative(directory, absolute);
    if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) return false;
  }
  return true;
}

export interface FileWatcherOptions extends WatchFilterOptions {
  /** Extra directories to watch (e.g. the folder of `--env-file`). */
  extraDirectories?: string[];
  /** Quiet period used to coalesce bursts of events (editors write twice). */
  debounceMs?: number;
  watch?: WatchFn;
}

export interface FileWatcher {
  /** Resolves with the changed file names, or `undefined` once closed. */
  next(): Promise<string[] | undefined>;
  close(): void;
}

/**
 * Watch the project and expose changes as an async sequence. Events arriving
 * within `debounceMs` of each other are merged into one batch, and changes that
 * happen while a run is in progress are kept for the next `next()` call.
 */
export function createFileWatcher(options: FileWatcherOptions): FileWatcher {
  const watch = options.watch ?? nodeWatch;
  const debounceMs = options.debounceMs ?? 100;
  const root = resolve(options.root);

  let pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let ready: string[] | undefined;
  let waiter: ((value: string[] | undefined) => void) | undefined;
  let closed = false;

  const flush = (): void => {
    timer = undefined;
    const batch = [...pending].sort();
    pending = new Set();
    if (waiter) {
      const resolveWaiter = waiter;
      waiter = undefined;
      resolveWaiter(batch);
    } else {
      ready = [...new Set([...(ready ?? []), ...batch])].sort();
    }
  };

  const onEvent = (directory: string) => (filename: string | null) => {
    if (closed) return;
    // `null` means the platform could not say what changed: assume the worst.
    const absolute = filename === null ? directory : resolve(directory, filename);
    if (filename !== null && !isRelevantChange(absolute, { ...options, root })) return;
    pending.add(relative(root, absolute) || '.');
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  };

  const handles = [root, ...(options.extraDirectories ?? []).map((dir) => resolve(dir))].map(
    (directory) => watch(directory, onEvent(directory)),
  );

  return {
    next(): Promise<string[] | undefined> {
      if (closed) return Promise.resolve(undefined);
      if (ready) {
        const batch = ready;
        ready = undefined;
        return Promise.resolve(batch);
      }
      return new Promise((resolveNext) => {
        waiter = resolveNext;
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      for (const handle of handles) handle.close();
      waiter?.(undefined);
      waiter = undefined;
    },
  };
}
