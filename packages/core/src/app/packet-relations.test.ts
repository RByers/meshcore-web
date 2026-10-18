import { describe, expect, it } from 'vitest';
import { PayloadType, RouteType } from '../packet/constants.js';
import { buildPacket } from '../packet/packet.js';
import {
  buildAckPayload,
  buildDiscoverReqPayload,
  buildDiscoverRespPayload,
  buildMultipartAckPayload,
  buildPeerDatagramPayload,
  buildTracePayload,
} from '../packet/payloads.js';
import { sha256 } from '../packet/crypto.js';
import { TxtType } from '../protocol/constants.js';
import type { Command } from '../protocol/types.js';
import { packetInputFromCommand, packetRecordFromInput, type PacketInput } from '../store/packet-log.js';
import type { PacketRecord } from '../store/schema.js';
import { concatBytes, fromHex, readU32LE, u32le, utf8Encode } from '../util/bytes.js';
import { PacketRelationIndex, decryptedRelationKeysOf, needsDecryption, relationBetween, relationKeysOf } from './packet-relations.js';
import type { DmKeys } from './packet-summary.js';

let nextId = 1;
async function rec(input: PacketInput): Promise<PacketRecord> {
  return { id: nextId++, ...(await packetRecordFromInput(input, 1000)) };
}

/** Our DM as logged from SEND_TXT_MSG, with RESP_SENT's tag (the expected ACK code, u32 LE). */
async function sentDm(tag: number | undefined, text = 'hi'): Promise<PacketRecord> {
  const input = packetInputFromCommand({ kind: 'sendTxtMsg', recipient: new Uint8Array(32).fill(0xa1), text, timestamp: 1 })!;
  const r = await rec(input);
  r.send = tag === undefined ? { status: 'pending' } : { status: 'sent', tag, flood: false };
  return r;
}

/** A received ACK packet (LOG_RX_DATA): payload = the 4 code bytes (§3.4), heard via `path`. */
function rxAck(code: Uint8Array, path: number[] = [], extra?: Uint8Array): Promise<PacketRecord> {
  const bytes = buildPacket({ routeType: RouteType.DIRECT, payloadType: PayloadType.ACK, path: Uint8Array.from(path), payload: buildAckPayload(code, extra) });
  return rec({ direction: 'rx', bytes, source: 'logRxData', snr: 5 });
}

/** A received TRACE packet: path = the SNRs appended so far (§3.10). */
function rxTrace(tag: number, hashes: number[], snrs: number[]): Promise<PacketRecord> {
  const payload = buildTracePayload({ tag, authCode: 7, hashes: Uint8Array.from(hashes) });
  const bytes = buildPacket({ routeType: RouteType.DIRECT, payloadType: PayloadType.TRACE, path: Uint8Array.from(snrs), payload });
  return rec({ direction: 'rx', bytes, source: 'logRxData' });
}

function index(...records: PacketRecord[]): PacketRelationIndex {
  const ix = new PacketRelationIndex();
  for (const r of records) ix.add(r);
  return ix;
}

// ACK code bytes 11 22 33 44 read as u32 LE (RESP_SENT[2..5], companion-protocol.md §5.1)
const CODE = fromHex('11223344');
const CODE_U32 = 0x44332211;

