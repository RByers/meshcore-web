/**
 * SMAZ short-string compression, byte-compatible with MeshCore Open
 * (`lib/helpers/smaz.dart`), and the `"s:" + base64` text envelope it puts on the air.
 *
 * Stream format (antirez's smaz): each byte 0..253 is a codebook index expanding to that entry's
 * ASCII bytes, `254 b` is one verbatim byte, and `255 n b0..bn` is a run of n+1 verbatim bytes
 * (2..256). The compressor is greedy: at each position the longest matching codebook entry is
 * emitted (lowest index on a tie; the codebook has no duplicates); unmatched bytes accumulate
 * into a verbatim run that is flushed before the next code, when it reaches 256 bytes, and at
 * the end. A run of one byte is written as `254 b`.
 *
 * Envelope (feature-inventory.md §2.4a): a compressed message is the ordinary text payload
 * `"s:" + base64(smaz(utf8(text)))` (standard alphabet, padded), used only when it is strictly
 * shorter in bytes than the original. There is no txt_type or flag byte; receivers recognise the
 * prefix and validate it ({@link smazTryDecode}).
 */

import { base64Decode, base64Encode, bytesEqual, utf8Encode } from './bytes.js';

const VERBATIM_SINGLE = 254;
const VERBATIM_RUN = 255;

/** The 254-entry codebook (MeshCore Open `Smaz._rcb`, the antirez smaz `Smaz_rcb` table). */
export const SMAZ_CODEBOOK: readonly string[] = [
  ' ', 'the', 'e', 't', 'a', 'of', 'o', 'and', 'i', 'n',
  's', 'e ', 'r', ' th', ' t', 'in', 'he', 'th', 'h', 'he ',
  'to', '\r\n', 'l', 's ', 'd', ' a', 'an', 'er', 'c', ' o',
  'd ', 'on', ' of', 're', 'of ', 't ', ', ', 'is', 'u', 'at',
  '   ', 'n ', 'or', 'which', 'f', 'm', 'as', 'it', 'that', '\n',
  'was', 'en', '  ', ' w', 'es', ' an', ' i', '\r', 'f ', 'g',
  'p', 'nd', ' s', 'nd ', 'ed ', 'w', 'ed', 'http://', 'for', 'te',
  'ing', 'y ', 'The', ' c', 'ti', 'r ', 'his', 'st', ' in', 'ar',
  'nt', ',', ' to', 'y', 'ng', ' h', 'with', 'le', 'al', 'to ',
  'b', 'ou', 'be', 'were', ' b', 'se', 'o ', 'ent', 'ha', 'ng ',
  'their', '"', 'hi', 'from', ' f', 'in ', 'de', 'ion', 'me', 'v',
  '.', 've', 'all', 're ', 'ri', 'ro', 'is ', 'co', 'f t', 'are',
  'ea', '. ', 'her', ' m', 'er ', ' p', 'es ', 'by', 'they', 'di',
  'ra', 'ic', 'not', 's, ', 'd t', 'at ', 'ce', 'la', 'h ', 'ne',
  'as ', 'tio', 'on ', 'n t', 'io', 'we', ' a ', 'om', ', a', 's o',
  'ur', 'li', 'll', 'ch', 'had', 'this', 'e t', 'g ', 'e\r\n', ' wh',
  'ere', ' co', 'e o', 'a ', 'us', ' d', 'ss', '\n\r\n', '\r\n\r', '="',
  ' be', ' e', 's a', 'ma', 'one', 't t', 'or ', 'but', 'el', 'so',
  'l ', 'e s', 's,', 'no', 'ter', ' wa', 'iv', 'ho', 'e a', ' r',
  'hat', 's t', 'ns', 'ch ', 'wh', 'tr', 'ut', '/', 'have', 'ly ',
  'ta', ' ha', ' on', 'tha', '-', ' l', 'ati', 'en ', 'pe', ' re',
  'there', 'ass', 'si', ' fo', 'wa', 'ec', 'our', 'who', 'its', 'z',
  'fo', 'rs', '>', 'ot', 'un', '<', 'im', 'th ', 'nc', 'ate',
  '><', 'ver', 'ad', ' we', 'ly', 'ee', ' n', 'id', ' cl', 'ac',
  'il', '</', 'rt', ' wi', 'div', 'e, ', ' it', 'whi', ' ma', 'ge',
  'x', 'e c', 'men', '.com',
];

const CODEBOOK_BYTES: readonly Uint8Array[] = SMAZ_CODEBOOK.map((s) => Uint8Array.from(s, (c) => c.charCodeAt(0)));
const MAX_ENTRY_LEN = CODEBOOK_BYTES.reduce((m, e) => Math.max(m, e.length), 0);

