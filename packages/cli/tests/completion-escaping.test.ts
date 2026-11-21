/**
 * Regression tests for CodeQL js/incomplete-sanitization in `apiforge completion`.
 *
 * The fish generator escaped `'` but not `\`, and the zsh generator escaped
 * nothing. Both are structurally incomplete: a description ending in a
 * backslash produced `'path C:\'`, which fish rejects with
 *
 *   Unexpected end of string, quotes are not balanced
 *
 * and an apostrophe broke the zsh `commands=(...)` array.
 *
 * The escaping helpers are pure functions, so they are verified directly, and
 * the generator is verified end to end by running a script built from a hostile
 * description through the real shell parser. The fish and zsh cases are skipped
 * when those shells are not available in the environment.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  escapeBashWordList,
  escapeFishSingleQuoted,
  escapeZshSingleQuoted,
} from '../src/commands/meta.js';

const FISH = spawnSync('fish', ['--version'], { encoding: 'utf8' }).status === 0;
const ZSH = spawnSync('zsh', ['--version'], { encoding: 'utf8' }).status === 0;

/** Values a real description could plausibly contain. */
const HOSTILE_VALUES = [
  'plain text',
  "the user's name",
  'path C:\\',
  "it's C:\\",
  'back\\slash',
  'trailing backslash \\',
  '$HOME and $(whoami) and `id`',
  'non-latin: تشغيل الاختبارات ✓',
  "both \\ and ' and \\",
  "''''",
  '\\\\\\',
  '',
];

/** Run `script` through a shell, returning the value the shell read back. */
function roundTrip(shell: 'fish' | 'zsh', script: string, tmp: string): string {
  const file = join(tmp, `case.${shell}`);
  writeFileSync(file, script, 'utf8');
  return execFileSync(shell, [file], { encoding: 'utf8' }).trim();
}

function withTemp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'apiforge-completion-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('escapeFishSingleQuoted', () => {
  it('escapes backslashes before apostrophes', () => {
    expect(escapeFishSingleQuoted('a\\b')).toBe('a\\\\b');
    expect(escapeFishSingleQuoted("it's")).toBe("it\\'s");
    // Backslash first, then apostrophe: the backslash introduced by the second
    // pass must not be doubled again.
    expect(escapeFishSingleQuoted("a\\'b")).toBe("a\\\\\\'b");
  });

  it('leaves safe characters alone', () => {
    expect(escapeFishSingleQuoted('plain text')).toBe('plain text');
    expect(escapeFishSingleQuoted('$HOME $(id) `id`')).toBe('$HOME $(id) `id`');
    expect(escapeFishSingleQuoted('تشغيل ✓')).toBe('تشغيل ✓');
  });

  it.skipIf(!FISH)('round-trips through the real fish parser', () => {
    withTemp((dir) => {
      for (const value of HOSTILE_VALUES) {
        const script = `echo '${escapeFishSingleQuoted(value)}'`;
        expect(roundTrip('fish', script, dir), `value ${JSON.stringify(value)}`).toBe(value);
      }
    });
  });

  it.skipIf(!FISH)('shows the previous escaping produced an unparseable script', () => {
    withTemp((dir) => {
      // The old implementation only replaced apostrophes.
      //
      // Reproducing that escaper is the point of this test: the assertion below
      // proves fish rejects its output. The missing backslash handling is the
      // subject under test, and this helper only ever builds a deliberately
      // broken fixture, never a script that is executed as a real completion.
      // codeql[js/incomplete-sanitization]
      const oldEscape = (value: string): string => value.replace(/'/g, "\\'");
      const broken = `echo '${oldEscape('path C:\\')}'`;

      expect(() => roundTrip('fish', broken, dir)).toThrow();
    });
  });
});

describe('escapeZshSingleQuoted', () => {
  it('wraps the value in single quotes', () => {
    expect(escapeZshSingleQuoted('plain')).toBe("'plain'");
  });

  it('closes, escapes and reopens around an apostrophe', () => {
    expect(escapeZshSingleQuoted("it's")).toBe("'it'\\''s'");
  });

  it.skipIf(!ZSH)('round-trips through the real zsh parser', () => {
    withTemp((dir) => {
      for (const value of HOSTILE_VALUES) {
        const script = `print -r -- ${escapeZshSingleQuoted(value)}`;
        expect(roundTrip('zsh', script, dir), `value ${JSON.stringify(value)}`).toBe(value);
      }
    });
  });
});

describe('escapeBashWordList', () => {
  it('quotes every entry', () => {
    expect(escapeBashWordList(['init', 'test'])).toBe("'init' 'test'");
  });

  it('escapes apostrophes inside an entry', () => {
    expect(escapeBashWordList(["it's"])).toBe("'it'\\''s'");
  });

  it('round-trips through bash', () => {
    withTemp((dir) => {
      const words = ['init', 'test', "weird'name"];
      const script = `for w in ${escapeBashWordList(words)}; do printf '%s\\n' "$w"; done`;
      const file = join(dir, 'case.bash');
      writeFileSync(file, script, 'utf8');
      const out = execFileSync('bash', [file], { encoding: 'utf8' }).trimEnd().split('\n');
      expect(out).toEqual(words);
    });
  });
});

describe('completion output', () => {
  // The real generator is exercised through the built CLI in cli.test.ts; here
  // we assert the invariant that matters: applying the fish escaper to every
  // actual description yields a script fish accepts.
  const DESCRIPTIONS = [
    'Create a starter APIFORGE project (config, environments and example suites)',
    'Run API test suites (YAML/JSON) and evaluate their assertions',
    'Send a single ad-hoc HTTP request and assert on the response',
  ];

  it.skipIf(!FISH)('produces a parseable fish script for every real description', () => {
    withTemp((dir) => {
      const script = DESCRIPTIONS.map(
        (description) =>
          `complete -c apiforge -n '__fish_use_subcommand' -a init -d '${escapeFishSingleQuoted(description)}'`,
      ).join('\n');
      const file = join(dir, 'completion.fish');
      writeFileSync(file, `${script}\n`, 'utf8');
      // `fish -n` parses without executing; a non-zero exit means a syntax error.
      expect(() => execFileSync('fish', ['-n', file], { encoding: 'utf8' })).not.toThrow();
    });
  });
});