describe('relationKeysOf', () => {
  it('derives keys from DMs, ACKs, MULTIPART ACKs, TRACEs and DISCOVER control packets', async () => {
    expect(relationKeysOf(await sentDm(CODE_U32))).toEqual([{ rule: 'ack', key: CODE_U32, role: 'request' }]);
    expect(relationKeysOf(await rxAck(CODE))).toEqual([{ rule: 'ack', key: CODE_U32, role: 'reply' }]);
    // 6-byte ACK form: only the first 4 bytes are the code
    expect(relationKeysOf(await rxAck(CODE, [], fromHex('00ab')))).toEqual([{ rule: 'ack', key: CODE_U32, role: 'reply' }]);
    const multi = await rec({
      direction: 'rx',
      bytes: buildPacket({ routeType: RouteType.DIRECT, payloadType: PayloadType.MULTIPART, payload: buildMultipartAckPayload(CODE, 1) }),
    });
    expect(relationKeysOf(multi)).toEqual([{ rule: 'ack', key: CODE_U32, role: 'reply' }]);
    const tx = await rec(packetInputFromCommand({ kind: 'sendTracePath', tag: 0xdeadbeef, authCode: 1, path: Uint8Array.of(0xa1, 0xb2, 0xa1) })!);
    expect(relationKeysOf(tx)).toEqual([{ rule: 'trace', key: 0xdeadbeef, role: 'request' }]);
    expect(relationKeysOf(await rxTrace(0xdeadbeef, [0xa1, 0xb2, 0xa1], [20]))).toEqual([{ rule: 'trace', key: 0xdeadbeef, role: 'hop' }]);
    expect(relationKeysOf(await rxTrace(0xdeadbeef, [0xa1, 0xb2, 0xa1], [20, 8, 12]))).toEqual([{ rule: 'trace', key: 0xdeadbeef, role: 'reply' }]);
    const req = await rec(packetInputFromCommand({ kind: 'sendControlData', payload: buildDiscoverReqPayload({ typeFilter: 4, tag: 99 }) })!);
    expect(relationKeysOf(req)).toEqual([{ rule: 'discover', key: 99, role: 'request' }]);
    const resp = await rec({
      direction: 'rx',
      bytes: buildDiscoverRespPayload({ nodeType: 2, snr: 4, tag: 99, publicKey: new Uint8Array(8).fill(3) }),
      format: 'payload',
      payloadType: PayloadType.CONTROL,
      pathLen: 0,
    });
    expect(relationKeysOf(resp)).toEqual([{ rule: 'discover', key: 99, role: 'reply' }]);
  });

  it('has no keys for unsent / CLI DMs, received DMs, other control types and unparsable bytes', async () => {
    expect(relationKeysOf(await sentDm(undefined))).toEqual([]); // no RESP_SENT yet
    expect(relationKeysOf(await sentDm(0))).toEqual([]); // CLI text: not ACKed
    const other = await rec({ direction: 'rx', bytes: Uint8Array.of(0x20, 1, 2), format: 'payload', payloadType: PayloadType.CONTROL, pathLen: 0 });
    expect(relationKeysOf(other)).toEqual([]);
    const shortAck = await rec({ direction: 'rx', bytes: Uint8Array.of(1, 2), format: 'payload', payloadType: PayloadType.ACK, pathLen: 0 });
    expect(relationKeysOf(shortAck)).toEqual([]);
    expect(relationKeysOf(await rec({ direction: 'rx', bytes: Uint8Array.of(0xff) }))).toEqual([]);
  });

  it('relationBetween pairs requests with replies, and TRACE hops with anything of the same trace', () => {
    expect(relationBetween('ack', 'request', 'reply')).toBe('ack');
    expect(relationBetween('ack', 'reply', 'request')).toBe('acked');
    expect(relationBetween('discover', 'request', 'reply')).toBe('reply');
    expect(relationBetween('discover', 'reply', 'request')).toBe('request');
    expect(relationBetween('discover', 'reply', 'reply')).toBeNull();
    expect(relationBetween('ack', 'request', 'request')).toBeNull();
    expect(relationBetween('trace', 'hop', 'request')).toBe('hop');
    expect(relationBetween('trace', 'reply', 'hop')).toBe('hop');
  });
});

