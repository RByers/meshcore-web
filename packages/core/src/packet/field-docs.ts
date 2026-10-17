/**
 * Field descriptions for the packet inspector's tooltips: what each annotated field means, with
 * the relevant rules from docs/mesh-packet-format.md (section numbers cited as "§n").
 *
 * Descriptions are attached to an annotation tree after it is built ({@link describePacketTree}),
 * by looking up each node's name path in a table. Keys are `<scope>:<path>`, where scope is `env`
 * (the packet envelope), a payload type name (`TXT_MSG`, …) or `*` (any), and path is the node's
 * name with its ancestors' names inside that scope, joined by `/` (`[n]` indices become `[]`).
 * The longest matching path wins; scoped keys beat `*` keys of the same length.
 */

import type { AnnotationNode } from './annotate.js';
import { PayloadType, payloadTypeName, RouteType } from './constants.js';

export type FieldDoc = string | ((node: AnnotationNode) => string | undefined);
export type FieldDocTable = Readonly<Record<string, FieldDoc>>;

function normName(name: string): string {
  return name.replace(/\s*\(truncated\)$/, '').replace(/\[\d+\]/g, '[]');
}

function lookup(table: FieldDocTable, scope: string, chain: readonly string[], node: AnnotationNode): string | undefined {
  for (let i = 0; i < chain.length; i++) {
    const key = chain.slice(i).join('/');
    for (const doc of [table[`${scope}:${key}`], table[`*:${key}`]]) {
      const d = typeof doc === 'function' ? doc(node) : doc;
      if (d) return d;
    }
  }
  return undefined;
}

/**
 * Sets `description` on `nodes` and their descendants that do not have one yet. `chain` is the
 * name path of the parent within `scope`.
 */
export function describeNodes(nodes: readonly AnnotationNode[], scope: string, table: FieldDocTable, chain: readonly string[] = []): void {
  for (const n of nodes) {
    const c = [...chain, normName(n.name)];
    if (n.description === undefined) {
      const d = lookup(table, scope, c, n);
      if (d) n.description = d;
    }
    if (n.children) describeNodes(n.children, scope, table, c);
  }
}

// ---------------------------------------------------------------------------
// Payload types §1.1, §3
// ---------------------------------------------------------------------------

const PAYLOAD_PURPOSE: Record<number, string> = {
  [PayloadType.REQ]:
    'REQ (0): an encrypted request to a peer, e.g. GET_STATUS, KEEP_ALIVE, GET_TELEMETRY_DATA, GET_ACCESS_LIST, GET_NEIGHBOURS. The plaintext timestamp doubles as the request tag that the RESPONSE echoes. §3.1',
  [PayloadType.RESPONSE]:
    'RESPONSE (1): an encrypted reply to a REQ or ANON_REQ: [tag u32][body]. The tag is the request timestamp, or the server clock for a login reply. §3.2',
  [PayloadType.TXT_MSG]:
    'TXT_MSG (2): an encrypted direct text message between two nodes. Plain messages are ACKed with SHA256(plaintext ‖ sender pubkey)[0..4]; CLI types are not ACKed. §3.3',
  [PayloadType.ACK]:
    'ACK (3): acknowledges a text message (or keep-alive) with a 4-byte ack code. Unencrypted and unaddressed: receivers match the code against their expected-ACK table. §3.4',
  [PayloadType.ADVERT]:
    "ADVERT (4): a node announcing itself: public key, timestamp, Ed25519 signature and app_data (type, location, name). Unencrypted. Adverts with a timestamp not newer than the stored one are ignored as replays. §3.5",
  [PayloadType.GRP_TXT]:
    'GRP_TXT (5): a channel (group) text message, encrypted with the channel PSK. Plaintext text is "<sender>: <message>"; the sender name is not authenticated. §3.6',
  [PayloadType.GRP_DATA]:
    'GRP_DATA (6): channel binary datagram, encrypted with the channel PSK: [data_type u16][data_len u8][data]. §3.7',
  [PayloadType.ANON_REQ]:
    "ANON_REQ (7): a request from a node the recipient may not know: carries the sender's full public key in clear so the recipient can derive the ECDH secret. Used for logins to repeaters / room servers / sensors. §3.8",
  [PayloadType.PATH]:
    'PATH (8): returns the flood route a packet took back to its sender (who stores it as its out_path), optionally carrying an ACK or RESPONSE as "extra". Encrypted. §3.9',
  [PayloadType.TRACE]:
    'TRACE (9): an unencrypted, always-direct probe that visits a list of hop hashes; each hop appends its receive SNR to the path field. §3.10',
  [PayloadType.MULTIPART]:
    'MULTIPART (10): one part of a multi-part sequence; only ACKs are implemented (extra ACK copies sent ahead of the real ACK when multi_acks > 0). §3.11',
  [PayloadType.CONTROL]:
    'CONTROL (11): unencrypted control data, e.g. node discovery (DISCOVER_REQ / DISCOVER_RESP). Delivered to the companion app only when zero-hop direct and flags & 0x80. §3.12',
  [PayloadType.RAW_CUSTOM]:
    'RAW_CUSTOM (15): opaque application bytes. Delivered to the companion app only when direct; never flooded. §3.13',
};

