# MeshCore Open: Feature Inventory (for web re-implementation)

Source: `scratchpad/ref/meshcore-open` (Flutter client, app `9.5.0+18`, docs reviewed 2026-10-11). Read-only survey of `README.md`, `documentation/*.md`, `docs/BLE_PROTOCOL.md`, and `lib/` (249 Dart files, ~216k lines). Protocol names and file references were checked against `lib/connector/meshcore_protocol.dart`, `lib/connector/meshcore_connector.dart`, and `lib/services/image_chunk_transport.dart`.

Platform tags used below:
- **N**: platform-neutral (works on the web build, subject to browser limits noted in section 4)
- **M**: mobile-only (Android, sometimes iOS)
- **NW**: native-only, i.e. not available in the web build
- **USB/TCP/BLE**: transport-specific

---

## 1. User-facing screens and features

### 1.1 Connection

| Feature | Platform | Behavior |
|---|---|---|
| Scanner (home) | N (BLE part NW on web) | Launch screen. Shows status bar (Not connected / Scanning / Connecting / Connected / Disconnecting) and device list with RSSI-coloured icons (green >= -60, light green -60..-70, amber -70..-80, orange -80..-90, red < -90 dBm). Scan runs 10 s then stops. |
| BLE connect | NW (web blocked, see section 4) | Filters on Nordic UART Service UUID `6e400001-…`; names are not filters. 15 s connect timeout (6 s Linux), MTU 185, subscribe to TX notify. Auto-reconnect with backoff 1,2,4,8,16,30,30… s; disabled on manual disconnect. |
| USB serial connect | USB (desktop, Android, Chrome web via Web Serial) | Port list (desktop polls every 2 s for hot-plug; mobile uses Scan FAB). Platform-specific error messages. Not auto-reconnected. |
| TCP connect | NW (not web) | Host + port (1–65535), last values pre-filled. Auto-reconnects dropped links with backoff; TCP keepalive 30 s/10 s/3 probes. |
| Disconnect | N | Confirmation dialog from overflow menus. Unexpected disconnect returns user to Scanner. |
| Review mode (hidden) | N | Long-press the title on Scanner, then Enter. Simulated companion radio (6 contacts, 3 channels, periodic incoming messages, auto-replies). Used for store reviewers. Works on web; no OS notifications. |

### 1.2 Navigation shell

| Feature | Platform | Behavior |
|---|---|---|
| QuickSwitchBar | N | M3 NavigationBar with three tabs: 0 Contacts, 1 Channels, 2 Map. Channels shown first after connect. Flat navigation (no back between tabs). |
| Theme | N | System / Light / Dark, user-selectable. |
| Language | N | System or one of 18 locales (ARB files in `lib/l10n`). |

### 1.3 Contacts

| Feature | Platform | Behavior |
|---|---|---|
| Contact list | N | Avatar by type (Chat blue, Repeater amber, Room magenta, Sensor teal). Shows name, path label (Direct / N hops / Flood, plus forced variants), short pubkey, unread pill, relative last-seen, favorite star, GPS pin icon. Pull-to-refresh re-fetches from device. |
| Search and filter | N | Name or pubkey-prefix search (300 ms debounce). Sort: latest message, heard recently, A-Z. Filter: All, Favorites, Users, Repeaters, Rooms, Unread. |
| Contact groups | N | Client-side groups (name unique, case-insensitive, "all" reserved), stored per radio identity. |
| Tap actions | N | Chat/Sensor opens chat. Repeater or Room prompts for password, then Repeater Hub or Room chat. |
| Long-press menu | N | Ping/Path Trace (repeaters, rooms, chats with path), Manage Repeater, Room Login, Room Management, favorite toggle, Share (copies `meshcore://<hex>`), zero-hop share, delete (device and local messages). |
| Overflow menu | N | Discovered Contacts; Add from clipboard (`meshcore://`); zero-hop advert; flood advert; copy own advert URI; disconnect; settings. |
| Add contacts | N | Auto-add by type (Settings). Clipboard import. QR scan (camera; gallery QR on scanner screen). |
| Discovered Contacts | N | Heard-but-not-added nodes. Tap imports. Radar "Scan for nearby nodes" (fw code 8+) with live results (~12 s). Export/import JSON (up to 2 MB). Evicts to 500 most recent when enabled. |

### 1.4 Direct messages

