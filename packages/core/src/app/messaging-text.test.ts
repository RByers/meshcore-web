/**
 * Outgoing text preparation (MeshCore Open `prepareContactOutboundText` / `prepareChannelOutboundText`,
 * feature-inventory.md §2.4a): which texts are structured payloads that are never SMAZ-compressed,
 * and what actually goes on the air.
 */

import { describe, expect, it } from 'vitest';
import { smazEncodeIfSmaller, smazTryDecode } from '../util/smaz.js';
import { isStructuredPayload, outboundText } from './messaging.js';

type Conv = 'contact' | 'channel';

/** Long, very compressible English: SMAZ always wins on this. */
const LONG = 'the weather is nice this morning';

describe('isStructuredPayload', () => {
  const rows: Array<[Conv, string, boolean]> = [
    ['contact', `g:${LONG}`, true], // GIF
    ['channel', `g:${LONG}`, true],
    ['contact', `m:${LONG}`, true], // map / location
    ['channel', `m:${LONG}`, true],
    ['contact', `V1|${LONG}`, true], // DM-only structured envelope
    ['channel', `V1|${LONG}`, false],
    ['contact', `   g:${LONG}`, true], // checked on the trimmed text
    ['contact', `r:👍:abcd`, false], // reactions are not structured (the chat model sends them raw)
    ['contact', `s:${LONG}`, false], // an "s:" envelope is not structured either
    ['contact', LONG, false],
    ['contact', 'G:upper case', false],
    ['contact', '', false],
  ];
  it.each(rows)('%s %j → %s', (conv, text, want) => {
    expect(isStructuredPayload(conv, text)).toBe(want);
  });
});

describe('outboundText', () => {
  const compressed = smazEncodeIfSmaller(LONG);

  it('compresses long text into a decodable, shorter "s:" envelope (both conversation types)', () => {
    expect(compressed).toBe('s:AeknejgXCYOcTHsqCUY=');
    expect(compressed.length).toBeLessThan(LONG.length);
    expect(smazTryDecode(compressed)).toBe(LONG);
    expect(outboundText('contact', LONG, true)).toBe(compressed);
    expect(outboundText('channel', LONG, true)).toBe(compressed);
  });

  const unchanged: Array<[string, Conv, string, boolean]> = [
    ['compression off', 'contact', LONG, false],
    ['compression off (channel)', 'channel', LONG, false],
    ['GIF', 'contact', `g:${LONG}`, true],
    ['GIF (channel)', 'channel', `g:${LONG}`, true],
    ['location', 'channel', `m:${LONG}`, true],
    ['DM V1| envelope', 'contact', `V1|${LONG}`, true],
    ['already an "s:" envelope', 'contact', `s:${LONG}`, true],
    ['short text (envelope not shorter)', 'contact', 'hi', true],
    ['reaction "r:" (envelope never shorter)', 'contact', 'r:👍:abcd', true],
    ['empty', 'channel', '', true],
  ];
  it.each(unchanged)('%s: sent as-is', (_label, conv, text, compress) => {
    expect(outboundText(conv, text, compress)).toBe(text);
  });

  it('"V1|" is only exempt in DMs: a channel compresses it', () => {
    const t = `V1|${LONG}`;
    const out = outboundText('channel', t, true);
    expect(out).toBe(smazEncodeIfSmaller(t));
    expect(out.startsWith('s:')).toBe(true);
    expect(smazTryDecode(out)).toBe(t);
  });

  it('a reply prefix is compressed together with the text', () => {
    const t = `@[Alice] ${LONG}`;
    const out = outboundText('contact', t, true);
    expect(out.startsWith('s:')).toBe(true);
    expect(smazTryDecode(out)).toBe(t);
  });
});
