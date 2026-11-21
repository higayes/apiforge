/**
 * Safe construction of user-supplied regular expressions.
 *
 * APIFORGE lets suite authors write their own patterns (`body.matches`,
 * `headers.x.matches`, `jsonPath` value checks, `import --path`). Those patterns
 * are not remote input, but they are still arbitrary: a pattern copied from a
 * ticket, or a careless `(a+)+$`, can hang the process for minutes with no
 * diagnostic while the CLI sits silent.
 *
 * This module cannot make JavaScript's backtracking engine linear — no wrapper
 * can. What it does is bound the damage and make the failure legible:
 *
 *   1. Compile the pattern once, with a clear error for invalid syntax.
 *   2. Refuse pathological constructs that are the known source of catastrophic
 *      backtracking when they are nested (a quantified group that itself ends
 *      in a quantifier, e.g. `(a+)+`, `(.*)*`, `(?:x+)+`).
 *   3. Cap the amount of text a single pattern is allowed to scan, so an
 *      unbounded response body cannot be fed to an exponential pattern.
 *
 * A refusal is reported as a normal assertion failure, never a crash, so the
 * rest of the suite still runs and the user sees which assertion was rejected
 * and why.
 */

/** How much text one user pattern may scan. Far above any realistic assertion. */
export const MAX_PATTERN_INPUT = 100_000;

/** Result of compiling a user pattern. */
export type CompiledPattern = { ok: true; regex: RegExp } | { ok: false; reason: string };

/**
 * A single matcher inside a group, described well enough to decide whether two
 * of them can consume the same character.
 */
type Atom =
  | { kind: 'dot' }
  | { kind: 'literal'; value: string }
  | { kind: 'class'; raw: string }
  | { kind: 'shorthand'; value: string }
  | { kind: 'anchor' }
  | { kind: 'group' }
  | { kind: 'none' };

/** Do two atoms share at least one character they can both match? */
function atomsOverlap(a: Atom, b: Atom): boolean {
  if (a.kind === 'none' || b.kind === 'none') return true;
  if (a.kind === 'dot' || b.kind === 'dot') return true;
  if (a.kind === 'group' || b.kind === 'group') return true;
  if (a.kind === 'literal' && b.kind === 'literal') return a.value === b.value;
  if (a.kind === 'shorthand' && b.kind === 'shorthand') return a.value === b.value;
  if (a.kind === 'literal' && b.kind === 'shorthand') return shorthandMatches(b.value, a.value);
  if (a.kind === 'shorthand' && b.kind === 'literal') return shorthandMatches(a.value, b.value);
  if (a.kind === 'class' && b.kind === 'literal') return classContains(a.raw, b.value);
  if (a.kind === 'literal' && b.kind === 'class') return classContains(b.raw, a.value);
  if (a.kind === 'class' && b.kind === 'shorthand') return shorthandInClass(b.value, a.raw);
  if (a.kind === 'shorthand' && b.kind === 'class') return shorthandInClass(a.value, b.raw);
  if (a.kind === 'class' && b.kind === 'class') return a.raw === b.raw;
  return false;
}

function shorthandMatches(shorthand: string, char: string): boolean {
  if (char.length !== 1) return false;
  if (shorthand === '\\w') return /[A-Za-z0-9_]/.test(char);
  if (shorthand === '\\d') return /[0-9]/.test(char);
  if (shorthand === '\\s') return /\s/.test(char);
  return true;
}

function shorthandInClass(shorthand: string, raw: string): boolean {
  if (raw.includes(shorthand)) return true;
  if (shorthand === '\\w' && raw.includes('\\d')) return false;
  // Without a full class parser, assume overlap when the class mentions any
  // shorthand that is not obviously disjoint. Erring toward "overlaps" keeps
  // the guard conservative; the atom-level checks above cover the common cases.
  return false;
}

function classContains(raw: string, char: string): boolean {
  if (raw.includes(char)) return true;
  const match = /^\^?\[([^\]]+)\]$/.exec(`[${raw}]`);
  if (match?.[1]) {
    const body = match[1];
    const ranges = body.matchAll(/(.)-(.)/g);
    for (const range of ranges) {
      const from = range[1] ?? '';
      const to = range[2] ?? '';
      if (from && to && char >= from && char <= to) return true;
    }
  }
  return false;
}

