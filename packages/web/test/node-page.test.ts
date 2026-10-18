/** The merged node page `/node/:key[/:tab]`: tabs per kind, embedded chat, remove / add contact, prefixes. */
import { afterEach, describe, expect, it } from 'vitest';
import { PayloadType, RouteType, buildPacket, encodeAdvertAppData } from '@meshcore-web/core/packet';
import { scenarioKey } from '@meshcore-web/core/emulator';
import { ContactFlag } from '@meshcore-web/core/protocol';
import { concatBytes, toHex } from '@meshcore-web/core/util/bytes';
import type { PacketRecord } from '@meshcore-web/core/store';
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

type Who = 'alice' | 'bob' | 'carol' | 'repeater' | 'room' | 'sensor';

function key(t: Harness, who: Who): string {
  return toHex(t.emulatorScenario().keys[who]);
}

function tabs(t: Harness): string[] {
  return t.queryAll<HTMLAnchorElement>('nav[role="tablist"] a[data-tab]').map((a) => a.dataset['tab']!);
}

function selected(t: Harness): string | undefined {
  return t.query<HTMLAnchorElement>('nav[role="tablist"] a[aria-selected="true"]')?.dataset['tab'];
}

/** Logs a flood ADVERT from `pubKey` (mesh-packet-format.md §1 envelope, §3.5 payload; signature zeros). */
async function logAdvert(
  t: Harness,
  pubKey: Uint8Array,
  app: { nodeType: number; name: string; latitude?: number; longitude?: number },
  opts: { path?: number[]; snr?: number } = {},
): Promise<PacketRecord> {
  const ts = Math.floor(t.clock.now() / 1000);
  const payload = concatBytes(pubKey, Uint8Array.of(ts & 0xff, (ts >>> 8) & 0xff, (ts >>> 16) & 0xff, (ts >>> 24) & 0xff), new Uint8Array(64), encodeAdvertAppData(app));
  const bytes = buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.ADVERT, path: Uint8Array.from(opts.path ?? []), payload });
  const rec = await t.app.connection.store.value!.packets.append({
    direction: 'rx',
    source: 'logRxData',
    bytes,
    ts: t.clock.now(),
    ...(opts.snr !== undefined ? { snr: opts.snr } : {}),
  });
  await t.app.node(toHex(pubKey)).settled();
  return rec;
}

/** A first key byte (hex) no stored contact (nor this radio) starts with. */
function unusedByte(t: Harness): string {
  const used = new Set([...t.app.contacts.views.value.map((v) => v.key.slice(0, 2)), key(t, 'alice').slice(0, 2), toHex(t.emulatorScenario().keys.self).slice(0, 2)]);
  for (let b = 0; b < 256; b++) {
    const hex = b.toString(16).padStart(2, '0');
    if (!used.has(hex)) return hex;
  }
  throw new Error('no unused byte');
}

