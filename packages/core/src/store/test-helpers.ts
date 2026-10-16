/** Shared fixtures for the store tests (not exported from the barrel). */

import { IDBFactory } from 'fake-indexeddb';
import type { Contact } from '../protocol/types.js';
import { decodePathLen } from '../protocol/constants.js';
import { buildPacket } from '../packet/packet.js';
import { PayloadType, RouteType } from '../packet/constants.js';
import { RadioStore, type RadioStoreOptions } from './radio-store.js';

/** A fresh, isolated in-memory IndexedDB per test. */
export function freshFactory(): IDBFactory {
  return new IDBFactory();
}

export function key32(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

export function hexKey(fill: number): string {
  return fill.toString(16).padStart(2, '0').repeat(32);
}

export function makeContact(fill: number, over: Partial<Contact> = {}): Contact {
  return {
    pubKey: key32(fill),
    type: 1,
    flags: 0,
    outPathLen: 0xff,
    outPathInfo: decodePathLen(0xff),
    outPath: new Uint8Array(0),
    name: `node-${fill}`,
    lastAdvert: 1_700_000_000,
    lat: 0,
    lon: 0,
    lastMod: 1_700_000_000,
    ...over,
  };
}

/** A small flood GRP_TXT packet with `hops` 1-byte path entries. */
export function grpTxtPacket(hops = 0, fill = 0xaa): Uint8Array {
  return buildPacket({
    routeType: RouteType.FLOOD,
    payloadType: PayloadType.GRP_TXT,
    path: new Uint8Array(hops).fill(0x11),
    payload: new Uint8Array(20).fill(fill),
  });
}

export function advertPacket(fill = 0x55): Uint8Array {
  return buildPacket({ routeType: RouteType.DIRECT, payloadType: PayloadType.ADVERT, payload: new Uint8Array(101).fill(fill) });
}

export async function openStore(pubFill = 0x01, opts: RadioStoreOptions = {}): Promise<RadioStore> {
  return RadioStore.open(key32(pubFill), { factory: freshFactory(), ...opts });
}
