import { describe, expect, it } from 'vitest';
import { PayloadType } from '../packet/constants.js';
import type { PacketSend } from '../store/schema.js';
import { formatDurationMs, sendOutcomeLabel } from './packet-summary.js';

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