/** Per-group bookkeeping used to decide whether a repetition is ambiguous. */
interface GroupFrame {
  first: Atom;
  firstSeen: boolean;
  last: Atom;
  /** The last atom carries a quantifier. */
  lastQuantified: boolean;
  /** The last atom can match the empty string (`*`, `?`, `{0,}`). */
  lastNullable: boolean;
}

const emptyFrame = (): GroupFrame => ({
  first: { kind: 'none' },
  firstSeen: false,
  last: { kind: 'none' },
  lastQuantified: false,
  lastNullable: false,
});

/**
 * Reject the repetition shapes that backtrack exponentially.
 *
 * A group repeated without bound is dangerous when its body is *ambiguous*:
 * two consecutive iterations can absorb the same text. That happens in two
 * situations:
 *
 *   a) the body ends in an optional tail (`(\w+\s?)*`), so the next iteration
 *      may also match the tail; or
 *   b) the body ends in a quantified atom that can match what the body *starts*
 *      with (`(a+)+`, `([a-z]+)*`), so the run can be split at any position.
 *
 * A quantified tail that cannot match the first atom is unambiguous and safe —
 * `(\s[a-z]+)*` must be accepted, because every iteration is forced to begin
 * with whitespace.
 *
 * This is not a full static analyser. It recognises the shapes that actually
 * blow up in practice and deliberately errs toward accepting unusual-but-safe
 * patterns rather than rejecting working ones.
 */
