import { describe, expect, it } from 'vitest';
import { toHex, utf8Encode } from '../util/bytes.js';
import { ContactType, encodePathLen } from '../protocol/constants.js';
import { buildPacket } from '../packet/packet.js';
import { buildAdvertPayload } from '../packet/payloads.js';
import { PayloadType, RouteType } from '../packet/constants.js';
import { hashtagChannelSecret, publicChannelSecret, scenarioIdentity } from '../emulator/scenarios.js';
import {
  base64Decode,
  base64Encode,
  byteBudget,
  channelKind,
  channelNameError,
  contactShareUrl,
  formatReply,
  messageByteLimit,
  parseContactShare,
  parsePsk,
  parseReply,
  pathDisplay,
  receivedHops,
  receivedPathLabel,
  receivedSignal,
  replyPrefix,
  resolveChannelPsk,
  splitChannelSender,
  textByteLength,
} from './messaging.js';

describe('byte budgets (companion-protocol.md §8: 160 bytes, channel "name: " prefix included)', () => {
  it('counts UTF-8 bytes', () => {
    expect(textByteLength('abc')).toBe(3);
    expect(textByteLength('é')).toBe(2);
    expect(textByteLength('👋')).toBe(4);
  });

  it('direct messages get 160 bytes, channels 160 minus "<name>: "', () => {
    expect(messageByteLimit('contact', 'Emulator')).toBe(160);
    expect(messageByteLimit('channel', 'Emulator')).toBe(160 - 'Emulator: '.length);
    expect(messageByteLimit('channel', 'Zoë')).toBe(160 - 6);
    expect(messageByteLimit('contact', 'x', replyPrefix('Alice'))).toBe(160 - '@[Alice] '.length);
  });

  it('reports remaining and overflow', () => {
    expect(byteBudget('hi', 10)).toEqual({ used: 2, limit: 10, remaining: 8, over: false });
    expect(byteBudget('x'.repeat(11), 10)).toEqual({ used: 11, limit: 10, remaining: -1, over: true });
  });
});

describe('conventions (feature-inventory.md §2.4, §3.6)', () => {
  it('formats and parses replies "@[name] text"', () => {
    expect(formatReply('Alice', 'yes')).toBe('@[Alice] yes');
    expect(parseReply('@[Alice] yes please')).toEqual({ name: 'Alice', text: 'yes please' });
    expect(parseReply('@[Bob Smith] ')).toEqual({ name: 'Bob Smith', text: '' });
    expect(parseReply('hello @[Alice]')).toBeNull();
  });

  it('splits channel "sender: text"', () => {
    expect(splitChannelSender('Dave: Good morning')).toEqual({ senderName: 'Dave', text: 'Good morning' });
    expect(splitChannelSender('a: b: c')).toEqual({ senderName: 'a', text: 'b: c' });
    expect(splitChannelSender('no sender')).toEqual({ text: 'no sender' });
    expect(splitChannelSender(': x')).toEqual({ text: ': x' });
  });

  it('labels paths (§3.4)', () => {
    expect(pathDisplay(0xff)).toEqual({ kind: 'flood', hops: 0, label: 'flood' });
    expect(pathDisplay(0)).toEqual({ kind: 'direct', hops: 0, label: 'direct' });
    expect(pathDisplay(encodePathLen(1))).toEqual({ kind: 'hops', hops: 1, label: '1 hop' });
    expect(pathDisplay(encodePathLen(3, 2))).toEqual({ kind: 'hops', hops: 3, label: '3 hops' });
    expect(receivedPathLabel(0xff)).toBe('direct route');
    expect(receivedPathLabel(encodePathLen(2))).toBe('2 hops');
  });
});

