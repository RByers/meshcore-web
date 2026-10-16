# Protocol conformance review (host side vs firmware companion-v1.18.0)

Independent review of the host implementation against the firmware source (`.ref/MeshCore`, tag
`companion-v1.18.0`, `FIRMWARE_VER_CODE 14`), not against our docs or emulator. Line numbers refer
to `.ref/MeshCore/examples/companion_radio/MyMesh.cpp` unless another file is named.

Severity: **breaks** = misbehaves against a real device; **subtle** = wrong in some situations or
can silently corrupt device state; **cosmetic** = wrong display or error, no protocol impact.

## Verified conformant (no discrepancy found)

- **Command codes, response codes, push codes, error codes** (`constants.ts`) match L9-139.
- **Every command layout in `encode.ts`** checked against `handleCmdFrame` L1055-2060. That covers
  APP_START (≥ 8 bytes, name at [8]), SEND_TXT_MSG, SEND_CHANNEL_TXT_MSG, GET_CONTACTS since,
  SET_RADIO_PARAMS (freq kHz, bw Hz, repeat byte), TX power i8, lat/lon i32 ×1e6, tuning ×1000,
  SET_OTHER_PARAMS suffix rules, TELEMETRY_REQ ([1..3] reserved, key at [4], self = 4 bytes),
  GET_ADVERT_PATH / PATH_DISCOVERY reserved byte, TRACE flags = path_sz with 1<<path_sz hashes,
  SET_CHANNEL 2+32+16, SEND_CHANNEL_DATA path/data_type u16 LE, flood scope commands, default
  scope 1+31+16, RAW_PACKET priority, CLI ≥ 3 bytes, the REBOOT/FACTORY_RESET magic strings and
  the IMPORT_CONTACT length guard.
- **Every response/push layout in `decode.ts`** checked: SELF_INFO offsets 1..58 (L1076-1117),
  DEVICE_INFO incl. v9/v10 tail (L1056-1075), contact record 148 B (L170-192), V1/V3 contact and
  channel messages incl. the SIGNED_PLAIN 4-byte author prefix (L440-596), CHANNEL_DATA_RECV
  (L601-640), SENT (10 B), BATT (u16+u32+u32), STATS core/radio/packets (L1914-1964), ADVERT_PATH,
  TUNING, AUTOADD, ALLOWED_REPEAT_FREQ, DEFAULT_FLOOD_SCOPE, CLI_REPLY, SEND_CONFIRMED
  (ack + round trip, L413-431), LOG_RX_DATA (L278-289), RAW_DATA/CONTROL_DATA (L820-865),
  LOGIN_SUCCESS legacy/new (L696-735), STATUS/TELEMETRY/BINARY responses (L736-790),
  PATH_DISCOVERY_RESPONSE (L795-818), TRACE_DATA (L867-899, SNR count = path_len >> path_sz,
  matches `Mesh.cpp` L42-68). Signedness matches: SNR i8/4, RSSI i8, noise floor i16, lat/lon i32.
- **Strings**: fixed char[32] fields cut at the first NUL. SELF_INFO name and message text run to
  the frame end with no NUL. Non-fatal UTF-8 decode, which matters because the firmware truncates
  text at `MAX_FRAME_SIZE` bytes and can split a code point.
- **Serial framing** (`serial-framer.ts`) matches `ArduinoSerialInterface.cpp`: host→device `'<'`,
  device→host `'>'`, u16 LE length, N = 0 ignored, max 176.
- **BLE**: NUS UUIDs match the esp32/nrf52/rp2040 `SerialBLEInterface`. RX is written, TX
  notifies, one write or notification = one frame. Name prefix "MeshCore-" (MyMesh.h L66). On
  nRF52 the name is in the scan response and the service is advertised, so either filter matches.
- **Handshake**: DEVICE_QUERY with app_target_ver 3 (same as meshcore.js), then APP_START.
  `app_target_ver` only gates the V3 message frames (L443, L561), and we decode both V1 and V3.
- **Correlation**: one command in flight, codes < 0x80 answer it, pushes ≥ 0x80. GET_CONTACTS
  streams START / CONTACT×n / END from the main loop (L2392-2410), END carries the max lastmod of
  the contacts actually sent (0 if none) and the client handles 0. SEND_CHANNEL_TXT_MSG → OK.
