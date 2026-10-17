/**
 * Emoji reactions, wire compatible with MeshCore Open (feature-inventory.md §2.4b; MeshCore Open
 * `lib/helpers/reaction_helper.dart`, `lib/widgets/emoji_picker.dart`).
 *
 * A reaction is an ordinary text message (DM or channel) `"r:<hash>:<index>"`:
 * - `<hash>`: 4 lowercase hex digits, the low 16 bits of a one-at-a-time string hash
 *   ({@link stableStringHash}) over `"<sender timestamp secs><sender name?><first 5 UTF-16 units of
 *   the text>"` of the target message. DMs leave the sender name out; channels include the
 *   "sender: text" sender name.
 * - `<index>`: 2 lowercase hex digits, the position of the emoji in {@link REACTION_EMOJIS}
 *   (first occurrence: the quick set repeats some category emojis).
 *
 * Received MeshCoreOne reactions (`"<emoji>\n<8 crockford base32>"`, optionally with `@[name]`) are
 * understood too; they are never sent.
 */

import type { ConversationType, MessageReaction, MessageRecord, MessageStatus } from '../store/schema.js';
import { sha256Sync } from '../emulator/crypto-sync.js';
import { concatBytes, u32le, utf8Encode } from '../util/bytes.js';

// ---------------------------------------------------------------------------
// Emoji table (order is the wire format; never reorder)
// ---------------------------------------------------------------------------

/** The quick-pick row (MeshCore Open `EmojiPicker.quickEmojis`); indices 0x00-0x05. */
export const REACTION_QUICK_EMOJIS: readonly string[] = [
  '👍', '❤️', '😂', '🎉', '👏', '🔥',
];

/** `EmojiPicker.smileys` (64). */
const SMILEYS: readonly string[] = [
  '😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘',
  '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🥸', '🤩', '🥳', '😏',
  '😒', '😞', '😔', '😟', '😕', '🙁', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡',
  '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🤗', '🤔', '🤭', '🤫', '🤥', '😶',
];

/** `EmojiPicker.gestures` (33). */
const GESTURES: readonly string[] = [
  '👍', '👎', '👊', '✊', '🤛', '🤜', '🤞', '✌️', '🤟', '🤘', '👌', '🤌', '🤏', '👈', '👉', '👆',
  '👇', '☝️', '👋', '🤚', '🖐️', '✋', '🖖', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️', '💅', '🤳',
  '💪',
];

/** `EmojiPicker.hearts` (32). */
const HEARTS: readonly string[] = [
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❤️‍🔥', '❤️‍🩹', '💕', '💞', '💓', '💗',
  '💖', '💘', '💝', '💟', '💌', '💢', '💥', '💫', '💦', '💨', '🕳️', '💬', '👁️‍🗨️', '🗨️', '🗯️', '💭',
];

/** `EmojiPicker.objects` (49). */
const OBJECTS: readonly string[] = [
  '🎉', '🎊', '🎈', '🎁', '🎀', '🪅', '🪆', '🏆', '🥇', '🥈', '🥉', '⚽', '⚾', '🥎', '🏀', '🏐',
  '🏈', '🏉', '🎾', '🥏', '🎳', '🏏', '🏑', '🏒', '🥍', '🏓', '🏸', '🥊', '🥋', '🥅', '⛳', '🔥',
  '⭐', '🌟', '✨', '⚡', '💡', '🔦', '🏮', '🪔', '📱', '💻', '⌚', '📷', '📺', '📻', '🎵', '🎶',
  '🚀',
];

export interface ReactionEmojiCategory {
  id: 'smileys' | 'gestures' | 'hearts' | 'objects';
  label: string;
  emojis: readonly string[];
}

/** The picker's tabs (MeshCore Open `EmojiPicker._emojiCategories`). */
export const REACTION_EMOJI_CATEGORIES: readonly ReactionEmojiCategory[] = [
  { id: 'smileys', label: 'Smileys', emojis: SMILEYS },
  { id: 'gestures', label: 'Gestures', emojis: GESTURES },
  { id: 'hearts', label: 'Hearts', emojis: HEARTS },
  { id: 'objects', label: 'Objects', emojis: OBJECTS },
];

