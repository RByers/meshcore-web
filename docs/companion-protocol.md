# MeshCore Companion Protocol (host <-> device) — reference

Ground truth: MeshCore firmware `companion-v1.18.0` (`FIRMWARE_VER_CODE 14`, `FIRMWARE_VERSION "v1.18.0"`), commit `81dbae5`.
Abbreviations used in citations:

| Abbrev | File |
|---|---|
| `MM` | `examples/companion_radio/MyMesh.cpp` (line numbers from commit 81dbae5) |
| `MM.h` | `examples/companion_radio/MyMesh.h` |
| `BCM` | `src/helpers/BaseChatMesh.cpp` |
| `ASI` | `src/helpers/ArduinoSerialInterface.cpp` |
| `BLE32` / `BLE52` / `BLE2040` | `src/helpers/{esp32,nrf52,rp2040}/SerialBLEInterface.cpp` |
| `JS` | meshcore.js v1.15.0 `src/connection/connection.js` |
| `DOC` | `docs/companion_protocol.md` in the firmware repo, identical to https://docs.meshcore.io/companion_protocol/ ("Last Updated 2026-03-08") |

Conventions: all multi-byte integers are **little-endian** unless stated otherwise (CayenneLPP is big-endian). `i8` = signed byte. "prefix6" = first 6 bytes of a 32-byte Ed25519 public key. Offsets are from byte 0 of the frame, and byte 0 is always the code. "SNR×4" = `int8`, divide by 4 to get dB.

Constants: `MAX_FRAME_SIZE = 176` (`src/helpers/BaseSerialInterface.h`), `PUB_KEY_SIZE = 32`, `MAX_PATH_SIZE = 64`, `SIGNATURE_SIZE = 64`, `MAX_PACKET_PAYLOAD = 184`, `MAX_TEXT_LEN = 160` (`BaseChatMesh.h`), `MAX_CONTACTS` (default 100, most builds 350), `MAX_GROUP_CHANNELS` (1, 8 or 40 depending on build), `OFFLINE_QUEUE_SIZE` (default 16, most builds 256), `EXPECTED_ACK_TABLE_SIZE = 8`, `ADVERT_PATH_TABLE_SIZE = 16`.

---

## 1. Transport framing

### 1.1 Serial (USB / UART) and TCP (WiFi, port 5000)

`ASI writeFrame` / `checkRecvFrame`; WiFi uses the same header (`src/helpers/wifi/SerialWifiInterface.cpp`).

| Offset | Size | Type | Meaning |
|---|---|---|---|
| 0 | 1 | u8 | Marker: `0x3C '<'` = host→device; `0x3E '>'` = device→host |
| 1 | 2 | u16 LE | Payload length N |
| 3 | N | bytes | One companion frame (code byte + body) |

- Max N is 176 (`MAX_FRAME_SIZE`). Device→host: `writeFrame` with len > 176 **silently drops the frame** (returns 0).
- Host→device: the parser (`ASI checkRecvFrame`) skips bytes until `'<'`, reads the length, then reads N bytes. If N > 176 the extra bytes are consumed and the frame is **truncated to 176**, not rejected. N = 0 resets to idle. There is no timeout or resync: a stray `'<'` corrupts the next frame.
- WiFi/TCP: N > 176 is skipped entirely, and any marker other than `'<'` causes the frame to be skipped.
- Baud rate 115200 (`examples/companion_radio/main.cpp`; also meshcore.js `WebSerialConnection.open`).
- meshcore.js (`src/connection/serial_connection.js onDataReceived`) accepts **both** `'<'` and `'>'` markers on receive, and skips one byte and retries on a bad marker or zero length. This is compatible with the firmware.
- In USB-serial builds the CLI "rescue mode" uses the same UART as plain text. It is only entered on purpose, from the device UI.

### 1.2 BLE (Nordic UART Service UUIDs)

| Item | Value | Source |
|---|---|---|
| Service | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` | `BLE32` L7, `BLE2040` L10-13, nRF52 uses Adafruit `BLEUart` (same NUS UUIDs) |
| RX char (host writes) | `6E400002-B5A3-F393-E0A9-E50E24DCCA9E` (WRITE, encrypted + MITM) | same |
| TX char (device notifies) | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` (READ+NOTIFY, encrypted + MITM) | same |
| Device name | `"MeshCore-" + node_name` (`BLE_NAME_PREFIX`, `MM.h`) | `main.cpp` |
| Pairing | Static passkey = BLE PIN (default `123456`; random 6-digit per boot if the device has a display and the PIN is the default; `CMD_SET_DEVICE_PIN` sets it). Bonding with MITM. | `main.cpp` L188-205 |

- **No length header on BLE.** One GATT write is exactly one command frame, and one notification is exactly one response/push frame. There is no reassembly on either side (`BLE32 onWrite`, `checkRecvFrame`; DOC "Frame Handling").
- Writes larger than 176 bytes are dropped (`BLE32 onWrite` "frame too big").
- MTU: ESP32 calls `BLEDevice::setMTU(176)`. RP2040 **drops** any notification with `len + 3 > negotiated MTU` (`BLE2040` L122-126). nRF52 uses `bleuart.write`. UNVERIFIED: on nRF52 Bluefruit may split a frame longer than MTU-3 into several notifications. The client must negotiate an ATT MTU of at least 179. Chrome Web Bluetooth negotiates the MTU automatically, typically 247 or 517. UNVERIFIED for all platforms.
- Device send queue: 4 frames (ESP32), 12 (nRF52), 8 (RP2040). When full, `writeFrame` returns 0 and **the frame is lost**. ESP32 spaces notifications at least 60 ms apart (`BLE_WRITE_MIN_INTERVAL`). Contact-list streaming waits on `isWriteBusy()`. Other pushes do not, so bursts of pushes can be lost on BLE.
- Receive queue: 4 frames (ESP32), 12 (nRF52), 8 (RP2040). Send one command at a time.
- meshcore.js `web_ble_connection.js`: subscribes to TX notifications, calls `writeValue` on RX (write-with-response) with no write mutex (comment: "GATT operation already in progress"), and treats each notification as one frame. This matches the firmware.

### 1.3 Multiple interfaces

`MultiSerialInterface.h`: every outgoing frame is written to **all** enabled interfaces (BLE, USB, WiFi, Ethernet, HW serial). Incoming frames are taken from whichever interface has one first. `isConnected()` is true if any interface reports connected, and `ArduinoSerialInterface::isConnected()` **always returns true**. So on a USB-capable build, "connected-only" pushes (MSG_WAITING, LOG_RX_DATA, etc.) are always emitted.

---

## 2. Session start / handshake

Recommended order (DOC "Connection Steps"; meshcore.js `onConnected`):

1. `CMD_DEVICE_QUERY` (22) with `app_target_ver`. **This is the only command that sets the protocol version** (`MM handleCmdFrame` L1056-1057). meshcore.js sends 3 (`Constants.SupportedCompanionProtocolVersion`).
2. `CMD_APP_START` (1) → `RESP_CODE_SELF_INFO`.
3. `CMD_SET_DEVICE_TIME`, then `CMD_GET_CONTACTS`, then `CMD_GET_CHANNEL` × max_channels, then `CMD_SYNC_NEXT_MESSAGE` until `NO_MORE_MESSAGES`.

