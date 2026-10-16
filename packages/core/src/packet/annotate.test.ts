import { describe, expect, it } from 'vitest';
import { concatBytes, fromHex, toHex, utf8Encode } from '../util/bytes.js';
import { PUBLIC_CHANNEL_SECRET_HEX, TxtType } from '../protocol/constants.js';
import { PayloadType, RouteType } from './constants.js';
import { calcSharedSecret, ed25519KeyPairFromSeed } from './crypto.js';
import { buildPacket } from './packet.js';
import {
  buildAckPayload,
  buildAdvertPayload,
  buildAnonReqPayload,
  buildDiscoverReqPayload,
  buildDiscoverRespPayload,
  buildGroupDatagramPayload,
  buildGrpDataPlaintext,
  buildGrpTxtPlaintext,
  buildLoginRequest,
  buildMultipartAckPayload,
  buildPathPlaintext,
  buildPeerDatagramPayload,
  buildReqPlaintext,
  buildResponsePlaintext,
  buildTracePayload,
  buildTxtMsgPlaintext,
  channelHash,
} from './payloads.js';
import { annotatePacket, annotatePacketSync, annotatePayload, annotatePayloadSync, type AnnotateKeys, type AnnotationNode } from './annotate.js';

const PSK = fromHex(PUBLIC_CHANNEL_SECRET_HEX);
const a = await ed25519KeyPairFromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const b = await ed25519KeyPairFromSeed(Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i));
const secretAB = await calcSharedSecret(a.privateKey, b.publicKey);
const KEYS: AnnotateKeys = { channelPsks: [PSK], self: b, contacts: [a.publicKey] };

/** Every node's non-bit children must tile the node's byte range exactly (no gaps/overlaps). */
function checkTiling(n: AnnotationNode, path = n.name): void {
  const kids = (n.children ?? []).filter((c) => !c.bits);
  for (const c of n.children ?? []) {
    if (c.bits) expect([c.offset, c.length], `${path}/${c.name} bits`).toEqual([n.offset, n.length]);
  }
  if (kids.length === 0) return;
  let pos = n.offset;
  for (const c of kids) {
    expect(c.offset, `${path}/${c.name} starts at ${pos}`).toBe(pos);
    expect(c.length, `${path}/${c.name} length`).toBeGreaterThan(0);
    pos += c.length;
    checkTiling(c, `${path}/${c.name}`);
  }
  expect(pos, `${path} children end`).toBe(n.offset + n.length);
}

function find(n: AnnotationNode, name: string): AnnotationNode | undefined {
  if (n.name === name) return n;
  for (const c of n.children ?? []) {
    const f = find(c, name);
    if (f) return f;
  }
  return undefined;
}

function leaves(n: AnnotationNode): AnnotationNode[] {
  const kids = (n.children ?? []).filter((c) => !c.bits && !c.decrypted);
  return kids.length ? kids.flatMap(leaves) : [n];
}

