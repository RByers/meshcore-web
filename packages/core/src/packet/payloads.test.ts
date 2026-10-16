import { describe, expect, it } from 'vitest';
import { concatBytes, fromHex, toHex, utf8Encode } from '../util/bytes.js';
import { ControlType, PUBLIC_CHANNEL_SECRET_HEX, TxtType } from '../protocol/constants.js';
import { PayloadType } from './constants.js';
import { calcSharedSecret, ed25519KeyPairFromSeed, encryptThenMac } from './crypto.js';
import {
  PayloadError,
  ackCodeForTxtPlaintext,
  buildAckPayload,
  buildAdvertPayload,
  buildAnonReqPayload,
  buildDiscoverReqPayload,
  buildDiscoverRespPayload,
  buildGroupDatagramPayload,
  buildGrpDataPlaintext,
  buildGrpTxtPlaintext,
  buildLoginOkPlaintext,
  buildLoginRequest,
  buildMultipartAckPayload,
  buildPathPlaintext,
  buildPeerDatagramPayload,
  buildReqPlaintext,
  buildResponsePlaintext,
  buildTracePayload,
  buildTxtMsgPlaintext,
  channelHash,
  decryptPayload,
  encodeAdvertAppData,
  hashtagChannelPsk,
  nodeHash,
  nodeHashByte,
  parseAccessList,
  parseAdvertAppData,
  parseGrpDataPlaintext,
  parseGrpTxtPlaintext,
  parseLoginRequest,
  parseLoginResponse,
  parseNeighbours,
  parseOwnerInfo,
  parsePathPlaintext,
  parsePayload,
  parseReqPlaintext,
  parseResponsePlaintext,
  parseStatusBody,
  parseTxtMsgPlaintext,
  textAckCode,
  utf8Truncate,
  verifyAdvert,
  type AdvertPayload,
} from './payloads.js';

const h = (s: string): string => s.replace(/\s+/g, '').toLowerCase();
const x = (s: string): Uint8Array => fromHex(h(s));
const PSK = fromHex(PUBLIC_CHANNEL_SECRET_HEX);
const SEED_A = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const SEED_B = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i);

describe('hashes & ack codes', () => {
  it('node hash = pubkey prefix (§1.3, §3.0)', () => {
    const pk = Uint8Array.from({ length: 32 }, (_, i) => i + 0x10);
    expect(toHex(nodeHash(pk))).toBe('10');
    expect(toHex(nodeHash(pk, 3))).toBe('101112');
    expect(nodeHashByte(pk)).toBe(0x10);
  });

  it('channel hash = SHA256(psk16)[0]; public channel → 0x11 (§2)', async () => {
    expect(await channelHash(PSK)).toBe(0x11);
    expect(await channelHash(concatBytes(PSK, new Uint8Array(16)))).toBe(0x11); // zero-padded 32-byte form
    expect(toHex(await hashtagChannelPsk('#test'))).toBe('9cd8fcf22a47333b591d96a2b848b73f');
    expect(toHex(await hashtagChannelPsk('test'))).toBe('9cd8fcf22a47333b591d96a2b848b73f');
  });

  it('plain ACK = SHA256(ts ‖ attempt&3 ‖ text ‖ sender pubkey)[0..4] (§3.4; python hashlib vector)', async () => {
    const sender = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    expect(toHex(await textAckCode({ timestamp: 0x12345678, text: 'hello', senderPublicKey: sender }))).toBe('08d88350');
    expect(toHex(await textAckCode({ timestamp: 0x12345678, attempt: 2, text: 'hello', senderPublicKey: sender }))).toBe('ca41cad0');
    expect(toHex(await textAckCode({ timestamp: 0x12345678, attempt: 6, text: 'hello', senderPublicKey: sender }))).toBe('ca41cad0');
    // receiver side, from a padded plaintext
    const pt = concatBytes(buildTxtMsgPlaintext({ timestamp: 0x12345678, text: 'hello' }), new Uint8Array(6));
    expect(toHex((await ackCodeForTxtPlaintext(pt, { senderPublicKey: sender }))!)).toBe('08d88350');
    const cli = buildTxtMsgPlaintext({ timestamp: 1, text: 'ver', txtType: TxtType.CLI_DATA });
    expect(await ackCodeForTxtPlaintext(cli, { senderPublicKey: sender })).toBeNull();
  });
});

