import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/errors.js';
import { toSlug } from '../../src/util/text.js';
import { reportFileBase } from '../../src/report/html.js';
import {
  findPlaceholders,
  hasTemplate,
  renderTemplate,
  renderValue,
  resolveExpression,
} from '../../src/util/template.js';

describe('renderTemplate', () => {
  const ctx = {
    variables: { name: 'Ada', port: 8080, enabled: true, nested: { id: 7 }, list: [1, 2] },
    secrets: { apiKey: 'secret-value' },
    steps: { createUser: { json: { id: 99 } } },
    env: { APIFORGE_TEST_VAR: 'from-env' },
  };

  it('interpolates variables of different types', () => {
    expect(renderTemplate('{{name}}', ctx)).toBe('Ada');
    expect(renderTemplate('port={{port}}', ctx)).toBe('port=8080');
    expect(renderTemplate('{{enabled}}', ctx)).toBe('true');
    expect(renderTemplate('{{nested.id}}', ctx)).toBe('7');
  });

  it('resolves secrets and captured step values', () => {
    expect(renderTemplate('{{apiKey}}', ctx)).toBe('secret-value');
    expect(renderTemplate('{{steps.createUser.json.id}}', ctx)).toBe('99');
  });

  it('resolves $env references', () => {
    expect(renderTemplate('{{$env.APIFORGE_TEST_VAR}}', ctx)).toBe('from-env');
    process.env.APIFORGE_PROCESS_ENV = 'process-level';
    expect(renderTemplate('{{$env.APIFORGE_PROCESS_ENV}}', ctx)).toBe('process-level');
    delete process.env.APIFORGE_PROCESS_ENV;
  });

  it('supports $random and $now helpers', () => {
    const uuid = renderTemplate('{{$random.uuid}}', ctx);
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const n = Number(renderTemplate('{{$random.int(10,20)}}', ctx));
    expect(n).toBeGreaterThanOrEqual(10);
    expect(n).toBeLessThanOrEqual(20);
    expect(renderTemplate('{{$random.hex(8)}}', ctx)).toMatch(/^[0-9a-f]{8}$/);
    expect(renderTemplate('{{$now.unix}}', { ...ctx, now: new Date('2024-01-01T00:00:00Z') })).toBe(
      '1704067200',
    );
    expect(renderTemplate('{{$now.iso}}', { ...ctx, now: new Date('2024-01-01T00:00:00Z') })).toBe(
      '2024-01-01T00:00:00.000Z',
    );
  });

  it('throws a ConfigError for unknown variables in strict mode', () => {
    expect(() => renderTemplate('{{nope}}', ctx)).toThrow(ConfigError);
    expect(() => renderTemplate('{{nope}}', ctx)).toThrow(/Unknown template variable/);
  });

  it('leaves placeholders untouched in non-strict mode', () => {
    expect(renderTemplate('{{nope}}', ctx, { strict: false })).toBe('{{nope}}');
  });

  it('fails clearly when an $env variable is missing', () => {
    expect(() => renderTemplate('{{$env.DEFINITELY_NOT_SET_XYZ}}', ctx)).toThrow(
      /DEFINITELY_NOT_SET_XYZ/,
    );
  });

  it('serializes objects and arrays as JSON', () => {
    expect(renderTemplate('{{list}}', ctx)).toBe('[1,2]');
    expect(renderTemplate('{{nested}}', ctx)).toBe('{"id":7}');
  });

  it('keeps literal text without placeholders intact', () => {
    expect(renderTemplate('no templates here { } {a}', ctx)).toBe('no templates here { } {a}');
  });
});

describe('renderValue', () => {
  it('deeply renders strings inside nested structures', () => {
    const ctx = { variables: { id: 'u-1' } };
    const input = {
      url: '/users/{{id}}',
      headers: { 'x-id': '{{id}}' },
      list: ['{{id}}', 5, { deep: 'a-{{id}}' }],
      count: 2,
    };
    expect(renderValue(input, ctx)).toEqual({
      url: '/users/u-1',
      headers: { 'x-id': 'u-1' },
      list: ['u-1', 5, { deep: 'a-u-1' }],
      count: 2,
    });
  });
});

