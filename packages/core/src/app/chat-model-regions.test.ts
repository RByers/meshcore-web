import { describe, expect, it, vi } from 'vitest';
import { toHex } from '../util/bytes.js';
import { PayloadType, RouteType } from '../packet/constants.js';
import { parsePacket } from '../packet/packet.js';
import { transportCodeSync } from '../emulator/crypto-sync.js';
import { channelKeyForPsk } from '../store/channels.js';
import { publicChannelSecret } from '../emulator/scenarios.js';
import { UNSCOPED_REGION, regionKeySync } from './regions-model.js';
import { connectedApp, type ConnectedApp, type TestAppOptions } from './testing.js';

/** Out commands (kind + bytes hex) and the on-air GRP_TXT packets from now on. */
function watch(t: ConnectedApp) {
  const out: Array<{ kind: string; hex: string }> = [];
  t.client.events.on('frame', (e) => {
    if (e.direction === 'out' && e.command) out.push({ kind: e.command, hex: toHex(e.bytes) });
  });
  const start = t.scenario.emulator.airLog.length;
  const packets = () =>
    t.scenario.emulator.airLog
      .slice(start)
      .filter((e) => e.type === 'grpTxt')
      .map((e) => parsePacket((e as unknown as { raw: Uint8Array }).raw));
  const scopes = () => out.filter((o) => o.kind === 'setFloodScopeKey').map((o) => o.hex);
  return { out, packets, scopes };
}

async function publicChat(opts: TestAppOptions = {}) {
  const t = await connectedApp(opts);
  const chat = t.app.chat('channel', await channelKeyForPsk(publicChannelSecret()));
  await chat.settled();
  await vi.waitFor(() => expect(chat.channel.value?.name).toBe('Public'));
  return { t, chat };
}