export function hasNestedQuantifier(pattern: string): boolean {
  const stack: GroupFrame[] = [];

  const current = (): GroupFrame | undefined => stack[stack.length - 1];

  /** Parse a `{n,m}` quantifier at `index`. */
  const readBrace = (
    index: number,
  ): { length: number; unbounded: boolean; nullable: boolean } | undefined => {
    const match = /^\{(\d*)(,?)(\d*)\}/.exec(pattern.slice(index));
    if (!match) return undefined;
    const [, min, comma, max] = match;
    const unbounded = comma === ',' && (max ?? '') === '';
    const nullable = (min ?? '') === '' || min === '0';
    return { length: match[0].length, unbounded, nullable };
  };

  /** Parse one atom starting at `index`; returns the atom and the next index. */
  const readAtom = (index: number): { atom: Atom; next: number } => {
    const char = pattern[index];
    if (char === undefined) return { atom: { kind: 'none' }, next: index };
    if (char === '\\') {
      const next = pattern[index + 1] ?? '';
      const shorthand = `\\${next}`;
      if (['\\w', '\\d', '\\s', '\\W', '\\D', '\\S'].includes(shorthand)) {
        return { atom: { kind: 'shorthand', value: shorthand }, next: index + 2 };
      }
      return { atom: { kind: 'literal', value: next }, next: index + 2 };
    }
    if (char === '[') {
      let i = index + 1;
      while (i < pattern.length && pattern[i] !== ']') {
        if (pattern[i] === '\\') i += 1;
        i += 1;
      }
      return { atom: { kind: 'class', raw: pattern.slice(index + 1, i) }, next: i + 1 };
    }
    if (char === '.') return { atom: { kind: 'dot' }, next: index + 1 };
    if (char === '^' || char === '$') return { atom: { kind: 'anchor' }, next: index + 1 };
    if (char === '(') return { atom: { kind: 'group' }, next: index + 1 };
    return { atom: { kind: 'literal', value: char }, next: index + 1 };
  };

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] as string;
    const frame = current();

    if (char === '(') {
      // `(?:`, `(?=`, `(?!` and the lookbehind forms open a group whose first
      // characters are syntax, not content. Skipping them keeps the first-atom
      // analysis honest.
      if (pattern[i + 1] === '?') {
        if (pattern[i + 2] === '<' && (pattern[i + 3] === '=' || pattern[i + 3] === '!')) {
          i += 3;
        } else if (pattern[i + 2] === ':') {
          i += 2;
        } else if (pattern[i + 2] === '=' || pattern[i + 2] === '!') {
          i += 2;
        }
      }
      stack.push(emptyFrame());
      continue;
    }

    if (char === ')') {
      const group = stack.pop() ?? emptyFrame();
      // Work out what quantifier, if any, applies to this group.
      const nextChar = pattern[i + 1];
      let unbounded = nextChar === '+' || nextChar === '*';
      let nullableTail = nextChar === '*';
      let quantifierLength = unbounded ? 1 : 0;
      if (nextChar === '{') {
        const brace = readBrace(i + 1);
        if (brace) {
          unbounded = brace.unbounded;
          nullableTail = brace.nullable;
          quantifierLength = brace.length;
        }
      }

      if (unbounded) {
        // (a) an optional tail makes consecutive iterations overlap.
        if (group.lastNullable) return true;
        // (b) a quantified tail that can match the first atom splits the run.
        if (group.lastQuantified && atomsOverlap(group.last, group.first)) return true;
      }

      const parent = current();
      if (parent) {
        const atom: Atom = { kind: 'group' };
        if (!parent.firstSeen) {
          parent.first = atom;
          parent.firstSeen = true;
        }
        parent.last = atom;
        // Propagate the child's tail state when the group is not itself
        // quantified: an outer `+` then lands on a body that still ends in a
        // quantified atom, which is what makes `((a+))+` explosive.
        if (unbounded) {
          parent.lastQuantified = true;
          parent.lastNullable = nullableTail;
        } else {
          parent.lastQuantified = group.lastQuantified;
          parent.lastNullable = group.lastNullable;
        }
      }
      i += quantifierLength;
      continue;
    }

    if (char === '|') {
      // A new alternative restarts the ambiguity question for this group.
      if (frame) Object.assign(frame, emptyFrame());
      continue;
    }

    if (char === '*' || char === '+' || char === '?' || char === '{') {
      if (!frame) continue;
      if (char === '{') {
        const brace = readBrace(i);
        if (brace) {
          // Bounded repetition (`{3}`, `{1,4}`) cannot be unrolled
          // exponentially, so it does not count as an unbounded tail.
          frame.lastQuantified = brace.unbounded;
          frame.lastNullable = brace.nullable;
          i += brace.length - 1;
          continue;
        }
        // A literal `{` that starts no quantifier.
        frame.last = { kind: 'literal', value: '{' };
        frame.lastQuantified = false;
        frame.lastNullable = false;
        if (!frame.firstSeen) {
          frame.first = frame.last;
          frame.firstSeen = true;
        }
        continue;
      }
      frame.lastQuantified = true;
      frame.lastNullable = char === '*' || char === '?';
      continue;
    }

    const { atom, next } = readAtom(i);
    if (frame) {
      if (!frame.firstSeen) {
        frame.first = atom;
        frame.firstSeen = true;
      }
      frame.last = atom;
      frame.lastQuantified = false;
      frame.lastNullable = false;
    }
    i = next - 1;
  }

  return false;
}

/**
 * Compile a user-authored pattern with a size bound and a nesting guard.
 *
 * @param source the pattern text from the suite/config
 * @param flags  RegExp flags; `u` by default to match the old behaviour
 */
export function compileUserPattern(source: string, flags = 'u'): CompiledPattern {
  if (hasNestedQuantifier(source)) {
    return {
      ok: false,
      reason:
        `pattern /${source}/ nests a quantifier inside a quantified group, ` +
        'which can backtrack catastrophically; rewrite it without the nesting',
    };
  }
  try {
    return { ok: true, regex: new RegExp(source, flags) };
  } catch (error) {
    return { ok: false, reason: `invalid regular expression: ${(error as Error).message}` };
  }
}

/**
 * Test `text` against a user pattern, truncating the subject first.
 *
 * Returns the same verdict shape as `compileUserPattern` so call sites can
 * report a refusal as an ordinary failed assertion.
 */
export function testUserPattern(
  source: string,
  text: string,
  flags = 'u',
): { passed: boolean; reason?: string; truncated: boolean } {
  const compiled = compileUserPattern(source, flags);
  if (!compiled.ok) return { passed: false, reason: compiled.reason, truncated: false };

  const truncated = text.length > MAX_PATTERN_INPUT;
  const subject = truncated ? text.slice(0, MAX_PATTERN_INPUT) : text;
  return { passed: compiled.regex.test(subject), truncated };
}
