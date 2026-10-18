# MeshCore over-the-air packet format — decoder reference

Ground truth: MeshCore firmware v1.18.0 (commit `81dbae5`). The input is the raw bytes from `PUSH_CODE_LOG_RX_DATA` (0x88) `[3..]`, from `RESP_CODE_EXPORT_CONTACT` `[1..]`, or for `CMD_SEND_RAW_PACKET` `[2..]`.
All integers are **little-endian** unless stated otherwise. Citations: `Packet.h/.cpp`, `Mesh.cpp`, `Dispatcher.cpp` = `src/`; `BCM` = `src/helpers/BaseChatMesh.cpp`; `RPT` = `examples/simple_repeater/MyMesh.cpp`; `ROOM` = `examples/simple_room_server/MyMesh.cpp`; `SENS` = `examples/simple_sensor/SensorMesh.cpp`; `CMM` = `examples/companion_radio/MyMesh.cpp`.

Limits (`src/MeshCore.h`): `MAX_TRANS_UNIT 255` (whole packet), `MAX_PATH_SIZE 64` (path bytes), `MAX_PACKET_PAYLOAD 184`, `PUB_KEY_SIZE 32`, `SIGNATURE_SIZE 64`, `CIPHER_MAC_SIZE 2`, `CIPHER_BLOCK_SIZE 16`, `PATH_HASH_SIZE 1` (src/dest/channel hashes in payloads are **always 1 byte**), `MAX_ADVERT_DATA_SIZE 32`.

---

## 1. Envelope — `Dispatcher::tryParsePacket`, `Packet::writeTo`

```
[header u8][transport_codes 2×u16, only if route type 0 or 3][path_len u8][path: hops×hash_size bytes][payload: rest]
```

| Off | Size | Field |
|---|---|---|
| 0 | 1 | header |
| 1 | 4 | transport_code[0] u16, transport_code[1] u16 — **only** when route type is TRANSPORT_FLOOD (0) or TRANSPORT_DIRECT (3) |
| 1 or 5 | 1 | path_len (encoded, §1.3) |
| next | hops×hash_size | path |
| next | rest | payload (1..184 bytes; the firmware requires at least 1 byte after the path) |

Firmware rejects a packet (it still appears in LOG_RX_DATA, which is emitted **before** parsing) when: payload version > 0, path_len bits 6-7 == 3, path bytes > 64 or past the end, payload > 184.

### 1.1 Header byte (`Packet.h` L8-37)

| Bits | Mask | Field | Values |
|---|---|---|---|
| 0-1 | 0x03 | route type | 0 TRANSPORT_FLOOD, 1 FLOOD, 2 DIRECT, 3 TRANSPORT_DIRECT |
| 2-5 | 0x3C | payload type | 0 REQ, 1 RESPONSE, 2 TXT_MSG, 3 ACK, 4 ADVERT, 5 GRP_TXT, 6 GRP_DATA, 7 ANON_REQ, 8 PATH, 9 TRACE, 10 MULTIPART, 11 CONTROL, 12-14 reserved, 15 RAW_CUSTOM |
| 6-7 | 0xC0 | payload version | 0 = v1 (1-byte hashes, 2-byte MAC). 1-3 are reserved and dropped by the firmware. |

`header == 0xFF` is an internal "do not retransmit" marker and never appears on air (`Packet.h` L89).

### 1.2 Transport codes (region "scope") — `TransportKeyStore.cpp` `calcTransportCode`

- `code[0] = first 2 bytes (read as u16 LE) of HMAC-SHA256(key = 16-byte region key, msg = payload_type(1 byte) ‖ payload)`. 0x0000 is mapped to 0x0001 and 0xFFFF to 0xFFFE.
- Region key for public hashtag regions = `SHA256("#name")[0..16]` (`getAutoKeyFor`; meshcore.js `TransportKeyUtil` returns all 32 bytes, of which the firmware uses the first 16).
- `code[1]` = 0 currently ("REVISIT: home region", `CMM sendFloodScoped` L497).
- `{0,0}` with TRANSPORT_DIRECT, zero-hop = a "Share contact" re-broadcast that must not be treated as heard-direct (`RPT isShare`).
- The code cannot be inverted: a decoder identifies the region by computing `code[0]` with each region key it knows (this app: the saved region names' hashtag keys plus the radio's default-scope key) and naming the one that matches. 16 bits collide, so a code that several known keys give is ambiguous, and one that none gives is an unknown region; show the raw u16s alongside (`packet/regions.ts` `matchRegionCode`). Only TRANSPORT_FLOOD codes are region scopes.