describe('ChatModel: channel regions (flood scope)', () => {
  it('no region and no radio default: plain flood, no SET_FLOOD_SCOPE_KEY', async () => {
    const { t, chat } = await publicChat();
    const w = watch(t);
    expect(chat.region.value).toBeUndefined();
    expect(chat.effectiveRegion.value).toBeNull();
    const h = await chat.send('plain');
    expect((await h.done).status).toBe('sent');
    expect(w.scopes()).toEqual([]);
    expect(h.record.region).toBeUndefined();
    expect(w.packets()[0]!.routeType).toBe(RouteType.FLOOD);
  });

  it('a channel region: SET key, send, reset — on air as TRANSPORT_FLOOD with the region code', async () => {
    const { t, chat } = await publicChat();
    await chat.setRegion('#east');
    await vi.waitFor(() => expect(chat.region.value).toBe('east'));
    expect(chat.effectiveRegion.value).toEqual({ name: 'east', fromDefault: false });
    const w = watch(t);
    const h = await chat.send('scoped');
    expect((await h.done).status).toBe('sent');
    expect(h.record.region).toBe('east');
    const key = regionKeySync('east');
    // CMD 54: [54][0][key16] sets the session scope, [54][0] resets it (companion-protocol.md §4)
    expect(w.out.map((o) => o.kind)).toEqual(['setFloodScopeKey', 'sendChannelTxtMsg', 'setFloodScopeKey']);
    expect(w.scopes()).toEqual([`3600${toHex(key)}`, '3600']);
    const p = w.packets()[0]!;
    expect(p.routeType).toBe(RouteType.TRANSPORT_FLOOD);
    expect(p.transportCodes![0]).toBe(transportCodeSync(key, PayloadType.GRP_TXT, p.payload));
    expect(t.scenario.emulator.floodScope.key.every((b) => b === 0)).toBe(true);
    await vi.waitFor(() => expect(t.scenario.nodes.alice.channelMessages.map((m) => m.text)).toContain('Emulator: scoped'));

    await expect(chat.setRegion('Not Valid')).rejects.toThrow(/lowercase/);
    await chat.setRegion(undefined);
    await vi.waitFor(() => expect(chat.region.value).toBeUndefined());
  });

  it('send({region}) overrides the channel scope for one message', async () => {
    const { t, chat } = await publicChat();
    await chat.setRegion('east');
    await vi.waitFor(() => expect(chat.region.value).toBe('east'));
    const w = watch(t);
    const h = await chat.send('reply', { region: '#west' });
    await h.done;
    expect(h.record.region).toBe('west');
    expect(w.scopes()).toEqual([`3600${toHex(regionKeySync('west'))}`, '3600']);
  });

  it('the radio default scope applies without SET; "no region" forces a plain flood (v12+)', async () => {
    const { t, chat } = await publicChat();
    const homeKey = regionKeySync('home');
    await t.client.setDefaultFloodScope({ name: 'home', key: homeKey });
    await t.app.deviceSettings.loadDefaultFloodScope();
    expect(chat.effectiveRegion.value).toEqual({ name: 'home', fromDefault: true });
    const w = watch(t);
    const h = await chat.send('home');
    await h.done;
    expect(h.record.region).toBe('home');
    expect(w.scopes()).toEqual([]);
    const p = w.packets()[0]!;
    expect(p.routeType).toBe(RouteType.TRANSPORT_FLOOD);
    expect(p.transportCodes![0]).toBe(transportCodeSync(homeKey, PayloadType.GRP_TXT, p.payload));

    expect(chat.unscopedSupported.value).toBe(true);
    await chat.setRegion(UNSCOPED_REGION);
    await vi.waitFor(() => expect(chat.effectiveRegion.value).toBeNull());
    const w2 = watch(t);
    const h2 = await chat.send('everyone');
    await h2.done;
    expect(h2.record.region).toBeUndefined();
    expect(w2.scopes()).toEqual(['3601', '3600']);
    expect(w2.packets()[0]!.routeType).toBe(RouteType.FLOOD);
  });

  it('firmware before v12 cannot send unscoped: no SET, the radio default applies', async () => {
    const { t, chat } = await publicChat({ scenario: { firmware: { verCode: 11 } } });
    expect(chat.unscopedSupported.value).toBe(false);
    await chat.setRegion(UNSCOPED_REGION);
    await vi.waitFor(() => expect(chat.region.value).toBe(UNSCOPED_REGION));
    const w = watch(t);
    await (await chat.send('old fw')).done;
    expect(w.scopes()).toEqual([]);
  });

  it('a failed retry goes out with the current channel scope', async () => {
    const { t, chat } = await publicChat();
    const w = watch(t);
    const orig = t.client.sendChannelMessage.bind(t.client);
    let fail = true;
    t.client.sendChannelMessage = (...args) => (fail ? Promise.reject(new Error('boom')) : orig(...args));
    const h = await chat.send('again');
    expect((await h.done).status).toBe('failed');
    fail = false;
    await chat.setRegion('east');
    await vi.waitFor(() => expect(chat.region.value).toBe('east'));
    const r = await chat.retry(h.record.id);
    const done = await r.done;
    expect(done.status).toBe('sent');
    expect(done.region).toBe('east');
    expect(w.scopes()).toEqual([`3600${toHex(regionKeySync('east'))}`, '3600']);
  });

  it('channel reactions go out with the channel scope', async () => {
    const { t, chat } = await publicChat();
    await chat.setRegion('east');
    await vi.waitFor(() => expect(chat.region.value).toBe('east'));
    const target = chat.messages.value.find((m) => m.direction === 'in')!;
    const w = watch(t);
    await (await chat.react(target.id, '👍')).done;
    expect(w.scopes()).toEqual([`3600${toHex(regionKeySync('east'))}`, '3600']);
    expect(w.packets()[0]!.routeType).toBe(RouteType.TRANSPORT_FLOOD);
  });

  it('withFloodScope serialises sections (the scope is one sticky device setting)', async () => {
    const { t } = await publicChat();
    const w = watch(t);
    const a = regionKeySync('a');
    const b = regionKeySync('b');
    const order: string[] = [];
    await Promise.all([
      t.client.withFloodScope(a, async () => {
        order.push('a');
        await t.client.sendChannelMessage(0, 'one');
      }),
      t.client.withFloodScope(null, async () => {
        order.push('none');
      }),
      t.client.withFloodScope(b, async () => {
        order.push('b');
        throw new Error('fails');
      }).catch(() => undefined),
    ]);
    expect(order).toEqual(['a', 'none', 'b']);
    expect(w.scopes()).toEqual([`3600${toHex(a)}`, '3600', `3600${toHex(b)}`, '3600']);
  });
});
