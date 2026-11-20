import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../../src/util/concurrency.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapWithConcurrency', () => {
  it('returns results in input order, not completion order', async () => {
    const delays = [60, 5, 30, 1];
    const completion: number[] = [];
    const results = await mapWithConcurrency(delays, 4, async (delay, index) => {
      await sleep(delay);
      completion.push(index);
      return `item-${index}`;
    });
    expect(results).toEqual(['item-0', 'item-1', 'item-2', 'item-3']);
    expect(completion).not.toEqual([0, 1, 2, 3]);
  });

  it('never runs more than the limit at once', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency([...Array(10).keys()], 3, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(5);
      active -= 1;
    });
    expect(peak).toBe(3);
  });

  it('runs strictly sequentially with a limit of 1', async () => {
    const events: string[] = [];
    await mapWithConcurrency([1, 2, 3], 1, async (item) => {
      events.push(`start-${item}`);
      await sleep(5 - item);
      events.push(`end-${item}`);
    });
    expect(events).toEqual(['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
  });

  it('stops starting tasks when shouldStart says so and leaves those slots undefined', async () => {
    let failed = false;
    const results = await mapWithConcurrency(
      [1, 2, 3, 4],
      1,
      async (item) => {
        if (item === 2) failed = true;
        return item;
      },
      () => !failed,
    );
    expect(results).toEqual([1, 2, undefined, undefined]);
  });

  it('rejects with the first error after in-flight tasks settle and starts nothing new', async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3, 4], 2, async (item) => {
        started.push(item);
        if (item === 1) throw new Error('boom');
        await sleep(10);
        return item;
      }),
    ).rejects.toThrow('boom');
    expect(started).toEqual([1, 2]);
  });

  it('handles an empty list and rejects invalid limits', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    await expect(mapWithConcurrency([1], 0, async () => 1)).rejects.toThrow(RangeError);
    await expect(mapWithConcurrency([1], 1.5, async () => 1)).rejects.toThrow(RangeError);
  });
});
