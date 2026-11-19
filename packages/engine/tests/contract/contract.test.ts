import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffShapes, inferShape, isCompatible } from '../../src/contract/shape.js';
import { runContract } from '../../src/contract/runner.js';
import { closeHttpResources } from '../../src/http/client.js';
import { startMockServer, type MockServer } from '../helpers/mock-server.js';

let server: MockServer;
let tempDir: string;
const tool = { name: 'apiforge', version: '0.1.0' };

beforeAll(async () => {
  server = await startMockServer();
  tempDir = await mkdtemp(join(tmpdir(), 'apiforge-contract-'));
});

afterAll(async () => {
  await server.close();
  await closeHttpResources();
  await rm(tempDir, { recursive: true, force: true });
});

describe('inferShape', () => {
  it('captures nested types without values', () => {
    const shape = inferShape({
      id: 1,
      name: 'x',
      tags: ['a'],
      meta: { ok: true, score: 1.5 },
      nothing: null,
    });
    expect(shape).toEqual({
      type: 'object',
      properties: {
        id: { type: 'number' },
        name: { type: 'string' },
        tags: { type: 'array', element: { type: 'string' } },
        meta: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, score: { type: 'number' } },
        },
        nothing: { type: 'null' },
      },
    });
  });

  it('merges heterogeneous array elements', () => {
    const shape = inferShape([{ a: 1 }, { a: 2, b: 'x' }]);
    expect(shape.element?.type).toBe('object');
    expect(Object.keys(shape.element?.properties ?? {}).sort()).toEqual(['a', 'b']);
  });

  it('marks nullability when elements mix null and values', () => {
    const shape = inferShape([1, null, 2]);
    expect(shape.element).toEqual({ type: 'number', nullable: true });
  });

  it('handles empty arrays and empty objects', () => {
    expect(inferShape([])).toEqual({ type: 'array' });
    expect(inferShape({})).toEqual({ type: 'object', properties: {} });
  });
});

describe('diffShapes', () => {
  const baseline = inferShape({ id: 1, nested: { keep: true, drop: 'x' }, list: [{ a: 1 }] });

  it('reports removed fields as breaking', () => {
    const current = inferShape({ id: 1, nested: { keep: true }, list: [{ a: 1 }] });
    const changes = diffShapes(baseline, current);
    expect(changes).toEqual([{ path: '$.nested.drop', change: 'removed', before: 'string' }]);
    expect(isCompatible(changes)).toBe(false);
  });

  it('reports added fields as compatible', () => {
    const current = inferShape({
      id: 1,
      nested: { keep: true, drop: 'x' },
      list: [{ a: 1 }],
      extra: true,
    });
    const changes = diffShapes(baseline, current);
    expect(changes).toEqual([{ path: '$.extra', change: 'added', after: 'boolean' }]);
    expect(isCompatible(changes)).toBe(true);
  });

  it('reports type changes as breaking', () => {
    const current = inferShape({ id: '1', nested: { keep: true, drop: 'x' }, list: [{ a: 1 }] });
    const changes = diffShapes(baseline, current);
    expect(changes[0]).toEqual({
      path: '$.id',
      change: 'type-changed',
      before: 'number',
      after: 'string',
    });
    expect(isCompatible(changes)).toBe(false);
  });

  it('diffs inside array elements', () => {
    const current = inferShape({ id: 1, nested: { keep: true, drop: 'x' }, list: [{ a: 'str' }] });
    const changes = diffShapes(baseline, current);
    expect(changes[0]?.path).toBe('$.list[].a');
  });
});

describe('runContract', () => {
  it('writes a baseline on first run and passes', async () => {
    const baselineFile = join(tempDir, 'first.json');
    const report = await runContract({ url: `${server.url}/json`, baselineFile, tool });
    expect(report.snapshotUpdated).toBe(true);
    expect(report.passed).toBe(true);
    expect(report.changes).toEqual([]);
    const saved = JSON.parse(await readFile(baselineFile, 'utf8'));
    expect(saved.apiforgeContract).toBe(1);
    expect(saved.shape.type).toBe('object');
  });

  it('passes when the shape is unchanged, even if values differ', async () => {
    const baselineFile = join(tempDir, 'stable.json');
    await runContract({ url: `${server.url}/json`, baselineFile, tool });
    const second = await runContract({ url: `${server.url}/json`, baselineFile, tool });
    expect(second.passed).toBe(true);
    expect(second.snapshotUpdated).toBe(false);
  });

  it('detects breaking changes against an edited baseline', async () => {
    const baselineFile = join(tempDir, 'breaking.json');
    await runContract({ url: `${server.url}/json`, baselineFile, tool });
    const saved = JSON.parse(await readFile(baselineFile, 'utf8'));
    saved.shape.properties.removedField = { type: 'string' };
    await writeFile(baselineFile, JSON.stringify(saved));

    const report = await runContract({ url: `${server.url}/json`, baselineFile, tool });
    expect(report.passed).toBe(false);
    expect(report.compatible).toBe(false);
    expect(report.changes[0]?.path).toBe('$.removedField');
  });

  it('validates against an external JSON Schema', async () => {
    const baselineFile = join(tempDir, 'schema-baseline.json');
    const schemaFile = join(tempDir, 'schema.json');
    await writeFile(
      schemaFile,
      JSON.stringify({
        $defs: { tag: { type: 'string' } },
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'number' },
          name: { type: 'string' },
          tags: { type: 'array', items: { $ref: '#/$defs/tag' } },
        },
      }),
    );
    const report = await runContract({ url: `${server.url}/json`, baselineFile, schemaFile, tool });
    expect(report.schemaValidation?.valid).toBe(true);
    expect(report.passed).toBe(true);

    await writeFile(
      schemaFile,
      JSON.stringify({ type: 'object', required: ['definitelyMissing'] }),
    );
    const failing = await runContract({
      url: `${server.url}/json`,
      baselineFile,
      schemaFile,
      tool,
    });
    expect(failing.schemaValidation?.valid).toBe(false);
    expect(failing.passed).toBe(false);
  });

  it('updates the baseline when requested', async () => {
    const baselineFile = join(tempDir, 'update.json');
    await writeFile(
      baselineFile,
      JSON.stringify({
        apiforgeContract: 1,
        method: 'GET',
        url: '',
        capturedAt: '',
        shape: { type: 'object', properties: { stale: { type: 'string' } } },
      }),
    );
    const before = await runContract({ url: `${server.url}/json`, baselineFile, tool });
    expect(before.passed).toBe(false);
    const after = await runContract({
      url: `${server.url}/json`,
      baselineFile,
      update: true,
      tool,
    });
    expect(after.snapshotUpdated).toBe(true);
    expect(after.passed).toBe(true);
  });

  it('rejects non-JSON responses with a clear error', async () => {
    const baselineFile = join(tempDir, 'text.json');
    await expect(runContract({ url: `${server.url}/text`, baselineFile, tool })).rejects.toThrow(
      /requires a JSON response/,
    );
  });

  it('rejects malformed baseline files', async () => {
    const baselineFile = join(tempDir, 'invalid.json');
    await writeFile(baselineFile, '{"apiforgeContract":1,"shape":{"nope":true}}');
    await expect(runContract({ url: `${server.url}/json`, baselineFile, tool })).rejects.toThrow(
      /invalid "shape"/,
    );
  });

  it('rejects unparseable baseline files', async () => {
    const baselineFile = join(tempDir, 'broken.json');
    await writeFile(baselineFile, '{not json');
    await expect(runContract({ url: `${server.url}/json`, baselineFile, tool })).rejects.toThrow(
      /not valid JSON/,
    );
  });
});