/** Every reaction emoji in wire order: quick set, smileys, gestures, hearts, objects (184). */
export const REACTION_EMOJIS: readonly string[] = [...REACTION_QUICK_EMOJIS, ...SMILEYS, ...GESTURES, ...HEARTS, ...OBJECTS];

/** 2-hex-digit wire index of `emoji` (its first position), or null when it is not in the table. */
export function emojiToReactionIndex(emoji: string): string | null {
  const i = REACTION_EMOJIS.indexOf(emoji);
  return i < 0 ? null : i.toString(16).padStart(2, '0');
}

/** The emoji for a hex wire index, or null when out of range / not hex. */
export function reactionIndexToEmoji(hex: string): string | null {
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  return REACTION_EMOJIS[parseInt(hex, 16)] ?? null;
}

// ---------------------------------------------------------------------------
// Hashes
// ---------------------------------------------------------------------------

/**
 * The Dart VM's `String.hashCode` (one-at-a-time over UTF-16 code units, finalised to 30 bits,
 * 0 → 1), as reimplemented by MeshCore Open's `ReactionHelper.stableStringHash`.
 */
export function stableStringHash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h + input.charCodeAt(i)) >>> 0;
    h = (h + (h << 10)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  h = (h + (h << 3)) >>> 0;
  h = (h ^ (h >>> 11)) >>> 0;
  h = (h + (h << 15)) >>> 0;
  h &= 0x3fffffff;
  return h === 0 ? 1 : h;
}

/**
 * MeshCore Open `computeReactionHash`: 4 hex digits of
 * `stableStringHash("<ts><senderName><first 5 UTF-16 units of text>")` (no sender name for DMs).
 */
export function computeReactionHash(timestampSecs: number, senderName: string | null | undefined, text: string): string {
  const first5 = text.slice(0, 5);
  const input = senderName != null ? `${timestampSecs}${senderName}${first5}` : `${timestampSecs}${first5}`;
  return (stableStringHash(input) & 0xffff).toString(16).padStart(4, '0');
}

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

/** MeshCoreOne hash: lowercase Crockford base32 of the first 5 bytes of SHA-256(utf8(text) ‖ u32le(ts)). */
export function computeReactionHashMC1(timestampSecs: number, text: string): string {
  const d = sha256Sync(concatBytes(utf8Encode(text), u32le(timestampSecs >>> 0)));
  let bits = 0n;
  for (let i = 0; i < 5; i++) bits = (bits << 8n) | BigInt(d[i]!);
  let out = '';
  for (let i = 7; i >= 0; i--) out += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)]!;
  return out;
}

// ---------------------------------------------------------------------------
// Encode / parse
// ---------------------------------------------------------------------------

/** `"r:<hash>:<index>"` for `emoji`, or null when the emoji is not in the table. */
export function encodeReaction(hash: string, emoji: string): string | null {
  const idx = emojiToReactionIndex(emoji);
  return idx === null ? null : `r:${hash}:${idx}`;
}

export type ParsedReaction =
  /** MeshCore Open: `r:<4 hex>:<2 hex>`. */
  | { format: 'ours'; hash: string; emoji: string }
  /** MeshCoreOne (receive only): `[@[target]]<emoji>\n<8 base32>` or legacy `<emoji>[@[target]]\n<hash>`. */
  | { format: 'mc1'; hash: string; emoji: string; targetSender: string };

const OURS_RE = /^r:([0-9a-f]{4}):([0-9a-f]{2})$/;
const MC1_RE = /^(?:@\[(.*)])?(.+?)\n([a-tv-zA-TV-Z0-9]{8})$/;
const MC1_LEGACY_RE = /^(.+?)(?:@\[(.*)])?\n([a-tv-zA-TV-Z0-9]{8})$/;

function graphemeCount(s: string): number {
  let n = 0;
  for (const _ of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)) n++;
  return n;
}