/** Description of a payload type (§1.1 / §3), or undefined for reserved types. */
export function payloadTypeDescription(type: number): string | undefined {
  return PAYLOAD_PURPOSE[type];
}

const ROUTE_PURPOSE: Record<number, string> = {
  [RouteType.TRANSPORT_FLOOD]: 'TRANSPORT_FLOOD (0): flooded and scoped to a region with transport codes.',
  [RouteType.FLOOD]: 'FLOOD (1): every repeater retransmits it once, appending its own hash to the path.',
  [RouteType.DIRECT]: 'DIRECT (2): follows the path; each hop removes itself from the front. Path length 0 = zero-hop.',
  [RouteType.TRANSPORT_DIRECT]: 'TRANSPORT_DIRECT (3): direct-routed with transport codes.',
};

/** Number in a node's value ("12", "0x0c"), or NaN. */
function num(n: AnnotationNode): number {
  return Number(n.value);
}

const SNR_X4 = 'Signal-to-noise ratio as a signed byte ×4: divide by 4 for dB.';
const HASH_ENTRY = 'A path hash: the first hash_size bytes (1-3) of a node\'s public key. §1.3';
const TIMESTAMP_SENDER = "Sender's clock, u32 unix seconds.";
const PUBKEY = 'Ed25519 public key (32 bytes). Its first bytes are the node\'s path hash.';

const ENCRYPTED_MAC =
  'First 2 bytes of HMAC-SHA256(key = the 32-byte secret, msg = ciphertext). The receiver tries each candidate secret and accepts the one whose MAC matches. §2';
const ENCRYPTED_CT =
  'AES-128-ECB with key = secret[0..16], no IV; the plaintext is zero-padded to a multiple of 16 bytes, and the firmware rejects ciphertext that is not block-aligned. Decrypted plaintext byte i sits at ciphertext offset + i. §2';

const TXT_FLAGS =
  'bits 2-7 txt_type (0 PLAIN, 1 CLI_DATA, 2 SIGNED_PLAIN, 3 CLI_COMMAND), bits 0-1 = attempt & 3. §3.3';
const TXT_TYPE =
  'Text type: 0 PLAIN (ACKed), 1 CLI_DATA (not ACKed), 2 SIGNED_PLAIN (room-server post with a 4-byte author prefix), 3 CLI_COMMAND (remote CLI, not ACKed). §3.3';
const ATTEMPT =
  'Low 2 bits of the send attempt (retry counter). It is part of the ACK hash, so each retry has a different ACK code. When attempt > 3, the full value follows the text NUL. §3.3';

const ACK_CODE =
  "SHA256(timestamp ‖ flags ‖ text ‖ sender pubkey)[0..4] for plain text (receiver's pubkey for signed posts). Not a CRC. The companion reports the same 4 bytes in SENT and SEND_CONFIRMED. §3.4";