- **Message drain**: SYNC_NEXT_MESSAGE until NO_MORE_MESSAGES (L1415-1423). The queue holds only
  contact/channel messages and channel data, which matches MESSAGE_KINDS.
- **ACK matching**: SENT.tag = expected_ack (L1150-1170) is compared as the same LE u32 as
  SEND_CONFIRMED[1..4]. For CLI_DATA/CLI_COMMAND the tag is 0 and no ACK comes. Retries: the ACK
  covers `attempt & 3` (BaseChatMesh `composeMsgPacket`), so attempt 4 has the same ACK as attempt
  0. Matching against the set of codes handles that. Long texts (> 158 B) are clamped to attempt ≤ 3
  as the firmware requires.
- **Remote request matching** (L677-790, L1577-1740): login and status match on the pubkey
  prefix, telemetry/binary/anon on the tag, path discovery on the tag (pushed with the prefix).
  The device keeps only one pending request (`clearPendingReqs`), and the client serializes them.
  Remote CLI: the repeater/room server replies with TXT_TYPE_CLI_DATA (simple_repeater
  MyMesh.cpp L749).
- **Time sync**: SET_DEVICE_TIME rejects times earlier than the RTC (L1287-1296). The client only
  moves the clock forward and ignores the ERR.
- **ACK code / channel hash** (`payloads.ts`): plain = SHA256(ts‖flags‖text‖sender key)[0..4],
  signed = …‖receiver key (BaseChatMesh L234-306). Channel hash = SHA256(psk16 or psk32)[0]
  depending on the upper half (BaseChatMesh `setChannel` L933-946). The TRACE packet hash includes
  a u16 path_len (`Packet.h` L47). All match.

## Discrepancies