describe('ADVERT (§3.5)', () => {
  it('app_data layout: flags, lat/lon i32×1e6, feat1, feat2, name', () => {
    const app = encodeAdvertAppData({ nodeType: 2, latitude: 37.7749, longitude: -122.4194, feat1: 0x0102, feat2: 0x0304, name: 'Rpt' });
    // flags 0xF2; lat 37774900 = 0x0240_6634; lon -122419400 = 0xF8B4_0738
    expect(toHex(app)).toBe(h('f2 34664002 3807b4f8 0201 0403 527074'));
    expect(parseAdvertAppData(app)).toEqual({
      flags: 0xf2,
      nodeType: 2,
      latitudeE6: 37774900,
      longitudeE6: -122419400,
      latitude: 37.7749,
      longitude: -122.4194,
      feat1: 0x0102,
      feat2: 0x0304,
      name: 'Rpt',
      valid: true,
    });
    expect(toHex(encodeAdvertAppData({ nodeType: 1, name: 'Al' }))).toBe('81416c');
    expect(toHex(encodeAdvertAppData({ nodeType: 3 }))).toBe('03');
  });

  it('name is cut at a UTF-8 boundary to fit 32 bytes', () => {
    const app = encodeAdvertAppData({ nodeType: 1, name: 'a'.repeat(30) + 'é' }); // 1 + 30 + 2 > 32
    expect(app.length).toBe(31);
    expect(parseAdvertAppData(app).name).toBe('a'.repeat(30));
    expect(utf8Truncate(utf8Encode('aé'), 2).length).toBe(1);
  });

  it('declared-but-missing fields → valid=false (AdvertDataParser)', () => {
    expect(parseAdvertAppData(x('91 0102')).valid).toBe(false);
  });

  it('build signs pubkey ‖ ts ‖ app_data; parse + verify; tamper fails', async () => {
    const kp = await ed25519KeyPairFromSeed(SEED_A);
    const payload = await buildAdvertPayload({ keys: kp, timestamp: 0x65000000, appData: { nodeType: 1, name: 'Alice' } });
    expect(payload.length).toBe(100 + 6);
    expect(toHex(payload.subarray(0, 32))).toBe(toHex(kp.publicKey));
    expect(toHex(payload.subarray(32, 36))).toBe('00000065');
    expect(toHex(payload.subarray(100))).toBe(h('81 416c696365'));
    const a = parsePayload(PayloadType.ADVERT, payload) as AdvertPayload;
    expect(a.kind).toBe('advert');
    expect(a.timestamp).toBe(0x65000000);
    expect(a.app.name).toBe('Alice');
    expect(await verifyAdvert(a)).toBe(true);
    expect(await verifyAdvert({ ...a, timestamp: a.timestamp + 1 })).toBe(false);
    // app_data beyond 32 bytes is ignored by verification (truncated on verify)
    expect(await verifyAdvert({ ...a, appData: concatBytes(a.appData, new Uint8Array(40)) })).toBe(false);
    expect(() => parsePayload(PayloadType.ADVERT, payload.subarray(0, 99))).toThrow(PayloadError);
  });
});

