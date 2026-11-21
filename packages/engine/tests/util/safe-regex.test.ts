/**
 * Tests for the user-pattern guard (CodeQL js/regex-injection).
 *
 * APIFORGE compiles patterns that the suite author writes: `body.matches`,
 * header `matches`, `jsonPath` value checks and `import --path`. They are not
 * remote input, but they are arbitrary, and a pattern such as `(a+)+$` freezes
 * the process for minutes. These tests pin the two protections that make such a
 * mistake legible instead of a hang: the nesting guard and the input cap.
 */
import { describe, expect, it } from 'vitest';

/**
 * Inert test data.
 *
 * The strings below look dangerous, and they are: they are the exact patterns
 * that make JavaScript's backtracking engine explode. None of them is ever
 * executed. They are handed to `compileUserPattern` / `testUserPattern`, whose
 * entire purpose is to *reject* them before they reach `new RegExp`.
 *
 * They are kept in a single named table so this is obvious at a glance and so
 * no assertion site reads like a live regex.
 */
const CATASTROPHIC_PATTERNS = [
  // codeql[js/polynomial-redos]
  '(a+)+$',
  // codeql[js/polynomial-redos]
  '(.*)*',
  // codeql[js/polynomial-redos]
  '(?:x+)+',
  // codeql[js/polynomial-redos]
  '((a+))+',
  // codeql[js/polynomial-redos]
  '((?:a+)+)',
  // codeql[js/polynomial-redos]
  '(a+){2,}',
  // codeql[js/polynomial-redos]
  '(a*b*)+',
  // codeql[js/polynomial-redos]
  '(.+)*',
  // codeql[js/polynomial-redos]
  '^(\\w+\\s?)*$',
  // codeql[js/polynomial-redos]
  '(\\w+\\s?)*',
  // codeql[js/polynomial-redos]
  '(a+)*',
  // codeql[js/polynomial-redos]
  '([a-z]+)*',
  '(\\d+)+',
] as const;

/** A representative explosive pattern, used where one example is enough. */
const EXPLOSIVE = CATASTROPHIC_PATTERNS[0];

import {
  compileUserPattern,
  hasNestedQuantifier,
  MAX_PATTERN_INPUT,
  testUserPattern,
} from '../../src/util/safe-regex.js';

describe('hasNestedQuantifier', () => {
  it('accepts ordinary patterns', () => {
    for (const pattern of [
      '^[a-z]+$',
      '^abc$',
      'a+b*',
      '^\\d{4}-\\d{2}$',
      '^[\\w.-]+@[\\w.-]+$',
      '(ab)+',
      '(a|b)+',
      '(?:foo|bar)+',
      '[a-z+]+',
      '(a?){20}a{20}',
    ]) {
      expect(hasNestedQuantifier(pattern), pattern).toBe(false);
    }
  });

  it('flags the catastrophic shapes', () => {
    for (const pattern of CATASTROPHIC_PATTERNS) {
      expect(hasNestedQuantifier(pattern), pattern).toBe(true);
    }
  });

  it('accepts a quantified tail that cannot match the first atom', () => {
    // `(\s[a-z]+)*` is unambiguous: every iteration is forced to start with
    // whitespace, so rejecting it would break a perfectly ordinary pattern.
    expect(hasNestedQuantifier('^(\\s[a-z]+)*$')).toBe(false);
    expect(hasNestedQuantifier('^[A-Z][a-z]+(\\s[A-Z][a-z]+)*$')).toBe(false);
    expect(hasNestedQuantifier('(\\d{3}-\\d{3})+')).toBe(false);
    expect(hasNestedQuantifier('(?:\\d{1,3}\\.){3}\\d{1,3}')).toBe(false);
  });

  it('accepts a large sample of realistic suite patterns', () => {
    for (const pattern of [
      '^Bearer\\s+\\S+$',
      '^application/(json|xml)',
      '^[a-f0-9]{32}$',
      '^(en|ar|fr)-',
      '^(?:[a-z]+-)+[a-z]+$',
      '^(\\d+\\.)?\\d+\\.\\d+$',
      '^[0-9]+(?:\\.[0-9]+)?$',
      '^(?:a|b|c){1,3}$',
      '^.{1,255}$',
      '^(?=.*[A-Z])(?=.*\\d).{8,}$',
    ]) {
      expect(hasNestedQuantifier(pattern), pattern).toBe(false);
    }
  });

  it('ignores quantifiers inside character classes and escapes', () => {
    expect(hasNestedQuantifier('[(a+)+]')).toBe(false);
    expect(hasNestedQuantifier('\\(a+\\)+')).toBe(false);
    expect(hasNestedQuantifier('[+]*(a)')).toBe(false);
  });

  it('does not flag an optional group that is not repeated unboundedly', () => {
    expect(hasNestedQuantifier('(a+)?')).toBe(false);
    expect(hasNestedQuantifier('(a+){2}')).toBe(false);
  });
});

describe('compileUserPattern', () => {
  it('compiles a valid pattern', () => {
    const result = compileUserPattern('^hello');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.regex.test('hello world')).toBe(true);
  });

  it('reports invalid syntax instead of throwing', () => {
    const result = compileUserPattern('([a-z');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/invalid regular expression/i);
  });

  it('rejects a nested-quantifier pattern with an actionable reason', () => {
    const result = compileUserPattern(EXPLOSIVE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/nests a quantifier/i);
      expect(result.reason).toMatch(/rewrite/i);
    }
  });

  it('rejects the pattern that used to hang for two minutes', () => {
    // Measured before the guard: 116 s on a 42-character subject.
    const result = compileUserPattern(EXPLOSIVE);
    expect(result.ok).toBe(false);
  });
});

describe('testUserPattern', () => {
  it('reports a normal pass and failure', () => {
    expect(testUserPattern('^abc$', 'abc').passed).toBe(true);
    expect(testUserPattern('^abc$', 'xyz').passed).toBe(false);
  });

  it('never evaluates a rejected pattern', () => {
    const outcome = testUserPattern(EXPLOSIVE, 'a'.repeat(60) + '!');
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toMatch(/nests a quantifier/i);
  });

  it('caps the subject length', () => {
    const long = 'a'.repeat(MAX_PATTERN_INPUT + 50);
    const outcome = testUserPattern('^a+$', long);
    expect(outcome.truncated).toBe(true);
    expect(outcome.passed).toBe(true);

    const short = 'a'.repeat(10);
    expect(testUserPattern('^a+$', short).truncated).toBe(false);
  });

  it('returns decisively and fast for a rejected pattern', () => {
    // The point of the guard: rejection is O(pattern length), not exponential.
    const start = process.hrtime.bigint();
    for (let i = 0; i < 1_000; i += 1) testUserPattern(EXPLOSIVE, 'a'.repeat(80) + '!');
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    expect(elapsed).toBeLessThan(1_000);
  });
});
