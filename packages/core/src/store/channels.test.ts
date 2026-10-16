import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { sha256 } from '../packet/crypto.js';
import { fromHex, toHex } from '../util/bytes.js';
import { PUBLIC_CHANNEL_SECRET_HEX } from '../protocol/constants.js';
import type { ChannelInfo } from '../protocol/types.js';
import { channelKeyForPsk, isEmptyChannelSlot } from './channels.js';
import { openStore } from './test-helpers.js';

const PUBLIC = fromHex(PUBLIC_CHANNEL_SECRET_HEX);
const PSK2 = new Uint8Array(16).fill(0x22);
const EMPTY = new Uint8Array(16);
const info = (index: number, name: string, secret: Uint8Array): ChannelInfo => ({ index, name, secret });

describe('ChannelsRepo', () => {
  it('keys channels by sha256(psk) hex', async () => {
    expect(await channelKeyForPsk(PUBLIC)).toBe(toHex(await sha256(PUBLIC)));
    expect(isEmptyChannelSlot(info(3, '', EMPTY))).toBe(true);
    expect(isEmptyChannelSlot(info(3, 'x', EMPTY))).toBe(false);
  });

  it('upserts device slots, handles slot reuse and empty slots, preserves local fields', async () => {
    const s = await openStore();
    const pub = (await s.channels.upsertFromDevice(info(0, 'Public', PUBLIC)))!;
    expect(pub).toMatchObject({ key: await channelKeyForPsk(PUBLIC), deviceIndex: 0, name: 'Public', muted: false, unread: 0 });
    await s.channels.update(pub.key, { muted: true, unread: 4 });
    // Slot 0 reused for another PSK: Public is unassigned but kept.
    const other = (await s.channels.upsertFromDevice(info(0, 'Other', PSK2)))!;
    expect((await s.channels.byDeviceIndex(0))!.key).toBe(other.key);
    expect((await s.channels.get(pub.key))!).toMatchObject({ deviceIndex: null, muted: true, unread: 4 });
    // Re-adding Public restores its state at a new slot.
    await s.channels.upsertFromDevice(info(1, 'Public', PUBLIC));
    expect((await s.channels.getByPsk(PUBLIC))!).toMatchObject({ deviceIndex: 1, muted: true, unread: 4 });
    // Empty slot clears the holder.
    expect(await s.channels.upsertFromDevice(info(0, '', EMPTY))).toBeNull();
    expect(await s.channels.byDeviceIndex(0)).toBeUndefined();
    expect((await s.channels.list()).map((c) => [c.name, c.deviceIndex])).toEqual([
      ['Public', 1],
      ['Other', null],
    ]);
    s.close();
  });

  it('full sync assigns slots and unloads channels not on the device', async () => {
    const s = await openStore();
    await s.channels.put({ name: 'Local only', psk: new Uint8Array(16).fill(9) });
    await s.channels.syncFromDevice([info(0, 'Public', PUBLIC), info(1, 'Two', PSK2)]);
    const list = await s.channels.syncFromDevice([info(0, 'Two', PSK2), info(1, '', EMPTY)]);
    expect(list.map((c) => [c.name, c.deviceIndex])).toEqual([
      ['Two', 0],
      ['Local only', null],
      ['Public', null],
    ]);
    s.close();
  });

  it('put / update / delete with events', async () => {
    const s = await openStore();
    const ev: string[] = [];
    s.events.on('channel', (e) => ev.push(e.type === 'put' ? `put:${e.record.name}:${e.record.deviceIndex}` : 'delete'));
    s.events.on('unread', (e) => ev.push(`unread:${e.count}`));
    const a = await s.channels.put({ name: 'A', psk: PSK2, deviceIndex: 2 });
    await s.channels.put({ name: 'B', psk: PUBLIC, deviceIndex: 2 }); // takes slot 2 from A
    expect((await s.channels.get(a.key))!.deviceIndex).toBeNull();
    await s.channels.update(a.key.toUpperCase(), { name: 'A2', unread: 1 });
    expect(await s.channels.update('00', { name: 'x' })).toBeUndefined();
    await s.channels.delete(a.key);
    expect(await s.channels.get(a.key)).toBeUndefined();
    expect(ev).toEqual(['put:A:2', 'put:A:null', 'put:B:2', 'put:A2:null', 'unread:1', 'delete']);
    s.close();
  });
});