const fixtures: Record<string, () => Promise<Uint8Array>> = {
  'GRP_TXT flood (public channel)': async () =>
    buildPacket({
      routeType: RouteType.FLOOD,
      payloadType: PayloadType.GRP_TXT,
      path: fromHex('a1b2'),
      payload: await buildGroupDatagramPayload({
        channelHash: await channelHash(PSK),
        secret: PSK,
        plaintext: buildGrpTxtPlaintext({ timestamp: 1700000000, senderName: 'alice', text: 'hello world' }),
      }),
    }),
  'GRP_DATA transport flood': async () =>
    buildPacket({
      routeType: RouteType.TRANSPORT_FLOOD,
      payloadType: PayloadType.GRP_DATA,
      transportCodes: [0x1234, 0],
      payload: await buildGroupDatagramPayload({ channelHash: 0x11, secret: PSK, plaintext: buildGrpDataPlaintext(0xff00, fromHex('0102')) }),
    }),
  'TXT_MSG direct 2-byte path': async () =>
    buildPacket({
      routeType: RouteType.DIRECT,
      payloadType: PayloadType.TXT_MSG,
      path: fromHex('a1a2b1b2'),
      pathHashSize: 2,
      payload: await buildPeerDatagramPayload({
        destHash: b.publicKey[0]!,
        srcHash: a.publicKey[0]!,
        secret: secretAB,
        plaintext: buildTxtMsgPlaintext({ timestamp: 1700000000, text: 'hi bob', attempt: 5 }),
      }),
    }),
  'TXT_MSG signed plain': async () =>
    buildPacket({
      routeType: RouteType.FLOOD,
      payloadType: PayloadType.TXT_MSG,
      payload: await buildPeerDatagramPayload({
        destHash: b.publicKey[0]!,
        srcHash: a.publicKey[0]!,
        secret: secretAB,
        plaintext: buildTxtMsgPlaintext({ timestamp: 1, text: 'room post', txtType: TxtType.SIGNED_PLAIN, authorPrefix: a.publicKey }),
      }),
    }),
  'REQ': async () =>
    buildPacket({
      routeType: RouteType.FLOOD,
      payloadType: PayloadType.REQ,
      payload: await buildPeerDatagramPayload({
        destHash: b.publicKey[0]!,
        srcHash: a.publicKey[0]!,
        secret: secretAB,
        plaintext: buildReqPlaintext(1700000000, 0x01, fromHex('0000000011223344')),
      }),
    }),
  'RESPONSE': async () =>
    buildPacket({
      routeType: RouteType.DIRECT,
      payloadType: PayloadType.RESPONSE,
      payload: await buildPeerDatagramPayload({
        destHash: b.publicKey[0]!,
        srcHash: a.publicKey[0]!,
        secret: secretAB,
        plaintext: buildResponsePlaintext(1700000000, fromHex('01740190')),
      }),
    }),
  'PATH with ACK': async () =>
    buildPacket({
      routeType: RouteType.FLOOD,
      payloadType: PayloadType.PATH,
      payload: await buildPeerDatagramPayload({
        destHash: b.publicKey[0]!,
        srcHash: a.publicKey[0]!,
        secret: secretAB,
        plaintext: buildPathPlaintext({ path: fromHex('0a0b0c'), extraType: PayloadType.ACK, extra: fromHex('08d88350 0011'.replace(' ', '')) }),
      }),
    }),
  'PATH no extra': async () =>
    buildPacket({
      routeType: RouteType.DIRECT,
      payloadType: PayloadType.PATH,
      payload: await buildPeerDatagramPayload({
        destHash: b.publicKey[0]!,
        srcHash: a.publicKey[0]!,
        secret: secretAB,
        plaintext: buildPathPlaintext({ path: new Uint8Array(0), random: fromHex('01020304') }),
      }),
    }),
  'ANON_REQ login': async () =>
    buildPacket({
      routeType: RouteType.FLOOD,
      payloadType: PayloadType.ANON_REQ,
      payload: await buildAnonReqPayload({
        destHash: b.publicKey[0]!,
        senderPublicKey: a.publicKey,
        secret: secretAB,
        plaintext: buildLoginRequest({ timestamp: 9, password: 'password' }),
      }),
    }),
  'ADVERT': async () =>
    buildPacket({
      routeType: RouteType.FLOOD,
      payloadType: PayloadType.ADVERT,
      path: fromHex('01'),
      payload: await buildAdvertPayload({
        keys: a,
        timestamp: 1700000000,
        appData: { nodeType: 2, latitude: 1.5, longitude: -2.25, feat1: 1, feat2: 2, name: 'Repeater 1' },
      }),
    }),
  'ACK 6-byte': async () => buildPacket({ routeType: RouteType.DIRECT, payloadType: PayloadType.ACK, path: fromHex('aa'), payload: buildAckPayload(fromHex('08d88350'), fromHex('0042')) }),
  'MULTIPART ack': async () => buildPacket({ routeType: RouteType.DIRECT, payloadType: PayloadType.MULTIPART, payload: buildMultipartAckPayload(fromHex('08d88350'), 1) }),
  'TRACE': async () =>
    buildPacket({
      routeType: RouteType.DIRECT,
      payloadType: PayloadType.TRACE,
      path: fromHex('28f8'),
      payload: buildTracePayload({ tag: 1, authCode: 2, flags: 0, hashes: fromHex('aabbcc') }),
    }),
  'CONTROL discover req': async () => buildPacket({ routeType: RouteType.DIRECT, payloadType: PayloadType.CONTROL, payload: buildDiscoverReqPayload({ typeFilter: 4, tag: 7, since: 1 }) }),
  'CONTROL discover resp': async () =>
    buildPacket({ routeType: RouteType.DIRECT, payloadType: PayloadType.CONTROL, payload: buildDiscoverRespPayload({ nodeType: 2, snr: 5, tag: 7, publicKey: a.publicKey }) }),
  'RAW_CUSTOM': async () => buildPacket({ routeType: RouteType.DIRECT, payloadType: PayloadType.RAW_CUSTOM, payload: fromHex('deadbeef') }),
  'reserved type 13': async () => buildPacket({ routeType: RouteType.FLOOD, payloadType: 13, payload: fromHex('01') }),
};

