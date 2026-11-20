import { afterEach, describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'node:path';
import {
  createFileWatcher,
  isRelevantChange,
  type FileWatcher,
  type WatchFn,
} from '../src/lib/watch.js';

const root = resolve('/project');

/** A watcher whose events are fired by the test instead of the OS. */
function fakeWatch(): {
  watch: WatchFn;
  emit: (name: string | null) => void;
  closed: () => number;
} {
  let listener: (filename: string | null) => void = () => undefined;
  let closed = 0;
  return {
    watch: (_directory, next) => {
      listener = next;
      return { close: () => void (closed += 1) };
    },
    emit: (name) => listener(name),
    closed: () => closed,
  };
}

describe('isRelevantChange', () => {
  it.each([
    'suites/users.suite.yaml',
    'suites/users.suite.json',
    'environments/staging.yaml',
    'data/users.csv',
    'data/users.json',
  ])('reacts to %s', (file) => {
    expect(isRelevantChange(file, { root })).toBe(true);
  });

  it.each(['README.md', 'src/index.ts', 'node_modules/pkg/package.json', '.git/config'])(
    'ignores %s',
    (file) => {
      expect(isRelevantChange(file, { root })).toBe(false);
    },
  );

  it('ignores the report directory so a run cannot retrigger itself', () => {
    const ignore = [join(root, 'reports')];
    expect(isRelevantChange('reports/latest.json', { root, ignore })).toBe(false);
    expect(isRelevantChange('reports-archive/a.json', { root, ignore })).toBe(true);
  });
});

describe('createFileWatcher', () => {
  let watcher: FileWatcher | undefined;
  afterEach(() => {
    watcher?.close();
    vi.useRealTimers();
  });

  it('reports a changed suite file after the debounce window', async () => {
    vi.useFakeTimers();
    const fake = fakeWatch();
    watcher = createFileWatcher({ root, watch: fake.watch, debounceMs: 50 });
    const next = watcher.next();

    fake.emit('suites/a.suite.yaml');
    await vi.advanceTimersByTimeAsync(49);
    let settled = false;
    void next.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await next).toEqual(['suites/a.suite.yaml']);
  });

  it('merges a burst of events into one batch', async () => {
    vi.useFakeTimers();
    const fake = fakeWatch();
    watcher = createFileWatcher({ root, watch: fake.watch, debounceMs: 50 });
    const next = watcher.next();

    fake.emit('suites/a.suite.yaml');
    fake.emit('suites/a.suite.yaml');
    fake.emit('environments/dev.yaml');
    await vi.advanceTimersByTimeAsync(50);

    expect(await next).toEqual(['environments/dev.yaml', 'suites/a.suite.yaml']);
  });

  it('does not wake up for unrelated files', async () => {
    vi.useFakeTimers();
    const fake = fakeWatch();
    watcher = createFileWatcher({
      root,
      ignore: [join(root, 'reports')],
      watch: fake.watch,
      debounceMs: 10,
    });
    const next = watcher.next();
    let settled = false;
    void next.then(() => (settled = true));

    fake.emit('notes.md');
    fake.emit('reports/latest.json');
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);

    fake.emit('data/rows.csv');
    await vi.advanceTimersByTimeAsync(10);
    expect(await next).toEqual(['data/rows.csv']);
  });

  it('keeps changes that happen while a run is in progress', async () => {
    vi.useFakeTimers();
    const fake = fakeWatch();
    watcher = createFileWatcher({ root, watch: fake.watch, debounceMs: 10 });

    // No `next()` pending: this is the "run in progress" case.
    fake.emit('suites/late.suite.yaml');
    await vi.advanceTimersByTimeAsync(10);

    expect(await watcher.next()).toEqual(['suites/late.suite.yaml']);
  });

  it('treats an unknown file name as a change', async () => {
    vi.useFakeTimers();
    const fake = fakeWatch();
    watcher = createFileWatcher({ root, watch: fake.watch, debounceMs: 10 });
    const next = watcher.next();
    fake.emit(null);
    await vi.advanceTimersByTimeAsync(10);
    expect(await next).toEqual(['.']);
  });

  it('resolves with undefined and closes the OS watcher on close()', async () => {
    const fake = fakeWatch();
    watcher = createFileWatcher({ root, watch: fake.watch });
    const next = watcher.next();
    watcher.close();
    expect(await next).toBeUndefined();
    expect(fake.closed()).toBe(1);
    expect(await watcher.next()).toBeUndefined();
  });
});
