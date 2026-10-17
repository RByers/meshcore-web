/**
 * Reaction codec (feature-inventory.md §2.4b). Vectors are MeshCore Open's own
 * (`test/reaction_helper_test.dart`): Dart VM `String.hashCode` values and the MeshCoreOne hash.
 */
import { describe, expect, it } from 'vitest';
import {
  REACTION_EMOJIS,
  REACTION_EMOJI_CATEGORIES,
  REACTION_QUICK_EMOJIS,
  computeReactionHash,
  computeReactionHashMC1,
  emojiToReactionIndex,
  encodeReaction,
  parseReaction,
  reactionChips,
  reactionHashText,
  reactionIndexToEmoji,
  reactionMatches,
  reactionMessageHash,
  stableStringHash,
} from './reactions.js';

describe('emoji table', () => {
  it('is quick set + smileys + gestures + hearts + objects, 184 entries, first index wins', () => {
    expect(REACTION_QUICK_EMOJIS).toEqual(['👍', '❤️', '😂', '🎉', '👏', '🔥']);
    expect(REACTION_EMOJI_CATEGORIES.map((c) => [c.id, c.emojis.length])).toEqual([
      ['smileys', 64],
      ['gestures', 33],
      ['hearts', 32],
      ['objects', 49],
    ]);
    expect(REACTION_EMOJIS).toHaveLength(184);
    expect(emojiToReactionIndex('👍')).toBe('00');
    expect(emojiToReactionIndex('❤️')).toBe('01'); // U+2764 U+FE0F
    expect(emojiToReactionIndex('❤')).toBeNull(); // without the variation selector
    expect(emojiToReactionIndex('😀')).toBe('06'); // first smiley
    expect(emojiToReactionIndex('👎')).toBe('47'); // gestures[1] = 6 + 64 + 1
    expect(emojiToReactionIndex('🚀')).toBe('b7'); // last
    expect(emojiToReactionIndex('🦄')).toBeNull();
    expect(emojiToReactionIndex('')).toBeNull();
    expect(reactionIndexToEmoji('00')).toBe('👍');
    expect(reactionIndexToEmoji('0A')).toBe(REACTION_EMOJIS[10]);
    expect(reactionIndexToEmoji('b8')).toBeNull();
    expect(reactionIndexToEmoji('ff')).toBeNull();
    expect(reactionIndexToEmoji('zz')).toBeNull();
    // code points of the multi-code-point entries
    const cps = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16)).join('+');
    expect(cps(REACTION_EMOJIS[6 + 64 + 33 + 10]!)).toBe('2764+fe0f+200d+1f525'); // ❤️‍🔥
    expect(cps(REACTION_EMOJIS[6 + 64 + 33 + 28]!)).toBe('1f441+fe0f+200d+1f5e8+fe0f'); // 👁️‍🗨️
    for (let i = 0; i < REACTION_EMOJIS.length; i++) {
      const e = REACTION_EMOJIS[i]!;
      expect(reactionIndexToEmoji(emojiToReactionIndex(e)!)).toBe(e);
    }
  });
});

describe('hashes', () => {
  it('stableStringHash matches the Dart VM String.hashCode vectors', () => {
    // computeReactionHash vectors from MeshCore Open's tests (Dart VM `String.hashCode & 0xFFFF`)
    expect(computeReactionHash(1700000000, 'Bob', 'hello')).toBe('e779');
    expect(computeReactionHash(1700000000, null, 'hi')).toBe('b5bd');
    expect(computeReactionHash(1700000000, 'Привет😀', 'x')).toBe('7fee');
    expect(stableStringHash('')).toBe(1); // 0 → 1
    expect(stableStringHash('a')).toBeLessThan(2 ** 30);
  });

  it('hashes the first 5 UTF-16 code units of the text; the sender only when given', () => {
    expect(computeReactionHash(1234567890, 'Alice', 'Hello world')).toBe(computeReactionHash(1234567890, 'Alice', 'Hello there'));
    expect(computeReactionHash(1234567890, null, 'Hello')).not.toBe(computeReactionHash(1234567890, 'Alice', 'Hello'));
    expect(computeReactionHash(1234567890, null, 'Hello')).toBe((stableStringHash('1234567890Hello') & 0xffff).toString(16).padStart(4, '0'));
    // '😀' is 2 code units: "a😀bc" is 5 units, the 6th unit 'd' is cut
    expect(computeReactionHash(1, null, 'a😀bcd')).toBe(computeReactionHash(1, null, 'a😀bcX'));
    expect(computeReactionHash(1, null, 'a😀bcd')).not.toBe(computeReactionHash(1, null, 'a😀bXd'));
  });

  it('MeshCoreOne hash: crockford base32 of SHA-256(utf8(text) ‖ u32le(ts))[0..5]', () => {
    expect(computeReactionHashMC1(1234567890, 'Hello world!')).toBe('tyvbkb33');
  });
});

