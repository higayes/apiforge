import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSuite, parseCsv, coerceCsvScalar } from '../../src/test/runner.js';
import { buildTestReport } from '../../src/test/report.js';
import { closeHttpResources } from '../../src/http/client.js';
import { parseSuiteDocument } from '../../src/config/schema.js';
import { startMockServer, type MockServer } from '../helpers/mock-server.js';

let server: MockServer;
let tempDir: string;

beforeAll(async () => {
  server = await startMockServer();
  tempDir = await mkdtemp(join(tmpdir(), 'apiforge-runner-'));
});

afterAll(async () => {
  await server.close();
  await closeHttpResources();
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  server.reset();
});

const suite = (document: unknown) => parseSuiteDocument(document, 'test suite');

describe('runSuite — core execution', () => {
  it('runs tests in order and reports pass/fail/error/skip states', async () => {
    const definition = suite({
      name: 'core',
      baseUrl: server.url,
      tests: [
        {
          name: 'json responds',
          path: '/json',
          expect: { status: 200, jsonPath: { name: 'Ada Lovelace' } },
        },
        { name: 'wrong status', path: '/json', expect: { status: 201 } },
        { name: 'connection refused', url: 'http://127.0.0.1:1/x' },
        { name: 'deliberately skipped', path: '/json', skip: 'not today' },
      ],
    });

    const result = await runSuite(definition);
    expect(result.totals).toEqual({ total: 4, passed: 1, failed: 1, skipped: 1, errored: 1 });
    expect(result.passed).toBe(false);
    expect(result.results.map((entry) => entry.status)).toEqual([
      'passed',
      'failed',
      'error',
      'skipped',
    ]);
    expect(result.results[3]?.skipReason).toBe('not today');
  });

  it('resolves baseUrl from the environment and merges headers', async () => {
    const definition = suite({
      name: 'env',
      tests: [
        {
          name: 'echo',
          path: '/echo',
          headers: { 'x-suite': 'yes' },
          expect: { status: 200 },
        },
      ],
    });
    await runSuite(definition, {
      environment: { baseUrl: server.url, headers: { 'x-env': 'from-env' } },
      environmentName: 'staging',
    });
    const headers = server.requests.at(-1)?.headers ?? {};
    expect(headers['x-env']).toBe('from-env');
    expect(headers['x-suite']).toBe('yes');
  });

  it('fails the suite with a configuration error when baseUrl is missing', async () => {
    const definition = suite({ name: 'no-base', tests: [{ name: 'x', path: '/json' }] });
    const result = await runSuite(definition);
    expect(result.results[0]?.status).toBe('error');
    expect(result.results[0]?.error).toContain('no `baseUrl` is configured');
  });

  it('interpolates variables, secrets and environment values', async () => {
    const definition = suite({
      name: 'templates',
      baseUrl: server.url,
      variables: { userId: 1, prefix: 'users' },
      secrets: { token: 'top-secret' },
      tests: [
        {
          name: 'templated request',
          path: '/{{prefix}}/{{userId}}?t={{token}}',
          headers: { authorization: 'Bearer {{token}}' },
          expect: { status: 200, jsonPath: { id: 1 } },
        },
      ],
    });
    const result = await runSuite(definition);
    expect(result.passed).toBe(true);
    const request = server.requests.at(-1);
    expect(request?.url).toBe('/users/1?t=top-secret');
    expect(request?.headers.authorization).toBe('Bearer top-secret');
    // Secrets must not leak into the reported request summary.
    expect(result.results[0]?.request.url).not.toContain('top-secret');
  });

  it('reports unknown template variables as a test error, not a crash', async () => {
    const definition = suite({
      name: 'bad-var',
      baseUrl: server.url,
      tests: [{ name: 'x', path: '/{{missing}}' }],
    });
    const result = await runSuite(definition);
    expect(result.results[0]?.status).toBe('error');
    expect(result.results[0]?.error).toContain('Unknown template variable');
  });

  it('chains requests via capture and steps references', async () => {
    const definition = suite({
      name: 'chaining',
      baseUrl: server.url,
      tests: [
        {
          id: 'create',
          name: 'create user',
          method: 'POST',
          path: '/created',
          body: { json: { name: 'Ada' } },
          capture: { userId: 'id', location: { header: 'location' } },
          expect: { status: 201 },
        },
        {
          name: 'fetch captured user',
          path: '/users/{{steps.create.userId}}',
          expect: { status: 200, jsonPath: { id: 7 } },
        },
      ],
    });
    const result = await runSuite(definition);
    expect(result.totals.passed).toBe(2);
    expect(server.requests.at(-1)?.url).toBe('/users/7');
  });

  it('throws a clear error for chaining to an uncaptured id', async () => {
    const definition = suite({
      name: 'bad-chain',
      baseUrl: server.url,
      tests: [{ name: 'x', path: '/users/{{steps.nope.id}}' }],
    });
    const result = await runSuite(definition);
    expect(result.results[0]?.status).toBe('error');
    expect(result.results[0]?.error).toContain('Unknown template variable');
  });
});

