import { describe, expect, it } from 'vitest';
import { PayloadType, RouteType } from '../packet/constants.js';
import { buildPacket } from '../packet/packet.js';
import type { PacketRecord, PacketSend } from '../store/schema.js';
import { concatBytes, toHex } from '../util/bytes.js';
import { formatDurationMs, packetEndpoints, sendOutcomeLabel, viewPacket } from './packet-summary.js';

const T = 1_700_000_000_000;
const dm = (send: PacketSend) => ({ direction: 'tx' as const, ts: T, payloadType: PayloadType.TXT_MSG, send });

describe('sendOutcomeLabel', () => {
  it('is null for rx rows and tx rows without a send outcome', () => {
    expect(sendOutcomeLabel({ direction: 'rx', ts: T, payloadType: PayloadType.TXT_MSG, send: { status: 'sent' } }, T)).toBeNull();
    expect(sendOutcomeLabel({ direction: 'tx', ts: T, payloadType: PayloadType.ADVERT }, T)).toBeNull();
  });

  it('labels pending, sent, confirmed and failed', () => {
    expect(sendOutcomeLabel(dm({ status: 'pending' }), T)).toMatchObject({ status: 'pending', text: '…' });
    expect(sendOutcomeLabel(dm({ status: 'sent', flood: true, tag: 7, estTimeoutMs: 5000 }), T + 10)).toMatchObject({
      status: 'sent',
      text: '✓',
      title: 'Sent: the radio transmitted it (flood); waiting for the ACK',
    });
    expect(sendOutcomeLabel(dm({ status: 'confirmed', tag: 7, rttMs: 1234 }), T)).toMatchObject({
      status: 'confirmed',
      text: '✓✓ 1.2 s',
      title: 'Delivered: ACK received, round trip 1.2 s',
    });
    expect(sendOutcomeLabel(dm({ status: 'confirmed', rttMs: 850 }), T)!.text).toBe('✓✓ 850 ms');
    expect(sendOutcomeLabel(dm({ status: 'confirmed' }), T)!.text).toBe('✓✓');
    expect(sendOutcomeLabel(dm({ status: 'failed', error: 'NOT_FOUND', errCode: 2 }), T)).toMatchObject({
      status: 'failed',
      text: '✗ NOT_FOUND',
      title: 'Failed: the radio rejected it (NOT_FOUND)',
    });
    expect(sendOutcomeLabel(dm({ status: 'failed' }), T)!.text).toBe('✗ ERR');
  });

  it('calls a DM still sent after ts + estTimeoutMs "no ACK"', () => {
    const send: PacketSend = { status: 'sent', flood: false, tag: 0x1234, estTimeoutMs: 3000 };
    expect(sendOutcomeLabel(dm(send), T + 3000)!.status).toBe('sent'); // not yet past
    expect(sendOutcomeLabel(dm(send), T + 3001)).toMatchObject({ status: 'no-ack', text: 'no ACK' });
    expect(sendOutcomeLabel(dm(send), T + 3001)!.title).toContain('3.0 s');
    // only DMs expecting an ACK: CLI text (tag 0), channel text and traces stay 'sent'
    expect(sendOutcomeLabel(dm({ ...send, tag: 0 }), T + 99_999)!.status).toBe('sent');
    expect(sendOutcomeLabel({ ...dm(send), payloadType: PayloadType.TRACE }, T + 99_999)!.status).toBe('sent');
    expect(sendOutcomeLabel({ ...dm({ status: 'sent' }), payloadType: PayloadType.GRP_TXT }, T + 99_999)!.status).toBe('sent');
  });
});

describe('formatDurationMs', () => {
  it('uses ms below a second and tenths of seconds above', () => {
    expect(formatDurationMs(0)).toBe('0 ms');
    expect(formatDurationMs(999.4)).toBe('999 ms');
    expect(formatDurationMs(1000)).toBe('1.0 s');
    expect(formatDurationMs(12_345)).toBe('12.3 s');
  });
});

describe('packetEndpoints', () => {
  const rec = (payloadType: number, payload: Uint8Array, path = Uint8Array.of(0xa1, 0xb2)): PacketRecord => ({
    id: 1,
    ts: T,
    direction: 'rx',
    bytes: buildPacket({ routeType: RouteType.FLOOD, payloadType, path, payload }),
    format: 'packet',
    source: 'logRxData',
    routeType: RouteType.FLOOD,
    payloadType,
    pathLen: path.length,
    hash: '',
  });
  const mac = new Uint8Array(18); // MAC(2) ‖ one cipher block (16)

  it('reads dest_hash (byte 0) and src_hash (byte 1) of REQ / RESPONSE / TXT_MSG / PATH (§3.0)', () => {
    for (const t of [PayloadType.REQ, PayloadType.RESPONSE, PayloadType.TXT_MSG, PayloadType.PATH]) {
      const v = viewPacket(rec(t, concatBytes(Uint8Array.of(0x0c, 0x5e), mac)));
      expect(v.endpoints).toEqual({ src: '5e', dst: '0c' });
      expect(v.path).toEqual(['a1', 'b2']); // the path stays the relay hops only…
      expect(v.hops).toBe(2); // …and so does the hop count
    }
  });

  it('reads ANON_REQ dest_hash (byte 0) and the full sender key (bytes 1..32, §3.8)', () => {
    const sender = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const v = viewPacket(rec(PayloadType.ANON_REQ, concatBytes(Uint8Array.of(0x77), sender, mac)));
    expect(v.endpoints).toEqual({ src: toHex(sender), dst: '77' });
  });

  it('names no endpoints for other payloads, or none parsed', () => {
    expect(viewPacket(rec(PayloadType.ACK, Uint8Array.of(1, 2, 3, 4))).endpoints).toEqual({ src: null, dst: null });
    expect(viewPacket(rec(PayloadType.REQ, Uint8Array.of(0x0c))).endpoints).toEqual({ src: null, dst: null }); // malformed
    expect(packetEndpoints(undefined)).toEqual({ src: null, dst: null });
  });
});