| Feature | Platform | Behavior |
|---|---|---|
| Chat screen | N | Bubbles (outgoing right, incoming left, 72% max width). Avatar = initial or first emoji, colour hashed from name. Links are tappable. Pinch zoom 0.8x-1.8x. Jump-to-bottom FAB. Older messages loaded on scroll-up. Arrival-order display; clock-warning icon if sender time is >5 min in future. |
| Composer | N | UTF-8 limit 156 bytes (enforced live). Attach menu: GIF, share location. Translate toggle (not on web). Enter sends on desktop. |
| Message types | N | Text; GIF (`g:<id>`, Giphy CDN); location pin (`m:<lat>,<lon>\|<label>\|`); reaction (`r:<hash4hex>:<emoji2hex>`, §2.4b); URL image preview (per-contact opt-in, internet). |
| Reactions | N | Long-press incoming message (own messages cannot be reacted to), pick emoji (quick set or full picker). Chips under the bubble with counts; channels: tap a chip for a "who reacted" report. Own DM reaction pending (until ACK) = 50% opacity + spinner; failed = retry button. Implemented in MeshCore Web (issue #5), §2.4b. |
| Context actions | N | Copy, View path, Delete (local only), Mark unread, Retry (failed), Translate (NW), Open chat with sender (room messages). |
| Routing sheet | N | Auto / Direct / Flood, plus recent paths (hops, RTT, age, success count). Clear path on max retry (setting). |
| Chat settings | N | SMAZ compression, URL image previews, contact-level settings. |
| Clear chat | N | Overflow menu. |
| Telemetry and info | N | Overflow menu: Info, Telemetry (remote sensor), Settings. |

### 1.5 Channels

| Feature | Platform | Behavior |
|---|---|---|
| Channel list | N | Cards with type icon (Public green/globe, Hashtag blue, Private blue/lock, Community magenta), name, unread badge. Search (300 ms). Sort: manual (drag), A-Z, latest, unread. Pull-to-refresh re-syncs from firmware. "+" FAB. |
| Create or join | N | Create private (random PSK, 31-byte name), join private (32-hex PSK, separators stripped), join public (well-known PSK), join hashtag (PSK = SHA-256 of name), join community (HMAC-SHA256), scan community QR, create community (32-byte secret, QR share). |
| Edit channel | N | Name, PSK (dice = random), SMAZ toggle, Cyr2Lat toggle, URL images, region override. Delete removes device slot and local data (confirmed). |
| Channel chat | N | Sender avatar + name on incoming. Outgoing status (pending clock, sent check, failed red). Bell = mute. Title tap = region picker. Message tracing shows `via XX,YY` path prefixes. |
| Replies | N | Long-press "Reply" (all platforms); swipe-to-reply on mobile for incoming. Sent as `@[sender] text`. Received replies show quoted block; tap to scroll. Original region reused by default. |
| Path view | N | Long-press "Path": summary card, other observed paths, hop list with prefix, resolved name, GPS. Radar (trace) and map buttons. |
| Mesh images | NW (no codec on web) | Send compressed image as GRP_DATA chunks (fw 11+), with optional XOR recovery packet. Receive, reassemble (60 s partial expiry), reconstruct via ONNX model. |
| Auto-resend | N | Optional: resend until a repeat is heard through N hops (1-8), up to 1-5 times; can count different first-hop repeaters. |
| Communities | N | Manage Communities sheet (show QR, leave = deletes derived channels). Community QR scanner. |

### 1.6 Repeater and room administration

| Feature | Platform | Behavior |
|---|---|---|
| Login dialog | N | Password (up to 20 typed, firmware uses 15), save password, routing selector, up to 5 retries on timeout. Wrong password stops immediately. Optional auto clock sync. |
| Repeater Hub | N | Header card (name, key, path, GPS), battery chemistry selector. Cards: Status, Telemetry, Neighbors (all users); CLI, Settings (admin only). Room hub shows Room Management / Room Guest titles. |
| Status | N | System info (battery, clock, uptime, queue, error count), radio stats (RSSI, SNR, noise floor, airtime), packet stats (flood vs direct). Auto-queries on open. |
| Telemetry | N | Cayenne LPP cards. Channel 1 = battery and MCU temperature. |
| Neighbors | N | Up to 15 neighbors: name (resolved from contacts), time since heard, SNR quality. |
| CLI | N (admin) | Terminal-style: history, up/down arrows, 9 quick commands, help reference of all CLI commands, "debug next command" raw frame view, one automatic retry on timeout. |
| Settings | N (admin) | Nine cards: Basic (name, admin/guest passwords), Radio (freq, TX power, BW, SF, CR, RX gain), Location, Features (repeat, guest access, multi-acks, auto clock sync), Network health (loop detect, duty cycle), Advert intervals, Owner info, Actions (advert, zero-hop advert, clock sync), Advanced (path hash mode, TX delay, interference threshold, AGC). Danger zone: reboot, erase (serial only, no command sent). Fields refreshed individually; sent sequentially with 200 ms gaps. |
| Region commands on repeaters | N | Repeater region list/allow/deny/home commands via CLI (the app does not configure repeater regions directly beyond CLI). |

### 1.7 Map and location

| Feature | Platform | Behavior |
|---|---|---|
| Map view | N | flutter_map with OpenStreetMap (live) or Stadia raster styles (keyed). Markers by type: chat blue, repeater green, room purple, sensor orange; labels at zoom >= 14. Self location from device (never phone GPS). |
| Filters | N | Show chat / repeater / other / guessed / discovery / overlapping / shared pins; key-prefix filter; last-seen slider (up to 6 months); units metric or imperial. |
| Guessed locations | N | Positions inferred from path hops through repeaters with known GPS (runs in background isolate). Single anchor = 330 m circle; 2+ anchors = weighted average. Marked `~`. |
| Shared pins | N | Location messages appear as flags: blue DM, purple private channel, orange public channel. Track history per sender+label. |
| Share marker | N | Long-press empty map: label, then send to DM or channel (`m:…\|poi`). Or set as my location. |
| Path trace map | N | Animated polyline of hop path with SNR per hop, Single/Combined toggle, play/step/speed (0.5x-4x), follow-packet camera lock. |
| Line of sight | N (needs internet for elevation) | Open-Meteo elevation profile (21/41/81 points, 24 h cache). Clear / marginal / blocked status. Custom pins. K-factor 4/3 baseline. |
| Offline tile cache | N (tiles from Stadia need API key) | Pick bounds + zoom range (3-18), estimated tile count, 8 concurrent downloads. |
| Network map (opt-in) | N | Local / Online / Both views. Online = hexagons (2-3 km) from map.meshcoreopen.org with reachability hints; "Add to contacts"; "Manage". Contributing data is opt-in (no message text, no exact coordinates). |
| GPX export | NW | Export Repeaters / Contacts / All with GPS to `.gpx` (share sheet). Docs say not on web. |

### 1.8 Device settings (connected radio)

| Feature | Platform | Behavior |
|---|---|---|
| Device info | N | Collapsed card: name, ID, status, battery (% or V, alert at <= 15%), node name, public key prefix, contact count, channel count. |
| Node name | N | Max 31 chars, sent to device. |
| Radio settings | N | Regional presets; freq 300-2500 MHz; BW 7.8-500 kHz; SF5-12; CR 4/5-4/8; TX power 0..device max; Client Repeat (fw 9+, off-grid freqs only). Reboot may be required. |
| Regions | N (radio default fw 11+, unscoped fw 12+) | Saved region-name list (lowercase, digits, hyphen, 30 chars), fetch from repeaters, app default, radio default (writes to radio). |
| Location | N | Lat/lon (+-90, +-180). GPS hardware: update interval 60-86399 s, enable GPS. |
| Contact settings | N | Auto-add chat, repeater, room, sensor; overwrite oldest. |
| Privacy | N | Advert location, multi-ack, telemetry base/location/environment modes (deny / by contact / all). |
| Actions | N | Sync time, refresh contacts, reboot (confirm), delete all paths (confirm). |
| Radio stats | N (fw 8+) | Noise floor, last RSSI, last SNR, TX/RX airtime, recent noise chart (120 samples, 1 s polling while open). Self telemetry shortcut. |

### 1.9 App settings (local only, not sent to device)

| Area | Settings | Platform |
|---|---|---|
| Appearance | Theme, language | N |
| Notifications | Master, message, channel, advert toggles; per-channel mute | M (web: none) |
| Messaging | Clear path on max retry; jump to oldest unread; auto route rotation (weights, max retries 2-10); message tracing; region chip placement; channel auto-resend | N |
| Battery | Chemistry NMC / LiFePO4 / LiPo (per device) | N |
| Map display | Show repeaters/chat/other; time filter; units; tile source; offline cache entry | N |
| Translation | Enable, auto-translate, translate before send, target language, model download (llamadart GGUF) | NW (hidden on web) |
| Image messages | Enable, auto-process, model download (~1 GB ONNX) | NW |
| Cyr2Lat | Profiles (add/edit/delete) | N |
| Network map | Opt-in upload toggle | N |
| Debug | App debug log toggle | N |

### 1.10 Diagnostics

| Feature | Platform | Behavior |
|---|---|---|
| BLE debug log | N (BLE frames only from BLE transport) | Frames view (direction, description, hex, timestamp; long-press copy) and Raw RX view (decoded LoRa packets: route type, payload type, path). Copy all, clear. |
| App debug log | N | Structured Info/Warning/Error entries with tag. Must be enabled in App Settings. |
| Frame debug viewer | N | Shown in repeater CLI "debug next command". |
| Connection/help text | N | Troubleshooting doc: BLE, USB, browser (Chrome + HTTPS), unexpected disconnect. |

### 1.11 Mobile-only and platform-specific features

| Feature | Platform | Notes |
|---|---|---|
| Android Auto | M (Android) | Notification-based. Read aloud, reply by voice or suggested reply, mark as read. No in-car UI, no new-message-by-voice. |
| Wear OS / Galaxy watch | M (Android) | Reply and mute from watch notifications. |
| Notification reply and mute actions | M (Android) | Reply (split up to 3 messages at word boundaries), mark as read (local only), mute channel. iOS/macOS/Windows/Linux: no reply actions. |
| Message notifications | M, iOS, macOS, Windows, Linux (not web) | Channels: `channel_messages`; DMs: conversation style; adverts batched over 5 s. Min 3 s between alerts. |
| Background service | M (Android foreground service) | Persistent "MeshCore running" notification. Keeps BLE/TCP alive. No auto-start on reboot. |
| Dock/app icon badge | iOS, macOS | Total unread count. |
| Image picker / save | M, desktop | Gallery pick, save reconstructed image. |
| Share sheet exports | M, desktop (not web) | GPX, discovered-contacts JSON (web: download fallback if status unavailable). |
| Haptics, swipe-to-reply | M | Swipe on incoming channel messages. |
| Desktop right-click menus | Desktop (Linux, Windows, macOS) | Right-click = long-press. Enter sends. |
| Ports polling / hot-plug | Desktop | USB port list refresh every 2 s. |

Platform-neutral in practice: connection-independent UI (contacts, chat, channels, map, repeater admin, settings, diagnostics, review mode). Mobile-only: Android Auto, watches, notification replies, background service. Native-only: BLE, TCP, GPX export, translation, image codec.

---

## 2. Companion protocol usage

Frame layer: BLE uses raw payload writes to NUS RX (`6e400002-…`) and notifies on TX (`6e400003-…`). USB and TCP use framing `0x3C len_lo len_hi payload` out and `0x3E len_lo len_hi payload` in (max payload 172 bytes). The web USB path implements the same framing over Web Serial (`lib/services/usb_serial_service_web.dart`, `lib/services/usb_serial_frame_codec.dart`).

Constants are defined in `lib/connector/meshcore_protocol.dart` (lines 177-295); frame builders are in the same file. "Sent from" lists the call sites that build the frame. "Handled in" lists receive sites in `lib/connector/meshcore_connector.dart` (switch around lines 5888-6071) unless noted.

### 2.1 Commands (app to device)

| Code | Name | Sent from | Notes |
|---|---|---|---|
| 1 | CMD_APP_START | `meshcore_connector.dart` (`buildAppStartFrame`) | Reply: SELF_INFO (5) |
| 2 | CMD_SEND_TXT_MSG | `meshcore_connector.dart` (`buildSendTextMsgFrame`) | Also used for CLI: `buildSendCliCommandFrame` (`meshcore_protocol.dart:913`) from `screens/repeater_cli_screen.dart`, `services/repeater_command_service.dart`, `widgets/repeater_login_dialog.dart`. Txt type 1, 6-byte pubkey prefix. |
| 3 | CMD_SEND_CHANNEL_TXT_MSG | `meshcore_connector.dart` (`buildSendChannelTextMsgFrame`) | |
| 4 | CMD_GET_CONTACTS | `meshcore_connector.dart` (`buildGetContactsFrame`) | Optional `since`. Replies 2/3/4. |
| 5 | CMD_GET_DEVICE_TIME | Not sent (`buildGetDeviceTimeFrame` unused) | Listed in docs, dead code. |
| 6 | CMD_SET_DEVICE_TIME | `meshcore_connector.dart` | Clock sync. |
| 7 | CMD_SEND_SELF_ADVERT | `meshcore_connector.dart` | Flood or zero-hop flag. |
| 8 | CMD_SET_ADVERT_NAME | `meshcore_connector.dart` | Node name. |
| 9 | CMD_ADD_UPDATE_CONTACT | `buildUpdateContactPathFrame`, used in `meshcore_connector.dart` and `utils/contact_qr_frame.dart` | Path update / contact add. |
| 10 | CMD_SYNC_NEXT_MESSAGE | `meshcore_connector.dart` (`buildSyncNextMessageFrame`) | Drain offline queue. |
| 11 | CMD_SET_RADIO_PARAMS | `meshcore_connector.dart` | |
| 12 | CMD_SET_RADIO_TX_POWER | `widgets/radio_settings_dialog.dart` | |
| 13 | CMD_RESET_PATH | `meshcore_connector.dart` | |
| 14 | CMD_SET_ADVERT_LATLON | `meshcore_connector.dart` | "Set as my location". |
| 15 | CMD_REMOVE_CONTACT | `meshcore_connector.dart` | Delete contact. |
| 16 | CMD_SHARE_CONTACT | Constant only, no builder found | Docs describe share via advert then URI. |
| 17 | CMD_EXPORT_CONTACT | `screens/contacts_screen.dart` (`buildExportContactFrame`) | Reply 11. |
| 18 | CMD_IMPORT_CONTACT | `screens/contacts_screen.dart`, `utils/contact_qr.dart`, `utils/contact_qr_frame.dart` | QR / clipboard import. |
| 19 | CMD_REBOOT | `meshcore_connector.dart` (`buildRebootFrame`) | |
| 20 | CMD_GET_BATT_AND_STORAGE | `meshcore_connector.dart` | Reply 12. |
| 22 | CMD_DEVICE_QUERY | `meshcore_connector.dart` | Reply 13 (DEVICE_INFO). |
| 26 | CMD_SEND_LOGIN | `widgets/repeater_login_dialog.dart`, `widgets/room_login_dialog.dart` | Push 0x85/0x86. |
| 27 | CMD_SEND_STATUS_REQ | `screens/repeater_status_screen.dart` | Push 0x87. |
| 30 | CMD_GET_CONTACT_BY_KEY | `meshcore_connector.dart` | |
| 31 | CMD_GET_CHANNEL | `meshcore_connector.dart` | Reply 18. |
| 32 | CMD_SET_CHANNEL | `meshcore_connector.dart` | Name + PSK. |
| 36 | CMD_SEND_TRACE_PATH | `screens/path_trace_map.dart` (`buildTraceReq`) | Push 0x89. |
| 38 | CMD_SET_OTHER_PARAMS | `meshcore_connector.dart` | Privacy / misc. |
| 39 | CMD_SEND_TELEMETRY_REQ | `screens/telemetry_screen.dart` | |
| 40 | CMD_GET_CUSTOM_VAR | `meshcore_connector.dart` (`buildGetCustomVarsFrame`) | Reply 21. |
| 41 | CMD_SET_CUSTOM_VAR | `meshcore_connector.dart` (`buildSetCustomVarFrame`) | GPS interval and similar. |
| 50 | CMD_SEND_BINARY_REQ | `screens/neighbors_screen.dart`, `screens/telemetry_screen.dart` | Push 0x8C. |
| 54 | CMD_SET_FLOOD_SCOPE_KEY | `meshcore_connector.dart` (`buildSetFloodScopeFrame`, `buildSetFloodScopeUnscopedFrame`) | Per-send scope; `[54,0]` clears, `[54,1]` unscoped (fw 12+). |
| 55 | CMD_SEND_CONTROL_DATA | `meshcore_connector.dart`, `screens/region_management_screen.dart` | Zero-hop discovery. Push 0x8E. |
| 56 | CMD_GET_STATS | `meshcore_connector.dart` (`buildGetStatsFrame`) | Reply 24. |
| 57 | CMD_SEND_ANON_REQ | `screens/region_management_screen.dart` | Region query. |
| 58 | CMD_SET_AUTO_ADD_CONFIG | `meshcore_connector.dart`, `screens/settings_screen.dart` | Bitmask (section 3). |
| 59 | CMD_GET_AUTO_ADD_CONFIG | `meshcore_connector.dart`, `screens/settings_screen.dart` | Reply 25. |
| 60 | CMD_GET_ALLOWED_REPEAT_FREQ | `meshcore_connector.dart` | Reply 26. **Not in `documentation/ble-protocol.md`.** |
| 61 | CMD_SET_PATH_HASH_MODE | `meshcore_connector.dart` | Hop width 1-3 bytes. |
| 62 | CMD_SEND_CHANNEL_DATA | `services/image_chunk_transport.dart:1232` | Image GRP_DATA chunks, fw 11+. Constant defined in image_chunk_transport.dart, not the protocol file. |
| 63 | CMD_SET_DEFAULT_FLOOD_SCOPE | `meshcore_connector.dart` (`buildSetDefaultFloodScopeFrame`) | fw 11+. |
| 64 | CMD_GET_DEFAULT_FLOOD_SCOPE | `meshcore_connector.dart` (`buildGetDefaultFloodScopeFrame`) | fw 11+. Reply 28. |

Not used by the app: CMD_RUN_CLI_COMMAND (66), per the docs (not verified in code).

### 2.2 Responses (device to app)

| Code | Name | Handled in |
|---|---|---|
| 0 | RESP_CODE_OK | `meshcore_connector.dart:5888` |
| 1 | RESP_CODE_ERR | `meshcore_connector.dart:6071` |
| 2 / 3 / 4 | CONTACTS_START / CONTACT / END_OF_CONTACTS | `meshcore_connector.dart:5898, 5935, 5968` (contact frame 148 bytes, `models/contact.dart`) |
| 5 | SELF_INFO | `meshcore_connector.dart:5894` |
| 6 | SENT | `meshcore_connector.dart:6023` (`[1]=is_flood, [2-5]=ack_hash, [6-9]=est_timeout_ms`) |
| 7 / 16 | CONTACT_MSG_RECV (v2 / v3) | `meshcore_connector.dart:5982-5983`, `models/message.dart` |
| 8 / 17 | CHANNEL_MSG_RECV (v2 / v3) | `meshcore_connector.dart:5991-5999`, `models/channel_message.dart` |
| 9 | CURR_TIME | Parsed in `review_mode/review_frames.dart`; app-side handling in `pending_command_replies.dart` |
| 10 | NO_MORE_MESSAGES | `meshcore_connector.dart:6028` |
| 11 | EXPORT_CONTACT | `meshcore_connector.dart:6026`, `screens/contacts_screen.dart` |
| 12 | BATT_AND_STORAGE | `meshcore_connector.dart:6061` |
| 13 | DEVICE_INFO | `meshcore_connector.dart` (device info path) |
| 18 | CHANNEL_INFO | `meshcore_connector.dart:6054`, `models/channel.dart` |
| 21 | CUSTOM_VARS | `meshcore_connector.dart:6067` |
| 24 | STATS | `meshcore_connector.dart:6064`, `models/companion_radio_stats.dart` |
| 25 | AUTO_ADD_CONFIG | `meshcore_connector.dart:6057` |
| 26 | ALLOWED_REPEAT_FREQ | `meshcore_connector.dart:5956`. **Not in docs.** |
| 27 | CHANNEL_DATA_RECV | `meshcore_connector.dart:6002`, `services/image_chunk_transport.dart:1280` |
| 28 | DEFAULT_FLOOD_SCOPE | `meshcore_connector.dart:5962` |

### 2.3 Pushes (unsolicited, device to app)

| Code | Name | Handled in |
|---|---|---|
| 0x80 | PUSH_ADVERT | `meshcore_connector.dart:5921` (known contact re-seen) |
| 0x81 | PUSH_PATH_UPDATED | `meshcore_connector.dart:6037` |
| 0x82 | PUSH_SEND_CONFIRMED | `meshcore_connector.dart:6034` (ACK hash + trip time) |
| 0x83 | PUSH_MSG_WAITING | `meshcore_connector.dart:6031` (triggers SYNC_NEXT_MESSAGE drain) |
| 0x85 / 0x86 | LOGIN_SUCCESS / LOGIN_FAIL | `meshcore_connector.dart:6043, 6046`; login dialogs |
| 0x87 | STATUS_RESPONSE | `meshcore_connector.dart:6047`, `screens/repeater_status_screen.dart` |
| 0x88 | LOG_RX_DATA | `meshcore_connector.dart:6049` (SNR int8 in 1/4 dB, RSSI, raw packet); also `services/network_map/network_map_upload_service.dart` |
| 0x89 | TRACE_DATA | `screens/path_trace_map.dart` |
| 0x8A | NEW_ADVERT | `meshcore_connector.dart:5931` (new node; triggers advert notification) |
| 0x8B | TELEMETRY_RESPONSE | `screens/telemetry_screen.dart` |
| 0x8C | BINARY_RESPONSE | `screens/neighbors_screen.dart`, `screens/telemetry_screen.dart`, `screens/region_management_screen.dart` |
| 0x8E | CONTROL_DATA | `meshcore_connector.dart:6040`, `screens/region_management_screen.dart` (discovery responses) |
| 0x8F | CONTACT_DELETED | `meshcore_connector.dart:5944`. **Not in docs.** |
| 0x90 | CONTACTS_FULL | `meshcore_connector.dart:5947`. **Not in docs.** |

Over-the-air payload types (inside LOG_RX_DATA raw packets, `meshcore_protocol.dart:309-329`): REQ 0x00, RESPONSE 0x01, TXTMSG 0x02, ACK 0x03, ADVERT 0x04, GRPTXT 0x05, GRPDATA 0x06, ANONREQ 0x07, PATH 0x08, TRACE 0x09, MULTIPART 0x0A, CONTROL 0x0B, RAW_CUSTOM 0x0F.

### 2.4 Application-level conventions carried in text payloads

| Convention | Format | Where |
|---|---|---|
| Channel sender prefix | `"<name>: <text>"` in GRPTXT payload (sender is plain text, not verified) | `meshcore_protocol.dart:317`; docs channels.md |
| Reply | `@[<senderName>] <text>` | docs chat/channels |
| Reaction | `r:<hash 4 hex>:<emoji idx 2 hex>` — see §2.4b | `lib/helpers/reaction_helper.dart` |
| GIF | `g:<giphy id>` | docs |
| Location pin | `m:<lat>,<lon>\|<label>\|<type>` | docs map-and-location |
| SMAZ compressed | `s:<base64>` (only if shorter) — see §2.4a | `lib/helpers/smaz.dart` |
| Community QR | JSON `{"v":1,"type":"meshcore_community","name":…,"k":<base64url secret>}` | docs channels |
| Contact share | `meshcore://<hex advert packet>` | docs contacts |
| Hop path bytes | `hops * width` bytes; width 1-3 per hop | docs routing-paths |

### 2.4a SMAZ compression (implemented in MeshCore Web, issue #8)

Derived from `lib/helpers/smaz.dart` and its callers (`connector/meshcore_connector.dart`
`prepareContactOutboundText` / `prepareChannelOutboundText` / the CONTACT_MSG and GRP_TXT receive
paths, `models/channel_message.dart`, `storage/{contact,channel}_settings_store.dart`,
`screens/chat_screen.dart`, `screens/channels_screen.dart`). Web implementation:
`packages/core/src/util/smaz.ts`.

- **No protocol flag.** There is no txt_type value, flag byte or attempt bit for compression. The
  message is an ordinary `TXT_TYPE_PLAIN` text whose content is `"s:" + base64(smaz(utf8(text)))`
  (standard base64 alphabet with `=` padding). The firmware treats it as any other text (ACK hash,
  160-byte limit and, for channels, the `"<name>: "` prefix all apply to the envelope).
- **Codebook / stream.** The 254-entry antirez smaz codebook (`" "`, `"the"`, `"e"`, … `".com"`;
  longest entry 7 bytes, `"http://"`). Byte 0..253 = codebook index; `254 b` = one verbatim byte;
  `255 n b0..bn` = n+1 verbatim bytes (runs split at 256). Greedy longest match at each position.
  Example: `"This is a small string"` (22 B) → `fe 54 4c 38 ac 3e ad 98 3e c3 46` (11 B) →
  `s:/lRMOKw+rZg+w0Y=` (18 B).
- **Send.** Only when the per-contact / per-channel setting is on, and only if the envelope is
  strictly shorter in bytes than the plain text; otherwise the plain text is sent. Never applied
  to empty text, text already starting with `s:`, or the structured payloads `g:` (GIF), `m:`
  (location) and, for DMs, `V1|` (checked on the trimmed text). A reply's `@[name] ` prefix is
  inside the compressed text (the whole outgoing text is compressed). For channels the app sends
  the envelope and the firmware prepends `"<name>: "`, so on air it is `"<name>: s:…"`. The DM ACK
  hash is over the envelope. Retries re-run the transform (MeshCore Web: a record sent compressed
  is resent compressed).
- **Receive.** Decoding is attempted on *every* incoming plain / signed DM and channel message,
  regardless of the setting (CLI replies are excluded). For channels the `"<name>: "` prefix is
  split off first and only the message part is decoded. `tryDecodePrefixed` ignores leading
  whitespace, requires `s:` plus at least one character, accepts standard or URL-safe base64 with
  optional padding, and only accepts a payload that decompresses to valid UTF-8, re-compresses to
  the identical bytes, and whose envelope (`2 + base64 length`) is shorter than the decoded bytes.
  Anything else (`"s:test"`, `"s: hello"`) is shown as typed. Very short ambiguous texts could
  still match; this is accepted upstream.
- **Settings.** Local only, default off: `contact_smaz_<pubkeyhex>` and `channel_smaz_<channel id>`.
  DM toggle: chat screen → contact settings dialog, "SMAZ compression — Compress outgoing
  messages", committed immediately. Channel toggle: edit-channel sheet, saved with the form.
  SMAZ and Cyr2Lat are mutually exclusive in MeshCore Open (Cyr2Lat is not implemented here).
- **Byte budget.** With the setting on, the composer counts the bytes of the transformed (on-air)
  text against the limit.
- **MeshCore Web.** `ContactRecord.smaz` / `ChannelRecord.smaz` (optional, absent = off, so no DB
  migration; preserved across device syncs). `MessageRecord.text` is always the plain text;
  `MessageRecord.compressed` marks messages sent or received as an envelope. Toggles: chat page
  composer ("Compress messages (SMAZ, MeshCore Open compatible)", DMs and channels) and the
  channel add/edit dialog. `ChatModel.byteLimit` no longer subtracts the reply prefix while
  compression is on (the prefix is compressed with the text and counted in `budget().used`).

### 2.4b Emoji reactions (implemented in MeshCore Web, issue #5)

Derived from `lib/helpers/reaction_helper.dart` (+ `test/reaction_helper_test.dart`),
`lib/widgets/emoji_picker.dart`, `lib/widgets/reaction_chips.dart`, `connector/meshcore_connector.dart`
(`sendMessage`, `sendChannelMessage`, `_addMessage`, `_addChannelMessage`, `_setReactionStatus`),
`models/{message,channel_message}.dart`, `screens/{chat,channel_chat}_screen.dart`. Web
implementation: `packages/core/src/app/reactions.ts`.

- **Wire format.** An ordinary `TXT_TYPE_PLAIN` DM or channel text, exactly
  `^r:([0-9a-f]{4}):([0-9a-f]{2})$` (lowercase; 9 bytes; on a channel the device sends
  `"<name>: r:…"`). No flag, no txt_type.
- **Hash (4 hex).** `stableStringHash(input) & 0xFFFF`, zero-padded lowercase hex, where `input` is
  the decimal sender timestamp (secs), then the sender name (channels: the `"name: "` sender of
  the target; DMs: omitted), then the first 5 UTF-16 code units of the target's text
  (`substring(0, 5)`). `stableStringHash` is the Dart VM `String.hashCode`: one-at-a-time over
  UTF-16 units (`h += u; h += h << 10; h ^= h >>> 6`, then `h += h << 3; h ^= h >>> 11;
  h += h << 15`, 32-bit), masked to 30 bits, 0 → 1. Vectors: `(1700000000, "Bob", "hello")` →
  `e779`; `(1700000000, none, "hi")` → `b5bd`; `(1700000000, "Привет😀", "x")` → `7fee`. The text is
  the decoded text (SMAZ undone); channel replies are hashed without their `@[name] ` prefix
  (MeshCore Open stores channel replies stripped). Room servers hash with the post's author name
  (not supported in MeshCore Web, which does not store room authors).
- **Emoji index (2 hex).** Position in a fixed 184-entry list: quick set (6: 👍 ❤️ 😂 🎉 👏 🔥), then
  smileys (64), gestures (33), hearts (32), objects (49), copied verbatim from `EmojiPicker`
  (multi-code-point entries such as `❤️` = U+2764 U+FE0F matter). Duplicates take the first index
  (👍 = `00`, ❤️ = `01`, 🚀 = `b7`). Out-of-range indices do not parse.
- **SMAZ.** DM reactions go through `prepareContactOutboundText` (not exempt like `g:`/`m:`), but a
  9-byte reaction never compresses shorter (checked over all 65536 × 184 texts), so it is always plain. Channel reactions bypass
  `prepareChannelOutboundText` and are never compressed. Received `s:` texts are decoded before
  parsing.
- **Receive / matching.** A parsed reaction is matched against the newest message in the
  conversation whose hash is equal: DMs only against our outgoing messages, channels against all
  messages. A match adds the reactor (DM: the contact's name; channel: the `"name: "` sender) under
  that emoji and the reaction is not shown as a message. An unmatched `r:` is silently dropped
  (no orphan store). Duplicates (same target, emoji, sender) are ignored (MeshCore Open: per
  session, in memory; MeshCore Web: persisted).
- **MeshCoreOne reactions** (receive only): `[@[target sender]]<emoji>\n<8 Crockford base32>` or the
  legacy `<emoji>[@[target sender]]\n<hash>`; the emoji must be one grapheme starting ≥ U+2000 or
  containing U+FE0F / U+20E3. Hash = lowercase Crockford base32 of the first 5 bytes of
  SHA-256(utf8(text) ‖ u32le(timestamp)) (vector: `(1234567890, "Hello world!")` → `tyvbkb33`),
  matched together with the target sender (empty for DMs). Unmatched ones are shown as ordinary
  messages.
- **Send / status.** Only incoming messages offer "Add reaction". DMs: the reaction is applied
  locally at once and sent through the normal retry/ACK path; `reactionStatuses[emoji]` tracks
  pending → delivered / failed; the chip is 50% opacity with a spinner while pending (or sent),
  and a failed chip is a retry button that resends. Channels: applied locally and sent once, no
  status (MeshCore Web marks a channel reaction failed if the radio rejects it).
- **MeshCore Web.** `MessageRecord.reactions?: { emoji, sender, own?, status?, at }[]` (optional;
  no migration). The capture pipeline attaches incoming reactions (`MessagesRepo.addReaction`);
  `ChatModel.react / retryReaction / reactions / canReact`. UI: "☺+" button, right-click or
  long-press on an incoming bubble opens the picker; chips list who reacted in their tooltip.
  Retrying a failed message now records its new sender timestamp, so reactions to it match.

---

## 3. Persistence and UX conventions

### 3.1 What is stored (from `documentation/ble-protocol.md`)

Storage is SharedPreferences (JSON strings), no SQLite. Files are used for image bundles, received images, and map tiles.

| Data | Key pattern | Scope |
|---|---|---|
| Contacts | `contacts<pubKey10>` | Per radio identity (first 10 hex of pubkey) |
| Direct messages | `messages_<pubKey10><contactKey>` | Per radio + contact; up to 1000 stored, 200 in memory |
| Channel messages | `channel_messages_<pubKey10>_<channelId>` | Per radio + channel |
| Channel list and order | `channels<pubKey10>`, `channel_order_<pubKey10>`, `channel_slot_ids_<pubKey10>` | Per radio |
| Channel settings | `channel_{smaz,cyr2lat,url_images}_…`, region | Per radio + channel |
| channelId | first 8 bytes of SHA-256("meshcore-channel:" + PSK), hex | Key-based, survives slot reuse |
| Contact groups | `contact_groups<pubKey10>` | Per radio |
| Communities | `communities_v1<pubKey10>` | Per radio |
| Unread counts | `contact_unread_count<pubKey10>` (and channel equivalents) | Per radio |
| Discovered contacts | `discovered_contacts<pubKey10>` (cap 500) | Per radio |
| Path history | `path_history_<contactKey>` (50 contacts x 100 entries, in memory LRU) | Per contact |
| Timeout ML observations | Persisted with 2 s debounce | Global |
| Region names | `regions` | Global |
| Channel region | `channel_region_<pubKey10>_<channelId>`; default `default_region_<pubKey10>` | Per radio |
| App settings | `app_settings` | Global |

Lost data cases: deleting a channel removes its history; re-adding with the same PSK restores it. Reusing a slot starts clean.

Debug logs (BLE frames, app log): storage behaviour not verified in this survey.

### 3.2 Message status

| Status | Icon | Meaning |
|---|---|---|
| Pending | Grey double check | Queued or handed to device. Same icon as Sent. |
| Sent | Grey double check | Device confirmed transmit (RESP 6). |
| Delivered | Green double check | Remote ACK received (PUSH 0x82 or late ACK in grace window). |
| Failed | Red X | Retries exhausted. |

Channel messages have pending / sent / failed only (no ACK, so never "delivered"). Channel status icons: clock, check, red error circle.

### 3.3 Retries (direct messages)

| Item | Behavior |
|---|---|
| Expected ACK | `SHA256([timestamp][attempt][text][selfPubKey])[0:4]` (uses SMAZ text when enabled). |
| Timeout | Preferred: ML predictor (1.5x margin, after 10 observations); else device `est_timeout` (RESP 6); else airtime formula `500 + (airtime*6+250) * (pathLen+…)`. Fallback `3000 + 3000*hops` ms. |
| Backoff | `1000 * 2^retryCount` ms. |
| Max retries | Default 5, range 2-10. |
| Grace | 30 s after failure, late ACK still resolves to delivered. |
| In-flight | One message per contact (firmware ACK table holds 8). Others queued. |
| Path handling | Auto route rotation (weights: max 5, initial 3.0, success +0.5, failure -0.2). Clear path on max retry (optional). |
| Manual | Long-press failed message, then Retry. |
| Channel auto-resend | Optional: resend until heard through N hops (1-8), up to 1-5 times. |

### 3.4 Path display

| Item | Convention |
|---|---|
| Path label | "Direct", "N hops", "Flood", "flood (auto)", "direct (forced)". |
| Path bytes | Rendered as `A1A2 → B1B2 → C1C2` (per-hop prefix, width-aware). |
| Routing modes | Auto / Direct / Flood, plus manual path overrides. |
| Recent paths | Hops, RTT, age, success count; colour per repeater. |
| Message trace | `via XX,YY,…` prefix bytes, timestamp, repeat count, RTT. |
| Estimated map positions | `~` prefix; grey border = one anchor, coloured = two or more. |

### 3.5 SNR and signal

| Item | Convention |
|---|---|
| Radio SNR | int8 in 1/4 dB units in LOG_RX_DATA (0x88). |
| RSSI bands (scanner) | >= -60 green; -60..-70 light green; -70..-80 amber; -80..-90 orange; < -90 red. |
| Remote SNR | Repeater status (last RSSI/SNR, noise floor), neighbors (SNR quality icon), path trace (per-hop SNR icons). |
| Radio stats | Last RSSI/SNR, noise floor, airtime. |
| Discovery | "They heard us at … dB" on node scan results. |

### 3.6 Channel "sender: text" convention

- Sent as `"<sender>: <text>"` inside the GRPTXT payload. The sender name is part of the encrypted payload text, not a verified identity (docs: "Plain text prefix in payload").
- Display: sender name in primary colour above the bubble (incoming). Avatar initial or first emoji.
- Byte budget: 160 minus sender name bytes minus 2 (name counted as 31 bytes if unknown).
- Replies: `@[name] text`.

### 3.7 Unread counts

- Stored per contact (pubkey) and per channel, scoped to radio identity.
- Opening a chat or channel resets count to 0 and cancels its OS notification.
- Excluded: outgoing, CLI messages, repeater contacts.
- Badge cap "9999+". Debounced write (500 ms).
- "Mark as Unread" on an incoming message marks it and later incoming messages unread.
- No per-contact mute (channel mute only).

### 3.8 Other UX rules

- Message length: DM 156 bytes UTF-8; channel 160 minus name minus 2.
- Arrival-order sorting (not sender clock). Future-timestamp icon if >5 min ahead.
- Delete is local only; mesh is not affected.
- Long-press (right-click on desktop) is the universal context-menu gesture.
- Review mode banner: "Send test message" and "Exit".

---

## 4. Web build specifics

Sources: `documentation/README.md`, `documentation/navigation.md`, `documentation/scanner-and-connection.md`, plus code references.

### 4.1 Supported browsers and origin

- Chrome and Chromium browsers that identify as Chrome (Edge, Brave). Firefox and Safari have no Web Serial.
- Non-Chromium: `ChromeRequiredScreen` replaces the app (`lib/main.dart:476`, `lib/utils/browser_detection_web.dart:4-7` user-agent check).
- Needs a secure origin (HTTPS or localhost).
- Flutter web pinned to 3.41.2 (README). Build: `flutter build web --release`. Hosted at meshcoreopen.org/install/web.

### 4.2 Transports on web

| Transport | Web status | Evidence |
|---|---|---|
| USB (Web Serial) | Supported | `lib/services/usb_serial_service_web.dart` (`navigator.serial`, `package:web`), `UsbScreen` via `PlatformInfo.supportsUsbSerial` (`lib/utils/platform_info.dart:45-46`). User picks port via browser chooser. Framing as in section 2. Not auto-reconnected. |
| BLE | Blocked in UI | `scanner_screen.dart:218-224`: scan button shows "not supported in browser" snackbar. Docs state BLE not available on web. |
| TCP | Unavailable | `lib/services/tcp_transport_service_web.dart` throws `UnsupportedError`. TCP button hidden (`scanner_screen.dart:131`). |

Inconsistency to note: `meshcore_connector.dart` contains extensive `PlatformInfo.isWeb` branches for a Bluetooth-on-web path (lines ~2366, 2772, 2924-3059, 3981-4185, 4183-4190: handshake retries every 10 s x3, `setNotifyValue` logging, self-info gating). The scanner comment says `flutter_blue_plus` "has no web backend". Treat the web BLE branches as unverified dead or experimental code, and do not plan on BLE in the web port.

### 4.3 Features gated off on web

| Feature | Web behavior | Evidence |
|---|---|---|
| OS notifications | Disabled (`_canNotify = false`) | `lib/services/notification_service.dart:155, 217` |
| Background service | No-op (Android only) | `lib/services/background_service.dart` |
| Translation | Settings section hidden; service returns false | `app_settings_screen.dart:111`, `translation_service.dart:565` |
| Image codec (mesh images) | Unavailable | `image_codec_service.dart:193, 391, 505`; `image_codec_backend.dart:881` |
| GPX export | Unavailable (snackbar) | docs `map-and-location.md`, `additional-features.md`; `lib/utils/gpx_export.dart` |
| Share sheet exports | Web treats an "unavailable" share result as delivered (`discovery_screen.dart:458`) | `discovery_screen.dart:458` |
| Chat image save | Desktop save dialog vs. mobile share (`lib/utils/image_save.dart:24`); web path not verified | `lib/utils/image_save.dart` |
| Android Auto / watches / notification replies | Not applicable | |
| Repeater "erase filesystem" | Serial only; no OTA command | docs `repeater-management.md` |

### 4.4 Web-specific connection handling (for reference)

- Web resets handshake state on connect (`meshcore_connector.dart:2772`).
- Initial channel sync is gated for USB, TCP, review, and web BLE (`_shouldGateInitialChannelSync`, around line 3485).
- Devices on web wait for stop-scan before connecting (`meshcore_connector.dart:2366-2370`).

### 4.5 Storage on web (inferred)

- `shared_preferences` on web maps to `localStorage`. Per-origin, cleared with site data. The 1000-message and 500-discovered caps apply the same way.
- Media files (image bundles, received images, map tile cache) rely on native file stores. Web variants are stubs (`*_stub.dart`, `*_file_store*.dart`). Assume no offline tile cache and no received-image storage on web unless verified.

### 4.6 Features that work on web (from the platform matrix)

Core messaging, channels, contacts, map (OSM live view), repeater hub (status, telemetry, neighbors, CLI, settings), device settings (radio, location, privacy, regions), network map (local and online views, opt-in upload; no web gating found in `lib/services/network_map`), review mode, GIFs (Giphy), URL image previews, reactions, replies, path trace, LOS (Open-Meteo, needs internet), QR scan (camera permission).

---

## 5. Items to confirm before implementing

1. Web BLE: whether `flutter_blue_plus` web is actually reachable in this build (scanner blocks it; connector has branches).
2. Tile cache on web: `lib/services/map_tile_cache_service.dart` was not inspected for web gating.
3. Protocol constants present in code but absent from `documentation/ble-protocol.md`: CMD 60, RESP 26, PUSH 0x8F, PUSH 0x90, CMD 62 and RESP 27 (defined in `image_chunk_transport.dart`). Use the code as source of truth.
4. CMD_GET_DEVICE_TIME (5) is defined but unused. Device clock is set with CMD 6 only.
5. CMD_SHARE_CONTACT (16) has no builder. Contact share goes through export (17) or advert.
6. Channel messages have no ACK in firmware, so "delivered" is DM-only.
