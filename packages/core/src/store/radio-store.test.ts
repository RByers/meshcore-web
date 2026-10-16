import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { encodeDeviceFrame } from '../protocol/encode-frame.js';
import { PayloadType } from '../packet/constants.js';
import { RadioStore } from './radio-store.js';
import { freshFactory, grpTxtPacket, hexKey, key32, makeContact } from './test-helpers.js';

describe('RadioStore', () => {
  it('keeps each radio in its own database', async () => {
    const factory = freshFactory();
    const a = await RadioStore.open(key32(0xa1), { factory });
    const b = await RadioStore.open(hexKey(0xb2).toUpperCase(), { factory });
    expect(a.db.name).toBe(`meshcore-web:${hexKey(0xa1)}`);
    expect(b.pubKey).toBe(hexKey(0xb2));
    await a.contacts.upsertFromDevice(makeContact(5));
    await a.frames.append({ direction: 'in', bytes: Uint8Array.of(0) });
    await a.settings.set('x', 'a');
    await b.settings.set('x', 'b');
    expect(await b.contacts.count()).toBe(0);
    expect(await b.frames.count()).toBe(0);
    expect(await a.settings.get('x')).toBe('a');
    expect(await b.settings.get('x')).toBe('b');
    // Events are per store too.
    let bFrames = 0;
    b.events.on('frame', () => bFrames++);
    await a.frames.append({ direction: 'in', bytes: Uint8Array.of(0) });
    expect(bFrames).toBe(0);
    a.close();
    b.close();
    // Data survives reopening.
    const a2 = await RadioStore.open(key32(0xa1), { factory });
    expect(await a2.contacts.count()).toBe(1);
    expect(await a2.frames.count()).toBe(2);
    a2.close();
    await RadioStore.delete(key32(0xa1), { factory });
    const a3 = await RadioStore.open(key32(0xa1), { factory });
    expect(await a3.contacts.count()).toBe(0);
    a3.close();
  });

  it('captureFrame logs the frame and the packet it carries, linked by sourceFrameId', async () => {
    const s = await RadioStore.open(key32(1), { factory: freshFactory() });
    const packet = grpTxtPacket(1);
    const bytes = encodeDeviceFrame({ kind: 'logRxData', code: 0x88, snr: 6.5, rssi: -80, packet });
    const r = await s.captureFrame('in', bytes, { ts: 42 });
    expect(r.decoded?.kind).toBe('logRxData');
    expect(r.frame).toMatchObject({ ts: 42, direction: 'in', code: 0x88, kind: 'logRxData', size: bytes.length });
    expect(r.packet).toMatchObject({ ts: 42, direction: 'rx', sourceFrameId: r.frame.id, snr: 6.5, rssi: -80, payloadType: PayloadType.GRP_TXT });
    expect(r.packet!.bytes).toEqual(packet);

    const ok = await s.captureFrame('in', Uint8Array.of(0x00));
    expect(ok.packet).toBeNull();
    const out = await s.captureFrame('out', Uint8Array.of(0x16));
    expect(out.decoded).toBeNull();
    expect(out.packet).toBeNull();
    expect(await s.frames.count()).toBe(3);
    expect(await s.packets.count()).toBe(1);
    s.close();
  });
});