describe('ACK / MULTIPART / TRACE / CONTROL / RAW (§3.4, §3.10-3.13)', () => {
  it('ACK 4- and 6-byte forms', () => {
    expect(toHex(buildAckPayload(x('08d88350')))).toBe('08d88350');
    const p = parsePayload(PayloadType.ACK, x('08d88350 00 7f'));
    expect(p).toMatchObject({ kind: 'ack', ackCodeU32: 0x5083d808 });
    if (p.kind !== 'ack') throw new Error();
    expect(toHex(p.extra)).toBe('007f');
    expect(() => parsePayload(PayloadType.ACK, x('010203'))).toThrow(PayloadError);
  });

  it('MULTIPART ack: [(remaining<<4)|3][ack] (Mesh::createMultiAck)', () => {
    const b = buildMultipartAckPayload(x('08d88350'), 2);
    expect(toHex(b)).toBe('2308d88350');
    const p = parsePayload(PayloadType.MULTIPART, b);
    expect(p).toMatchObject({ kind: 'multipart', remaining: 2, innerType: 3 });
    if (p.kind !== 'multipart') throw new Error();
    expect(toHex(p.ackCode!)).toBe('08d88350');
  });

  it('TRACE: tag u32, auth u32, flags (path_sz), hashes', () => {
    const b = buildTracePayload({ tag: 1, authCode: 2, flags: 1, hashes: x('a1a2b1b2') });
    expect(toHex(b)).toBe(h('01000000 02000000 01 a1a2b1b2'));
    expect(parsePayload(PayloadType.TRACE, b)).toMatchObject({ kind: 'trace', tag: 1, authCode: 2, pathSz: 1, hashSize: 2 });
  });

  it('CONTROL discover req/resp (§3.12)', () => {
    const req = buildDiscoverReqPayload({ prefixOnly: true, typeFilter: 1 << 2, tag: 0xaabbccdd, since: 5 });
    expect(toHex(req)).toBe(h('81 04 ddccbbaa 05000000'));
    expect(parsePayload(PayloadType.CONTROL, req)).toMatchObject({
      subType: ControlType.NODE_DISCOVER_REQ,
      prefixOnly: true,
      typeFilter: 4,
      tag: 0xaabbccdd,
      since: 5,
    });
    const resp = buildDiscoverRespPayload({ nodeType: 2, snr: -2.5, tag: 7, publicKey: x('0102030405060708') });
    expect(toHex(resp)).toBe(h('92 f6 07000000 0102030405060708'));
    expect(parsePayload(PayloadType.CONTROL, resp)).toMatchObject({ subType: 0x90, nodeType: 2, snr: -2.5, tag: 7 });
    expect(parsePayload(PayloadType.CONTROL, x('a0 01'))).toMatchObject({ subType: 0xa0, flags: 0xa0 });
  });

  it('RAW_CUSTOM and reserved types are opaque', () => {
    expect(parsePayload(PayloadType.RAW_CUSTOM, x('0102'))).toMatchObject({ kind: 'rawCustom' });
    expect(parsePayload(13, x('0102'))).toMatchObject({ kind: 'unknown', payloadType: 13 });
  });
});

describe('GRP_TXT / GRP_DATA (§3.6, §3.7)', () => {
  it('byte-exact public channel message (openssl AES-ECB + python HMAC vector)', async () => {
    const pt = buildGrpTxtPlaintext({ timestamp: 1700000000, senderName: 'alice', text: 'hello world' });
    expect(toHex(pt)).toBe(h('00f15365 00') + toHex(utf8Encode('alice: hello world')));
    const payload = await buildGroupDatagramPayload({ channelHash: await channelHash(PSK), secret: PSK, plaintext: pt });
    expect(toHex(payload)).toBe(h('11 21d3 48f4884524f1fdd7ead13790fca6e1ec5137e5c307f366ad713e36f60ca29221'));
    const p = parsePayload(PayloadType.GRP_TXT, payload);
    if (p.kind !== 'grpTxt') throw new Error();
    expect(p.channelHash).toBe(0x11);
    const dec = await decryptPayload(p, PSK);
    const m = parseGrpTxtPlaintext(dec!);
    expect(m).toMatchObject({ timestamp: 1700000000, txtType: 0, senderName: 'alice', message: 'hello world', text: 'alice: hello world' });
    expect(await decryptPayload(p, await hashtagChannelPsk('#other'))).toBeNull();
  });

  it('GRP_TXT text cut so prefix + text ≤ 160 bytes', () => {
    const pt = buildGrpTxtPlaintext({ timestamp: 0, senderName: 'bob', text: 'x'.repeat(200) });
    expect(pt.length).toBe(5 + 160);
  });

  it('GRP_DATA plaintext: [type u16][len u8][data] + round trip', async () => {
    const pt = buildGrpDataPlaintext(0xff01, x('010203'));
    expect(toHex(pt)).toBe(h('01ff 03 010203'));
    const payload = await buildGroupDatagramPayload({ channelHash: 0x11, secret: PSK, plaintext: pt });
    const p = parsePayload(PayloadType.GRP_DATA, payload);
    if (p.kind !== 'grpData') throw new Error();
    const d = parseGrpDataPlaintext((await decryptPayload(p, PSK))!);
    expect(d.dataType).toBe(0xff01);
    expect(toHex(d.data)).toBe('010203');
    expect(() => parseGrpDataPlaintext(x('0100 09 00'))).toThrow(PayloadError);
  });
});

