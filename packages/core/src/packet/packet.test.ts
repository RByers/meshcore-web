import { describe, expect, it } from 'vitest';
import { fromHex, toHex, utf8Encode } from '../util/bytes.js';
import { PayloadType, RouteType, payloadTypeName, routeTypeName } from './constants.js';
import { hmacSha256, sha256 } from './crypto.js';
import {
  PacketError,
  buildPacket,
  calcTransportCode,
  decodeHeader,
  encodeHeader,
  firmwareRejectReasons,
  packetHash,
  parsePacket,
  regionKey,
  splitPath,
} from './packet.js';

const h = (s: string): string => s.replace(/\s+/g, '').toLowerCase();
const x = (s: string): Uint8Array => fromHex(h(s));

describe('header byte (mesh-packet-format.md §1.1)', () => {
  it('bits 0-1 route, 2-5 payload type, 6-7 version', () => {
    expect(encodeHeader(RouteType.FLOOD, PayloadType.GRP_TXT)).toBe(0x15);
    expect(encodeHeader(RouteType.DIRECT, PayloadType.TXT_MSG)).toBe(0x0a);
    expect(encodeHeader(RouteType.TRANSPORT_FLOOD, PayloadType.ADVERT)).toBe(0x10);
    expect(encodeHeader(RouteType.TRANSPORT_DIRECT, PayloadType.RAW_CUSTOM, 3)).toBe(0xff);
    expect(decodeHeader(0x15)).toEqual({ routeType: 1, payloadType: 5, payloadVersion: 0 });
    expect(decodeHeader(0xc6)).toEqual({ routeType: 2, payloadType: 1, payloadVersion: 3 });
    expect(routeTypeName(3)).toBe('TRANSPORT_DIRECT');
    expect(payloadTypeName(0x0b)).toBe('CONTROL');
    expect(payloadTypeName(13)).toBe('RESERVED_13');
  });
});