describe('encode / parse', () => {
  it('encodes "r:<hash>:<index>" (9 bytes)', () => {
    const hash = computeReactionHash(1700000000, 'Bob', 'hello');
    expect(encodeReaction(hash, '👍')).toBe('r:e779:00');
    expect(encodeReaction(hash, '🔥')).toBe('r:e779:05');
    expect(encodeReaction(hash, '🚀')).toBe('r:e779:b7');
    expect(encodeReaction(hash, '🦄')).toBeNull();
  });

  it('parses MeshCore Open reactions strictly', () => {
    expect(parseReaction('r:a1b2:00')).toEqual({ format: 'ours', hash: 'a1b2', emoji: '👍' });
    for (const bad of ['invalid', 'r:abc:00', 'r:abcde:00', 'r:a1b2:0', 'r:a1b2:000', 'R:a1b2:00', 'r:A1B2:00', '', 'r:a1b2:ff', ' r:a1b2:00']) {
      expect(parseReaction(bad), bad).toBeNull();
    }
  });

  it('parses MeshCoreOne reactions (current and legacy, channel and DM)', () => {
    expect(parseReaction('@[entropy 📓]🥳\nb3je6qf7')).toEqual({ format: 'mc1', hash: 'b3je6qf7', emoji: '🥳', targetSender: 'entropy 📓' });
    expect(parseReaction('🥳@[entropy 📓]\nb3je6qf7')).toEqual({ format: 'mc1', hash: 'b3je6qf7', emoji: '🥳', targetSender: 'entropy 📓' });
    expect(parseReaction('🥳\nB3JE6QF7')).toEqual({ format: 'mc1', hash: 'b3je6qf7', emoji: '🥳', targetSender: '' });
    for (const ok of ['\u{1f44c}\u{1f3ff}\n01234567', '@[entropy]🧑‍🧑‍🧒\n01234567', '🧑‍🧑‍🧒‍🧒\n01234567']) expect(parseReaction(ok), ok).not.toBeNull();
    for (const bad of ['test\nabcdefgh', '🥳\nhashistoolong', '🥳\nshort', '🥳🥳\n01234567', 'X\n01234567', '🥳\nabcuuxyz']) {
      expect(parseReaction(bad), bad).toBeNull();
    }
  });
});

describe('messages', () => {
  const dm = { convType: 'contact' as const, timestamp: 1700000000, text: 'hi' };
  const ch = { convType: 'channel' as const, timestamp: 1700000000, text: 'hello there', senderName: 'Bob' };

  it('DM hash has no sender; channel hash has the sender and drops a reply prefix', () => {
    expect(reactionMessageHash(dm)).toBe('b5bd');
    expect(reactionMessageHash(ch)).toBe('e779');
    expect(reactionMessageHash({ ...ch, text: '@[Alice] hello there' })).toBe('e779');
    expect(reactionHashText('contact', '@[Alice] hi')).toBe('@[Alice] hi');
    expect(reactionMatches(parseReaction('r:e779:00')!, ch)).toBe(true);
    expect(reactionMatches(parseReaction('r:e779:00')!, { ...ch, senderName: 'Carol' })).toBe(false);
  });

  it('matches MeshCoreOne reactions by hash and target sender', () => {
    const m = { convType: 'channel' as const, timestamp: 1234567890, text: 'Hello world!', senderName: 'Alice' };
    expect(reactionMatches(parseReaction('@[Alice]👍\ntyvbkb33')!, m)).toBe(true);
    expect(reactionMatches(parseReaction('@[Bob]👍\ntyvbkb33')!, m)).toBe(false);
    expect(reactionMatches(parseReaction('👍\ntyvbkb33')!, { ...m, convType: 'contact' })).toBe(true);
  });

  it('summarises chips: counts, senders, own pending / failed state', () => {
    const chips = reactionChips({
      convType: 'contact',
      reactions: [
        { emoji: '👍', sender: 'Alice', at: 1 },
        { emoji: '❤️', sender: 'Me', own: true, status: 'sent', at: 2 },
        { emoji: '👍', sender: 'Me', own: true, status: 'failed', at: 3 },
      ],
    });
    expect(chips).toEqual([
      { emoji: '👍', count: 2, senders: ['Alice', 'Me'], own: true, state: 'failed' },
      { emoji: '❤️', count: 1, senders: ['Me'], own: true, state: 'pending' }, // DM: pending until ACKed
    ]);
    expect(reactionChips({ convType: 'channel', reactions: [{ emoji: '❤️', sender: 'Me', own: true, status: 'sent', at: 2 }] })[0]!.state).toBeUndefined();
    expect(reactionChips({ convType: 'channel' })).toEqual([]);
  });
});
