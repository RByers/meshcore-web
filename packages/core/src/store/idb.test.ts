import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { deleteDatabase, openDatabase, type Migration } from './idb.js';

interface Row {
  id: number;
  ts: number;
  tag: string;
}

const v1: Migration = ({ db }) => {
  const s = db.createObjectStore('rows', { keyPath: 'id' });
  s.createIndex('ts', 'ts');
};
const v2: Migration = ({ tx }) => {
  tx.objectStore('rows').createIndex('tag_ts', ['tag', 'ts']);
};

async function seeded() {
  const factory = new IDBFactory();
  const db = await openDatabase({ name: 't', migrations: [v1, v2], factory });
  await db.transaction('rows', 'readwrite', async (t) => {
    const s = t.store<Row>('rows');
    for (let i = 1; i <= 10; i++) await s.put({ id: i, ts: 100 - i, tag: i % 2 ? 'odd' : 'even' });
  });
  return { db, factory };
}

describe('idb wrapper', () => {
  it('opens with migrations and reports version/stores', async () => {
    const { db } = await seeded();
    expect(db.version).toBe(2);
    expect(db.storeNames).toEqual(['rows']);
    expect(Array.from(db.raw.transaction('rows').objectStore('rows').indexNames).sort()).toEqual(['tag_ts', 'ts']);
    db.close();
  });

  it('runs only the missing migration steps on upgrade', async () => {
    const factory = new IDBFactory();
    const seen: number[][] = [];
    const track =
      (m: Migration): Migration =>
      (ctx) => {
        seen.push([ctx.oldVersion, ctx.version]);
        m(ctx);
      };
    (await openDatabase({ name: 'u', version: 1, migrations: [track(v1), track(v2)], factory })).close();
    (await openDatabase({ name: 'u', migrations: [track(v1), track(v2)], factory })).close();
    expect(seen).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it('a throwing migration rejects the open and leaves the old version', async () => {
    const factory = new IDBFactory();
    (await openDatabase({ name: 'x', version: 1, migrations: [v1], factory })).close();
    const bad: Migration = () => {
      throw new Error('boom');
    };
    await expect(openDatabase({ name: 'x', migrations: [v1, bad], factory })).rejects.toThrow('boom');
    const db = await openDatabase({ name: 'x', version: 1, migrations: [v1], factory });
    expect(db.version).toBe(1);
    db.close();
  });

  it('rejects a version with no migration', async () => {
    await expect(openDatabase({ name: 'y', version: 3, migrations: [v1], factory: new IDBFactory() })).rejects.toThrow(RangeError);
  });

  it('get / put / add / delete / count / clear', async () => {
    const { db } = await seeded();
    expect(await db.get<Row>('rows', 3)).toEqual({ id: 3, ts: 97, tag: 'odd' });
    expect(await db.get('rows', 99)).toBeUndefined();
    await expect(db.add<Row>('rows', { id: 3, ts: 0, tag: 'dup' })).rejects.toThrow();
    expect(await db.put<Row>('rows', { id: 11, ts: 1, tag: 'odd' })).toBe(11);
    expect(await db.count('rows')).toBe(11);
    expect(await db.count('rows', db.range(['odd', -Infinity], ['odd', Infinity]), 'tag_ts')).toBe(6);
    await db.delete('rows', db.range(1, 5)!);
    expect(await db.count('rows')).toBe(6);
    await db.clear('rows');
    expect(await db.count('rows')).toBe(0);
    db.close();
  });

  it('getAll by index and range', async () => {
    const { db } = await seeded();
    const rows = await db.getAll<Row>('rows', { index: 'ts', query: db.range(92, 95) });
    expect(rows.map((r) => r.ts)).toEqual([92, 93, 94, 95]);
    expect((await db.getAll<Row>('rows', { count: 2 })).map((r) => r.id)).toEqual([1, 2]);
    db.close();
  });

  it('cursor iteration with direction, offset, limit and filter', async () => {
    const { db } = await seeded();
    const desc = await db.iterate<Row>('rows', { index: 'ts', direction: 'prev', offset: 2, limit: 3 });
    expect(desc.map((r) => r.ts)).toEqual([97, 96, 95]);
    const asc = await db.iterate<Row>('rows', { index: 'ts', limit: 2 });
    expect(asc.map((r) => r.ts)).toEqual([90, 91]);
    const evens = await db.iterate<Row>('rows', { direction: 'prev', offset: 1, limit: 2, filter: (r) => r.tag === 'even' });
    expect(evens.map((r) => r.id)).toEqual([8, 6]);
    expect(await db.iterate<Row>('rows', { limit: 0 })).toEqual([]);
    db.close();
  });

  it('transaction commits on success and rolls back when the callback throws', async () => {
    const { db } = await seeded();
    const n = await db.transaction('rows', 'readwrite', async (t) => {
      await t.store<Row>('rows').put({ id: 20, ts: 0, tag: 'x' });
      return t.store('rows').count();
    });
    expect(n).toBe(11);
    await expect(
      db.transaction('rows', 'readwrite', async (t) => {
        await t.store<Row>('rows').put({ id: 21, ts: 0, tag: 'x' });
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    expect(await db.get('rows', 21)).toBeUndefined();
    expect(await db.get('rows', 20)).toBeDefined();
    db.close();
  });

  it('cursor update/delete via each()', async () => {
    const { db } = await seeded();
    await db.transaction('rows', 'readwrite', (t) =>
      t.store<Row>('rows').each({}, (r, c) => {
        if (r.tag === 'odd') c.delete();
        else c.update({ ...r, tag: 'EVEN' });
      }),
    );
    const rows = await db.getAll<Row>('rows');
    expect(rows.map((r) => r.tag)).toEqual(Array(5).fill('EVEN'));
    db.close();
  });

  it('closes on versionchange and deleteDatabase succeeds', async () => {
    const { db, factory } = await seeded();
    await deleteDatabase('t', factory);
    expect(db.closed).toBe(true);
    const again = await openDatabase({ name: 't', version: 1, migrations: [v1], factory });
    expect(await again.count('rows')).toBe(0);
    again.close();
  });
});