describe('envelope build/parse (§1, Packet::writeTo/readFrom)', () => {
  it('FLOOD zero-hop: [header][path_len=0][payload]', () => {
    const bytes = buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.ACK, payload: x('01020304') });
    expect(toHex(bytes)).toBe(h('0d 00 01020304'));
    const p = parsePacket(bytes);
    expect(p).toMatchObject({ header: 0x0d, routeType: 1, payloadType: 3, payloadVersion: 0, pathLen: 0, pathHashCount: 0 });
    expect(p.transportCodes).toBeUndefined();
    expect(toHex(p.payload)).toBe('01020304');
  });

  it('DIRECT with 2 one-byte hops (§1.3 0x02)', () => {
    const bytes = buildPacket({
      routeType: RouteType.DIRECT,
      payloadType: PayloadType.TXT_MSG,
      path: x('aabb'),
      payload: x('0102 a1a2 ' + '00'.repeat(16).replace(/ /g, '')),
    });
    expect(toHex(bytes)).toBe(h('0a 02 aabb 0102a1a2') + '00'.repeat(16));
    const p = parsePacket(bytes);
    expect(p.pathHashSize).toBe(1);
    expect(splitPath(p.path, p.pathHashSize).map(toHex)).toEqual(['aa', 'bb']);
  });

  it('2-byte hashes: path_len 0x42 = 2 hops × 2 B (§1.3)', () => {
    const bytes = buildPacket({
      routeType: RouteType.FLOOD,
      payloadType: PayloadType.ADVERT,
      path: x('a1a2b1b2'),
      pathHashSize: 2,
      payload: Uint8Array.of(9),
    });
    expect(toHex(bytes)).toBe(h('11 42 a1a2b1b2 09'));
    const p = parsePacket(bytes);
    expect([p.pathHashSize, p.pathHashCount]).toEqual([2, 2]);
    expect(splitPath(p.path, 2).map(toHex)).toEqual(['a1a2', 'b1b2']);
    // 3-byte hashes: 0x81
    expect(toHex(buildPacket({ routeType: 1, payloadType: 4, path: x('010203'), pathHashSize: 3, payload: Uint8Array.of(0) }))).toBe(
      h('11 81 010203 00'),
    );
  });

  it('TRANSPORT_FLOOD carries 2×u16 LE codes before path_len (§1.2)', () => {
    const bytes = buildPacket({
      routeType: RouteType.TRANSPORT_FLOOD,
      payloadType: PayloadType.GRP_TXT,
      transportCodes: [0x1234, 0],
      payload: x('ff'),
    });
    expect(toHex(bytes)).toBe(h('14 3412 0000 00 ff'));
    expect(parsePacket(bytes).transportCodes).toEqual([0x1234, 0]);
    // default codes {0,0} for TRANSPORT_DIRECT
    expect(toHex(buildPacket({ routeType: RouteType.TRANSPORT_DIRECT, payloadType: 4, payload: Uint8Array.of(1) }))).toBe(
      h('13 0000 0000 00 01'),
    );
  });

  it('round-trips every route type and hash size', () => {
    for (const routeType of [0, 1, 2, 3] as const) {
      for (const hashSize of [1, 2, 3]) {
        const path = Uint8Array.from({ length: hashSize * 3 }, (_, i) => i + 1);
        const init = { routeType, payloadType: PayloadType.REQ, path, pathHashSize: hashSize, payload: x('deadbeef') };
        const p = parsePacket(buildPacket(init));
        expect(p.routeType).toBe(routeType);
        expect(p.pathHashSize).toBe(hashSize);
        expect(toHex(p.path)).toBe(toHex(path));
        expect(toHex(buildPacket({ ...init, transportCodes: p.transportCodes }))).toBe(toHex(buildPacket(init)));
      }
    }
  });

  it('rejects structurally invalid packets', () => {
    expect(() => parsePacket(new Uint8Array(0))).toThrow(PacketError);
    expect(() => parsePacket(x('10 3412'))).toThrow(/transport/);
    expect(() => parsePacket(x('11 c1 00'))).toThrow(/path_len/); // hash size 4 reserved
    expect(() => parsePacket(x('11 3f 00'))).toThrow(/past end/); // 63 hops is a valid path_len but truncated here
    expect(() => parsePacket(x('11 61 00'))).toThrow(/path_len/); // 33 × 2 = 66 > 64
    expect(() => buildPacket({ routeType: 1, payloadType: 0, transportCodes: [1, 2], payload: Uint8Array.of(0) })).toThrow(PacketError);
    expect(() => buildPacket({ routeType: 1, payloadType: 0, path: Uint8Array.of(1, 2, 3), pathHashSize: 2, payload: Uint8Array.of(0) })).toThrow();
    expect(() => buildPacket({ routeType: 1, payloadType: 0, payload: new Uint8Array(254) })).toThrow(/255/);
  });

  it('firmwareRejectReasons: version > 0, empty payload, payload > 184', () => {
    expect(firmwareRejectReasons(parsePacket(x('51 00 01')))).toEqual(['payload version 1 is not supported']);
    expect(firmwareRejectReasons(parsePacket(x('11 00')))).toEqual(['empty payload']);
    expect(firmwareRejectReasons(parsePacket(buildPacket({ routeType: 1, payloadType: 0, payload: new Uint8Array(185) })))).toEqual([
      'payload 185 > 184 bytes',
    ]);
    expect(firmwareRejectReasons(parsePacket(x('11 00 01')))).toEqual([]);
  });
});

describe('packet hash (§1.4)', () => {
  it('SHA256(type ‖ payload)[0..8], independent of route and path', async () => {
    const a = parsePacket(x('15 00 112233'));
    const b = parsePacket(x('14 3412 0000 02 aabb 112233'));
    const want = toHex((await sha256(x('05 112233'))).subarray(0, 8));
    expect(toHex(await packetHash(a))).toBe(want);
    expect(toHex(await packetHash(b))).toBe(want);
  });

  it('TRACE includes path_len as a 2-byte u16 LE', async () => {
    const p = parsePacket(x('26 02 2820 0100000002000000 00 aabb'));
    const want = toHex((await sha256(x('09 0200 0100000002000000 00 aabb'))).subarray(0, 8));
    expect(toHex(await packetHash(p))).toBe(want);
  });
});

describe('transport codes (§1.2 calcTransportCode)', () => {
  it('= HMAC-SHA256(key16, type ‖ payload)[0..2] as u16 LE; region key = SHA256("#name")[0..16]', async () => {
    const key = await regionKey('#test');
    expect(toHex(key)).toBe('9cd8fcf22a47333b591d96a2b848b73f');
    expect(toHex(await regionKey('test'))).toBe(toHex(key));
    const payload = utf8Encode('payload');
    const mac = await hmacSha256(key, Uint8Array.of(5), payload);
    const raw = mac[0]! | (mac[1]! << 8);
    const expected = raw === 0 ? 1 : raw === 0xffff ? 0xfffe : raw;
    expect(await calcTransportCode(key, 5, payload)).toBe(expected);
  });
});