describe('peer datagrams: TXT_MSG / REQ / RESPONSE / PATH (§3.0-3.3, §3.9)', async () => {
  const a = await ed25519KeyPairFromSeed(SEED_A);
  const b = await ed25519KeyPairFromSeed(SEED_B);
  const secretAB = await calcSharedSecret(a.privateKey, b.publicKey);

  it('TXT_MSG plaintext layout incl. attempt > 3 tail (composeMsgPacket)', () => {
    expect(toHex(buildTxtMsgPlaintext({ timestamp: 0x01020304, text: 'hi', attempt: 1 }))).toBe(h('04030201 01 6869'));
    expect(toHex(buildTxtMsgPlaintext({ timestamp: 0x01020304, text: 'hi', attempt: 5 }))).toBe(h('04030201 01 6869 00 05'));
    expect(toHex(buildTxtMsgPlaintext({ timestamp: 1, text: 'hi', txtType: TxtType.SIGNED_PLAIN, authorPrefix: x('a1a2a3a4') }))).toBe(
      h('01000000 08 a1a2a3a4 6869'),
    );
    const m = parseTxtMsgPlaintext(x('04030201 01 6869 00 05 000000000000000000'));
    expect(m).toMatchObject({ timestamp: 0x01020304, txtType: 0, attempt: 5, text: 'hi', textOffset: 5 });
    const s = parseTxtMsgPlaintext(x('01000000 0a a1a2a3a4 6869 00000000000000'));
    expect(s.txtType).toBe(TxtType.SIGNED_PLAIN);
    expect(toHex(s.authorPrefix!)).toBe('a1a2a3a4');
    expect(s.attempt).toBe(2);
    expect(() => buildTxtMsgPlaintext({ timestamp: 0, text: 'x'.repeat(161) })).toThrow(PayloadError);
    expect(() => buildTxtMsgPlaintext({ timestamp: 0, text: 'x'.repeat(159), attempt: 4 })).toThrow(PayloadError);
  });

  it('encrypt → parse → MAC verify → decrypt a DM; ack matches the sender-side code', async () => {
    const pt = buildTxtMsgPlaintext({ timestamp: 1700000000, text: 'hello bob' });
    const payload = await buildPeerDatagramPayload({ destHash: b.publicKey[0]!, srcHash: a.publicKey[0]!, secret: secretAB, plaintext: pt });
    expect(payload.length).toBe(2 + 2 + 16);
    expect(payload[0]).toBe(b.publicKey[0]);
    expect(payload[1]).toBe(a.publicKey[0]);
    expect(toHex(payload.subarray(2))).toBe(toHex(await encryptThenMac(secretAB, pt)));
    const p = parsePayload(PayloadType.TXT_MSG, payload);
    if (p.kind !== 'txtMsg') throw new Error();
    const secretBA = await calcSharedSecret(b.privateKey, a.publicKey);
    const dec = await decryptPayload(p, secretBA);
    expect(dec).not.toBeNull();
    const m = parseTxtMsgPlaintext(dec!);
    expect(m.text).toBe('hello bob');
    expect(toHex((await ackCodeForTxtPlaintext(dec!, { senderPublicKey: a.publicKey }))!)).toBe(
      toHex(await textAckCode({ timestamp: 1700000000, text: 'hello bob', senderPublicKey: a.publicKey })),
    );
    const wrong = await calcSharedSecret(b.privateKey, b.publicKey);
    expect(await decryptPayload(p, wrong)).toBeNull();
  });

  it('REQ / RESPONSE plaintexts', () => {
    const req = buildReqPlaintext(0x11223344, 0x01, x('0000000001020304'));
    expect(toHex(req)).toBe(h('44332211 01 0000000001020304'));
    expect(parseReqPlaintext(req)).toMatchObject({ timestamp: 0x11223344, reqType: 1 });
    const resp = buildResponsePlaintext(0x11223344, x('aabb'));
    expect(parseResponsePlaintext(resp)).toMatchObject({ tag: 0x11223344 });
  });

  it('login OK response (13 bytes) and legacy "OK"', () => {
    const pt = buildLoginOkPlaintext({ serverTime: 5, isAdmin: 1, permissions: 3, random: x('01020304'), firmwareVerLevel: 2 });
    expect(toHex(pt)).toBe(h('05000000 00 00 01 03 01020304 02'));
    expect(parseLoginResponse(concatBytes(pt, new Uint8Array(3)))).toMatchObject({
      serverTime: 5,
      ok: true,
      legacy: false,
      isAdmin: 1,
      permissions: 3,
      role: 3,
      firmwareVerLevel: 2,
    });
    expect(parseLoginResponse(x('05000000 4f4b 00'))).toEqual({ serverTime: 5, ok: true, legacy: true });
    expect(parseLoginResponse(x('05000000 01 00')).ok).toBe(false);
  });

  it('STATUS body: repeater stats from a padded 60-byte body (§3.2)', () => {
    const body = new Uint8Array(60);
    const v = new DataView(body.buffer);
    v.setUint16(0, 4100, true);
    v.setInt16(4, -110, true);
    v.setUint32(20, 3600, true);
    v.setInt16(42, 26, true);
    v.setUint32(52, 9, true);
    const s = parseStatusBody(body);
    expect(s).toMatchObject({ kind: 'repeater', batteryMv: 4100, noiseFloorDbm: -110, upTimeSecs: 3600, lastSnr: 6.5, recvErrors: 9 });
    expect(parseStatusBody(body, 'room')).toMatchObject({ kind: 'room' });
  });

  it('access list / neighbours / owner info bodies', () => {
    const acl = parseAccessList(x('010203040506 03  0a0b0c0d0e0f 01  000000000000 00'));
    expect(acl.map((e) => [toHex(e.pubKeyPrefix), e.permissions])).toEqual([
      ['010203040506', 3],
      ['0a0b0c0d0e0f', 1],
    ]);
    const n = parseNeighbours(x('0500 0200  aabbccdd 3c000000 28  11223344 0a000000 f6  0000'), 4);
    expect(n.total).toBe(5);
    expect(n.results.map((r) => [toHex(r.pubKeyPrefix), r.heardSecsAgo, r.snr])).toEqual([
      ['aabbccdd', 60, 10],
      ['11223344', 10, -2.5],
    ]);
    expect(parseOwnerInfo(concatBytes(utf8Encode('v1.18.0\nRpt\nme\nyou'), new Uint8Array(3)))).toEqual({
      firmwareVersion: 'v1.18.0',
      nodeName: 'Rpt',
      ownerInfo: 'me\nyou',
    });
  });

  it('PATH plaintext: [path_len][path][extra_type][extra] and the no-extra 0xFF form', async () => {
    const withAck = buildPathPlaintext({ path: x('a1a2b1b2'), hashSize: 2, extraType: PayloadType.ACK, extra: x('08d88350 00 11') });
    expect(toHex(withAck)).toBe(h('42 a1a2b1b2 03 08d88350 0011'));
    const pp = parsePathPlaintext(concatBytes(withAck, new Uint8Array(4)));
    expect(pp).toMatchObject({ pathLen: 0x42, hashSize: 2, hashCount: 2, extraType: 3, hasExtra: true });
    expect(toHex(pp.path)).toBe('a1a2b1b2');
    const none = buildPathPlaintext({ path: new Uint8Array(0), random: x('01020304') });
    expect(toHex(none)).toBe(h('00 ff 01020304'));
    expect(parsePathPlaintext(none)).toMatchObject({ extraTypeRaw: 0xff, extraType: 0x0f, hasExtra: false });
    expect(() => parsePathPlaintext(x('c1 00'))).toThrow(PayloadError);
    const payload = await buildPeerDatagramPayload({ destHash: 1, srcHash: 2, secret: secretAB, plaintext: withAck });
    const p = parsePayload(PayloadType.PATH, payload);
    expect(p.kind).toBe('path');
  });

  it('minimum lengths match Mesh.cpp (≥ 2 + MAC + 1)', () => {
    expect(() => parsePayload(PayloadType.TXT_MSG, x('01020304'))).toThrow(PayloadError);
    expect(parsePayload(PayloadType.REQ, x('0102030405')).kind).toBe('req');
  });
});