/** MeshCore Open `_looksLikeEmoji`: one grapheme, starting at U+2000+ or carrying U+FE0F / U+20E3. */
function looksLikeEmoji(s: string): boolean {
  if (!s || graphemeCount(s) > 1) return false;
  const cps = [...s].map((c) => c.codePointAt(0)!);
  return cps[0]! >= 0x2000 || cps.some((c) => c === 0xfe0f || c === 0x20e3);
}

/** Parses a reaction text (MeshCore Open format first, then MeshCoreOne); null for anything else. */
export function parseReaction(text: string): ParsedReaction | null {
  const m = OURS_RE.exec(text);
  if (m) {
    const emoji = reactionIndexToEmoji(m[2]!);
    return emoji === null ? null : { format: 'ours', hash: m[1]!, emoji };
  }
  const a = MC1_RE.exec(text);
  if (a && looksLikeEmoji(a[2]!)) return { format: 'mc1', hash: a[3]!.toLowerCase(), emoji: a[2]!, targetSender: a[1] ?? '' };
  const b = MC1_LEGACY_RE.exec(text);
  if (b && looksLikeEmoji(b[1]!)) return { format: 'mc1', hash: b[3]!.toLowerCase(), emoji: b[1]!, targetSender: b[2] ?? '' };
  return null;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type ReactionTarget = Pick<MessageRecord, 'convType' | 'timestamp' | 'text' | 'senderName'>;

/**
 * The text MeshCore Open hashes for a message: channel replies are stored there without their
 * `"@[name] "` prefix (`ChannelMessage.parseReplyMention`), DMs as they are.
 */
export function reactionHashText(convType: ConversationType, text: string): string {
  if (convType !== 'channel') return text;
  const m = /^@\[([^\]]+)\]\s+([\s\S]+)$/.exec(text);
  return m ? m[2]! : text;
}

/** The sender name in the hash: the channel "sender: text" name; none for DMs. */
function hashSender(m: ReactionTarget): string | null {
  return m.convType === 'channel' ? (m.senderName ?? '') : null;
}

/** The 4-hex hash a reaction to `m` carries. */
export function reactionMessageHash(m: ReactionTarget): string {
  return computeReactionHash(m.timestamp, hashSender(m), reactionHashText(m.convType, m.text));
}

/** Whether the parsed reaction `r` targets message `m`. */
export function reactionMatches(r: ParsedReaction, m: ReactionTarget): boolean {
  if (r.format === 'ours') return reactionMessageHash(m) === r.hash;
  const sender = hashSender(m) ?? '';
  return r.targetSender === sender && computeReactionHashMC1(m.timestamp, reactionHashText(m.convType, m.text)) === r.hash;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export interface ReactionChip {
  emoji: string;
  count: number;
  /** Who reacted, in arrival order (own reaction included under our name). */
  senders: string[];
  /** We reacted with this emoji. */
  own: boolean;
  /**
   * Our reaction's state: 'pending' (DM: until ACKed; channel: until the radio accepted it),
   * 'failed' (retry offered) or undefined once sent / delivered.
   */
  state?: 'pending' | 'failed';
}

function ownState(convType: ConversationType, status: MessageStatus | undefined): ReactionChip['state'] {
  if (status === 'pending' || (status === 'sent' && convType === 'contact')) return 'pending';
  if (status === 'failed') return 'failed';
  return undefined;
}

/** Reaction chips for a message, one per emoji in first-reaction order (MeshCore Open `ReactionChips`). */
export function reactionChips(m: Pick<MessageRecord, 'convType' | 'reactions'>): ReactionChip[] {
  const out = new Map<string, ReactionChip>();
  for (const r of m.reactions ?? []) {
    let chip = out.get(r.emoji);
    if (!chip) out.set(r.emoji, (chip = { emoji: r.emoji, count: 0, senders: [], own: false }));
    chip.count++;
    chip.senders.push(r.sender);
    if (r.own) {
      chip.own = true;
      const state = ownState(m.convType, r.status);
      if (state) chip.state = state;
    }
  }
  return [...out.values()];
}

/** Our own reaction with `emoji` on `m`, if any. */
export function ownReaction(m: Pick<MessageRecord, 'reactions'>, emoji: string): MessageReaction | undefined {
  return m.reactions?.find((r) => r.own === true && r.emoji === emoji);
}