describe('node page', () => {
  it('shows the tabs for each kind, Info first and by default; unknown / hidden tabs fall back to Info', async () => {
    const t = await connected();
    const rep = key(t, 'repeater');
    await t.go(`/node/${rep}`, 'nav[role="tablist"] a[data-tab="overview"]');
    expect(tabs(t)).toEqual(['info', 'messages', 'path', 'overview', 'telemetry', 'cli', 'tools', 'stats']);
    expect(selected(t)).toBe('info');
    expect(t.query('mc-node-info')).not.toBeNull();
    expect(t.query('[data-field="header"] [data-field="name"]')!.textContent).toBe('Hilltop Repeater');
    expect(t.query('[data-field="header"] [data-field="type"]')!.textContent).toBe('Repeater');
    expect(t.query('[data-field="header"] [data-field="session"]')!.textContent).toContain('Not logged in');
    expect(t.query<HTMLAnchorElement>('a[data-tab="overview"]')!.getAttribute('href')).toBe(`#/node/${rep}/overview`);
    expect(t.query<HTMLAnchorElement>('a[data-tab="info"]')!.getAttribute('href')).toBe(`#/node/${rep}`);

    const alice = key(t, 'alice');
    await t.go(`/node/${alice}`, 'nav[role="tablist"] a[data-tab="messages"]');
    await t.until(() => !t.query('nav[role="tablist"] a[data-tab="overview"]'), 3000, 'chat tabs');
    expect(tabs(t)).toEqual(['info', 'messages', 'path', 'stats']);
    expect(t.query('[data-field="header"] [data-field="session"]')).toBeNull();

    await t.go(`/node/${key(t, 'room')}`, 'nav[role="tablist"] a[data-tab="overview"]');
    expect(tabs(t)).toEqual(['info', 'messages', 'path', 'overview', 'telemetry', 'cli', 'tools', 'stats']);

    // a chat contact has no admin tabs; unknown tab names too → Info
    for (const tab of ['overview', 'bogus']) {
      location.hash = `#/node/${alice}/${tab}`;
      await t.until(() => t.query(`mc-node-page[data-page="/node/:key/:tab"]`) && selected(t) === 'info' && t.query('mc-node-info'), 3000, `${tab} → info`);
      expect(t.query('mc-node-admin')).toBeNull();
    }
    await t.go(`/node/${rep}/overview`, '[data-field="password"]');
    expect(selected(t)).toBe('overview');
    // a repeater's DM conversation (where CLI replies land) is its Messages tab
    await t.go(`/node/${rep}/messages`, '[data-field="composer"]');
    expect(selected(t)).toBe('messages');
  });

  it('shows the contact subtitle (path · last seen) on every tab, not just Messages', async () => {
    const t = await connected();
    const alice = key(t, 'alice');
    await t.go(`/node/${alice}/info`, '[data-field="header"] [data-field="subtitle"]');
    await t.go(`/node/${alice}/path`, '[data-field="header"] [data-field="subtitle"]');
    await t.until(() => selected(t) === 'path', 3000, 'path tab');
    expect(t.query('[data-field="header"] [data-field="subtitle"]')).not.toBeNull();
  });

  it('the Messages tab embeds the chat without its own header; a DM sends and is delivered', async () => {
    const t = await connected();
    const alice = key(t, 'alice');
    await t.go(`/node/${alice}/messages`, '[data-field="composer"]');
    expect(t.query('mc-chat-page')!.hasAttribute('embedded')).toBe(true);
    expect(selected(t)).toBe('messages');
    expect(t.query('.chat-head')).toBeNull();
    expect(t.query('[data-field="header"] [data-field="name"]')!.textContent).toBe('Alice');
    expect(t.query('[data-field="header"] [data-field="subtitle"]')).not.toBeNull();
    await t.fill('[data-field="composer"]', 'hello from the node page');
    await t.click('[data-action="send"]');
    await t.until(() => t.query('.msg[data-dir="out"][data-status="delivered"]'), 8000, 'delivered');
    expect(t.query('.msg[data-dir="out"] [data-field="text"]')!.textContent).toBe('hello from the node page');
  });

  it('a room not logged in hints at the Overview login above its messages', async () => {
    const t = await connected();
    const room = key(t, 'room');
    await t.go(`/node/${room}/messages`, '[data-field="room-login-hint"]');
    expect(t.query<HTMLAnchorElement>('[data-field="room-login-hint"] a')!.getAttribute('href')).toBe(`#/node/${room}/overview`);
  });

  it('toggles favourite from the Info tab, on the radio too', async () => {
    const t = await connected();
    const bob = key(t, 'bob');
    await t.go(`/node/${bob}`, '[data-section="contact"] [data-action="favourite"]');
    const star = () => t.query<HTMLButtonElement>('[data-section="contact"] [data-action="favourite"]')!;
    expect(star().getAttribute('aria-pressed')).toBe('false');
    expect(t.query('[data-field="contact-flags"]')!.textContent!.trim()).toBe('on radio');

    await t.click('[data-section="contact"] [data-action="favourite"]');
    await t.until(() => star().getAttribute('aria-pressed') === 'true' && !star().disabled, 5000, 'starred and saved to the radio');
    expect(t.app.contacts.view(bob)!.favourite).toBe(true);
    expect(star().textContent!.trim()).toBe('★ Favourite');
    expect(t.emulatorScenario().emulator.getContact(t.emulatorScenario().keys.bob)!.flags & ContactFlag.FAVOURITE).toBe(ContactFlag.FAVOURITE);

    await t.click('[data-section="contact"] [data-action="favourite"]');
    await t.until(() => star().getAttribute('aria-pressed') === 'false' && !star().disabled, 5000, 'unstarred and saved to the radio');
    expect(t.app.contacts.view(bob)!.favourite).toBe(false);
    expect(t.emulatorScenario().emulator.getContact(t.emulatorScenario().keys.bob)!.flags & ContactFlag.FAVOURITE).toBe(0);
  });

  it('Remove contact takes two clicks (another click disarms) and the page stays, as a non-contact', async () => {
    const t = await connected();
    const bob = key(t, 'bob');
    await t.go(`/node/${bob}`, '[data-section="contact"] [data-action="remove-contact"]');
    const btn = () => t.query<HTMLButtonElement>('[data-action="remove-contact"]');
    expect(btn()!.textContent!.trim()).toBe('Remove contact');

    await t.click('[data-action="remove-contact"]');
    await t.until(() => btn()?.hasAttribute('data-armed'), 2000, 'armed');
    expect(btn()!.textContent!.trim()).toBe('Confirm remove');
    await t.click('[data-field="key"]');
    await t.until(() => !btn()?.hasAttribute('data-armed'), 2000, 'disarmed by another click');
    expect(t.app.contacts.view(bob)).toBeDefined();

    await t.click('[data-action="remove-contact"]');
    await t.until(() => btn()?.hasAttribute('data-armed'), 2000, 'armed again');
    await t.click('[data-action="remove-contact"]');
    await t.until(() => !t.app.contacts.view(bob) && !t.query('[data-section="contact"]'), 5000, 'removed');
    expect(t.app.node(bob).identity.value?.kind).toBe('unknown'); // no advert of Bob logged
    expect(location.hash).toBe(`#/node/${bob}`);
    expect(t.query('[data-field="header"]')).not.toBeNull();
    await t.until(() => t.text().includes('Removed Bob'), 2000, 'toast');
  });

  it('a node only heard advertising shows its advert and can be added as a contact', async () => {
    const t = await connected();
    const dave = scenarioKey('dave');
    const k = toHex(dave);
    const rec = await logAdvert(t, dave, { nodeType: 2, name: 'Dave Relay', latitude: 47.5, longitude: -122.25 }, { path: [0x11, 0x22], snr: 6 });
    await t.go(`/node/${k}`, '[data-action="add-contact"]');
    expect(t.query('[data-field="header"] [data-field="name"]')!.textContent).toBe('Dave Relay');
    expect(t.query('[data-field="header"] [data-field="type"]')!.textContent).toContain('Repeater');
    expect(t.query('[data-field="key"]')!.textContent).toBe(k);
    expect(t.query('[data-field="location"]')!.textContent).toBe('47.50000, -122.25000');
    expect(t.query('[data-field="heard"]')!.textContent).toContain('2 hops');
    expect(t.query('[data-field="heard"]')!.textContent).toContain('SNR 6');
    expect(t.app.node(k).identity.value).toMatchObject({ kind: 'heard', heard: { heardAt: rec.ts } });
    expect(t.query('[data-section="contact"]')).toBeNull();
    expect(tabs(t)).toEqual(['info', 'stats']);

    await t.click('[data-action="add-contact"]');
    await t.until(() => t.query('[data-section="contact"]'), 5000, 'contact section');
    expect(t.query('[data-action="add-contact"]')).toBeNull();
    expect(t.app.contacts.view(k)).toMatchObject({ name: 'Dave Relay', typeName: 'repeater' });
    expect(tabs(t)).toEqual(['info', 'messages', 'path', 'overview', 'telemetry', 'cli', 'tools', 'stats']);
    await t.until(() => t.text().includes('Added Dave Relay'), 2000, 'toast');
    await t.go('/contacts', `[data-contact="${k}"]`);
  });

  it('resolves a unique 2-hex prefix to the contact; a hash with no data shows only the hash', async () => {
    const t = await connected();
    const views = t.app.contacts.views.value;
    const unique = views.find((v) => views.filter((w) => w.key.startsWith(v.key.slice(0, 2))).length === 1)!;
    const prefix = unique.key.slice(0, 2);
    await t.go(`/node/${prefix}`, '[data-section="contact"]');
    expect(t.query('[data-field="key"]')!.textContent).toBe(unique.key);
    expect(t.query('[data-field="header"] [data-field="name"]')!.textContent).toBe(unique.name);
    expect(t.query<HTMLAnchorElement>('a[data-tab="stats"]')!.getAttribute('href')).toBe(`#/node/${unique.key}/stats`);

    const free = unusedByte(t);
    await t.go(`/node/${free}`, '[data-field="unknown"]');
    expect(t.query('[data-field="key"]')!.textContent).toBe(free);
    expect(t.query('mc-node-info')!.shadowRoot!.querySelector('dt')!.textContent).toBe('Hash');
    expect(t.query('[data-action="add-contact"]')).toBeNull();
    expect(t.query('[data-section="contact"]')).toBeNull();
    expect(tabs(t)).toEqual(['info']);
    expect(t.query<HTMLAnchorElement>('[data-action="node-packets"]')!.getAttribute('href')).toBe(`#/packets/node/${free}`);
  });

  it('lists the candidates of an ambiguous hash', async () => {
    const t = await connected();
    const free = unusedByte(t);
    const a = scenarioKey('erin').slice();
    const b = scenarioKey('frank').slice();
    a[0] = b[0] = parseInt(free, 16);
    await logAdvert(t, a, { nodeType: 1, name: 'Erin' });
    await logAdvert(t, b, { nodeType: 1, name: 'Frank' });
    await t.go(`/node/${free}`, '[data-field="candidates"]');
    const links = t.queryAll<HTMLAnchorElement>('[data-candidate]');
    expect(links.map((l) => l.dataset['candidate']).sort()).toEqual([toHex(a), toHex(b)].sort());
    expect(links.map((l) => l.textContent).sort()).toEqual(['Erin', 'Frank']);
    expect(links[0]!.getAttribute('href')).toBe(`#/node/${links[0]!.dataset['candidate']}`);
    expect(t.query('[data-action="add-contact"]')).toBeNull();
  });

  it('rejects a reference that is not hex', async () => {
    const t = await connected();
    await t.go('/node/xyz', '[data-field="invalid"]');
    expect(t.query('nav[role="tablist"]')).toBeNull();
  });
});