| # | Where | Firmware | We did | Severity | Status |
|---|---|---|---|---|---|
| 1 | `client/companion-client.ts` `setRadioParams` | SET_RADIO_PARAMS always sets client repeat from [11], and an absent byte means off (L1424-1458) | sent `clientRepeat ?? false`, so changing frequency/SF silently **disabled client repeat** on v9+ devices (meshcore.js has the same bug, §12) | subtle (breaks repeat mode) | **fixed**: defaults to DEVICE_INFO.clientRepeat; cache updated |
| 2 | `protocol/writer.ts` `writeContactRecord`, `client.addOrUpdateContact` | a NEW contact is built in an uninitialised stack `ContactInfo`, and `updateContactFromFrame` copies gps only if present (L194-216, L1328-1348) | omitted lat/lon when not given (contacts-model "add by public key" does this) → **garbage coordinates stored on the device** | subtle | **fixed**: lat/lon always encoded (0 default). The client fills them from the cached contact so an update does not wipe a known location |
| 3 | `transport/web-bluetooth.ts` | nRF52 BLEUart RX = WRITE \| WRITE_NR, and `onBleUartRX` reads all buffered RX bytes as ONE frame (nrf52/SerialBLEInterface.cpp L365-400) | write-without-response whenever advertised, so back-to-back unacknowledged writes could merge into one corrupt frame. A long (> MTU-3) write is also only possible with response | subtle (nRF52 only) | **fixed**: write-with-response by default (as meshcore.js `writeValue`); `preferWriteWithResponse: false` opts out. Web transport test updated |
| 4 | `client/companion-client.ts` `#pump` | ESP32/nRF52 require an encrypted, MITM-bonded link (`ESP_GATT_PERM_WRITE_ENC_MITM`, `SECMODE_ENC_WITH_MITM`). The first write to an unbonded device blocks during the OS PIN dialog | the reply timer (5 s) started before the write, so DEVICE_QUERY timed out during pairing. The client then fell back to "old firmware" (no DEVICE_INFO, wrong max channels) and the late DEVICE_INFO was ignored | subtle (first BLE connect) | **fixed**: the reply timeout runs from write completion, with a 60 s cap on the write itself |
| 5 | `client/companion-client.ts` `syncContacts` | the `since` filter is strict `lastmod > since` at 1 s resolution (L2397) | incremental sync used since = last mostRecentLastMod, so a contact modified later in that same second was missed | subtle | **fixed**: queries `since - 1`; boundary contacts are re-sent harmlessly |
| 6 | `client` `sendTextMessage` | text > 160 B (> 158 B with attempt > 3) → `composeMsgPacket` NULL → ERR **TABLE_FULL**. Empty text → frame < 14 → ERR UNSUPPORTED_CMD | no host-side check, so the user sees a misleading "table full" | cosmetic | not fixed. `app/messaging.ts` already enforces the byte limits in the UI path, and emulator tests rely on sending over-long text |
| 7 | `client` `sendChannelMessage` | the firmware silently truncates to 160 − len("name: ") bytes, possibly mid-UTF-8 (BaseChatMesh L518-535) | no client check | cosmetic | not fixed (enforced in `app/messaging.ts`) |
| 8 | `client` `login` | password truncated to 15 bytes (BaseChatMesh `sendLogin`) | no check | cosmetic | not fixed (consistent with how repeaters store it) |
| 9 | `store/packet-log.ts` `packetInputFromFrame` (TRACE) | the received TRACE packet's header path_len = SNR count (`Mesh.cpp` L55-61), and the packet hash includes path_len | rebuilt the TRACE record with `pathLen = frame.pathLen` (hash byte count), so its packet hash never matches the same packet seen via LOG_RX_DATA | cosmetic | not fixed (should be `frame.snrs.length`) |
| 10 | `app/radio-presets.ts` `findRadioPreset` | SELF_INFO freq/bw = `(uint32_t)(float × 1000)` (L1103-1106), which truncates | exact kHz match. ~0.5 % of integer kHz values read back 1 kHz low (e.g. 512001 → 512000). None of the shipped presets are affected (checked) | cosmetic | not fixed (allow ±1 kHz) |
| 11 | `client` request correlation | no request ids; a reply that arrives after our timeout answers whatever is in flight next. A GET_CONTACTS that times out keeps streaming CONTACT frames, and a following GET_CONTACT_BY_KEY would take one | first-matching-kind wins | subtle (only after a timeout) | not fixed (inherent; partly mitigated by #4) |
| 12 | firmware `expected_ack_table` (8 entries, L285) | older entries are overwritten | parallel retries to several contacts (5 attempts each) can push an early attempt's ACK out of the table, so its SEND_CONFIRMED never arrives | subtle | not fixed (later attempts still confirm; per-contact sends are serialized) |
| 13 | `emulator/companion-emulator.ts` `#addUpdateContact` | uninitialised gps for a new contact without lat/lon | zero-initialises, so it shares misunderstanding #2 | cosmetic (test fidelity) | not fixed. The encoder no longer omits the field, so this path is unreachable from our client |

## Could not be verified without hardware

- **Web Serial DTR/RTS on open**: on ESP32 boards with USB-UART auto-reset (CP210x/CH340) or
  USB-Serial-JTAG, Chrome asserting DTR/RTS on `open()` may reset the board. The first
  DEVICE_QUERY/APP_START would then be lost while it boots. Neither meshcore.js nor we call
  `setSignals`. If connects fail on such boards, add `setSignals({dataTerminalReady: false,
  requestToSend: false})` or a retry after a boot delay.
- **ESP32 BLE MTU**: the firmware sets the local MTU to 176 (esp32 SerialBLEInterface L27). That
  allows only 173-byte notifications, so 174-176-byte frames (e.g. a V3 DM with 158-160 text
  bytes) may be truncated by the stack. Firmware-side issue; our decoder tolerates truncated text.
- **First BLE write during pairing**: whether Chrome holds the write until bonding completes, or
  fails it with an insufficient-authentication error, depends on the OS. A failed write now fails
  `connect()` with a TransportError; retrying the connect should work once bonded.
- **ESP32 send queue (4 frames, 60 ms spacing)**: bursts of LOG_RX_DATA pushes can be dropped by
  the firmware. This is not visible to the host and not fixable host-side.
- Long BLE writes (> MTU-3) via prepared writes on ESP32 Bluedroid: believed supported, untested.

## Not reviewed in depth (time)

- `protocol/encode-frame.ts` and `protocol/decode-command.ts` (emulator side). Only spot-checked,
  via the round-trip tests.
- `app/packet-log-model.ts` beyond how it labels LOG_RX/RAW frames. `packet/payloads.ts` beyond
  the ACK and channel-hash functions.
- `protocol/annotate-frame.ts`.
