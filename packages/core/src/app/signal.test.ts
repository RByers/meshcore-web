import { describe, expect, it } from 'vitest';
import { Watcher, batch, computed, effect, signal, untracked, when } from './signal.js';

describe('signal', () => {
  it('reads, writes and notifies subscribers on change only', () => {
    const s = signal(1);
    const seen: number[] = [];
    const off = s.subscribe((v) => seen.push(v));
    s.value = 2;
    s.value = 2;
    s.update((v) => v + 1);
    off();
    s.value = 10;
    expect(seen).toEqual([2, 3]);
    expect(s.value).toBe(10);
    expect(s.peek()).toBe(10);
  });

  it('supports custom equality', () => {
    const s = signal({ n: 1 }, { equals: (a, b) => a.n === b.n });
    let calls = 0;
    s.subscribe(() => calls++);
    s.value = { n: 1 };
    s.value = { n: 2 };
    expect(calls).toBe(1);
  });

  it('exposes a read-only view that tracks the same value', () => {
    const s = signal('a');
    const r = s.readonly;
    const seen: string[] = [];
    effect(() => {
      seen.push(r.value);
    });
    s.value = 'b';
    expect(seen).toEqual(['a', 'b']);
    expect('update' in r).toBe(false);
  });

  it('same listener registered twice gets two independent subscriptions', () => {
    const s = signal(0);
    let calls = 0;
    const l = (): void => {
      calls++;
    };
    const off1 = s.subscribe(l);
    s.subscribe(l);
    off1();
    s.value = 1;
    expect(calls).toBe(1);
  });
});

describe('computed', () => {
  it('derives lazily without watchers', () => {
    const a = signal(2);
    let runs = 0;
    const c = computed(() => {
      runs++;
      return a.value * 10;
    });
    expect(runs).toBe(0);
    expect(c.value).toBe(20);
    a.value = 3;
    expect(c.value).toBe(30);
  });

  it('notifies watchers only when the derived value changes', () => {
    const a = signal(1);
    const parity = computed(() => a.value % 2);
    const seen: number[] = [];
    parity.subscribe((v) => seen.push(v));
    a.value = 3;
    a.value = 4;
    a.value = 6;
    a.value = 7;
    expect(seen).toEqual([0, 1]);
  });

  it('tracks dynamic dependencies', () => {
    const flag = signal(true);
    const x = signal('x');
    const y = signal('y');
    const c = computed(() => (flag.value ? x.value : y.value));
    const seen: string[] = [];
    c.subscribe((v) => seen.push(v));
    y.value = 'y2'; // not a dependency yet
    flag.value = false;
    x.value = 'x2'; // no longer a dependency
    y.value = 'y3';
    expect(seen).toEqual(['y2', 'y3']);
  });

  it('chains computeds and unsubscribes from deps when unwatched', () => {
    const a = signal(1);
    const b = computed(() => a.value + 1);
    const c = computed(() => b.value * 2);
    const seen: number[] = [];
    const off = c.subscribe((v) => seen.push(v));
    a.value = 2;
    off();
    a.value = 5;
    expect(seen).toEqual([6]);
    expect(c.value).toBe(12);
  });

  it('detects cycles', () => {
    let c: { value: number } | undefined;
    const self = computed((): number => (c ? c.value : 0) + 1);
    c = self;
    expect(() => self.value).toThrow(/cycle/);
  });
});

describe('effect', () => {
  it('runs immediately and on change, with cleanup', () => {
    const a = signal(1);
    const log: string[] = [];
    const dispose = effect(() => {
      const v = a.value;
      log.push(`run ${v}`);
      return () => log.push(`cleanup ${v}`);
    });
    a.value = 2;
    dispose();
    a.value = 3;
    expect(log).toEqual(['run 1', 'cleanup 1', 'run 2', 'cleanup 2']);
  });

  it('does not track reads inside untracked()', () => {
    const a = signal(1);
    const b = signal(1);
    let runs = 0;
    effect(() => {
      runs++;
      void a.value;
      untracked(() => b.value);
    });
    b.value = 2;
    expect(runs).toBe(1);
    a.value = 2;
    expect(runs).toBe(2);
  });

  it('re-runs once when it writes a signal it depends on', () => {
    const a = signal(0);
    let runs = 0;
    effect(() => {
      runs++;
      if (a.value < 3) a.value = a.value + 1;
    });
    expect(a.value).toBe(3);
    expect(runs).toBe(4);
  });

  it('batch() coalesces notifications', () => {
    const a = signal(1);
    const b = signal(1);
    const sum = computed(() => a.value + b.value);
    const seen: number[] = [];
    effect(() => {
      seen.push(sum.value);
    });
    batch(() => {
      a.value = 10;
      b.value = 20;
      batch(() => {
        a.value = 11;
      });
    });
    expect(seen).toEqual([2, 31]);
  });

  it('a throwing watcher does not stop others', () => {
    const a = signal(0);
    let other = 0;
    a.subscribe(() => {
      throw new Error('boom');
    });
    a.subscribe(() => other++);
    expect(() => (a.value = 1)).toThrow('boom');
    expect(other).toBe(1);
  });
});

describe('when', () => {
  it('resolves now or on the first matching value', async () => {
    const a = signal(1);
    await expect(when(a, (v) => v === 1)).resolves.toBe(1);
    const p = when(a, (v) => v > 5);
    a.value = 3;
    a.value = 7;
    await expect(p).resolves.toBe(7);
  });
});

describe('Watcher', () => {
  it('watches what was read between begin and end, replacing the set each pass', () => {
    const a = signal(1);
    const b = signal(2);
    const c = computed(() => a.value + b.value);
    let changes = 0;
    const w = new Watcher(() => changes++);
    w.begin();
    void a.value;
    void c.value;
    w.end();
    expect(w.size).toBe(2);
    b.value = 3; // via c
    expect(changes).toBe(1);
    w.run(() => b.value);
    expect(w.size).toBe(1);
    a.value = 5;
    expect(changes).toBe(1);
    b.value = 4;
    expect(changes).toBe(2);
    w.dispose();
    b.value = 9;
    expect(changes).toBe(2);
    expect(w.size).toBe(0);
  });

  it('auto-ends an unmatched begin on the next microtask', async () => {
    const a = signal(1);
    let changes = 0;
    const w = new Watcher(() => changes++);
    w.begin();
    void a.value;
    await Promise.resolve();
    const other = signal(0);
    effect(() => void other.value); // would be mis-tracked if the watcher's tracker leaked
    a.value = 2;
    expect(changes).toBe(1);
    other.value = 1;
    expect(changes).toBe(1);
  });
});
