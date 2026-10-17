import { describe, expect, it } from 'vitest';
import { ContactType, PATH_LEN_UNKNOWN, encodePathLen } from '../protocol/constants.js';
import { fromHex } from '../util/bytes.js';
import { formatResolvedPath, pathLabel, resolveHop, resolvePath, resolvedPathTitle, splitPathHashes, type PathContact } from './path-resolver.js';

function contact(keyHex: string, name: string, type: number = ContactType.REPEATER): PathContact {
  return { pubKey: fromHex(keyHex.padEnd(64, '0')), name, type };
}

const alice = contact('a1b2', 'Alice');
const bob = contact('b0b0', 'Bob');
const cathy = contact('c4c4', 'Cathy');
const dupe1 = contact('d1aa', 'Dee One');
const dupe2 = contact('d1bb', 'Dee Two');
const chatD1 = contact('d1cc', 'Chatter', ContactType.CHAT);
const chatE = contact('e5e5', 'Eve', ContactType.CHAT);
const contacts = [alice, bob, cathy, dupe1, dupe2, chatD1, chatE];

describe('splitPathHashes (mesh-packet-format.md §1.2: path = hop hashes of path_len hash size)', () => {
  it('splits by hash size and drops a trailing partial hash', () => {
    expect(splitPathHashes(Uint8Array.of(1, 2, 3)).map((h) => [...h])).toEqual([[1], [2], [3]]);
    expect(splitPathHashes(Uint8Array.of(1, 2, 3, 4, 5), 2).map((h) => [...h])).toEqual([[1, 2], [3, 4]]);
    expect(splitPathHashes(new Uint8Array(0))).toEqual([]);
  });
});

describe('resolvePath', () => {
  it('resolves unique hashes to names, unknown ones to hex', () => {
    const hops = resolvePath(Uint8Array.of(0xa1, 0xb0, 0x33, 0xc4), contacts);
    expect(hops.map((h) => h.label)).toEqual(['Alice', 'Bob', '33', 'Cathy']);
    expect(formatResolvedPath(hops)).toBe('Alice > Bob > 33 > Cathy');
    expect(hops[2]).toMatchObject({ hash: '33', ambiguous: false, candidates: [], title: '33: unknown node' });
    expect(hops[0]).toMatchObject({ name: 'Alice', title: 'a1: Alice' });
  });

  it('marks shared prefixes ambiguous ("d1?") and lists the candidates, preferring repeaters', () => {
    const [h] = resolvePath([0xd1], contacts);
    expect(h).toMatchObject({ hash: 'd1', ambiguous: true, label: 'd1?', title: 'd1: Dee One, Dee Two (ambiguous)' });
    expect(h!.name).toBeUndefined();
    expect(h!.candidates.map((c) => c.name)).toEqual(['Dee One', 'Dee Two']);
  });

  it('falls back to non-forwarding contacts when no repeater matches', () => {
    expect(resolveHop(Uint8Array.of(0xe5), contacts).label).toBe('Eve');
    // a 1-byte hash matching a repeater and a chat node is the repeater; a longer hash disambiguates
    expect(resolveHop(Uint8Array.of(0xd1), [chatD1, dupe1]).label).toBe('Dee One');
    expect(resolveHop(fromHex('d1cc'), [chatD1, dupe1]).label).toBe('Chatter');
    // endpoint hashes (src / dest) do not prefer forwarders
    expect(resolveHop(Uint8Array.of(0xd1), [chatD1, dupe1], { preferForwarders: false }).candidates.map((c) => c.name)).toEqual(['Chatter', 'Dee One']);
  });

  it('accepts 2-byte hashes as bytes or hex strings, and the self key', () => {
    expect(resolvePath(Uint8Array.of(0xa1, 0xb2, 0xb0, 0xb1), contacts, { hashSize: 2 }).map((h) => h.label)).toEqual(['Alice', 'b0b1']);
    expect(resolvePath(['a1', 'b0b0'], contacts).map((h) => h.label)).toEqual(['Alice', 'Bob']);
    const self = { pubKey: fromHex('a1ff'.padEnd(64, '0')) };
    expect(resolvePath([0xa1], contacts, { self })[0]!.label).toBe('You');
    expect(resolvedPathTitle(resolvePath([0xa1, 0x33], contacts))).toBe('a1: Alice\n33: unknown node');
  });
});

describe('pathLabel', () => {
  const path = Uint8Array.of(0xa1, 0xd1);
  it('uses the count label unless names are on and the path bytes are known', () => {
    const o = { pathLen: encodePathLen(2), path, countLabel: '2 hops' };
    expect(pathLabel(o, contacts, { names: false })).toMatchObject({ hops: 2, label: '2 hops', named: false, title: 'a1: Alice\nd1: Dee One, Dee Two (ambiguous)' });
    expect(pathLabel(o, contacts, { names: true })).toMatchObject({ label: 'Alice > d1?', named: true });
    expect(pathLabel({ pathLen: encodePathLen(2), countLabel: '2 hops' }, contacts, { names: true }).label).toBe('2 hops');
    expect(pathLabel({ pathLen: 0, path, countLabel: 'direct' }, contacts, { names: true })).toMatchObject({ hops: 0, label: 'direct', resolved: [], named: false });
    expect(pathLabel({ pathLen: PATH_LEN_UNKNOWN, path, countLabel: 'flood' }, contacts, { names: true })).toMatchObject({ hops: null, label: 'flood' });
    // 2-byte hashes per path_len bits 6-7
    expect(pathLabel({ pathLen: encodePathLen(1, 2), path: fromHex('b0b0'), countLabel: '1 hop' }, contacts, { names: true }).label).toBe('Bob');
  });
});
