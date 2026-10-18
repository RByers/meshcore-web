/**
 * `/nodes/:prefix`: the listing of every known node (contacts and heard adverts) whose key starts
 * with a hash, and the packet inspector's source / destination hashes linking to it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PayloadType, RouteType, buildPacket, encodeAdvertAppData } from '@meshcore-web/core/packet';
import { scenarioKey } from '@meshcore-web/core/emulator';
import { concatBytes, toHex } from '@meshcore-web/core/util/bytes';
import '../src/mc-app.js';
import { createHarness, type Harness } from '../src/testing/harness.js';

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function connected(): Promise<Harness> {
  const t = (h = createHarness());
  await t.mount();
  await t.connectEmulator();
  await t.app.connection.capture!.idle();
  return t;
}

/** A contact whose first key byte no other contact shares. */
function uniqueContact(t: Harness) {
  const views = t.app.contacts.views.value;
  return views.find((v) => views.filter((w) => w.key.startsWith(v.key.slice(0, 2))).length === 1)!;
}

/** Logs a heard ADVERT (§3.5: pubkey ‖ timestamp ‖ signature ‖ app data). */
async function logAdvert(t: Harness, pubKey: Uint8Array, name: string): Promise<void> {
  const ts = Math.floor(t.clock.now() / 1000);
  const payload = concatBytes(pubKey, Uint8Array.of(ts & 0xff, (ts >>> 8) & 0xff, (ts >>> 16) & 0xff, (ts >>> 24) & 0xff), new Uint8Array(64), encodeAdvertAppData({ nodeType: 2, name }));
  const bytes = buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.ADVERT, path: new Uint8Array(0), payload });
  await t.app.connection.store.value!.packets.append({ direction: 'rx', source: 'logRxData', bytes, ts: t.clock.now() });
}

const candidates = (t: Harness): string[] => t.queryAll<HTMLElement>('[data-candidate]').map((li) => li.dataset['candidate']!);

describe('node listing by hash', () => {
  it('lists every contact and heard node with the hash, even when only one contact has it', async () => {
    const t = await connected();
    const c = uniqueContact(t);
    const hash = c.key.slice(0, 2);
    const stranger = scenarioKey('erin').slice();
    stranger[0] = parseInt(hash, 16);
    await logAdvert(t, stranger, 'Stranger');

    await t.go(`/nodes/${hash.toUpperCase()}`, '[data-list="nodes"]');
    await t.until(() => candidates(t).length === 2, 5000, 'both candidates');
    expect(location.hash).toBe(`#/nodes/${hash.toUpperCase()}`); // a listing, not the contact's page
    expect(t.query('mc-node-page')).toBeNull();
    expect(t.query('[data-field="prefix"]')!.textContent).toBe(hash);
    expect(t.query('[data-field="count"]')!.textContent).toBe('(2)');
    expect(candidates(t)).toEqual([c.key, toHex(stranger)]); // contacts first
    expect(candidates(t).every((k) => k.startsWith(hash))).toBe(true);
    const heard = t.query(`[data-candidate="${toHex(stranger)}"]`)!;
    expect(heard.hasAttribute('data-heard')).toBe(true);
    expect(heard.textContent).toContain('Stranger');
    expect(t.query<HTMLAnchorElement>('[data-action="node-packets"]')!.getAttribute('href')).toBe(`#/packets/node/${hash}`);

    heard.querySelector<HTMLAnchorElement>('a')!.click();
    await t.until(() => location.hash === `#/node/${toHex(stranger)}` && t.query('mc-node-page'), 5000, 'heard node page');
  });

  it('says so when nothing matches, and rejects non-hex', async () => {
    const t = await connected();
    await t.go('/nodes/xyz', '[data-field="invalid"]');
    const used = new Set(t.app.contacts.views.value.map((v) => v.key.slice(0, 2)));
    const free = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0')).find((x) => !used.has(x))!;
    await t.go(`/nodes/${free}`, '[data-field="none"]');
    expect(t.query('[data-field="count"]')!.textContent).toBe('(0)');
  });

  it('the packet inspector links source and destination hashes to their listings', async () => {
    const t = await connected();
    const c = uniqueContact(t);
    const dst = c.key.slice(0, 2);
    const src = dst === '5e' ? '5f' : '5e';
    // REQ (§3.0): dest_hash ‖ src_hash ‖ MAC(2) ‖ ciphertext
    const bytes = buildPacket({
      routeType: RouteType.FLOOD,
      payloadType: PayloadType.REQ,
      path: Uint8Array.of(0x11),
      payload: concatBytes(Uint8Array.of(parseInt(dst, 16), parseInt(src, 16)), new Uint8Array(18)),
    });
    const rec = await t.app.connection.store.value!.packets.append({ direction: 'rx', source: 'logRxData', bytes, ts: t.clock.now() });
    await t.go(`/packets/${rec.id}`, '[data-endpoint="dst"]');
    const from = t.query<HTMLAnchorElement>('[data-meta="From"] [data-endpoint="src"] a[data-hash-link]')!;
    expect(from.textContent).toBe(src);
    expect(from.getAttribute('href')).toBe(`#/nodes/${src}`);
    const to = t.query<HTMLAnchorElement>('[data-meta="To"] [data-endpoint="dst"] a[data-hash-link]')!;
    expect(to.getAttribute('href')).toBe(`#/nodes/${dst}`);

    to.click();
    await t.until(() => location.hash === `#/nodes/${dst}` && candidates(t).length, 5000, 'destination listing');
    expect(candidates(t)).toEqual([c.key]);
  });
});