describe('contact shares', () => {
  it('parses a bare public key', () => {
    const key = scenarioIdentity('dave').publicKey;
    const s = parseContactShare(` ${toHex(key).toUpperCase()} `);
    expect(s.kind).toBe('pubKey');
    expect(toHex(s.pubKey)).toBe(toHex(key));
  });

  it('parses meshcore://<advert packet hex> and the bare hex', async () => {
    const id = scenarioIdentity('dave');
    const payload = await buildAdvertPayload({
      keys: id,
      timestamp: 1_760_000_000,
      appData: { nodeType: ContactType.CHAT, name: 'Dave', latitude: 47.5, longitude: -122.25 },
    });
    const packet = buildPacket({ routeType: RouteType.FLOOD, payloadType: PayloadType.ADVERT, path: new Uint8Array(0), payload });
    const url = contactShareUrl(packet);
    expect(url).toBe(`meshcore://${toHex(packet)}`);
    for (const input of [url, toHex(packet)]) {
      const s = parseContactShare(input);
      if (s.kind !== 'advert') throw new Error('expected advert');
      expect(toHex(s.pubKey)).toBe(toHex(id.publicKey));
      expect(s.name).toBe('Dave');
      expect(s.type).toBe(ContactType.CHAT);
      expect(s.lat).toBeCloseTo(47.5);
    }
  });

  it('rejects junk with a readable message', () => {
    expect(() => parseContactShare('')).toThrow(/Paste/);
    expect(() => parseContactShare('zz')).toThrow(/hex/);
    expect(() => parseContactShare('0102')).toThrow(/advert/);
  });
});

describe('channel keys', () => {
  it('parses 16-byte PSKs as hex or base64', () => {
    const psk = publicChannelSecret();
    expect(toHex(parsePsk(toHex(psk)))).toBe(toHex(psk));
    expect(toHex(parsePsk('8b33 87e9-c5cd:ea6a c9e5 edba a115 cd72'))).toBe(toHex(psk));
    expect(base64Encode(psk)).toBe('izOH6cXN6mrJ5e26oRXNcg==');
    expect(toHex(parsePsk('izOH6cXN6mrJ5e26oRXNcg=='))).toBe(toHex(psk));
    expect(toHex(parsePsk('izOH6cXN6mrJ5e26oRXNcg'))).toBe(toHex(psk));
    expect(() => parsePsk('00'.repeat(32))).toThrow(/256-bit/);
    expect(() => parsePsk('abc')).toThrow(/16 bytes/);
  });

  it('base64 round-trips', () => {
    for (const n of [0, 1, 2, 3, 16, 31]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37) & 0xff);
      expect(toHex(base64Decode(base64Encode(b))!)).toBe(toHex(b));
    }
    expect(base64Decode('a')).toBeNull();
    expect(base64Decode('a$')).toBeNull();
  });

  it('derives hashtag and Public keys from the name', async () => {
    expect(toHex(await resolveChannelPsk('#test'))).toBe(toHex(hashtagChannelSecret('#test')));
    expect(toHex(await resolveChannelPsk('Public'))).toBe(toHex(publicChannelSecret()));
    expect(toHex(await resolveChannelPsk('Team', '', (n) => new Uint8Array(n).fill(7)))).toBe('07'.repeat(16));
    expect(toHex(await resolveChannelPsk('#test', toHex(publicChannelSecret())))).toBe(toHex(publicChannelSecret()));
  });

  it('classifies channels and validates names', () => {
    expect(channelKind('Public', publicChannelSecret())).toBe('public');
    expect(channelKind('#test', hashtagChannelSecret('#test'))).toBe('hashtag');
    expect(channelKind('Team', new Uint8Array(16).fill(1))).toBe('private');
    expect(channelNameError('')).toMatch(/required/);
    expect(channelNameError('#')).toMatch(/hashtag/i);
    expect(channelNameError('x'.repeat(32))).toMatch(/31/);
    expect(channelNameError('ok')).toBeNull();
    expect(utf8Encode('x').length).toBe(1);
  });
});

describe('receivedSignal (issue #11: SNR only for zero-hop messages)', () => {
  it('shows SNR for zero hop, hides it (keeping the raw value) for relayed / direct-routed', () => {
    expect(receivedSignal({ pathLen: 0, snr: 6.5 })).toEqual({ hops: 0, zeroHop: true, pathLabel: 'zero hop', snr: 6.5, lastHopSnr: 6.5 });
    expect(receivedSignal({ pathLen: encodePathLen(2), snr: 3 })).toEqual({ hops: 2, zeroHop: false, pathLabel: '2 hops', lastHopSnr: 3 });
    expect(receivedSignal({ pathLen: 0xff, snr: 3 })).toEqual({ hops: null, zeroHop: false, pathLabel: 'direct route', lastHopSnr: 3 });
    expect(receivedSignal({ pathLen: 0 })).toEqual({ hops: 0, zeroHop: true, pathLabel: 'zero hop' });
    expect(receivedHops(encodePathLen(3, 2))).toBe(3);
  });
});