const PATH_LEN_HASH_SIZE = 'Bits 6-7 of path_len: hash size − 1 (0 → 1-byte, 1 → 2-byte, 2 → 3-byte entries; 3 is invalid). The flood originator chooses it. §1.3';
const PATH_LEN_HOPS = 'Bits 0-5 of path_len: number of path entries (0-63). Path bytes = hops × hash size and must be ≤ 64. §1.3';

export const PACKET_FIELD_DOCS: FieldDocTable = {
  // ---- envelope §1 ----
  'env:header':
    'Header byte: route type (bits 0-1), payload type (bits 2-5) and payload version (bits 6-7). §1.1',
  'env:header/route type': (n) =>
    `How the packet travels: 0 TRANSPORT_FLOOD, 1 FLOOD, 2 DIRECT, 3 TRANSPORT_DIRECT. ${ROUTE_PURPOSE[num(n)] ?? ''} §1.1`,
  'env:header/payload type': (n) =>
    `What the payload is (0-11, 15; 12-14 reserved). ${PAYLOAD_PURPOSE[num(n)] ?? 'Reserved type: the firmware has no handler for it.'}`,
  'env:header/payload version':
    'Payload format version. 0 = v1 (1-byte src/dest hashes, 2-byte MAC); 1-3 are reserved and the firmware drops such packets. §1.1',
  'env:transport codes':
    'Two u16 region ("scope") codes, present only for TRANSPORT_FLOOD and TRANSPORT_DIRECT. Repeaters configured for a region forward only packets whose code matches. §1.2',
  'env:transport codes/transport_code[]': (n) =>
    n.name === 'transport_code[0]'
      ? 'First 2 bytes (u16 LE) of HMAC-SHA256(key = 16-byte region key, msg = payload type ‖ payload); 0 maps to 1 and 0xFFFF to 0xFFFE. Hashtag regions use key SHA256("#name")[0..16]. Cannot be verified without the region key. §1.2'
      : 'Reserved for the "home region"; currently always 0. {0,0} on a zero-hop TRANSPORT_DIRECT advert marks a "Share contact" re-broadcast. §1.2',
  'env:path_len':
    'Encoded path length: bits 6-7 = hash size − 1, bits 0-5 = number of path entries. 0x00 = no path (zero-hop or a fresh flood). For TRACE it counts SNR bytes instead. §1.3',
  'env:path_len/hash size': PATH_LEN_HASH_SIZE,
  'env:path_len/hop count': PATH_LEN_HOPS,
  'env:path_len/SNR count': 'TRACE only: number of SNR bytes in the path field (one per hop so far); hash-size bits are 0. §3.10',
  'env:path':
    'FLOOD: the route taken so far, oldest first (each repeater appends its hash before retransmitting). DIRECT: the route still to travel; the next hop is path[0] and each forwarder removes itself. §1.3',
  'env:path/hop[]': HASH_ENTRY,
  'env:path (SNRs)': 'TRACE only: the path field holds one SNR byte per hop instead of hashes. Each hop appends the SNR at which it received the trace. §3.10',
  'env:path (SNRs)/snr[]': `${SNR_X4} The receive SNR at this hop of the trace. §3.10`,

  // ---- generic ----
  '*:unparsed': 'Bytes not covered by the documented layout.',
  '*:padding': 'Zero padding up to the AES block size (16 bytes). Decrypted plaintext keeps it; it is not part of the message. §2',
  '*:MAC': ENCRYPTED_MAC,
  '*:ciphertext': ENCRYPTED_CT,
  '*:dest_hash': "Destination hash: the first byte of the recipient's public key. Several nodes can share it, so the recipient also needs the MAC to verify. §3.0",
  '*:src_hash': "Source hash: the first byte of the sender's public key. The recipient tries each contact with this first byte to find the shared secret. §3.0",
  '*:NUL': 'Terminating NUL after the text.',
  '*:random': 'Random byte(s) that make the packet hash unique, so otherwise-identical packets are not dropped as duplicates.',
  '*:hop[]': HASH_ENTRY,

  // ---- REQ / RESPONSE / TXT_MSG / PATH plaintext ----
  'TXT_MSG:ciphertext/timestamp': `${TIMESTAMP_SENDER} Part of the ACK hash. §3.3`,
  'TXT_MSG:ciphertext/flags': `Text flags: ${TXT_FLAGS}`,
  'TXT_MSG:ciphertext/flags/txt_type': TXT_TYPE,
  'TXT_MSG:ciphertext/flags/attempt': ATTEMPT,
  'TXT_MSG:ciphertext/author prefix': 'SIGNED_PLAIN only: first 4 bytes of the original author\'s public key (a room server relaying a post). §3.3',
  'TXT_MSG:ciphertext/text': 'UTF-8 message text, max 160 bytes, ended by NUL or zero padding. §3.3',
  'TXT_MSG:ciphertext/extended attempt': 'Full attempt counter, present only when attempt > 3 (after a 0x00 byte). §3.3',

  'REQ:ciphertext/timestamp (tag)': `${TIMESTAMP_SENDER} Also the request tag: the RESPONSE echoes it so the requester can match the reply. §3.1`,
  'REQ:ciphertext/req_type':
    'Request type: 1 GET_STATUS, 2 KEEP_ALIVE, 3 GET_TELEMETRY_DATA, 4 GET_AVG_MIN_MAX, 5 GET_ACCESS_LIST, 6 GET_NEIGHBOURS, 7 GET_OWNER_INFO, 8 SUBSCRIBE, 9 UNSUBSCRIBE. §3.1',
  'REQ:ciphertext/request data':
    'Request parameters; layout depends on req_type (e.g. GET_TELEMETRY_DATA: inverse permission mask + reserved + random; GET_NEIGHBOURS: version, count, offset, order, prefix length, random). §3.1',

  'RESPONSE:ciphertext/tag':
    "The request's timestamp echoed back (or, for a login reply, the server's current time). §3.2",
  'RESPONSE:ciphertext/response body':
    'Body whose layout depends on the request: login OK (13 bytes), RepeaterStats (56 B) / ServerStats (52 B), CayenneLPP telemetry, access list, neighbours, owner info… §3.2',

  'PATH:ciphertext/path_len':
    'Encoded length of the returned route: the flood path the original packet accumulated, from its sender to this node. The recipient stores it as its out_path for future direct sends. §3.9',
  'PATH:ciphertext/path_len/hash size': PATH_LEN_HASH_SIZE,
  'PATH:ciphertext/path_len/hop count': PATH_LEN_HOPS,
  'PATH:ciphertext/path': 'The returned route, one hash per hop; becomes the recipient\'s out_path. §3.9',
  'PATH:ciphertext/extra_type':
    'Type of the bundled extra: low 4 bits are a payload type (3 ACK, 1 RESPONSE); 0xFF = none (4 random bytes follow). Replies to flood messages ride here instead of in a separate packet. §3.9, §5',
  'PATH:ciphertext/ack code': `Bundled ACK. ${ACK_CODE}`,
  'PATH:ciphertext/extended attempt': 'Optional 6-byte ACK form: the extended attempt byte from the original plaintext. §3.4',
  'PATH:ciphertext/response tag': 'Tag of the bundled RESPONSE (the request timestamp). §3.2',
  'PATH:ciphertext/response body': 'Bundled RESPONSE body; layout depends on the request. §3.2',
  'PATH:ciphertext/extra': 'Bundled extra payload of the type in extra_type. §3.9',

  // ---- ACK §3.4 ----
  'ACK:ack code': ACK_CODE,
  'ACK:extended attempt':
    '6-byte ACK form (v1.18 companions): the byte following the text NUL in the original plaintext (the extended attempt byte, usually 0). Receivers compare only the first 4 bytes. §3.4',
  'MULTIPART:ack code': ACK_CODE,
  'MULTIPART:extended attempt': 'Optional 6-byte ACK form: the extended attempt byte. §3.4',

  // ---- ADVERT §3.5 ----
  'ADVERT:public key': `${PUBKEY} Identifies the advertising node. §3.5`,
  'ADVERT:timestamp':
    "Advertiser's clock, u32 unix seconds. Must increase: an advert not newer than the last one stored for this key is treated as a replay and ignored. §3.5",
  'ADVERT:signature': 'Ed25519 signature over public key ‖ timestamp ‖ app_data (first 32 bytes). Proves the advert came from the key owner. §3.5',
  'ADVERT:app_data': 'Up to 32 bytes: flags, then optional lat/lon, feat1, feat2 and name as the flags declare. §3.5',
  'ADVERT:app_data/flags':
    'bits 0-3 node type; 0x10 has lat/lon; 0x20 has feat1; 0x40 has feat2; 0x80 has name. §3.5',
  'ADVERT:app_data/flags/node type': 'Node type: 0 none, 1 chat (companion), 2 repeater, 3 room server, 4 sensor, 5-15 future. §3.5',
  'ADVERT:app_data/flags/has lat/lon': 'Flag 0x10: latitude and longitude follow. §3.5',
  'ADVERT:app_data/flags/has feat1': 'Flag 0x20: feat1 (u16, reserved) follows. §3.5',
  'ADVERT:app_data/flags/has feat2': 'Flag 0x40: feat2 (u16, reserved) follows. §3.5',
  'ADVERT:app_data/flags/has name': 'Flag 0x80: the node name follows. Companions ignore adverts without a name. §3.5',
  'ADVERT:app_data/latitude': 'Latitude, i32 degrees × 1e6. §3.5',
  'ADVERT:app_data/longitude': 'Longitude, i32 degrees × 1e6. §3.5',
  'ADVERT:app_data/feat1': 'Reserved feature word (u16). §3.5',
  'ADVERT:app_data/feat2': 'Reserved feature word (u16). §3.5',
  'ADVERT:app_data/name': 'Node name, UTF-8 to the end of app_data, no NUL; cut at a UTF-8 boundary to fit 32 bytes. §3.5',
  'ADVERT:ignored': 'Bytes past the 32-byte app_data limit: not signed and not parsed. §3.5',

  // ---- GRP_TXT / GRP_DATA §3.6-3.7 ----
  '*:channel_hash':
    'First byte of SHA256(channel PSK). Receivers try each channel whose hash matches; collisions are resolved by the MAC. §2, §3.6',
  'GRP_TXT:ciphertext/timestamp': `${TIMESTAMP_SENDER} §3.6`,
  'GRP_TXT:ciphertext/flags': 'txt_type << 2 | attempt. Receivers drop the message unless txt_type is 0 (PLAIN). §3.6',
  'GRP_TXT:ciphertext/flags/txt_type': 'Must be 0 (PLAIN) for channel messages; anything else is dropped. §3.6',
  'GRP_TXT:ciphertext/flags/attempt': 'Low 2 bits of the send attempt. §3.6',
  'GRP_TXT:ciphertext/text':
    'UTF-8 "<sender name>: <message>". The sender name is just text and is not authenticated: anyone with the PSK can claim any name. §3.6',
  'GRP_DATA:ciphertext/data_type': 'Datagram type (u16): 0 reserved/invalid, 0xFF00-0xFFFE testing, 0xFFFF dev; others from the number registry. §3.7',
  'GRP_DATA:ciphertext/data_len': 'Length of data (max 165). §3.7',
  'GRP_DATA:ciphertext/data': 'Application datagram bytes. §3.7',

  // ---- ANON_REQ §3.8 ----
  'ANON_REQ:sender public key':
    "The requester's full Ed25519 public key in clear, so the recipient can compute the ECDH shared secret without knowing it as a contact. §3.8",
  'ANON_REQ:ciphertext/timestamp': `${TIMESTAMP_SENDER} Also the request tag. §3.8`,
  'ANON_REQ:ciphertext/request data':
    'Repeater/sensor login: password (≤15 bytes). Room login: sync_since u32 + password. 0x01 regions / 0x02 owner / 0x03 clock: type + reply path. The repeater picks by plaintext[4]: 0x00 or ≥ 0x20 means login. §3.8',

  // ---- TRACE §3.10 ----
  'TRACE:tag': 'Random u32 chosen by the sender to match the TRACE_DATA result. §3.10',
  'TRACE:auth code': 'u32 authentication code checked by hops. §3.10',
  'TRACE:flags': 'bits 0-1 = path_sz: hop hashes are 1 << path_sz bytes (v1.11+). §3.10',
  'TRACE:flags/path_sz': 'Hash entry size = 1 << path_sz bytes (1, 2, 4 or 8). §3.10',
  'TRACE:hop hashes':
    'The nodes to visit, in order. The hop whose hash is at index path_len (number of SNRs so far) forwards next; when all are visited the trace is complete. §3.10',
  'TRACE:hop hashes/hash[]': 'Hash of a node to visit (first bytes of its public key). §3.10',

  // ---- MULTIPART §3.11 ----
  'MULTIPART:multipart header': '(remaining << 4) | inner type. §3.11',
  'MULTIPART:multipart header/remaining': 'How many more parts follow; counts down to 0. §3.11',
  'MULTIPART:multipart header/inner type': 'Payload type of the part; only ACK (3) is implemented. §3.11',
  'MULTIPART:inner payload': 'The inner payload. §3.11',

  // ---- CONTROL §3.12 ----
  'CONTROL:flags': 'Upper nibble = sub_type (0x80 DISCOVER_REQ, 0x90 DISCOVER_RESP); lower bits depend on it. §3.12',
  'CONTROL:flags/sub_type': '0x80 DISCOVER_REQ: ask nearby nodes to identify themselves; 0x90 DISCOVER_RESP: the answer. §3.12',
  'CONTROL:flags/prefix_only': 'DISCOVER_REQ bit 0: respondents send an 8-byte key prefix instead of the full 32-byte key. §3.12',
  'CONTROL:flags/node type': 'DISCOVER_RESP: responder node type (1 chat, 2 repeater, 3 room, 4 sensor). §3.12',
  'CONTROL:type filter': 'Bitmask of node types that should answer: bit (1 << ADV_TYPE). §3.12',
  'CONTROL:tag': 'Random u32 echoed by DISCOVER_RESP so the requester can match answers. §3.12',
  'CONTROL:since': 'Optional: only nodes changed since this time should answer (u32 unix seconds). §3.12',
  'CONTROL:snr': `${SNR_X4} The SNR at which the responder heard the request. §3.12`,
  'CONTROL:public key': 'Responder public key: 8-byte prefix if prefix_only was set, else all 32 bytes. §3.12',
  'CONTROL:data': 'Body of an unknown control sub-type. §3.12',

  // ---- RAW_CUSTOM §3.13 ----
  'RAW_CUSTOM:data': 'Opaque application bytes. §3.13',
};

/** Root/payload node descriptions plus the table lookup, for a packet or bare-payload annotation. */
export function describePacketTree(root: AnnotationNode, payloadType: number | undefined, bare: boolean): void {
  const scope = payloadType === undefined ? '*' : payloadTypeName(payloadType);
  const purpose = payloadType === undefined ? undefined : PAYLOAD_PURPOSE[payloadType];
  const describePayload = (p: AnnotationNode): void => {
    p.description ??=
      (purpose ? `${purpose}\n\n` : '') +
      'Payload: everything after the path (1-184 bytes). Its packet hash, SHA256(payload type ‖ payload)[0..8], is the de-duplication id. §1.4';
    describeNodes(p.children ?? [], scope, PACKET_FIELD_DOCS);
  };
  if (bare) {
    describePayload(root);
    return;
  }
  root.description ??=
    'A raw over-the-air packet: [header][transport codes?][path_len][path][payload], at most 255 bytes. §1' + (purpose ? `\n\n${purpose}` : '');
  for (const c of root.children ?? []) {
    if (c.name === 'payload') describePayload(c);
    else describeNodes([c], 'env', PACKET_FIELD_DOCS);
  }
}