describe('annotatePacket — every fixture is tiled exactly', () => {
  for (const [name, make] of Object.entries(fixtures)) {
    it(name, async () => {
      const bytes = await make();
      for (const ann of [await annotatePacket(bytes, { keys: KEYS }), await annotatePacket(bytes), annotatePacketSync(bytes)]) {
        expect([ann.offset, ann.length]).toEqual([0, bytes.length]);
        checkTiling(ann);
        const ls = leaves(ann);
        expect(ls.reduce((s, l) => s + l.length, 0)).toBe(bytes.length);
        expect(ann.errors.filter((e) => !e.startsWith('reserved payload type'))).toEqual([]);
      }
    });
  }
});

describe('annotatePacket — content', () => {
  it('header/path_len bits and path entries', async () => {
    const ann = await annotatePacket(await fixtures['TXT_MSG direct 2-byte path']!());
    expect(ann.value).toBe('DIRECT TXT_MSG');
    expect(ann.meaning).toMatch(/^packet hash [0-9a-f]{16}$/);
    const header = find(ann, 'header')!;
    expect(header.children?.map((c) => [c.name, c.value, c.bits?.mask])).toEqual([
      ['route type', '2', 0x03],
      ['payload type', '2', 0x3c],
      ['payload version', '0', 0xc0],
    ]);
    const pl = find(ann, 'path_len')!;
    expect(pl.value).toBe('0x42');
    expect(pl.children?.map((c) => [c.name, c.value])).toEqual([
      ['hash size', '2'],
      ['hop count', '2'],
    ]);
    expect(find(ann, 'path')!.children?.map((c) => c.value)).toEqual(['a1a2', 'b1b2']);
  });

  it('decrypts a channel message with the PSK and nests decrypted fields', async () => {
    const ann = await annotatePacket(await fixtures['GRP_TXT flood (public channel)']!(), { keys: KEYS });
    const ct = find(ann, 'ciphertext')!;
    expect(ct.meaning).toBe('decrypted with channel PSK #0');
    expect(find(ann, 'MAC')!.meaning).toBe('verified (channel PSK #0)');
    expect(ct.children!.every((c) => c.decrypted)).toBe(true);
    const text = ct.children!.find((c) => c.name === 'text')!;
    expect(text.value).toBe('"alice: hello world"');
    expect(text.meaning).toBe('sender "alice" (unauthenticated)');
    expect(ct.children!.map((c) => c.name)).toEqual(['timestamp', 'flags', 'text', 'NUL', 'padding']);
    // without keys: no decrypted children
    const plain = await annotatePacket(await fixtures['GRP_TXT flood (public channel)']!());
    expect(find(plain, 'ciphertext')!.children).toBeUndefined();
  });

  it('decrypts a DM via ECDH (self + contacts), with extended attempt', async () => {
    const ann = await annotatePacket(await fixtures['TXT_MSG direct 2-byte path']!(), { keys: KEYS });
    const ct = find(ann, 'ciphertext')!;
    expect(ct.meaning).toBe(`decrypted with ECDH with ${toHex(a.publicKey.subarray(0, 6))}`);
    expect(ct.children!.map((c) => [c.name, c.value])).toEqual([
      ['timestamp', '1700000000'],
      ['flags', '0x01'],
      ['text', '"hi bob"'],
      ['NUL', '00'],
      ['extended attempt', '5'],
      ['padding', '000000'],
    ]);
    // the sender can decrypt its own message too (self = a, contact = b)
    const asSender = await annotatePacket(await fixtures['TXT_MSG direct 2-byte path']!(), { keys: { self: a, contacts: [b.publicKey] } });
    expect(find(asSender, 'ciphertext')!.children).toBeDefined();
    // raw shared secret
    const viaSecret = await annotatePacket(await fixtures['REQ']!(), { keys: { sharedSecrets: [secretAB] } });
    expect(find(viaSecret, 'req_type')!.meaning).toBe('GET_STATUS');
  });

  it('decrypts ANON_REQ from the cleartext sender key and PATH inner layout', async () => {
    const anon = await annotatePacket(await fixtures['ANON_REQ login']!(), { keys: { self: b } });
    expect(find(anon, 'request data')!.value).toBe(toHex(utf8Encode('password')));
    const path = await annotatePacket(await fixtures['PATH with ACK']!(), { keys: KEYS });
    const ct = find(path, 'ciphertext')!;
    expect(ct.children!.map((c) => c.name)).toEqual(['path_len', 'path', 'extra_type', 'ack code', 'extended attempt', 'random', 'padding']);
    expect(ct.children![1]!.children!.map((c) => c.value)).toEqual(['0a', '0b', '0c']);
  });

  it('advert signature check and app_data fields', async () => {
    const bytes = await fixtures['ADVERT']!();
    const ann = await annotatePacket(bytes);
    expect(find(ann, 'signature')!.meaning).toBe('valid signature');
    expect(find(ann, 'name')!.value).toBe('"Repeater 1"');
    expect(find(ann, 'latitude')!.value).toBe('1.5');
    expect(find(ann, 'longitude')!.value).toBe('-2.25');
    const flags = find(ann, 'app_data')!.children![0]!;
    expect(flags.children!.find((c) => c.name === 'node type')!.meaning).toBe('repeater');
    const forged = bytes.slice();
    forged[forged.length - 1] = forged[forged.length - 1]! ^ 1;
    const bad = await annotatePacket(forged);
    expect(find(bad, 'signature')!.meaning).toBe('INVALID signature');
    expect(bad.errors).toContain('advert signature does not verify');
  });

  it('TRACE path holds SNRs', async () => {
    const ann = await annotatePacket(await fixtures['TRACE']!());
    expect(find(ann, 'path_len')!.children![1]).toMatchObject({ name: 'SNR count', value: '2' });
    expect(find(ann, 'path (SNRs)')!.children!.map((c) => c.meaning)).toEqual(['10 dB', '-2 dB']);
    expect(find(ann, 'hop hashes')!.children!.map((c) => c.value)).toEqual(['aa', 'bb', 'cc']);
  });

  it('reports firmware rejections and trailing bytes', async () => {
    const v1 = await annotatePacket(fromHex('5100' + '01'));
    expect(v1.errors).toContain('firmware would reject: payload version 1 is not supported');
    const shortTxt = await annotatePacket(fromHex('0900' + '0102a1a2' + '00'.repeat(15)));
    expect(shortTxt.errors.some((e) => e.includes('not a multiple of 16'))).toBe(true);
    checkTiling(shortTxt);
    const ctrl = await annotatePacket(fromHex('2e00' + '80'));
    checkTiling(ctrl);
    expect(ctrl.errors.length).toBeGreaterThan(0);
  });
});