describe('PacketRelationIndex', () => {
  it('links our DM to every ACK copy heard, and each copy back to the DM', async () => {
    const dm = await sentDm(CODE_U32);
    const direct = await rxAck(CODE);
    const viaRepeater = await rxAck(CODE, [0x5c]); // same packet hash (path excluded): a copy
    const otherAck = await rxAck(fromHex('11223345'));
    const ix = index(dm, direct, viaRepeater, otherAck);
    expect(direct.hash).toBe(viaRepeater.hash);
    expect(ix.related(dm.id)).toEqual([
      { id: direct.id, relation: 'ack', rule: 'ack' },
      { id: viaRepeater.id, relation: 'ack', rule: 'ack' },
    ]);
    expect(ix.related(direct.id)).toEqual([{ id: dm.id, relation: 'acked', rule: 'ack' }]); // not its own copy
    expect(ix.related(viaRepeater.id)).toEqual([{ id: dm.id, relation: 'acked', rule: 'ack' }]);
    expect(ix.related(otherAck.id)).toEqual([]);
  });

  it('pairs each retry with its own ACK code, and a MULTIPART ACK too', async () => {
    const first = await sentDm(0x01020304);
    const retry = await sentDm(0x0a0b0c0d);
    const ackRetry = await rxAck(Uint8Array.of(0x0d, 0x0c, 0x0b, 0x0a));
    const multi = await rec({
      direction: 'rx',
      bytes: buildPacket({ routeType: RouteType.DIRECT, payloadType: PayloadType.MULTIPART, payload: buildMultipartAckPayload(Uint8Array.of(0x0d, 0x0c, 0x0b, 0x0a), 0) }),
    });
    const ix = index(first, retry, ackRetry, multi);
    expect(ix.related(first.id)).toEqual([]); // unacknowledged
    expect(ix.related(retry.id).map((r) => [r.id, r.relation])).toEqual([
      [ackRetry.id, 'ack'],
      [multi.id, 'ack'],
    ]);
    expect(ix.related(multi.id)).toEqual([{ id: retry.id, relation: 'acked', rule: 'ack' }]);
    expect(ix.related(ackRetry.id)).toEqual([{ id: retry.id, relation: 'acked', rule: 'ack' }]); // the two ACKs are not linked
  });

  it('pairs our TRACE with the trace back and the hops it was overheard at; other tags stay apart', async () => {
    const hashes = Uint8Array.of(0xa1, 0xb2, 0xa1);
    const tx = await rec(packetInputFromCommand({ kind: 'sendTracePath', tag: 0x1234, authCode: 1, path: hashes })!);
    const hop1 = await rxTrace(0x1234, [...hashes], [20]);
    const back = await rxTrace(0x1234, [...hashes], [20, 8, 12]);
    // TRACE_DATA push for the same completed trace (payload record, path_len = SNR count): a copy of `back`
    const pushed = await rec({
      direction: 'rx',
      bytes: buildTracePayload({ tag: 0x1234, authCode: 7, hashes }),
      format: 'payload',
      source: 'traceData',
      payloadType: PayloadType.TRACE,
      routeType: RouteType.DIRECT,
      pathLen: 3,
    });
    const otherTag = await rxTrace(0x1235, [...hashes], [20, 8, 12]);
    const ix = index(tx, hop1, back, pushed, otherTag);
    expect(pushed.hash).toBe(back.hash);
    expect(ix.related(tx.id)).toEqual([
      { id: hop1.id, relation: 'hop', rule: 'trace' },
      { id: back.id, relation: 'reply', rule: 'trace' },
      { id: pushed.id, relation: 'reply', rule: 'trace' },
    ]);
    expect(ix.related(back.id)).toEqual([
      { id: tx.id, relation: 'request', rule: 'trace' },
      { id: hop1.id, relation: 'hop', rule: 'trace' },
    ]);
    expect(ix.related(hop1.id).map((r) => r.relation)).toEqual(['hop', 'hop', 'hop']);
    expect(ix.related(otherTag.id)).toEqual([]);
  });

  it("pairs DISCOVER_REQ with every node's DISCOVER_RESP by tag, ours or overheard", async () => {
    const req = await rec(packetInputFromCommand({ kind: 'sendControlData', payload: buildDiscoverReqPayload({ typeFilter: 4, tag: 42 }) })!);
    const resp = (key: number, tag = 42) =>
      rec({
        direction: 'rx',
        bytes: buildDiscoverRespPayload({ nodeType: 2, snr: 4, tag, publicKey: new Uint8Array(8).fill(key) }),
        format: 'payload',
        payloadType: PayloadType.CONTROL,
        pathLen: 0,
      });
    const a = await resp(1);
    const b = await resp(2);
    const stranger = await resp(3, 43);
    const ix = index(req, a, b, stranger);
    expect(ix.related(req.id)).toEqual([
      { id: a.id, relation: 'reply', rule: 'discover' },
      { id: b.id, relation: 'reply', rule: 'discover' },
    ]);
    expect(ix.related(a.id)).toEqual([{ id: req.id, relation: 'request', rule: 'discover' }]);
    expect(ix.related(stranger.id)).toEqual([]);
  });

  it('keeps response keys of different contacts apart (scope)', () => {
    const ix = new PacketRelationIndex();
    ix.set(1, '', [{ rule: 'response', key: 7, role: 'request', scope: 'aaaaaaaa' }]);
    ix.set(2, 'h2', [{ rule: 'response', key: 7, role: 'reply', scope: 'bbbbbbbb' }]);
    ix.set(3, 'h3', [{ rule: 'response', key: 7, role: 'reply', scope: 'aaaaaaaa' }]);
    expect(ix.related(1)).toEqual([{ id: 3, relation: 'reply', rule: 'response' }]);
    expect(ix.related(2)).toEqual([]);
  });

  it('set / delete / clear keep both directions consistent', async () => {
    const dm = await sentDm(undefined);
    const ack = await rxAck(CODE);
    const ix = index(dm, ack);
    expect(ix.size).toBe(1); // the pending DM has no key yet
    expect(ix.related(ack.id)).toEqual([]);
    expect(ix.add({ ...dm, send: { status: 'sent', tag: CODE_U32 } })).toBe(true); // RESP_SENT arrived
    expect(ix.add({ ...dm, send: { status: 'confirmed', tag: CODE_U32 } })).toBe(false); // same keys
    expect(ix.related(ack.id)).toEqual([{ id: dm.id, relation: 'acked', rule: 'ack' }]);
    expect(ix.delete(dm.id)).toBe(true);
    expect(ix.related(ack.id)).toEqual([]);
    ix.clear();
    expect(ix.size).toBe(0);
    expect(ix.related(ack.id)).toEqual([]);
  });
});