### 1.3 path_len encoding (`Packet.h` L79-83, `Packet.cpp isValidPathLen`)

| Bits | Meaning |
|---|---|
| 0-5 | hop count (number of path entries, 0..63) |
| 6-7 | hash_size − 1 (0 → 1 byte, 1 → 2 bytes, 2 → 3 bytes, 3 → invalid/reserved) |

Path byte length = `(path_len & 63) × ((path_len >> 6) + 1)` and must be ≤ 64. Examples: `0x00` = zero-hop; `0x05` = 5×1 B; `0x45` = 5×2 B; `0x8A` = 10×3 B. Each entry is the **first hash_size bytes of a node's public key**. The flood originator chooses the size (`CMD_SET_PATH_HASH_MODE`: mode+1). Firmware before v1.12 understood only 1-byte entries (docs/packet_format.md).

Semantics:
- **FLOOD**: the path starts empty (count 0). Each repeater **appends** its hash before retransmitting (`Mesh::routeRecvPacket`). The path is the route taken so far, oldest first.
- **DIRECT**: the path is the route still to travel. The next hop is `path[0]`, and each forwarder **removes itself from the front** (`Mesh::removeSelfFromPath`). Zero-hop = DIRECT with path_len 0.
- **TRACE** is different (§3.10): its path field holds SNR bytes.
- Contacts store `out_path_len = 0xFF` to mean "unknown / use flood". 0xFF never appears on air as a path_len (hash size 4 is invalid).

### 1.4 Packet hash (de-duplication id) — `Packet::calculatePacketHash`

`SHA256( payload_type (1 byte) ‖ [TRACE only: path_len as **2-byte u16 LE**] ‖ payload )`, truncated to 8 bytes. The header route bits, transport codes and path are excluded, so the same message heard via different repeaters has the same hash. Use it to group LOG_RX_DATA captures.

### 1.5 Max sizes / priorities

Total ≤ 255. A flood with 64 path bytes leaves room for up to 184 payload bytes. When sending, the firmware sets the version bits to 0.

---

## 2. Cryptography (needed to decrypt payloads)

| Item | Definition | Source |
|---|---|---|
| Identity | Ed25519 key pair (orlp/ed25519; the private key is the 64-byte expanded form `SHA512(seed)` with clamping) | `lib/ed25519/keypair.c` |
| Peer shared secret (32 B) | X25519: Ed25519 pubkey converted to Montgomery u, scalar = clamped `prv[0..32]` (`ed25519_key_exchange`). Equivalent to `x25519(edPrivScalar, edwardsToMontgomery(peerPub))`. Symmetric. | `Identity.cpp calcSharedSecret` |
| Channel secret | 16-byte PSK zero-padded to 32 bytes (or a 32-byte PSK, not settable via the companion) | `BCM addChannel/setChannel` |
| Channel hash | `SHA256(psk[0..16])[0]` for 128-bit (`SHA256(psk32)[0]` for 256-bit) | `BCM setChannel` L933-946 |
| Cipher | **AES-128-ECB**, key = `secret[0..16]`. Plaintext zero-padded to a multiple of 16. No IV. | `Utils::encrypt` |
| MAC | `HMAC-SHA256(key = secret[0..32] (all 32 bytes), msg = ciphertext)[0..2]` | `Utils::encryptThenMAC` |
| Wire layout | `MAC(2) ‖ ciphertext(16·k)`. The receiver rejects a ciphertext that is not block-aligned. | `Utils::MACThenDecrypt` |

Decrypted plaintext keeps its **zero padding**. Text fields are NUL-terminated or padding-terminated. Never trust a length implied by the ciphertext size.

Public channel PSK: `8b3387e9c5cdea6ac9e5edbaa115cd72` (base64 `izOH6cXN6mrJ5e26oRXNcg==`). Hashtag channel `#foo`: PSK = `SHA256("#foo")[0..16]` (docs/companion_protocol.md).

---

## 3. Payload layouts