/** Text prefix of a SMAZ-compressed message. */
export const SMAZ_PREFIX = 's:';

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function matchesAt(input: Uint8Array, offset: number, entry: Uint8Array): boolean {
  if (offset + entry.length > input.length) return false;
  for (let i = 0; i < entry.length; i++) if (input[offset + i] !== entry[i]) return false;
  return true;
}

/** Compresses bytes (MeshCore Open `Smaz.compressBytes`). */
export function smazCompressBytes(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  const verbatim: number[] = [];
  const flush = (): void => {
    if (verbatim.length === 0) return;
    if (verbatim.length === 1) out.push(VERBATIM_SINGLE, verbatim[0]!);
    else out.push(VERBATIM_RUN, verbatim.length - 1, ...verbatim);
    verbatim.length = 0;
  };
  let i = 0;
  while (i < input.length) {
    const maxLen = Math.min(input.length - i, MAX_ENTRY_LEN);
    let bestLen = 0;
    let bestCode = -1;
    for (let code = 0; code < CODEBOOK_BYTES.length; code++) {
      const entry = CODEBOOK_BYTES[code]!;
      if (entry.length === 0 || entry.length > maxLen || entry.length <= bestLen) continue;
      if (matchesAt(input, i, entry)) {
        bestLen = entry.length;
        bestCode = code;
        if (bestLen === maxLen) break;
      }
    }
    if (bestCode >= 0) {
      flush();
      out.push(bestCode);
      i += bestLen;
      continue;
    }
    verbatim.push(input[i]!);
    i++;
    if (verbatim.length === 256) flush();
  }
  flush();
  return Uint8Array.from(out);
}

/** Decompresses bytes (MeshCore Open `Smaz.decompressBytes`); throws on a malformed stream. */
export function smazDecompressBytes(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < input.length) {
    const code = input[i]!;
    if (code === VERBATIM_SINGLE) {
      if (i + 1 >= input.length) throw new Error('Invalid SMAZ stream: truncated verbatim byte');
      out.push(input[i + 1]!);
      i += 2;
    } else if (code === VERBATIM_RUN) {
      if (i + 1 >= input.length) throw new Error('Invalid SMAZ stream: truncated verbatim length');
      const end = i + 2 + input[i + 1]! + 1;
      if (end > input.length) throw new Error('Invalid SMAZ stream: truncated verbatim run');
      for (let j = i + 2; j < end; j++) out.push(input[j]!);
      i = end;
    } else {
      const entry = CODEBOOK_BYTES[code];
      if (!entry) throw new Error('Invalid SMAZ stream: code out of range');
      out.push(...entry);
      i += 1;
    }
  }
  return Uint8Array.from(out);
}

/** SMAZ-compresses the UTF-8 bytes of `text`. */
export function smazCompress(text: string): Uint8Array {
  return smazCompressBytes(utf8Encode(text));
}

/** Decompresses a SMAZ stream to text; throws on a malformed stream or invalid UTF-8. */
export function smazDecompress(bytes: Uint8Array): string {
  return strictUtf8.decode(smazDecompressBytes(bytes));
}

/**
 * MeshCore Open `Smaz.encodeIfSmaller`: `"s:" + base64(smaz(utf8(text)))` when that is strictly
 * shorter (in UTF-8 bytes) than `text`; otherwise `text` unchanged. Empty text and text that
 * already starts with "s:" are never encoded.
 */
export function smazEncodeIfSmaller(text: string): string {
  if (text === '' || text.startsWith(SMAZ_PREFIX)) return text;
  const original = utf8Encode(text);
  const candidate = SMAZ_PREFIX + base64Encode(smazCompressBytes(original));
  return candidate.length < original.length ? candidate : text; // the candidate is ASCII
}

/**
 * MeshCore Open `Smaz.tryDecodePrefixed`: the decoded text if `text` is a compressed payload,
 * else null. Leading whitespace is ignored. Plain text can start with "s:" too ("s:test"), so a
 * payload only counts when it satisfies the encoder's invariants: the base64 (standard or
 * URL-safe, padding optional) decodes to a non-empty, well-formed SMAZ stream of valid UTF-8,
 * re-compressing the result gives the same bytes, and the envelope is shorter than the decoded
 * bytes. Very short ambiguous inputs can still match (as in MeshCore Open).
 */
export function smazTryDecode(text: string): string | null {
  const t = text.trimStart();
  if (!t.startsWith(SMAZ_PREFIX) || t.length <= SMAZ_PREFIX.length) return null;
  const compressed = base64Decode(t.slice(SMAZ_PREFIX.length));
  if (!compressed || compressed.length === 0) return null;
  try {
    const raw = smazDecompressBytes(compressed);
    const decoded = strictUtf8.decode(raw);
    if (!bytesEqual(smazCompressBytes(raw), compressed)) return null;
    if (SMAZ_PREFIX.length + base64Encode(compressed).length >= raw.length) return null;
    return decoded;
  } catch {
    return null;
  }
}