// ---- rules that need the radio's private key ----

const SELF = new Uint8Array(32).fill(0x11);
const PEER = new Uint8Array(32).fill(0x22);
const OTHER = new Uint8Array(32).fill(0x33);
const SECRET = new Uint8Array(32).fill(0x5a);
const OTHER_SECRET = new Uint8Array(32).fill(0x6b);
const PEER_SCOPE = '22222222';
/** DM keys as PacketLogModel.dmKeys provides them (fixed shared secrets stand in for ECDH). */
const DM: DmKeys = {
  selfPublicKey: SELF,
  contacts: [OTHER, PEER],
  sharedSecret: (c) => Promise.resolve(c[0] === 0x22 ? SECRET : c[0] === 0x33 ? OTHER_SECRET : null),
};

/** A heard REQ / RESPONSE / TXT_MSG / PATH, `[dest][src][MAC][ciphertext]` (§3.0). */
async function rxPeer(
  payloadType: number,
  plaintext: Uint8Array,
  o: { from?: Uint8Array; to?: Uint8Array; secret?: Uint8Array; path?: number[] } = {},
): Promise<PacketRecord> {
  const payload = await buildPeerDatagramPayload({ destHash: (o.to ?? SELF)[0]!, srcHash: (o.from ?? PEER)[0]!, secret: o.secret ?? SECRET, plaintext });
  const bytes = buildPacket({ routeType: RouteType.DIRECT, payloadType, path: Uint8Array.from(o.path ?? []), payload });
  return rec({ direction: 'rx', bytes, source: 'logRxData' });
}

/** Our request as logged from its command, with RESP_SENT's tag. */
async function sentReq(cmd: Command, tag: number): Promise<PacketRecord> {
  const r = await rec(packetInputFromCommand(cmd)!);
  r.send = { ...r.send!, status: 'sent', tag };
  return r;
}