describe('annotatePacket — garbage input never throws and stays tiled', () => {
  // xorshift for reproducibility
  let seed = 0x12345678;
  const rnd = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 2 ** 32;
  };
  const randomBytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => Math.floor(rnd() * 256));

  it('random byte strings', async () => {
    for (let i = 0; i < 1500; i++) {
      const bytes = randomBytes(Math.floor(rnd() * 270));
      const ann = await annotatePacket(bytes, { keys: KEYS });
      expect(ann.length).toBe(bytes.length);
      checkTiling(ann);
    }
  });

  it('every truncation and single-byte corruption of every fixture', async () => {
    for (const make of Object.values(fixtures)) {
      const good = await make();
      for (let len = 0; len <= good.length; len++) {
        const ann = annotatePacketSync(good.subarray(0, len));
        checkTiling(ann);
        if (len < good.length && len > 0) expect(ann.errors.length + (ann.children?.length ?? 0)).toBeGreaterThan(0);
      }
      for (let i = 0; i < good.length; i += 3) {
        const bad = good.slice();
        bad[i] = bad[i]! ^ (1 + Math.floor(rnd() * 255));
        checkTiling(await annotatePacket(concatBytes(bad, randomBytes(Math.floor(rnd() * 4))), { keys: KEYS }));
      }
    }
  });
});

describe('annotatePayload (bare payloads: RAW_DATA / TRACE_DATA / CONTROL_DATA records)', () => {
  it('TRACE payload §3.10: offsets relative to the payload, tiling', async () => {
    const pl = buildTracePayload({ tag: 7, authCode: 9, flags: 1, hashes: fromHex('aabbccdd') });
    const ann = await annotatePayload(PayloadType.TRACE, pl);
    checkTiling(ann);
    expect(ann.errors).toEqual([]);
    expect(ann.value).toBe('TRACE, 13 bytes');
    expect(find(ann, 'tag')).toMatchObject({ offset: 0, length: 4, value: '7' });
    expect(find(ann, 'flags')).toMatchObject({ offset: 8, length: 1 });
    expect(find(ann, 'hash[1]')).toMatchObject({ offset: 11, length: 2, value: 'ccdd' });
  });

  it('GRP_TXT payload decrypts with a PSK; sync variant does not', async () => {
    const pl = await buildGroupDatagramPayload({
      channelHash: await channelHash(PSK),
      secret: PSK,
      plaintext: buildGrpTxtPlaintext({ timestamp: 1, senderName: 'a', text: 'b' }),
    });
    const ann = await annotatePayload(PayloadType.GRP_TXT, pl, { keys: KEYS });
    checkTiling(ann);
    expect(find(ann, 'text')).toMatchObject({ decrypted: true, value: '"a: b"' });
    expect(find(annotatePayloadSync(PayloadType.GRP_TXT, pl), 'text')).toBeUndefined();
    expect((await annotatePayload(PayloadType.ACK, new Uint8Array(0))).errors).toEqual(['empty payload']);
  });
});