describe('runSuite — data-driven tests', () => {
  it('runs inline data rows', async () => {
    const definition = suite({
      name: 'data',
      baseUrl: server.url,
      tests: [
        {
          name: 'row {{row.id}}',
          path: '/users/{{row.id}}',
          data: [{ row: { id: 1 } }, { row: { id: 1 } }],
          expect: { status: 200 },
        },
      ],
    });
    const result = await runSuite(definition);
    expect(result.results).toHaveLength(2);
    expect(result.results.map((entry) => entry.dataRow)).toEqual([0, 1]);
    expect(result.results[0]?.name).toBe('row 1');
  });

  it('loads JSON and CSV data files', async () => {
    const jsonFile = join(tempDir, 'rows.json');
    const csvFile = join(tempDir, 'rows.csv');
    await writeFile(jsonFile, JSON.stringify([{ id: 1 }, { id: 1 }]));
    await writeFile(csvFile, 'id,label\n1,one\n1,two\n');

    const fromJson = await runSuite(
      suite({
        name: 'json-data',
        baseUrl: server.url,
        tests: [{ name: 'json row', path: '/users/{{id}}', dataFile: jsonFile }],
      }),
    );
    expect(fromJson.results).toHaveLength(2);

    const fromCsv = await runSuite(
      suite({
        name: 'csv-data',
        baseUrl: server.url,
        tests: [{ name: 'csv {{label}}', path: '/users/{{id}}', dataFile: csvFile }],
      }),
    );
    expect(fromCsv.results).toHaveLength(2);
    expect(fromCsv.results.map((entry) => entry.name)).toEqual(['csv one', 'csv two']);
  });

  it('errors clearly on unsupported or unreadable data files', async () => {
    const badFile = join(tempDir, 'rows.txt');
    await writeFile(badFile, 'nope');
    const result = await runSuite(
      suite({
        name: 'bad-data',
        baseUrl: server.url,
        tests: [{ name: 'x', path: '/json', dataFile: badFile }],
      }),
    );
    expect(result.results[0]?.status).toBe('error');
    expect(result.results[0]?.error).toContain('Unsupported data file format');

    const missing = await runSuite(
      suite({
        name: 'missing-data',
        baseUrl: server.url,
        tests: [{ name: 'x', path: '/json', dataFile: join(tempDir, 'nope.json') }],
      }),
    );
    expect(missing.results[0]?.status).toBe('error');
    expect(missing.results[0]?.error).toContain('Could not read data file');
  });
});

describe('runSuite — filters, thresholds, cancellation', () => {
  it('filters by text and tag', async () => {
    const definition = suite({
      name: 'filtering',
      baseUrl: server.url,
      tests: [
        { name: 'alpha test', path: '/json', tags: ['smoke'] },
        { name: 'beta test', path: '/json', tags: ['slow'] },
      ],
    });
    const byName = await runSuite(definition, { filter: 'alpha' });
    expect(byName.totals.total).toBe(1);
    const byTag = await runSuite(definition, { tags: ['slow'] });
    expect(byTag.totals.total).toBe(1);
    expect(byTag.results[0]?.name).toBe('beta test');
  });

  it('applies suite thresholds and fails the suite when violated', async () => {
    const failing = await runSuite(
      suite({
        name: 'thresholds',
        baseUrl: server.url,
        thresholds: [
          { metric: 'successRate', min: 100 },
          { metric: 'total', min: 2 },
        ],
        tests: [{ name: 'ok', path: '/json', expect: { status: 200 } }],
      }),
    );
    expect(failing.thresholds).toHaveLength(2);
    expect(failing.thresholds[1]?.passed).toBe(false);
    expect(failing.thresholds[1]?.actual).toBe(1);
    expect(failing.passed).toBe(false);

    const passing = await runSuite(
      suite({
        name: 'thresholds-ok',
        baseUrl: server.url,
        thresholds: [
          { metric: 'successRate', min: 100 },
          { metric: 'total', min: 1 },
        ],
        tests: [{ name: 'ok', path: '/json', expect: { status: 200 } }],
      }),
    );
    expect(passing.passed).toBe(true);
  });

  it('stops cleanly when the run is cancelled', async () => {
    const controller = new AbortController();
    const definition = suite({
      name: 'cancel',
      baseUrl: server.url,
      tests: [
        { name: 'slow one', path: '/delay/1s' },
        { name: 'second', path: '/json' },
      ],
    });
    setTimeout(() => controller.abort(), 100);
    const result = await runSuite(definition, { signal: controller.signal });
    expect(result.results.length).toBeLessThanOrEqual(2);
    expect(result.results[0]?.status).toBe('error');
    expect(result.results[0]?.error).toMatch(/cancel/i);
  });

  it('reports progress through callbacks', async () => {
    const started: string[] = [];
    const finished: string[] = [];
    await runSuite(
      suite({
        name: 'progress',
        baseUrl: server.url,
        tests: [
          { name: 'a', path: '/json' },
          { name: 'b', path: '/json' },
        ],
      }),
      {
        onTestStarting: (test) => started.push(test.name),
        onTestFinished: (result) => finished.push(`${result.name}:${result.status}`),
      },
    );
    expect(started).toEqual(['a', 'b']);
    expect(finished).toEqual(['a:passed', 'b:passed']);
  });
});