`app_target_ver` starts at 0 at boot and is **never reset on disconnect** (only `CMD_DEVICE_QUERY` writes it). Its only effect is the V3 message format (§6). Messages already queued keep the format chosen at the time they were received (the queue stores fully encoded frames).

### 2.1 CMD_APP_START (0x01) — `MM` L1076-1117

| Off | Size | Type | Meaning |
|---|---|---|---|
| 0 | 1 | u8 | `0x01` |
| 1 | 7 | — | Reserved, ignored by firmware. meshcore.js writes `[1]=1` ("appVer") then 6 zero bytes. |
| 8 | n | UTF-8 | App name, rest of frame (log only) |

The firmware requires len ≥ 8. A shorter frame → `ERR(1 UNSUPPORTED_CMD)`. Side effect: aborts any running contact iteration (`_iter_started = false`).

### 2.2 RESP_CODE_SELF_INFO (0x05)

| Off | Size | Type | Meaning |
|---|---|---|---|
| 0 | 1 | u8 | `0x05` |
| 1 | 1 | u8 | adv_type, always `1` (ADV_TYPE_CHAT) |
| 2 | 1 | i8 | tx_power_dbm (can be negative, -9..max) |
| 3 | 1 | i8 | MAX_LORA_TX_POWER |
| 4 | 32 | bytes | self public key |
| 36 | 4 | i32 | latitude × 1e6 |
| 40 | 4 | i32 | longitude × 1e6 |
| 44 | 1 | u8 | multi_acks (extra ACK transmissions, v7+) |
| 45 | 1 | u8 | advert_loc_policy (0 = none, 1 = share) |
| 46 | 1 | u8 | telemetry modes: bits0-1 base, bits2-3 loc, bits4-5 env (each 0 = deny, 1 = per-contact flags, 2 = allow all) (v5+) |
| 47 | 1 | u8 | manual_add_contacts (bit0 = 1: manual mode, see §8) |
| 48 | 4 | u32 | radio freq in **kHz** (`freq_MHz * 1000`) |
| 52 | 4 | u32 | radio bandwidth in **Hz** (`bw_kHz * 1000`) |
| 56 | 1 | u8 | spreading factor (5..12) |
| 57 | 1 | u8 | coding rate (5..8) |
| 58 | n | UTF-8 | node name, rest of frame, **no NUL** |

meshcore.js reads [2] and [3] as unsigned, and lumps 44-46 into `reserved` (`JS onSelfInfoResponse`).

### 2.3 CMD_DEVICE_QUERY (0x16 = 22) → RESP_CODE_DEVICE_INFO (0x0D) — `MM` L1056-1075

Request: `[0]=0x16, [1]=app_target_ver (u8)`. len ≥ 2 is required. A 1-byte frame → `ERR(1)`.

| Off | Size | Type | Meaning |
|---|---|---|---|
| 0 | 1 | u8 | `0x0D` |
| 1 | 1 | u8 | FIRMWARE_VER_CODE (14 for v1.18.0) |
| 2 | 1 | u8 | MAX_CONTACTS / 2 (v3+) |
| 3 | 1 | u8 | MAX_GROUP_CHANNELS (v3+) |
| 4 | 4 | u32 | BLE PIN stored in prefs (0 = default/unset) |
| 8 | 12 | char[12] | build date, e.g. `"15 Oct 2026"`, NUL-padded |
| 20 | 40 | char[40] | manufacturer/board name, NUL-padded (`strzcpy`) |
| 60 | 20 | char[20] | firmware version string, e.g. `"v1.18.0"`, NUL-padded |
| 80 | 1 | u8 | client repeat enabled (v9+) |
| 81 | 1 | u8 | path_hash_mode 0..2 (v10+) |

Total 82 bytes. meshcore.js `onDeviceInfoResponse` reads `firmwareVer` as int8, skips 6 bytes, reads the 12-byte date, then decodes **all remaining bytes** as one string `manufacturerModel` (manufacturer + NULs + version + 2 binary bytes). **This is a bug.** DOC is correct.

---

## 3. Generic responses and errors

| Code | Name | Layout | Source |
|---|---|---|---|
| 0x00 | RESP_CODE_OK | `[0]` only, **always 1 byte** | `MM writeOKFrame` L153 |
| 0x01 | RESP_CODE_ERR | `[0]=0x01, [1]=err_code` (always 2 bytes) | `MM writeErrFrame` L158 |
| 0x0F | RESP_CODE_DISABLED | `[0]` only (feature compiled out: private key export/import) | `MM writeDisabledFrame` |

DOC claims OK may carry an "optional 32-bit value". **The firmware never sends one.**

| err_code | Name | Typical cause |
|---|---|---|
| 1 | ERR_CODE_UNSUPPORTED_CMD | unknown code, **or any known code whose length/guard check fails** (falls through to the final `else`, `MM` L2059), unsupported txt_type, flood raw data |
| 2 | ERR_CODE_NOT_FOUND | unknown contact / channel idx / advert path |
| 3 | ERR_CODE_TABLE_FULL | packet pool empty, contacts full, **and also text too long** (sendMessage returns MSG_SEND_FAILED), sign buffer overflow |
| 4 | ERR_CODE_BAD_STATE | GET_CONTACTS while an iteration is running; SIGN_DATA/FINISH without SIGN_START |
| 5 | ERR_CODE_FILE_IO_ERROR | import private key save failed, factory reset format failed |
| 6 | ERR_CODE_ILLEGAL_ARG | out-of-range values |

**Emulator note:** guard failures are not reported as ILLEGAL_ARG. For example `CMD_SEND_TXT_MSG` with len < 14 returns `ERR 1` because the `else if` chain falls through.

---

## 4. Command table (host → device)

"SENT" = `RESP_CODE_SENT` (0x06, §5.1). All commands are in `MM handleCmdFrame` (L1055-2063), listed in that order. "len" = whole frame length including the code byte.