### 3.0 Common encrypted peer envelope — REQ(0), RESPONSE(1), TXT_MSG(2), PATH(8) — `Mesh.cpp` L130-196, `Mesh::createDatagram`

| Off | Size | Field (visible without keys) |
|---|---|---|
| 0 | 1 | dest_hash = `dest_pubkey[0]` |
| 1 | 1 | src_hash = `src_pubkey[0]` |
| 2 | 2 | MAC |
| 4 | 16·k | ciphertext |

To decrypt: try every known contact whose pubkey[0] == src_hash (when the local node is the destination) and check the MAC.

Size guards when building (`Mesh::create*Datagram`): reject when `data_len + overhead + 15 > 184`, with overhead 2 for REQ/RESPONSE/TXT_MSG (the MAC; the 2 hash bytes are not counted), 33 for ANON_REQ (hash + pubkey; the MAC is not counted) and 1 for GRP_TXT/GRP_DATA. `createPathReturn` instead requires `path bytes + extra_len + 5 ≤ 166`.

### 3.1 REQ (0x00) plaintext

| Off | Size | Field |
|---|---|---|
| 0 | 4 | timestamp u32 (sender clock). Also the request **tag**; the response echoes it. |
| 4 | 1 | req_type |
| 5 | … | request data |

req_type values (servers: `RPT` L46-51, `SENS` L53-62; companion `CMM.h` L74-76):

| Value | Name | Request data after req_type | Handled by |
|---|---|---|---|
| 0x01 | GET_STATUS | companion sends `[4 zero][4 random]` (`BCM sendRequest(type)` L690) | repeater, room, sensor |
| 0x02 | KEEP_ALIVE | `[sync_since u32]` (`BCM checkConnections`). ACK = `SHA256(9 plaintext bytes ‖ sender pubkey)[0..4]`. | room server |
| 0x03 | GET_TELEMETRY_DATA | `[inverse permission mask u8][3 reserved][4 random]`. mask byte 0 = all, `~0x01` = base only. Bits: 0x01 base, 0x02 location, 0x04 environment. | all incl. companion (`CMM onContactRequest`) |
| 0x04 | GET_AVG_MIN_MAX | `[start u32 secs ago][end u32 secs ago][2 reserved]` (docs/payloads.md) | sensor |
| 0x05 | GET_ACCESS_LIST | `[res1=0][res2=0]` | repeater/room/sensor (admin) |
| 0x06 | GET_NEIGHBOURS | `[ver=0][count u8][offset u16][order_by u8 (0 newest,1 oldest,2 strongest,3 weakest)][pubkey_prefix_len u8][4 random]` | repeater |
| 0x07 | GET_OWNER_INFO | — | repeater (FIRMWARE_VER_LEVEL ≥ 2) |
| 0x08 | SUBSCRIBE | `[push tag u32][timeout_secs u16][reserved u8][min_deltas_len u8][LPP min deltas]` (docs/payloads.md) | sensor |
| 0x09 | UNSUBSCRIBE | — | sensor |

### 3.2 RESPONSE (0x01) plaintext

`[tag u32][body…]`. tag = the request's timestamp, except for login responses where it is the server's current time. Bodies:

The companion reports a request's tag in `RESP_SENT[2..5]` (`BCM sendRequest` / `sendAnonReq`: `tag = getCurrentTimeUnique()`, also the plaintext's first 4 bytes), so a host can pair its REQ / non-login ANON_REQ with the RESPONSE (or PATH RESPONSE extra) echoing it. For a login, `RESP_SENT[2..5]` is instead the target's first 4 public-key bytes (`pending_login`) and the reply starts with the server's clock, so a login and its response share no tag.

**Login OK** (reply to ANON_REQ login; `RPT handleLoginReq` L135-144, `ROOM` L385-391), 13 bytes:

| Off | Size | Field |
|---|---|---|
| 0 | 4 | server time u32 |
| 4 | 1 | 0 = RESP_SERVER_LOGIN_OK |
| 5 | 1 | legacy keep-alive (secs/16), now 0 |
| 6 | 1 | is_admin (repeater 1/0; room 1 admin, 2 guest-with-perms-0, 0 other) |
| 7 | 1 | ACL permissions (bits 0-1 role: 0 guest, 1 read-only, 2 read-write, 3 admin) |
| 8 | 4 | random |
| 12 | 1 | FIRMWARE_VER_LEVEL (repeater 2, room 1) |