describe('parseCsv', () => {
  it('handles quoted fields, escaped quotes and CRLF', () => {
    const rows = parseCsv('name,note\r\n"Ada","says ""hi"""\r\nGrace,"multi\nline"\r\n');
    expect(rows).toEqual([
      { name: 'Ada', note: 'says "hi"' },
      { name: 'Grace', note: 'multi\nline' },
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\n')).toEqual([]);
  });
});

describe('coerceCsvScalar', () => {
  it('converts unambiguous scalars and preserves text otherwise', () => {
    // Regression: CSV rows were always strings, so `equals: "{{id}}"` against a
    // numeric id could never pass.
    expect(coerceCsvScalar('42')).toBe(42);
    expect(coerceCsvScalar('-7')).toBe(-7);
    expect(coerceCsvScalar('1.5')).toBe(1.5);
    expect(coerceCsvScalar('true')).toBe(true);
    expect(coerceCsvScalar('false')).toBe(false);
    expect(coerceCsvScalar('null')).toBe(null);
    expect(coerceCsvScalar('')).toBe('');
  });

  it('keeps identifiers that only look numeric as text', () => {
    expect(coerceCsvScalar('007')).toBe('007');
    expect(coerceCsvScalar('+1')).toBe('+1');
    expect(coerceCsvScalar('1e5')).toBe('1e5');
    expect(coerceCsvScalar('12px')).toBe('12px');
    expect(coerceCsvScalar('2024-01-01')).toBe('2024-01-01');
  });
});

describe('data files', () => {
  it('resolves dataFile relative to the suite directory', async () => {
    // Regression: data files were resolved against the project root, so
    // `dataFile: ../data/x.csv` looked one directory too high.
    const dataFile = join(tempDir, 'rows.csv');
    await writeFile(dataFile, 'userId\n1\n2\n', 'utf8');
    const suiteDir = join(tempDir, 'suites');
    await writeFile(join(tempDir, 'placeholder'), '', 'utf8');
    const result = await runSuite(
      suite({
        name: 'data',
        baseUrl: server.url,
        tests: [
          {
            name: 'row',
            path: '/users/{{userId}}',
            dataFile: '../rows.csv',
            expect: { status: 200 },
          },
        ],
      }),
      { suiteDir },
    );
    expect(result.totals.total).toBe(2);
    expect(result.totals.passed).toBe(2);
  });
});

describe('templating in assertions', () => {
  it('preserves the type of a single-placeholder expectation', async () => {
    // Regression: assertions used to be rendered as text, so a data row value
    // of `1` never equalled the string "1" and every row failed.
    const result = await runSuite(
      suite({
        name: 'typed',
        baseUrl: server.url,
        tests: [
          {
            name: 'numeric equality from a data row',
            method: 'GET',
            path: '/json',
            data: [{ expectedId: 42 }],
            expect: { status: 200, jsonPath: { id: '{{expectedId}}' } },
          },
        ],
      }),
    );
    expect(result.results[0]?.status).toBe('passed');
  });

  it('interpolates mixed strings and nested operator values', async () => {
    const result = await runSuite(
      suite({
        name: 'mixed',
        baseUrl: server.url,
        variables: { greeting: 'Ada' },
        tests: [
          {
            name: 'string interpolation',
            method: 'GET',
            path: '/json',
            expect: {
              status: 200,
              jsonPath: {
                name: { contains: '{{greeting}}' },
              },
            },
          },
        ],
      }),
    );
    expect(result.results[0]?.status).toBe('passed');
  });
});

describe('buildTestReport', () => {
  it('aggregates suites and thresholds', async () => {
    const one = await runSuite(
      suite({ name: 's1', baseUrl: server.url, tests: [{ name: 't', path: '/json' }] }),
    );
    const two = await runSuite(
      suite({
        name: 's2',
        baseUrl: server.url,
        tests: [{ name: 't', path: '/json', expect: { status: 500 } }],
      }),
    );
    const report = buildTestReport({
      title: 'Aggregate',
      suites: [one, two],
      tool: { name: 'apiforge', version: '0.1.0' },
      environment: 'test',
    });
    expect(report.totals).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
      errored: 0,
      durationMs: report.totals.durationMs,
    });
    expect(report.passed).toBe(false);
    expect(report.environment).toBe('test');
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