describe('packet log path column endpoints', () => {
  const cell = (id: number) => `tr[data-packet-id="${id}"] [data-field="path"]`;
  const text = (t: Harness, id: number) => t.query(cell(id))!.textContent!.replace(/\s+/g, ' ').trim();

  it('a REQ flood reads source → relay hops → destination; the count is the relay hops only', async () => {
    const t = await connected();
    await t.go('/packets', '[data-tab="packets"]');
    const c = uniqueContact(t);
    const dst = c.key.slice(0, 2);
    const src = dst === '5e' ? '5f' : '5e';
    // REQ (§3.0): dest_hash ‖ src_hash ‖ MAC(2) ‖ ciphertext; flood path = the hops so far
    const bytes = buildPacket({
      routeType: RouteType.FLOOD,
      payloadType: PayloadType.REQ,
      path: Uint8Array.of(0x11, 0x22),
      payload: concatBytes(Uint8Array.of(parseInt(dst, 16), parseInt(src, 16)), new Uint8Array(18)),
    });
    const rec = await t.app.connection.store.value!.packets.append({ direction: 'rx', source: 'logRxData', bytes, ts: t.clock.now() });
    await t.until(() => t.query(`${cell(rec.id)} [data-endpoint="dst"]`), 5000, 'path cell');
    expect(text(t, rec.id)).toBe(`${src}→11→22→${dst} (2)`);
    const ends = t.queryAll<HTMLElement>(`${cell(rec.id)} [data-endpoint]`);
    expect(ends.map((e) => e.dataset['endpoint'])).toEqual(['src', 'dst']);
    expect(t.queryAll(`${cell(rec.id)} [data-hop]`).map((e) => e.getAttribute('data-hop'))).toEqual(['11', '22']); // endpoints aren't hops
    const to = t.query<HTMLAnchorElement>(`${cell(rec.id)} [data-endpoint="dst"] a`)!;
    expect(to.getAttribute('href')).toBe(`#/nodes/${dst}`);
    expect(to.title).toBe(`Destination ${dst}: ${c.name}`);
    expect(t.query<HTMLAnchorElement>(`${cell(rec.id)} [data-endpoint="src"] a`)!.title).toMatch(/^Source /);

    // the endpoint link opens the listing, not the row's inspector
    to.click();
    await t.until(() => location.hash === `#/nodes/${dst}` && candidates(t).length, 5000, 'listing');
    expect(t.query('mc-packet-inspector')).toBeNull();
    expect(candidates(t)).toEqual([c.key]);
  });

  it('a zero-hop packet shows just its ends; ANON_REQ links its sender key to the node page', async () => {
    const t = await connected();
    await t.go('/packets', '[data-tab="packets"]');
    const store = t.app.connection.store.value!;
    const direct = buildPacket({ routeType: RouteType.DIRECT, payloadType: PayloadType.TXT_MSG, path: new Uint8Array(0), payload: concatBytes(Uint8Array.of(0x0c, 0x5e), new Uint8Array(18)) });
    const a = await store.packets.append({ direction: 'rx', source: 'logRxData', bytes: direct, ts: t.clock.now() });
    const sender = scenarioKey('erin');
    // ANON_REQ (§3.8): dest_hash ‖ sender pubkey(32) ‖ MAC(2) ‖ ciphertext
    const anon = buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.ANON_REQ, path: Uint8Array.of(0x33), payload: concatBytes(Uint8Array.of(0x0c), sender, new Uint8Array(18)) });
    const b = await store.packets.append({ direction: 'rx', source: 'logRxData', bytes: anon, ts: t.clock.now() });
    await t.until(() => t.query(`${cell(a.id)} [data-endpoint]`) && t.query(`${cell(b.id)} [data-endpoint]`), 5000, 'path cells');
    expect(text(t, a.id)).toBe('5e→0c (0)');
    expect(text(t, b.id)).toBe(`${toHex(sender).slice(0, 2)}→33→0c (1)`);
    expect(t.query<HTMLAnchorElement>(`${cell(b.id)} [data-endpoint="src"] a`)!.getAttribute('href')).toBe(`#/node/${toHex(sender)}`);
  });
});
