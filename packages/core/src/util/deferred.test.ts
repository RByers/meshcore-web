import { describe, expect, it } from 'vitest';
import { Deferred } from './deferred.js';

describe('Deferred', () => {
  it('resolves', async () => {
    const d = new Deferred<number>();
    expect(d.settled).toBe(false);
    d.resolve(42);
    expect(d.settled).toBe(true);
    await expect(d.promise).resolves.toBe(42);
  });

  it('rejects', async () => {
    const d = new Deferred<void>();
    d.reject(new Error('nope'));
    await expect(d.promise).rejects.toThrow('nope');
  });

  it('ignores calls after settling', async () => {
    const d = new Deferred<string>();
    d.resolve('first');
    d.resolve('second');
    d.reject(new Error('late'));
    await expect(d.promise).resolves.toBe('first');
  });
});