async function indexWithKeys(...records: PacketRecord[]): Promise<PacketRelationIndex> {
  const ix = new PacketRelationIndex();
  for (const r of records) ix.set(r.id, r.hash, [...relationKeysOf(r), ...(await decryptedRelationKeysOf(r, DM))]);
  return ix;
}

describe('decryptedRelationKeysOf', () => {
  it('keys our REQ by RESP_SENT tag and the RESPONSE from that contact by its echoed tag (§3.1/§3.2)', async () => {
    const req = await sentReq({ kind: 'sendStatusReq', pubKey: PEER }, 0x65000001);
    expect(relationKeysOf(req)).toEqual([{ rule: 'response', key: 0x65000001, role: 'request', scope: PEER_SCOPE }]);
    // [tag u32 LE][body]
    const resp = await rxPeer(PayloadType.RESPONSE, concatBytes(fromHex('01000065'), new Uint8Array(56).fill(9)));
    expect(relationKeysOf(resp)).toEqual([]); // nothing without keys
    expect(await decryptedRelationKeysOf(resp, DM)).toEqual([{ rule: 'response', key: 0x65000001, role: 'reply', scope: PEER_SCOPE }]);
    // the same tag from another contact is another exchange
    const other = await rxPeer(PayloadType.RESPONSE, fromHex('01000065aa'), { from: OTHER, secret: OTHER_SECRET });
    expect(await decryptedRelationKeysOf(other, DM)).toEqual([{ rule: 'response', key: 0x65000001, role: 'reply', scope: '33333333' }]);
    // a RESPONSE we sent (echoed back by a repeater) answers the contact's request, not ours
    expect(await decryptedRelationKeysOf(await rxPeer(PayloadType.RESPONSE, fromHex('01000065aa'), { from: SELF, to: PEER }), DM)).toEqual([]);
    // no known secret verifies the MAC / not addressed to us
    expect(await decryptedRelationKeysOf(await rxPeer(PayloadType.RESPONSE, fromHex('01000065aa'), { secret: OTHER_SECRET }), DM)).toEqual([]);
    expect(await decryptedRelationKeysOf(await rxPeer(PayloadType.RESPONSE, fromHex('01000065aa'), { to: OTHER }), DM)).toEqual([]);

    const ix = await indexWithKeys(req, resp, other);
    expect(ix.related(req.id)).toEqual([{ id: resp.id, relation: 'reply', rule: 'response' }]);
    expect(ix.related(resp.id)).toEqual([{ id: req.id, relation: 'request', rule: 'response' }]);
    expect(ix.related(other.id)).toEqual([]);
  });

  it('keys a non-login ANON_REQ by its tag, but not a login (RESP_SENT tag = key prefix, reply = server clock)', async () => {
    const anon = await sentReq({ kind: 'sendAnonReq', pubKey: PEER, data: Uint8Array.of(3) }, 0x65000002);
    expect(relationKeysOf(anon)).toEqual([{ rule: 'response', key: 0x65000002, role: 'request', scope: PEER_SCOPE }]);
    const login = await sentReq({ kind: 'sendLogin', pubKey: PEER, password: 'pw' }, 0x22222222);
    expect(relationKeysOf(login)).toEqual([]);
    // a request without (a prefix of) the peer's key cannot be scoped
    const r = await sentReq({ kind: 'sendStatusReq', pubKey: PEER }, 5);
    expect(relationKeysOf({ ...r, send: { status: 'sent', tag: 5, peer: '22' } })).toEqual([]);
  });

  it('keys a PATH carrying a RESPONSE by its tag and one carrying an ACK by the code (§3.9)', async () => {
    // [path_len][path][extra_type][extra]
    const withResp = await rxPeer(PayloadType.PATH, concatBytes(fromHex('01a5'), Uint8Array.of(PayloadType.RESPONSE), fromHex('01000065'), Uint8Array.of(1, 2)));
    expect(await decryptedRelationKeysOf(withResp, DM)).toEqual([{ rule: 'response', key: 0x65000001, role: 'reply', scope: PEER_SCOPE }]);
    const withAck = await rxPeer(PayloadType.PATH, concatBytes(fromHex('00'), Uint8Array.of(PayloadType.ACK), CODE, fromHex('00ab')));
    expect(await decryptedRelationKeysOf(withAck, DM)).toEqual([{ rule: 'ack', key: CODE_U32, role: 'reply' }]);
    // the ACK path we send for a flood DM, heard back: an ACK code has no direction
    const ours = await rxPeer(PayloadType.PATH, concatBytes(fromHex('00'), Uint8Array.of(PayloadType.ACK), CODE), { from: SELF, to: PEER });
    expect(await decryptedRelationKeysOf(ours, DM)).toEqual([{ rule: 'ack', key: CODE_U32, role: 'reply' }]);
    const none = await rxPeer(PayloadType.PATH, concatBytes(fromHex('00ff'), fromHex('01020304')));
    expect(await decryptedRelationKeysOf(none, DM)).toEqual([]);

    const dm = await sentDm(CODE_U32);
    const ix = await indexWithKeys(dm, withAck);
    expect(ix.related(dm.id)).toEqual([{ id: withAck.id, relation: 'ack', rule: 'ack' }]);
  });

  it('keys a received DM by the ACK code the firmware answers it with (BCM onPeerDataRecv)', async () => {
    // plain: SHA256(timestamp ‖ flags ‖ text ‖ SENDER key)[0..4], §3.4
    const plain = concatBytes(fromHex('78563412'), Uint8Array.of((TxtType.PLAIN << 2) | 1), utf8Encode('hello'));
    const plainCode = readU32LE(await sha256(plain, PEER), 0);
    const rx = await rxPeer(PayloadType.TXT_MSG, plain);
    expect(await decryptedRelationKeysOf(rx, DM)).toEqual([{ rule: 'ack', key: plainCode, role: 'request' }]);
    // signed plain (room post): SHA256(timestamp ‖ flags ‖ author prefix ‖ text ‖ RECEIVER key)[0..4]
    const signed = concatBytes(fromHex('78563412'), Uint8Array.of(TxtType.SIGNED_PLAIN << 2), fromHex('a1b2c3d4'), utf8Encode('post'));
    const signedCode = readU32LE(await sha256(signed, SELF), 0);
    expect(await decryptedRelationKeysOf(await rxPeer(PayloadType.TXT_MSG, signed), DM)).toEqual([{ rule: 'ack', key: signedCode, role: 'request' }]);
    // CLI text is not ACKed; our own DM heard back pairs through its tx row instead
    const cli = concatBytes(fromHex('78563412'), Uint8Array.of(TxtType.CLI_DATA << 2), utf8Encode('ver'));
    expect(await decryptedRelationKeysOf(await rxPeer(PayloadType.TXT_MSG, cli), DM)).toEqual([]);
    expect(await decryptedRelationKeysOf(await rxPeer(PayloadType.TXT_MSG, plain, { from: SELF, to: PEER }), DM)).toEqual([]);

    // our ACK for it, forwarded back by a repeater, links to the DM
    const ack = await rxAck(u32le(plainCode), [0x5c]);
    const ix = await indexWithKeys(rx, ack);
    expect(ix.related(rx.id)).toEqual([{ id: ack.id, relation: 'ack', rule: 'ack' }]);
  });

  it('ignores records that cannot carry decrypted keys, and malformed plaintext', async () => {
    expect(needsDecryption(await sentDm(CODE_U32))).toBe(false);
    expect(needsDecryption(await rxAck(CODE))).toBe(false);
    expect(await decryptedRelationKeysOf(await rxAck(CODE), DM)).toEqual([]);
    // PATH plaintext with an invalid path_len
    expect(await decryptedRelationKeysOf(await rxPeer(PayloadType.PATH, fromHex('ff')), DM)).toEqual([]);
  });
});