describe('resolveExpression', () => {
  it('returns native types for whole-expressions', () => {
    expect(resolveExpression('port', { variables: { port: 8080 } })).toBe(8080);
    expect(resolveExpression('nested', { variables: { nested: { a: 1 } } })).toEqual({ a: 1 });
  });
});

describe('helpers', () => {
  it('detects placeholders', () => {
    expect(hasTemplate('a {{b}} c')).toBe(true);
    expect(hasTemplate('abc')).toBe(false);
    expect(findPlaceholders('{{a}} and {{b.c}}')).toEqual(['a', 'b.c']);
  });
});

/**
 * Regression tests for CodeQL js/polynomial-redos.
 *
 * The old pattern `/\{\{\s*([^{}]+?)\s*\}\}/g` had three quantifiers competing
 * over the same whitespace run. A truncated opener such as `'{{{{' + spaces`
 * made the engine enumerate every split of that run: 308 s for n = 10 000.
 *
 * These tests pin the two properties that matter:
 *   1. FUNCTIONAL  — the replacement is behaviourally identical to the old one.
 *   2. COMPLEXITY  — adversarial input cannot make the renderer blow up.
 *
 * The complexity checks deliberately do NOT assert wall-clock thresholds
 * (those are flaky across machines). They assert *shape*: doubling the input
 * must not multiply the cost by ~4, and a large adversarial input must finish
 * inside a generous, machine-independent budget.
 */
describe('renderTemplate — ReDoS hardening', () => {
  const ctx = {
    variables: { a: 'A', b: 'B', name: 'Ada' },
    secrets: {},
    steps: {},
    env: {},
  };

  describe('functional compatibility with the previous pattern', () => {
    it('handles the documented placeholder forms', () => {
      expect(renderTemplate('{{name}}', ctx)).toBe('Ada');
      expect(renderTemplate('{{ name }}', ctx)).toBe('Ada');
      expect(renderTemplate('{{   name   }}', ctx)).toBe('Ada');
      expect(renderTemplate('{{a}}{{b}}', ctx)).toBe('AB');
      expect(renderTemplate('x{{a}}y{{b}}z', ctx)).toBe('xAyBz');
    });

    it('handles tabs, newlines and other whitespace inside the braces', () => {
      expect(renderTemplate('{{ a }}', ctx)).toBe('A');
      expect(renderTemplate('{{\ta\t}}', ctx)).toBe('A');
      expect(renderTemplate('{{\na\n}}', ctx)).toBe('A');
    });

    it('leaves unterminated placeholders untouched', () => {
      expect(renderTemplate('{{a', ctx)).toBe('{{a');
      expect(renderTemplate('{{ a ', ctx)).toBe('{{ a ');
      expect(renderTemplate('a}}', ctx)).toBe('a}}');
      expect(renderTemplate('no placeholders here', ctx)).toBe('no placeholders here');
    });

    it('leaves empty and whitespace-only placeholders untouched', () => {
      expect(renderTemplate('{{}}', ctx)).toBe('{{}}');
      expect(renderTemplate('{{ }}', ctx)).toBe('{{ }}');
      expect(renderTemplate('{{    }}', ctx)).toBe('{{    }}');
    });

    it('rejects braces nested inside a placeholder, matching the old behaviour', () => {
      // The old pattern required [^{}]+, so the inner brace broke the match and
      // the scan resumed at the next candidate opener.
      expect(renderTemplate('{{a{b}}', ctx)).toBe('{{a{b}}');
      expect(renderTemplate('{{a}b}}', ctx)).toBe('{{a}b}}');
      expect(renderTemplate('{{ {{a}} }}', ctx)).toBe('{{ A }}');
      expect(renderTemplate('{{{a}}}', ctx)).toBe('{A}');
    });

    it('keeps every occurrence of a repeated placeholder', () => {
      expect(renderTemplate('{{a}}-{{a}}-{{a}}', ctx)).toBe('A-A-A');
    });

    it('handles the empty string', () => {
      expect(renderTemplate('', ctx)).toBe('');
    });

    it('reports and detects placeholders consistently', () => {
      expect(hasTemplate('a {{b}} c')).toBe(true);
      expect(hasTemplate('abc')).toBe(false);
      expect(findPlaceholders('{{a}} and {{ b }}')).toEqual(['a', 'b']);
      expect(findPlaceholders('{{}} {{   }}')).toEqual([]);
      expect(findPlaceholders('none')).toEqual([]);
    });
  });

  describe('no catastrophic backtracking', () => {
    /**
     * Cost model probe: returns elapsed ms for one render of `input`.
     * Warmed once so a cold JIT does not distort the ratio.
     */
    const time = (input: string): number => {
      renderTemplate(input, ctx, { strict: false });
      const start = process.hrtime.bigint();
      renderTemplate(input, ctx, { strict: false });
      return Number(process.hrtime.bigint() - start) / 1e6;
    };

    it('renders a 10 000-char truncated opener in bounded time', () => {
      // The exact input that took 308 221 ms before the fix.
      const input = '{{{{' + ' '.repeat(10_000);
      const elapsed = time(input);
      // Generous, machine-independent ceiling: the fixed version needs <1 ms.
      expect(elapsed).toBeLessThan(1_000);
    });

    it('scales roughly linearly, not quadratically, as the input doubles', () => {
      const small = time('{{{{' + ' '.repeat(20_000));
      const large = time('{{{{' + ' '.repeat(160_000));
      // 8x the input. Quadratic growth would be ~64x. Allow a wide margin for
      // timer noise on very fast runs: require strictly sub-quadratic growth.
      const ratio = large / Math.max(small, 0.05);
      expect(ratio).toBeLessThan(24); // 8x linear = 8; 64x quadratic = 64
    });

    it('stays fast on a flood of openers', () => {
      const elapsed = time('{{'.repeat(50_000));
      expect(elapsed).toBeLessThan(1_000);
    });

    it('stays fast on an unclosed placeholder with a huge whitespace run', () => {
      const elapsed = time('{{' + ' '.repeat(200_000));
      expect(elapsed).toBeLessThan(1_000);
    });

    it('stays fast when many valid placeholders are present', () => {
      const elapsed = time('{{a}}'.repeat(20_000));
      expect(elapsed).toBeLessThan(1_000);
    });

    it('stays fast on a large realistic template', () => {
      const line = 'GET https://{{name}}.example.com/{{a}}/{{b}}?q={{a}}\n';
      const elapsed = time(line.repeat(5_000));
      expect(elapsed).toBeLessThan(1_000);
    });
  });

  describe('worst-case inputs keep the previous semantics', () => {
    it('does not resolve anything inside a truncated opener', () => {
      const input = '{{{{' + ' '.repeat(100);
      expect(renderTemplate(input, ctx, { strict: false })).toBe(input);
    });

    it('resolves the inner placeholder of a nested form', () => {
      expect(renderTemplate('{{ {{a}} }}', ctx)).toBe('{{ A }}');
    });
  });
});