Legacy servers return `"OK"` at offset 4. Wrong password → **no response at all** (the companion's LOGIN_FAIL push fires only for a non-OK response that arrives).

**STATUS — repeater `RepeaterStats`** (`RPT MyMesh.h` L44-60; natural alignment, no padding), offsets relative to the start of the body (plaintext offset 4):

| Off | Type | Field |
|---|---|---|
| 0 | u16 | batt_milli_volts |
| 2 | u16 | curr_tx_queue_len |
| 4 | i16 | noise_floor dBm |
| 6 | i16 | last_rssi dBm |
| 8 | u32 | n_packets_recv |
| 12 | u32 | n_packets_sent |
| 16 | u32 | total_air_time_secs (TX) |
| 20 | u32 | total_up_time_secs |
| 24 | u32 | n_sent_flood |
| 28 | u32 | n_sent_direct |
| 32 | u32 | n_recv_flood |
| 36 | u32 | n_recv_direct |
| 40 | u16 | err_events (bit flags) |
| 42 | i16 | last_snr ×4 |
| 44 | u16 | n_direct_dups |
| 46 | u16 | n_flood_dups |
| 48 | u32 | total_rx_air_time_secs |
| 52 | u32 | n_recv_errors |

Total 56 bytes. Older repeaters stop at 48 (meshcore.js treats 48-55 as optional). Over the air the RESPONSE plaintext is zero-padded to 16 bytes, so both a repeater body (4 + 56) and a room body (4 + 52) decrypt to 60 bytes after the tag: an over-the-air decoder cannot tell them apart by length and must use the contact type.
**Room server `ServerStats`** (`ROOM` L24-39): identical up to offset 47, then `[48]n_posted u16, [50]n_post_push u16`, total 52. The two can be distinguished only by length or by the contact type.

**Telemetry** (0x03): `[LPP bytes]` (§4).
**Access list** (0x05): repeated `{pubkey prefix 6 bytes, permissions u8}` (`RPT` L262-275).
**Neighbours** (0x06): `[total_count i16][results_count i16]` then results_count × `{pubkey prefix (requested len), heard_secs_ago u32, snr i8 ×4}` (`RPT` L276-371).
**Owner info** (0x07): ASCII `"<fw version>\n<node name>\n<owner info>"` (`RPT` L372-375).
**Sensor AVG_MIN_MAX** (0x04): see §4 (end).

### 3.3 TXT_MSG (0x02) plaintext — `BCM composeMsgPacket` L451, `onPeerDataRecv` L231-310

| Off | Size | Field |
|---|---|---|
| 0 | 4 | sender timestamp u32 |
| 4 | 1 | flags: bits 2-7 = txt_type (0 plain, 1 CLI data, 2 signed plain, 3 CLI command), bits 0-1 = attempt & 3 |
| 5 | 4 | **txt_type 2 only**: author pubkey prefix (4 bytes) |
| 5/9 | n | UTF-8 text, then NUL / zero padding |
| … | 2 | only if the sender's attempt > 3: `0x00, attempt` after the text |

Max text 160 bytes.

### 3.4 ACK (0x03) — `Mesh.cpp` L117-129, `BCM` L243-257

| Off | Size | Field |
|---|---|---|
| 0 | 4 | ack code |
| 4 | 1 | (6-byte form, plain-text ACKs from v1.18 companions) the byte following the text's NUL in the original plaintext = the extended attempt byte, usually 0 |
| 5 | 1 | (6-byte form) random byte, makes the packet hash unique |

Receivers compare only the first 4 bytes. The ACK has no addressing.

**ACK code is NOT a CRC32** (docs/payloads.md wrongly calls it a "CRC checksum"):
- Plain text: `ack = SHA256( plaintext[0 .. 5+text_len) ‖ SENDER_pubkey(32) )[0..4]`, i.e. timestamp(4) ‖ flags byte (`attempt&3`, txt_type 0) ‖ text bytes without the NUL ‖ the **original sender's** public key (`BCM` L462 sender side, L245 receiver side).
- Signed plain (room posts): `SHA256( plaintext[0 .. 9+text_len) ‖ RECEIVER_pubkey )[0..4]` (`BCM` L297-298).
- Keep-alive REQ: `SHA256(9-byte plaintext ‖ requester pubkey)[0..4]`.
- The 4 bytes are copied verbatim into `RESP_CODE_SENT[2..5]` and `PUSH_CODE_SEND_CONFIRMED[1..4]` (also readable as u32 LE).
- CLI_DATA / CLI_COMMAND messages are **not** ACKed.
- When a message arrived via flood, the ACK is usually **embedded in a PATH packet** (extra_type 3) rather than sent as a separate ACK packet.

### 3.5 ADVERT (0x04) — `Mesh::createAdvert` L404-438, `Mesh.cpp` L252-291

| Off | Size | Field |
|---|---|---|
| 0 | 32 | Ed25519 public key |
| 32 | 4 | timestamp u32 (sender clock; must increase, otherwise treated as a replay and ignored) |
| 36 | 64 | Ed25519 signature over `pubkey(32) ‖ timestamp(4) ‖ app_data` (app_data truncated to its first 32 bytes on verify) |
| 100 | ≤32 | app_data |

app_data (`AdvertDataHelpers.cpp`):

| Off | Size | Present if | Field |
|---|---|---|---|
| 0 | 1 | always | flags: bits 0-3 = node type (0 none, 1 chat/companion, 2 repeater, 3 room server, 4 sensor, 5-15 future); 0x10 has lat/lon; 0x20 has feat1; 0x40 has feat2; 0x80 has name |
| +1 | 4 | 0x10 | latitude i32 ×1e6 |
| +4 | 4 | 0x10 | longitude i32 ×1e6 |
| next | 2 | 0x20 | feat1 u16 (reserved) |
| next | 2 | 0x40 | feat2 u16 (reserved) |
| next | rest | 0x80 | name, UTF-8, **no NUL**, cut at a UTF-8 boundary to fit 32 bytes |

Companions and BCM nodes ignore adverts without a name. The parser requires the declared optional fields to fit (`app_data_len >= i`).

### 3.6 GRP_TXT (0x05) — `Mesh.cpp` L225-251, `BCM sendGroupMessage` L518

| Off | Size | Field |
|---|---|---|
| 0 | 1 | channel_hash |
| 1 | 2 | MAC (channel secret) |
| 3 | 16·k | ciphertext |

Plaintext: `[timestamp u32][flags u8 = 0 (txt_type<<2; receivers drop if >>2 ≠ 0)][UTF-8 "<sender name>: <text>"][NUL/padding]`. The sender name is not authenticated.

### 3.7 GRP_DATA (0x06)

Same envelope as GRP_TXT. Plaintext: `[data_type u16][data_len u8][data (data_len bytes)][padding]` (`BCM sendGroupData` L539, `onGroupDataRecv` L431-448). data_type 0 is reserved/invalid (`DATA_TYPE_RESERVED`; companions refuse to send it), 0x0001-0x00FF are reserved for internal use, 0x0100-0xFEFF are custom apps assigned in the registry (docs/number_allocations.md), 0xFF00-0xFFFE are testing and 0xFFFF is dev (`DATA_TYPE_DEV`). Max data 165 bytes.

### 3.8 ANON_REQ (0x07) — `Mesh::createAnonDatagram` L512, `Mesh.cpp` L197-224

| Off | Size | Field |
|---|---|---|
| 0 | 1 | dest_hash |
| 1 | 32 | **sender's full Ed25519 public key** (cleartext) |
| 33 | 2 | MAC |
| 35 | 16·k | ciphertext (secret = ECDH(sender, dest)) |

Plaintext variants (the repeater decides by `plaintext[4]`: 0x00 or ≥ 0x20 means password/login; `RPT onAnonDataRecv` L571-620):

| Variant | Layout |
|---|---|
| Repeater / sensor login | `[timestamp u32][password, ≤15 bytes]` |
| Room server login | `[timestamp u32][sync_since u32][password ≤15]` (`BCM sendLogin` L603-636) |
| Anon regions (0x01) / owner (0x02) / clock+status (0x03) — repeaters (`simple_repeater`) only, and only when the ANON_REQ arrived **direct-routed** (a flooded one is silently dropped; send zero-hop or along a known path) | `[timestamp u32][type][reply_path_len (encoded)][reply_path]` (reply path = the request's hops reversed; `0` = zero-hop) |
| Companion `CMD_SEND_ANON_REQ` | `[tag u32 = timestamp][app data …]` |

Anon replies (RESPONSE body): regions → `[tag][now u32][ASCII "*,name,name"]` (`RegionMap::exportNamesTo`: regions that allow flood, names **without** the leading '#' (private regions keep their '$'), '*' first when the wildcard allows flood, no trailing comma, truncated to fit; the companion's BINARY_RESPONSE data starts at `now`); owner → `[tag][now][ "name\nowner_info"]`; clock → `[tag][now][features u8: 0x01 RS232 bridge, 0x03 ESP-NOW bridge, 0x80 repeat disabled]`.

### 3.9 PATH (0x08) plaintext — `Mesh::createPathReturn` L448-486, `Mesh.cpp` L160-179

| Off | Size | Field |
|---|---|---|
| 0 | 1 | path_len (encoded) — the route **from the original sender to this node** (the flood path the original packet accumulated). The recipient uses it as its out_path. |
| 1 | hops×size | path |
| next | 1 | extra_type (low 4 bits = a PAYLOAD_TYPE; 0xFF = none). The receiver masks with 0x0F, so 0xFF is dispatched as type 15 and ignored. |
| next | rest | extra: ACK (3) → 4 or 6 ACK bytes; RESPONSE (1) → a full response body (§3.2); none → 4 random bytes |

### 3.10 TRACE (0x09) — unencrypted, always DIRECT (`Mesh::createTrace` L605, `sendDirect` L698-704, `Mesh.cpp` L42-68)

Payload:

| Off | Size | Field |
|---|---|---|
| 0 | 4 | tag u32 |
| 4 | 4 | auth_code u32 |
| 8 | 1 | flags: bits 0-1 = path_sz (hash entry size = 1<<path_sz bytes; v1.11+) |
| 9 | rest | list of hop hashes to visit (rest-of-payload bytes) |

Packet path field: **SNR values, not hashes**. Each hop appends `i8 SNR×4` of its reception, and path_len = number of SNRs (hash-size bits 0). The hop at index `path_len` must match `payload[9 + (path_len<<path_sz)]`. When `path_len<<path_sz ≥ hashes_len`, the trace is complete. Packet hash includes path_len (§1.4).

### 3.11 MULTIPART (0x0A) — `Mesh::createMultiAck` L574

`[0] = (remaining << 4) | inner_type`, `[1..]` = inner payload. Only inner type ACK (3) is implemented: `[1..4]` ack code (+2 optional bytes). Sent DIRECT ahead of the normal ACK when `multi_acks > 0`. `remaining` counts down.

### 3.12 CONTROL (0x0B) — unencrypted (`RPT onControlDataRecv` L786-840; docs/payloads.md)

`[0]` flags: upper nibble = sub_type. Only packets with `[0] & 0x80` are delivered to the companion app, and only if zero-hop DIRECT (`Mesh.cpp` L70-76).

| sub_type | Layout |
|---|---|
| 0x80 DISCOVER_REQ | `[0]=0x80 \| prefix_only(bit0), [1]type_filter (bit (1<<ADV_TYPE_x)), [2..5]tag u32, [6..9]since u32 (optional)` |
| 0x90 DISCOVER_RESP | `[0]=0x90 \| node_type, [1]SNR×4 i8 of the request as heard, [2..5]tag, [6..]pubkey (8 bytes if prefix_only, else 32)` |

### 3.13 RAW_CUSTOM (0x0F)

Opaque application bytes. Delivered to the companion app (PUSH 0x84) only when DIRECT. Never flooded.

---

## 4. CayenneLPP (telemetry) — library `electroniccats/CayenneLPP@1.6.1` (not vendored; sizes from meshcore.js `cayenne_lpp.js` plus the library's published spec)

Stream of `[channel u8][type u8][value, big-endian]`. Channel 1 = `TELEM_CHANNEL_SELF` (`SensorManager.h`). Additional sensors use other channels. meshcore.js stops at `channel==0 && type==0` (trailing zeros) and at any unknown type. Unknown types can't be skipped because their size is unknown, so a decoder must know every size.

| Type | Name | Size | Encoding (BE) | Used by firmware |
|---|---|---|---|---|
| 0 | digital in | 1 | u8 | |
| 1 | digital out | 1 | u8 | |
| 2 | analog in | 2 | i16 /100 | yes |
| 3 | analog out | 2 | i16 /100 | |
| 100 | generic sensor | 4 | u32 | yes |
| 101 | luminosity | 2 | u16 lux | yes |
| 102 | presence | 1 | u8 | yes |
| 103 | temperature | 2 | i16 /10 °C | yes (MCU temp, env sensors) |
| 104 | relative humidity | 1 | u8 /2 % | yes |
| 113 | accelerometer | 6 | 3×i16 /1000 G | |
| 115 | barometric pressure | 2 | u16 /10 hPa | yes |
| 116 | voltage | 2 | u16 /100 V (meshcore.js reads it signed) | yes (battery, ch 1) |
| 117 | current | 2 | u16 /1000 A (meshcore.js reads it signed) | yes |
| 118 | frequency | 4 | u32 Hz | yes |
| 120 | percentage | 1 | u8 | yes |
| 121 | altitude | 2 | i16 m | yes |
| 122 | load | 3 | UNVERIFIED (i24 /1000 kg) | |
| 125 | concentration | 2 | u16 ppm | |
| 128 | power | 2 | u16 W | yes |
| 130 | distance | 4 | u32 /1000 m | yes |
| 131 | energy | 4 | u32 /1000 kWh | |
| 132 | direction | 2 | u16 deg | |
| 133 | unix time | 4 | u32 | |
| 134 | gyrometer | 6 | 3×i16 /100 °/s | |
| 135 | colour | 3 | r,g,b u8 | |
| 136 | GPS | 9 | lat i24 /10000, lon i24 /10000, alt i24 /100 m | yes |
| 142 | switch | 1 | u8 | |

Cross-check against the firmware's own LPP helper `src/helpers/sensors/LPPDataHelpers.h`, which defines `LPPReader`/`LPPWriter`. These are used by the companion UI to parse its own telemetry and by the sensor AVG_MIN_MAX reply:
- The `#define` comments and `*_MULT` constants agree with the table above.
- Its `getDataSize()` returns **2** for RELATIVE_HUMIDITY and `getMultiplier()` returns **10** for it. This contradicts its own `#define` (1 byte, ×2) and the CayenneLPP library. Treat it as a firmware bug, not the wire format: telemetry produced by `CayenneLPP::addRelativeHumidity` is 1 byte, /2. **However**, sensor AVG_MIN_MAX replies are written with `LPPData::putFloat` and therefore use 2-byte, ×10 humidity.
- `isSigned()` = altitude, temperature, gyrometer, analog in/out, GPS, accelerometer. Voltage, current and power are unsigned. meshcore.js reads voltage and current signed on purpose, to allow negative values. The firmware's own `LPPReader::readCurrent` also reads current signed, and `LPPReader::readRelativeHumidity` reads 1 byte /2 (consistent with the wire format, unlike `getDataSize`).
- Types it doesn't list (e.g. 122 load) fall back to size 1 in `getDataSize`. UNVERIFIED that the library ever emits 122; it is not used by firmware sensors.

Sensor AVG_MIN_MAX reply body (`SENS` L165-197): `[tag u32][now u32]`, then up to 8 × `{channel u8, lpp_type u8, min, max, avg}`, where each value is `getDataSize(type)` bytes big-endian, scaled by `getMultiplier(type)`, two's complement if `isSigned(type)`.

---

## 5. Routing behaviours relevant to decoding captures

- Flood replies: the recipient of a flooded TXT/REQ answers with a **flood PATH packet** whose extra is the ACK/RESPONSE (`BCM` L250-254, L316-320). It may then also receive a reciprocal PATH (no extra, `0xFF + 4 random`) sent direct (`Mesh.cpp` L173-178).
- Direct replies: plain ACK/RESPONSE packets sent along `out_path`.
- Companion send scope: floods from a companion are TRANSPORT_FLOOD when a default or session flood scope is set, otherwise FLOOD (`CMM sendFloodScoped` L491-525). Self-advert flood always uses the default scope.
- ADVERT flood priority 3, PATH 2, others 1. Direct traffic has priority 0 (`Mesh::sendFlood/sendDirect`).
- A packet whose payload decodes to the local node is never retransmitted. Others are retransmitted only if forwarding is enabled (companions: "client repeat", off by default).