describe('ANON_REQ (§3.8)', async () => {
  const a = await ed25519KeyPairFromSeed(SEED_A);
  const b = await ed25519KeyPairFromSeed(SEED_B);

  it('[dest][sender pubkey][MAC][ct]; login plaintexts', async () => {
    const secret = await calcSharedSecret(a.privateKey, b.publicKey);
    const login = buildLoginRequest({ timestamp: 9, password: 'secret' });
    expect(toHex(login)).toBe(h('09000000') + toHex(utf8Encode('secret')));
    const room = buildLoginRequest({ timestamp: 9, syncSince: 3, password: 'pw' });
    expect(toHex(room)).toBe(h('09000000 03000000 7077'));
    expect(parseLoginRequest(concatBytes(room, new Uint8Array(6)), true)).toEqual({ timestamp: 9, syncSince: 3, password: 'pw' });
    const payload = await buildAnonReqPayload({ destHash: b.publicKey[0]!, senderPublicKey: a.publicKey, secret, plaintext: login });
    expect(payload.length).toBe(1 + 32 + 2 + 16);
    const p = parsePayload(PayloadType.ANON_REQ, payload);
    if (p.kind !== 'anonReq') throw new Error();
    expect(toHex(p.senderPublicKey)).toBe(toHex(a.publicKey));
    // receiver derives the secret from the cleartext sender key
    const dec = await decryptPayload(p, await calcSharedSecret(b.privateKey, p.senderPublicKey));
    expect(parseLoginRequest(dec!)).toEqual({ timestamp: 9, password: 'secret' });
    expect(() => parsePayload(PayloadType.ANON_REQ, payload.subarray(0, 35))).toThrow(PayloadError);
  });

  it('rejects plaintexts that cannot fit in a payload', async () => {
    await expect(
      buildPeerDatagramPayload({ destHash: 0, srcHash: 0, secret: new Uint8Array(32), plaintext: new Uint8Array(170) }),
    ).rejects.toThrow(PayloadError);
    // 168 + 2 + 15 = 185 > 184 (createDatagram) although 2+2+176 = 180 would fit
    await expect(
      buildPeerDatagramPayload({ destHash: 0, srcHash: 0, secret: new Uint8Array(32), plaintext: new Uint8Array(168) }),
    ).rejects.toThrow(PayloadError);
    expect((await buildPeerDatagramPayload({ destHash: 0, srcHash: 0, secret: new Uint8Array(32), plaintext: new Uint8Array(167) })).length).toBe(180);
  });
});