/**
 * The remaining js/polynomial-redos alerts point at slug/trim helpers that use
 * a single, non-nested quantifier. They are linear because the quantifier
 * cannot overlap with a following group, but a future edit could reintroduce a
 * nested form. These tests fail if the cost stops scaling with the input.
 */
describe('slug helpers — linear time on hostile input', () => {
  const time = (fn: () => void): number => {
    fn();
    const start = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - start) / 1e6;
  };

  it('toSlug stays linear when the input is entirely non-alphanumeric', () => {
    const small = time(() => toSlug('!'.repeat(100_000)));
    const large = time(() => toSlug('!'.repeat(800_000)));
    // 8x the input; quadratic would be ~64x.
    expect(large / Math.max(small, 0.05)).toBeLessThan(24);
    expect(large).toBeLessThan(500);
  });

  it('toSlug stays linear when the input is one long run of separators', () => {
    const small = time(() => toSlug('-'.repeat(100_000)));
    const large = time(() => toSlug('-'.repeat(800_000)));
    expect(large / Math.max(small, 0.05)).toBeLessThan(24);
  });

  it('reportFileBase stays linear on a hostile title', () => {
    const small = time(() => reportFileBase('!'.repeat(100_000), 'html'));
    const large = time(() => reportFileBase('!'.repeat(800_000), 'html'));
    expect(large / Math.max(small, 0.05)).toBeLessThan(24);
    expect(large).toBeLessThan(500);
  });
});