| # | Hex | Name | Request layout (after `[0]=code`) | Guard | Response(s) |
|---|---|---|---|---|---|
| 1 | 01 | APP_START | §2.1 | len≥8 | SELF_INFO |
| 2 | 02 | SEND_TXT_MSG | `[1]txt_type u8, [2]attempt u8, [3..6]timestamp u32, [7..12]recipient prefix6, [13..]text UTF-8 (no NUL)` | len≥14; recipient found; txt_type ∈ {0,1,3} | SENT (expected_ack; 0 for CLI types) / ERR 2 (no contact) / ERR 1 (bad txt_type) / ERR 3 (send failed or text > 160 B) |
| 3 | 03 | SEND_CHANNEL_TXT_MSG | `[1]txt_type (must be 0), [2]channel_idx, [3..6]timestamp u32, [7..]text` | none | **OK** / ERR 1 (txt_type≠0) / ERR 2 (bad idx or send failed). DOC wrongly says MSG_SENT. |
| 4 | 04 | GET_CONTACTS | `[1..4]since u32` (optional, used if len≥5) | not iterating | CONTACTS_START, then CONTACT×k, then END_OF_CONTACTS (§7) / ERR 4 |
| 5 | 05 | GET_DEVICE_TIME | — | | CURR_TIME `[1..4]u32 epoch secs` |
| 6 | 06 | SET_DEVICE_TIME | `[1..4]epoch u32` | len≥5 | OK, or ERR 6 if `secs < current RTC` (**clock can't go backwards**) |
| 7 | 07 | SEND_SELF_ADVERT | `[1]` optional: `1` = flood (scoped with default scope), anything else or absent = zero-hop | | OK / ERR 3 |
| 8 | 08 | SET_ADVERT_NAME | `[1..]name` (truncated to 31 bytes) | len≥2 | OK. Firmware does **not** validate characters here (the CLI `set name` rejects `[]\:,?*`). |
| 9 | 09 | ADD_UPDATE_CONTACT | contact record body (§7.1) from offset 1. lat/lon optional (len≥1+32+3+64+32+4+8), lastmod optional (+4). | len≥36 (L1328), but bytes up to offset 135 are always read (send ≥136 B) | OK / ERR 3 (full). If lastmod is absent it is set to device RTC now. |
| 10 | 0A | SYNC_NEXT_MESSAGE | — | | next queued frame (CONTACT_MSG_RECV[_V3] / CHANNEL_MSG_RECV[_V3] / CHANNEL_DATA_RECV) or NO_MORE_MESSAGES `[0]=0x0A` |
| 11 | 0B | SET_RADIO_PARAMS | `[1..4]freq kHz u32, [5..8]bw Hz u32, [9]sf, [10]cr, [11]repeat u8 (optional, v9+)` | 150000≤f≤2500000, 7000≤bw≤500000, 5≤sf≤12, 5≤cr≤8; if repeat≠0, f must be in the allowed repeat list | OK / ERR 6. **Omitting [11] sets repeat=OFF** (meshcore.js omits it). Applied immediately. |
| 12 | 0C | SET_RADIO_TX_POWER | `[1]i8 dBm` | -9..MAX | OK / ERR 6 |
| 13 | 0D | RESET_PATH | `[1..32]pubkey` | len≥33 | OK (out_path_len=0xFF; lastmod unchanged) / ERR 2 |
| 14 | 0E | SET_ADVERT_LATLON | `[1..4]lat i32 ×1e6, [5..8]lon i32 ×1e6, [9..12]alt i32 (optional, ignored)` | len≥9, \|lat\|≤90e6, \|lon\|≤180e6 | OK / ERR 6 |
| 15 | 0F | REMOVE_CONTACT | `[1..32]pubkey` | | OK / ERR 2 |
| 16 | 10 | SHARE_CONTACT | `[1..32]pubkey` | | OK (re-sends the stored raw advert zero-hop with transport codes {0,0}) / ERR 3 (no stored advert or pool empty) / ERR 2 |
| 17 | 11 | EXPORT_CONTACT | `[1..32]pubkey`, or nothing = export self | | EXPORT_CONTACT `[0]=0x0B, [1..]raw advert packet` (§5.4) / ERR 2/3 |
| 18 | 12 | IMPORT_CONTACT | `[1..]raw advert packet` (wire format) | len>98 | OK (packet is looped back as if received over flood, then processed asynchronously) / ERR 6 |
| 19 | 13 | REBOOT | `[1..6]"reboot"` | literal | **no response**, device reboots |
| 20 | 14 | GET_BATT_AND_STORAGE | — | | BATT_AND_STORAGE (§5.3) |
| 21 | 15 | SET_TUNING_PARAMS | `[1..4]rx_delay_base×1000 u32, [5..8]airtime_factor×1000 u32` | none (no length check) | OK |
| 22 | 16 | DEVICE_QUERY | `[1]app_target_ver` | len≥2 | DEVICE_INFO |
| 23 | 17 | EXPORT_PRIVATE_KEY | — | | PRIVATE_KEY `[0]=0x0E, [1..64]` 64-byte expanded Ed25519 private key (§9) / DISABLED |
| 24 | 18 | IMPORT_PRIVATE_KEY | `[1..64]` 64-byte expanded private key (pubkey re-derived) | len≥65 | OK / ERR 6 (fails ECDH self-test) / ERR 5 / DISABLED. Reloads contacts. |
| 25 | 19 | SEND_RAW_DATA | `[1]path_len (encoded, §path), [2..]path bytes, then payload ≥4 B` | len≥6, valid path_len, payload≥4 | OK (sent DIRECT as PAYLOAD_TYPE_RAW_CUSTOM) / ERR 1 (any invalid path_len, including 0xFF: flood unsupported) / ERR 6 (payload < 4 B after the path) / ERR 3 |
| 26 | 1A | SEND_LOGIN | `[1..32]pubkey, [33..]password` (max 15 chars used) | len≥33 | SENT (tag = **first 4 bytes of the target pubkey**), then later LOGIN_SUCCESS/LOGIN_FAIL push / ERR 2/3 |
| 27 | 1B | SEND_STATUS_REQ | `[1..32]pubkey` | len≥33 | SENT (tag = request timestamp), then STATUS_RESPONSE push (matched by pubkey prefix, not by tag) |
| 28 | 1C | HAS_CONNECTION | `[1..32]pubkey` | len≥33 | OK (keep-alive connection active) / ERR 2 |
| 29 | 1D | LOGOUT | `[1..32]pubkey` | len≥33 | OK (always) |
| 30 | 1E | GET_CONTACT_BY_KEY | `[1..32]pubkey` | | CONTACT (0x03 record, §7.1) / ERR 2 |
| 31 | 1F | GET_CHANNEL | `[1]idx` | len≥2 | CHANNEL_INFO (§5.5) for **any idx < MAX_GROUP_CHANNELS, including empty slots** / ERR 2 |
| 32 | 20 | SET_CHANNEL | `[1]idx, [2..33]name char[32], [34..49]secret[16]` | len≥50; **len≥66 → ERR 1** (256-bit unsupported) | OK / ERR 2 (bad idx) |
| 33 | 21 | SIGN_START | — | | SIGN_START `[0]=0x13, [1]=0 reserved, [2..5]max_len u32 = 8192` (discards any previous buffer) |
| 34 | 22 | SIGN_DATA | `[1..]chunk` | len>1 | OK / ERR 4 (no start) / ERR 3 (>8192 total) |
| 35 | 23 | SIGN_FINISH | — | | SIGNATURE `[0]=0x14, [1..64]Ed25519 sig over all chunks` / ERR 4 |
| 36 | 24 | SEND_TRACE_PATH | `[1..4]tag u32, [5..8]auth_code u32, [9]flags (bits0-1 = path_sz: hash size 2^path_sz bytes, v1.11+), [10..]path hashes` | len>10 and len-10 < 179 (`MAX_PACKET_PAYLOAD-5`; otherwise falls through to ERR 1), (len-10)>>path_sz ≤ 64, (len-10) multiple of 2^path_sz | SENT (`[1]=0`, tag echoed, est_timeout), later TRACE_DATA push / ERR 6/3 |
| 37 | 25 | SET_DEVICE_PIN | `[1..4]pin u32` | len≥5; 0 or 100000..999999 | OK / ERR 6 (takes effect on reboot) |
| 38 | 26 | SET_OTHER_PARAMS | `[1]manual_add_contacts, [2]telemetry modes (bits as SELF_INFO[46], v5+), [3]advert_loc_policy, [4]multi_acks` (each optional from [2]) | none ([1] read even if len=1) | OK |
| 39 | 27 | SEND_TELEMETRY_REQ | `[1..3]reserved, [4..35]pubkey` | len≥36 | SENT, then TELEMETRY_RESPONSE push |
| 39 | 27 | (self telemetry) | `[1..3]reserved`, len **exactly 4** | | TELEMETRY_RESPONSE push immediately (self prefix6, local LPP). **No SENT.** |
| 40 | 28 | GET_CUSTOM_VARS | — | | CUSTOM_VARS `[0]=0x15, [1..]ASCII "name:value,name:value"` (no NUL; capped near 140 chars) |
| 41 | 29 | SET_CUSTOM_VAR | `[1..]ASCII "name:value"` | len≥4, has ':' | OK / ERR 6 |
| 42 | 2A | GET_ADVERT_PATH | `[1]reserved, [2..33]pubkey` (only first 7 bytes compared) | len≥34 | ADVERT_PATH `[0]=0x16, [1..4]recv_timestamp u32 (device RTC), [5]path_len (encoded), [6..]path bytes` / ERR 2 |
| 43 | 2B | GET_TUNING_PARAMS | — | | TUNING_PARAMS `[0]=0x17, [1..4]rx_delay_base×1000 u32, [5..8]airtime_factor×1000 u32` |
| 44-49 | | (parked for WiFi ops) | | | ERR 1 |
| 50 | 32 | SEND_BINARY_REQ | `[1..32]pubkey, [33..]request data (first byte = REQ_TYPE)` | len≥34 | SENT (tag), then BINARY_RESPONSE push with same tag |
| 51 | 33 | FACTORY_RESET | `[1..5]"reset"` | literal | interfaces disabled first, so OK is usually not received; reboot / ERR 5 |
| 52 | 34 | SEND_PATH_DISCOVERY_REQ | `[1]=0 (reserved, must be 0), [2..33]pubkey` | len≥34 | SENT, then PATH_DISCOVERY_RESPONSE push. Sent as a **flood** REQ `GET_TELEMETRY_DATA` with mask = base only. |
| 53 | 35 | (unassigned) | | | ERR 1 |
| 54 | 36 | SET_FLOOD_SCOPE_KEY (v8+) | `[1]=0, [2..17]16-byte transport key` (len<18 → clear override) / `[1]=1` → force **unscoped** flood (v12+) | len≥2; `[1]` ∉ {0,1} → ERR 1 | OK. Session only, not persisted. |
| 55 | 37 | SEND_CONTROL_DATA (v8+) | `[1..]control payload; [1]&0x80 must be set` | len≥2 | OK (sent zero-hop DIRECT, PAYLOAD_TYPE_CONTROL) / ERR 3 |
| 56 | 38 | GET_STATS (v8+) | `[1]stats_type 0/1/2` | len≥2 | STATS (§5.6) / ERR 6 |
| 57 | 39 | SEND_ANON_REQ | `[1..32]pubkey, [33..]data` | len>33. v13+: an unknown pubkey is accepted (a temporary anon contact is created, zero-hop) | SENT (tag = timestamp), reply as BINARY_RESPONSE / ERR 3 |
| 58 | 3A | SET_AUTOADD_CONFIG | `[1]autoadd_config bits, [2]max_hops (optional, clamped ≤64)` | | OK |
| 59 | 3B | GET_AUTOADD_CONFIG | — | | AUTOADD_CONFIG `[0]=0x19, [1]config, [2]max_hops` |
| 60 | 3C | GET_ALLOWED_REPEAT_FREQ | — | | `[0]=0x1A`, then repeated `{lower u32 kHz, upper u32 kHz}` (default `{433000,433000},{869495,869495},{918000,918000}`) |
| 61 | 3D | SET_PATH_HASH_MODE | `[1]=0 (must be 0), [2]mode 0..2` (hash size = mode+1 bytes, used for floods this node originates) | len≥3 | OK / ERR 6 |
| 62 | 3E | SEND_CHANNEL_DATA | `[1]idx, [2]path_len (0xFF = flood, else encoded), [3..]path bytes (absent if 0xFF), then data_type u16 LE, then payload` | len≥4 (shorter → **ERR 6**, not ERR 1) | OK / ERR 2 (idx), ERR 6 (bad path_len, data_type 0, payload > 165), ERR 3 |
| 63 | 3F | SET_DEFAULT_FLOOD_SCOPE | `[1..31]name char[31] (NUL-terminated, 1..30 chars), [32..47]key[16]`. Shorter frame → clear. | len≥48 for set | OK / ERR 6. Persisted. |
| 64 | 40 | GET_DEFAULT_FLOOD_SCOPE | — | | `[0]=0x1C, [1..31]name, [32..47]key` (48 B) or `[0]=0x1C` only when unset |
| 65 | 41 | SEND_RAW_PACKET | `[1]priority, [2..]complete raw mesh packet (wire format, see mesh-packet-format.md)` | len≥4, parses | OK / ERR 6 / ERR 3 |
| 66 | 42 | RUN_CLI_COMMAND (v14+) | `[1..]command text` | len≥3 | CLI_REPLY `[0]=0x1D, [1..]reply text` (no NUL; "Unknown command" if unhandled) |

Notes:
- **Only one remote request can be outstanding.** Every SEND_LOGIN / STATUS / TELEMETRY / BINARY / ANON / PATH_DISCOVERY calls `clearPendingReqs()` (`MM.h` L192), so a response to an earlier request is no longer recognised. It is then delivered as a generic BINARY_RESPONSE (§6.10).
- Sends choose flood or direct automatically: flood if the contact's `out_path_len == 0xFF`, else direct. `SENT[1]` reports which was used.
- `SET_OTHER_PARAMS`, `SET_TUNING_PARAMS` and `SET_RADIO_PARAMS` have no length checks. Always send full frames.
- There is **no command for automatic advert intervals or flood limits** on companion firmware: `advert_interval`, `flood_advert_interval` and `flood_max*` exist only as commented-out custom-var definitions (`NodePrefs.h` L145-147, L195-196). Those are repeater CLI settings (`set advert.interval`, …).

---

## 5. Response layouts (device → host, replies)

| Code | Name | Reply to |
|---|---|---|
| 0x00 | OK | many |
| 0x01 | ERR | many |
| 0x02 | CONTACTS_START | GET_CONTACTS |
| 0x03 | CONTACT | GET_CONTACTS (repeated), GET_CONTACT_BY_KEY |
| 0x04 | END_OF_CONTACTS | GET_CONTACTS |
| 0x05 | SELF_INFO | APP_START |
| 0x06 | SENT | SEND_TXT_MSG, LOGIN, STATUS_REQ, TELEMETRY_REQ, BINARY_REQ, ANON_REQ, PATH_DISCOVERY, TRACE_PATH |
| 0x07 | CONTACT_MSG_RECV | SYNC_NEXT_MESSAGE (app_target_ver < 3) |
| 0x08 | CHANNEL_MSG_RECV | SYNC_NEXT_MESSAGE (app_target_ver < 3) |
| 0x09 | CURR_TIME | GET_DEVICE_TIME |
| 0x0A | NO_MORE_MESSAGES | SYNC_NEXT_MESSAGE |
| 0x0B | EXPORT_CONTACT | EXPORT_CONTACT |
| 0x0C | BATT_AND_STORAGE | GET_BATT_AND_STORAGE |
| 0x0D | DEVICE_INFO | DEVICE_QUERY |
| 0x0E | PRIVATE_KEY | EXPORT_PRIVATE_KEY |
| 0x0F | DISABLED | key export/import when compiled out |
| 0x10 | CONTACT_MSG_RECV_V3 | SYNC_NEXT_MESSAGE (app_target_ver ≥ 3) |
| 0x11 | CHANNEL_MSG_RECV_V3 | SYNC_NEXT_MESSAGE (app_target_ver ≥ 3) |
| 0x12 | CHANNEL_INFO | GET_CHANNEL |
| 0x13 | SIGN_START | SIGN_START |
| 0x14 | SIGNATURE | SIGN_FINISH |
| 0x15 | CUSTOM_VARS | GET_CUSTOM_VARS |
| 0x16 | ADVERT_PATH | GET_ADVERT_PATH |
| 0x17 | TUNING_PARAMS | GET_TUNING_PARAMS |
| 0x18 | STATS | GET_STATS |
| 0x19 | AUTOADD_CONFIG | GET_AUTOADD_CONFIG |
| 0x1A | ALLOWED_REPEAT_FREQ | GET_ALLOWED_REPEAT_FREQ |
| 0x1B | CHANNEL_DATA_RECV | SYNC_NEXT_MESSAGE |
| 0x1C | DEFAULT_FLOOD_SCOPE | GET_DEFAULT_FLOOD_SCOPE |
| 0x1D | CLI_REPLY | RUN_CLI_COMMAND |

### 5.1 RESP_CODE_SENT (0x06) — 10 bytes, e.g. `MM` L1167-1171

| Off | Size | Type | Meaning |
|---|---|---|---|
| 0 | 1 | u8 | `0x06` |
| 1 | 1 | u8 | 1 = sent flood, 0 = sent direct (TRACE: always 0) |
| 2 | 4 | u32 / 4 raw bytes | TXT: expected ACK code (0 for CLI txt types). LOGIN: first 4 bytes of the target pubkey. Other requests: tag (= device `getCurrentTimeUnique()` used as the request timestamp). TRACE: tag echoed. |
| 6 | 4 | u32 | suggested timeout, ms (§10) |

### 5.2 CONTACTS_START / END_OF_CONTACTS

- `0x02`: `[1..4]` u32 = **total** number of contacts (`getNumContacts()`, not the number that will pass the `since` filter).
- `0x04`: `[1..4]` u32 = largest `lastmod` among the contacts **actually sent** (0 if none were sent, **not** the `since` you passed in).

### 5.3 BATT_AND_STORAGE (0x0C) — 11 bytes

`[1..2]` battery mV u16, `[3..6]` storage used KB u32, `[7..10]` storage total KB u32. (meshcore.js reads only the mV.)

### 5.4 EXPORT_CONTACT (0x0B)

`[1..]` = a raw mesh packet (header, path_len, path, ADVERT payload). For self: freshly signed advert, header `0x11` (ADVERT|FLOOD), path_len 0. For a contact: the last stored advert blob, with the route type forced to FLOOD (transport codes stripped), keeping the original received path (`BCM onAdvertRecv` L141-149). Can be passed unchanged to IMPORT_CONTACT on another device.

### 5.5 CHANNEL_INFO (0x12) — 50 bytes, `MM` L1752-1766

| Off | Size | Type | Meaning |
|---|---|---|---|
| 0 | 1 | u8 | `0x12` |
| 1 | 1 | u8 | channel idx |
| 2 | 32 | char[32] | name. Written with `strcpy`: bytes after the NUL are **stale buffer contents, not zeros**. Stop at the first NUL. |
| 34 | 16 | bytes | secret (128-bit only) |

Empty slot = name `""`, secret all zeros. Slot 0 is preloaded with `"Public"`, secret base64 `izOH6cXN6mrJ5e26oRXNcg==` = `8b3387e9c5cdea6ac9e5edbaa115cd72` (`MM` L114, L1002).

### 5.6 STATS (0x18) — `MM` L1914-1964

| stats_type | Layout after `[0]=0x18, [1]=type` | Total |
|---|---|---|
| 0 CORE | `[2..3]batt_mv u16, [4..7]uptime_s u32, [8..9]err_flags u16 (bit0 queue full, bit1 CAD timeout, bit2 startRX timeout; Dispatcher.h L110), [10]outbound queue len u8` | 11 |
| 1 RADIO | `[2..3]noise_floor i16 dBm, [4]last_rssi i8, [5]last_snr i8 ×4, [6..9]tx_air_secs u32, [10..13]rx_air_secs u32` | 14 |
| 2 PACKETS | `[2..5]recv, [6..9]sent, [10..13]sent_flood, [14..17]sent_direct, [18..21]recv_flood, [22..25]recv_direct, [26..29]recv_errors` (all u32) | 30 (older firmware: 26) |

---

## 6. Push codes (device → host, unsolicited)

| Code | Name | Layout | Emitted when | Source |
|---|---|---|---|---|
| 0x80 | ADVERT | `[1..32]pubkey` | an advert from an **existing** contact updated it, **or** a new contact was **auto-added** (the `is_new` flag is false in both cases) | `MM onDiscoveredContact` L358; `BCM onAdvertRecv` L156-200 |
| 0x81 | PATH_UPDATED | `[1..32]pubkey` | a PATH packet from a contact replaced its out_path (sent even when the app is not connected) | `MM onContactPathUpdated` L409 |
| 0x82 | SEND_CONFIRMED | `[1..4]ack code (same 4 bytes as SENT[2..5]), [5..8]round-trip ms u32` (9 bytes) | an ACK matched the 8-entry expected-ACK table. Each entry fires only once. | `MM processAck` L417-438 |
| 0x83 | MSG_WAITING | `[0]` only | each time a message/datagram is queued while "connected" | `MM queueMessage` L469 |
| 0x84 | RAW_DATA | `[1]SNR×4 i8, [2]RSSI i8, [3]=0xFF reserved, [4..]payload` | a DIRECT-routed PAYLOAD_TYPE_RAW_CUSTOM packet was received (first time) | `MM onRawDataRecv` L832 |
| 0x85 | LOGIN_SUCCESS | §6.6 | | `MM onContactResponse` L694-723 |
| 0x86 | LOGIN_FAIL | `[1]=0, [2..7]prefix6` | | same |
| 0x87 | STATUS_RESPONSE | `[1]=0, [2..7]prefix6, [8..]status struct (no tag)` | | L724-738 |
| 0x88 | LOG_RX_DATA | `[1]SNR×4 i8, [2]RSSI i8, [3..]raw over-the-air packet bytes` | **every** radio receive, before parsing (including corrupt or undecodable packets), if connected and len+3 ≤ 176 | `MM logRxRaw` L291; `Dispatcher::checkRecv` |
| 0x89 | TRACE_DATA | §6.7 | | `MM onTraceRecv` L855 |
| 0x8A | NEW_ADVERT | full contact record (§7.1) with code 0x8A | an advert from an unknown node was **not** added (manual mode / type not enabled / hop limit / contacts full) | `MM onDiscoveredContact` |
| 0x8B | TELEMETRY_RESPONSE | `[1]=0, [2..7]prefix6, [8..]CayenneLPP (no tag)` | | L739-749, L1700-1719 |
| 0x8C | BINARY_RESPONSE | `[1]=0, [2..5]tag u32, [6..]response data` | matched pending binary/anon request, or **any unmatched RESPONSE** (then `[2..]` = the whole decrypted response, whose first 4 bytes are the remote's tag/timestamp) | L750-776 |
| 0x8D | PATH_DISCOVERY_RESPONSE | `[1]=0, [2..7]prefix6, [8]out_path_len (encoded), out_path bytes, then in_path_len (encoded), in_path bytes` | | `MM onContactPathRecv` L779-808 |
| 0x8E | CONTROL_DATA (v8+) | `[1]SNR×4 i8, [2]RSSI i8, [3]path_len, [4..]control payload` | zero-hop DIRECT CONTROL packet with payload[0]&0x80 | `MM onControlDataRecv` L810; `Mesh.cpp` L70 |
| 0x8F | CONTACT_DELETED | `[1..32]pubkey` | the oldest non-favourite contact was overwritten (autoadd bit0) | `MM onContactOverwrite` L342 |
| 0x90 | CONTACTS_FULL | `[0]` only | after the NEW_ADVERT for an advert that could not be stored | `MM onContactsFull` L351 |

Note: there is no host command to enable or disable LOG_RX_DATA in v1.18 (no "SET_LOG" command); it is emitted for every receive whenever an interface reports connected.

### 6.1 Messages are NOT pushed directly

Contact messages, channel messages and channel datagrams are **never** sent to the host as pushes. They are encoded into a frame, appended to the offline queue, then a 1-byte `MSG_WAITING` (0x83) is sent if connected (`MM queueMessage`, `onChannelMessageRecv`, `onChannelDataRecv`). The host must drain the queue with `CMD_SYNC_NEXT_MESSAGE` until `NO_MORE_MESSAGES` (0x0A). FIFO order.

Queue full (`MM addToOfflineQueue` L224-246): the **oldest channel-type frame** (0x08/0x11/0x1B) is removed and the new frame appended. If the queue holds no channel frames, **the new frame is silently dropped**, but MSG_WAITING is still sent.

### 6.2 CONTACT_MSG_RECV (0x07) / _V3 (0x10) — `MM queueMessage` L440-479

| V1 off | V3 off | Size | Type | Meaning |
|---|---|---|---|---|
| 0 | 0 | 1 | u8 | 0x07 / 0x10 |
| — | 1 | 1 | i8 | SNR×4 of the received packet |
| — | 2 | 2 | — | reserved (0,0) |
| 1 | 4 | 6 | bytes | sender pubkey prefix6 |
| 7 | 10 | 1 | u8 | path_len: **encoded** `pkt->path_len` if received flood (bits 6-7 = hash size-1, bits 0-5 = hops), **0xFF if received direct** |
| 8 | 11 | 1 | u8 | txt_type: 0 PLAIN, 1 CLI_DATA, 2 SIGNED_PLAIN, 3 CLI_COMMAND |
| 9 | 12 | 4 | u32 | sender_timestamp (sender's clock) |
| 13 | 16 | 4 | bytes | **only if txt_type==2**: author pubkey prefix (4 bytes) — room-server posts; DOC calls it "signature" |
| 13/17 | 16/20 | n | UTF-8 | text, rest of frame, no NUL, truncated to the frame (176) |

meshcore.js does not skip the 4 extra bytes for txt_type 2 (they end up at the start of `text`). **This is a bug.**
txt_type 3 (CLI_COMMAND) is queued only if the sender's contact flags lack 0x10 (remote CLI allowed). Otherwise the companion executes the command and replies over the air (`MM onCLICommandRecv` L538).

### 6.3 CHANNEL_MSG_RECV (0x08) / _V3 (0x11) — `MM onChannelMessageRecv` L558-599

| V1 off | V3 off | Size | Type | Meaning |
|---|---|---|---|---|
| 0 | 0 | 1 | u8 | 0x08 / 0x11 |
| — | 1 | 1 | i8 | SNR×4 |
| — | 2 | 2 | — | reserved |
| 1 | 4 | 1 | u8 | channel_idx (`findChannelIdx`, 0xFF if not found, which shouldn't happen) |
| 2 | 5 | 1 | u8 | path_len: encoded if flood, 0xFF if direct |
| 3 | 6 | 1 | u8 | txt_type, always 0 (packets with txt_type>>2 ≠ 0 are dropped, `BCM` L417-420) |
| 4 | 7 | 4 | u32 | sender timestamp |
| 8 | 11 | n | UTF-8 | text = `"<sender name>: <message>"`. The sender name is unauthenticated and is part of the text. Split on the first `": "`. |

### 6.4 CHANNEL_DATA_RECV (0x1B) — `MM onChannelDataRecv` L601-637 (always V3-style)

`[1]SNR×4, [2..3]reserved, [4]channel_idx, [5]path_len (encoded if flood / 0xFF if direct; no path bytes follow), [6..7]data_type u16, [8]data_len u8, [9..]data`. Dropped if data_len > 167.

### 6.5 ACK matching (SEND_CONFIRMED)

On `SEND_TXT_MSG` (plain), the device computes `expected_ack` (mesh-packet-format.md §ACK), stores `{ms_sent, ack, contact}` in an 8-slot circular table, and returns it in `SENT[2..5]`. When an ACK arrives (standalone ACK packet, multipart ACK, or ACK bundled in a PATH), the first 4 bytes are compared with the table. On a match: push `0x82 [ack(4)] [rtt_ms u32]` and clear that slot. Later duplicates are ignored. No push is ever sent for a timeout (`onSendTimeout` is empty). **The host must implement retries itself**, re-sending with `attempt` incremented (which changes the ACK code). After the 8th newer send, an old slot is overwritten.

### 6.6 LOGIN_SUCCESS (0x85) — `MM` L694-717

Matched by `pending_login` = first 4 bytes of the target pubkey.

| Off | Size | Meaning |
|---|---|---|
| 0 | 1 | 0x85 |
| 1 | 1 | is_admin (response byte [6]: repeater 1/0; room server 1 = admin, 2 = guest with perms 0, 0 = other) |
| 2 | 6 | prefix6 |
| 8 | 4 | server timestamp u32 (response tag) — **new format only** |
| 12 | 1 | ACL permissions (v7+; bits 0-1 role: 0 guest, 1 read-only, 2 read-write, 3 admin) — new format only |
| 13 | 1 | server FIRMWARE_VER_LEVEL (repeater 2, room server 1) — new format only |

Legacy servers reply `"OK"`, and the push is then only 8 bytes (`[1]=0`). The keep-alive byte (`resp[5]×16` s) is always 0 in current servers, so no connection is started. meshcore.js reads only bytes 1-7 and has **no handler** for 0x86.

### 6.7 TRACE_DATA (0x89) — `MM onTraceRecv` L855-886

| Off | Size | Meaning |
|---|---|---|
| 0 | 1 | 0x89 |
| 1 | 1 | reserved 0 |
| 2 | 1 | path_len = **byte length** of the path-hash list (not a hop count) |
| 3 | 1 | flags (bits 0-1 = path_sz; hash size = 1<<path_sz) |
| 4 | 4 | tag u32 |
| 8 | 4 | auth_code u32 |
| 12 | path_len | path hashes |
| … | path_len>>path_sz | per-hop SNR×4 (i8 each) |
| last | 1 | SNR×4 of the final hop into this node |

meshcore.js reads `pathLen` SNR bytes. That is only correct when path_sz=0.

### 6.8 STATUS_RESPONSE payload (repeater RepeaterStats, 56 B; room server ServerStats, 52 B)

See mesh-packet-format.md §STATUS. Note `last_snr` is i16 ×4 there (meshcore.js does not divide by 4).

### 6.9 TELEMETRY_RESPONSE

`[8..]` CayenneLPP stream (mesh-packet-format.md §LPP). Self-telemetry (CMD 39, len 4) uses the self prefix6.

### 6.10 Matching rules (for client and emulator) — `MM onContactResponse` L690-777

In order of evaluation (only one pending slot is non-zero, see §4 notes):
1. `pending_login` and the sender pubkey starts with it → LOGIN_SUCCESS/FAIL.
2. len>4 and `pending_status` and the sender pubkey starts with it → STATUS_RESPONSE (`data[4..]`).
3. len>4 and tag == `pending_telemetry` → TELEMETRY_RESPONSE.
4. len>4 and tag == `pending_req` → BINARY_RESPONSE `[2..5]=tag`.
5. Otherwise → BINARY_RESPONSE `[1]=0, [2..]=entire response` (e.g. sensor telemetry pushes).
PATH_DISCOVERY is matched separately in `onContactPathRecv` (tag == pending_discovery), and the reciprocal path is suppressed.
- Rule 1 has no `len > 4` check, and the login reply's tag is the **server's** clock, not the request tag. Rules 3/4 compare the reply's first 4 bytes with the pending tag (the companion's `getCurrentTimeUnique()`), so a late reply whose tag happens to equal the pending tag is mis-delivered (e.g. a late login reply stamped with the same second as a pending telemetry request becomes a TELEMETRY_RESPONSE). Clients should check the prefix as well.
- A matched PATH_DISCOVERY reply does **not** update the contact's out_path (MyMesh returns before the base class). An unmatched one (late) takes the normal PATH route: out_path replaced, PATH_UPDATED, then the RESPONSE extra is handled by the rules above (→ generic BINARY_RESPONSE).
- Any request or message sent flood is answered inside a flood PATH packet (`BCM onPeerDataRecv`), so the companion first replaces out_path and pushes PATH_UPDATED, then handles the ACK / RESPONSE extra (`BCM onContactPathRecv` L353-370).

---

## 7. Contacts

### 7.1 Contact record (RESP 0x03 / PUSH 0x8A / CMD 0x09 body) — `MM writeContactRespFrame` L171-192, `updateContactFromFrame` L194-217

| Off | Size | Type | Field |
|---|---|---|---|
| 0 | 1 | u8 | code (0x03, 0x8A, or 0x09 in CMD) |
| 1 | 32 | bytes | public key |
| 33 | 1 | u8 | type: 0 NONE (temporary/anon), 1 CHAT, 2 REPEATER, 3 ROOM, 4 SENSOR |
| 34 | 1 | u8 | flags: 0x01 favourite, 0x02 telemetry base allowed, 0x04 location allowed, 0x08 environment allowed, 0x10 remote CLI allowed (`ContactInfo.h`) |
| 35 | 1 | u8 | out_path_len: **0xFF = unknown (flood)**, else encoded (bits 6-7 hash size-1, bits 0-5 hop count). meshcore.js reads it as int8 (-1), which breaks 3-byte-hash paths (0x80-0xBF become negative). |
| 36 | 64 | bytes | out_path (first hops×hash_size bytes valid, rest undefined) |
| 100 | 32 | char[32] | name, NUL-padded (`strzcpy` guarantees a NUL in the last byte) |
| 132 | 4 | u32 | last_advert_timestamp (sender's clock) |
| 136 | 4 | i32 | gps_lat × 1e6 |
| 140 | 4 | i32 | gps_lon × 1e6 |
| 144 | 4 | u32 | lastmod (device RTC, last change) |

Total 148 bytes. In CMD_ADD_UPDATE_CONTACT, offsets 136-147 are optional (lat/lon need len ≥ 144, lastmod needs len ≥ 148).

### 7.2 GET_CONTACTS flow (emulator must reproduce) — `MM` L1238-1258, `checkSerialInterface` L2388-2413

1. `[0x04]` or `[0x04, since u32]`. If an iteration is running → `ERR 4`.
2. Reply immediately `[0x02, total u32]`.
3. In the main loop, when no command frame arrived in that iteration and the interface is not write-busy, the next contact slot is visited (excluding the 8 internal anon slots). If `lastmod > since` (strictly greater), send `[0x03 …]`.
4. When finished, send `[0x04, max_lastmod_sent u32]`.
- Commands may be interleaved during iteration (they are handled first). `APP_START` aborts the iteration silently (no END frame).
- Order = internal array order (insertion order; removals shift the array).
- Client strategy (meshcore-web, not firmware): a since-filtered reply cannot report deletions, but `total` counts every contact, so after merging an incremental reply into the cached list a size ≠ `total` means something was removed (additions always carry a fresh lastmod, except ADD_UPDATE_CONTACT with an explicit old lastmod, which also shows up as a mismatch) and a full sync follows. With that check the app reconnects incrementally: it saves the contacts and the cursor (largest END_OF_CONTACTS value seen) per radio and asks `since = cursor - 1` (the strict filter's boundary second) on the next connect, so an unchanged list costs CONTACTS_START, the boundary-second contacts and END_OF_CONTACTS. The saved state is ignored (full sync) for another radio's public key, or when the device RTC read at connect (before the time sync corrects it) is earlier than the cursor: the clock went backwards, so contacts changed since may carry a lastmod below it. Not detectable: a contact *modified* with a lastmod ≤ cursor (an RTC regression later corrected by another app, or ADD_UPDATE_CONTACT with an explicit old lastmod) — an explicit full sync recovers.

### 7.3 Contact add/advert behaviour — `BCM onAdvertRecv` L122-201, `MM` L304-340

- Auto-add if `manual_add_contacts & 1 == 0`. Otherwise only types whose bit is set in `autoadd_config` (0x02 chat, 0x04 repeater, 0x08 room, 0x10 sensor). `autoadd_config` bit 0x01 = overwrite the oldest non-favourite when full (CONTACT_DELETED push).
- `autoadd_max_hops`: 0 = no limit, N = accept only if hop count < N.
- Adverts with timestamp ≤ the stored `last_advert_timestamp` are ignored (replay protection), with no push.
- Adverts without a name are ignored.
- Each advert accepted from a contact: update name, type, lat/lon (only if present), last_advert_timestamp, lastmod=now. Push ADVERT (0x80). Also records `{prefix7, name, path}` in the 16-entry advert-path table (CMD 42).
- `lastmod` is also set to the RTC "now" when a PLAIN or SIGNED_PLAIN message is received from the contact (`BCM onPeerDataRecv` L236, L293) and when a PATH replaces its out_path (`BCM onContactPathRecv` L357), but not for CLI_DATA messages or RESET_PATH. Such contacts therefore reappear in a since-filtered GET_CONTACTS.
- Contacts added with CMD_ADD_UPDATE_CONTACT have no stored advert blob until an advert from them is received, so SHARE_CONTACT answers ERR 3 and EXPORT_CONTACT ERR 2 for them.

---

## 8. Text messages

| txt_type | Name | Sendable via CMD 2 | Notes |
|---|---|---|---|
| 0 | PLAIN | yes | ACKed; expected_ack returned |
| 1 | CLI_DATA | yes | not ACKed (SENT ack=0). The device replaces the timestamp with its own unique RTC time. |
| 2 | SIGNED_PLAIN | **no** (ERR 1) | received from room servers; 4-byte author prefix |
| 3 | CLI_COMMAND (v1.18+) | yes | not ACKed. The timestamp is replaced like CLI_DATA. |

- `attempt`: the low 2 bits go in the on-air flags byte. If attempt > 3, two bytes `0x00, attempt` follow the text inside the ciphertext (`BCM composeMsgPacket` L451-471). This changes the ACK only via `attempt&3`.
- Max text: 160 bytes (158 if attempt>3). Longer → `ERR 3`. Channel text is truncated so that `"name: " + text` ≤ 160 bytes.
- Timestamps: the host supplies the sender_timestamp (unix seconds) for PLAIN and channel messages, and the device uses it as given. The recipient reports it unchanged.
- Application conventions (not firmware): clients identify a message by these on-air fields. MeshCore Open's emoji reaction `r:<hash>:<idx>` hashes the sender_timestamp, the channel `"name: "` sender name (none for DMs) and the first 5 UTF-16 units of the text (`feature-inventory.md` §2.4b). A host that resends with a new timestamp must remember the new one, or reactions to it will not match.

---

## 9. Keys and signing

- Identity = Ed25519 (orlp/ed25519). The private key is the **64-byte expanded key** `SHA512(seed)` with clamping (`lib/ed25519/keypair.c`). The seed is not stored. EXPORT_PRIVATE_KEY returns these 64 bytes. To sign with this key in JS you need an expanded-key implementation; @noble's seed-based API cannot be used.
- Public key first byte 0x00/0xFF is avoided at key generation (reserved hashes, `MM begin` L951).
- SIGN_* signs the raw concatenated bytes with standard Ed25519 (`self_id.sign`). The result verifies with any Ed25519 verifier.

## 10. Timeouts (est_timeout in SENT) — `MM` L888-896

- Flood: `500 + 16 × airtime_ms(packet)`.
- Direct: `500 + (airtime_ms × 6 + 250) × (hops + 1)`, where hops = `out_path_len & 63`.

## 11. Version gating summary

The firmware gates **only** on `app_target_ver ≥ 3` (V3 message frames). Everything else is length-based or always on. Introduced-in versions come from source comments: "vN" = FIRMWARE_VER_CODE. The git history is shallow, so release dates are UNVERIFIED.

| Feature | Version |
|---|---|
| DEVICE_INFO max_contacts/max_channels; V3 msg frames (SNR) | v3 |
| Telemetry modes in SELF_INFO/SET_OTHER_PARAMS | v5 |
| multi_acks in SELF_INFO; ACL perms in LOGIN_SUCCESS | v7 |
| SET_FLOOD_SCOPE_KEY, SEND_CONTROL_DATA, GET_STATS, PUSH CONTROL_DATA | v8 |
| client repeat (SET_RADIO_PARAMS[11], DEVICE_INFO[80]) | v9 |
| path_hash_mode (DEVICE_INFO[81]); multi-byte path hashes (firmware v1.12+ per docs/packet_format.md) | v10 |
| TRACE flags path_sz | "v1.11+" (code comment) |
| SET_FLOOD_SCOPE_KEY `[1]=1` unscoped | v12 |
| ANON_REQ to non-contacts | v13 |
| RUN_CLI_COMMAND / CLI_REPLY; TXT_TYPE_CLI_COMMAND | v14 (fw v1.18) |
| STATS PACKETS recv_errors (30-byte frame) | UNVERIFIED (docs say 26 B is "legacy") |
| GET_CONTACTS `since` | UNVERIFIED (present in all versions inspected) |

## 12. meshcore.js vs firmware

Firmware-handled codes **missing from meshcore.js**: commands 21 (constant only, no sender), 28, 29, 30, 37, 40, 41, 42, 43, 51, 52, 55, 57, 58, 59, 60, 61, 63, 64, 65, 66. Responses 0x15, 0x16, 0x17, 0x19, 0x1A, 0x1C, 0x1D. Pushes 0x86 (constant defined but not dispatched), 0x8D, 0x8F, 0x90. meshcore.js uses no code that the firmware lacks.

meshcore.js parsing deviations: DEVICE_INFO tail (§2.3); SELF_INFO signedness; CONTACT_MSG txt_type 2 prefix (§6.2); TRACE SNR count (§6.7); LOGIN_SUCCESS truncated (§6.6); BATT storage ignored; out_path_len as int8 (§7.1); `readCString` returns `undefined` when there is no NUL; SetRadioParams omits the repeat byte (turns repeat off); SendTracePath always sends flags=0.

## 13. DOC vs firmware discrepancies

| DOC says | Firmware does |
|---|---|
| SEND_CHANNEL_TXT_MSG → PACKET_MSG_SENT (0x06) | `OK` (0x00) |
| PACKET_OK may carry a 32-bit value | always 1 byte |
| PACKET_ACK (0x82) = 6-byte ACK code | 4-byte ack + 4-byte round-trip ms |
| contact msg "Signature (4 bytes)" for txt_type 2 | the author's pubkey prefix (4 bytes), not a signature |
| channel data limit lines "MyMesh.cpp:1265" | the code is at L1198-1237 (line refs stale) |
| Example uses channel idx 1-7 | valid range is 0..MAX_GROUP_CHANNELS-1 (1, 8 or 40) |
| "Messages limited to 133 characters" | 160 bytes minus the `"name: "` prefix for channels; 160 for direct |
