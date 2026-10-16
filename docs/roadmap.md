# MeshCore Web — Product plan and roadmap

A web-only MeshCore companion client (TypeScript, Lit, no backend) that talks to
companion-firmware radios over Web Serial (USB) and Web Bluetooth (BLE). Functional
peer of [MeshCore Open](https://github.com/zjs81/meshcore-open) minus mobile-only
features, plus a byte-level packet inspector backed by IndexedDB.

Reference docs in this folder: `companion-protocol.md` (host↔device protocol, ground
truth = firmware companion-v1.18.0), `mesh-packet-format.md` (over-the-air packets),
`feature-inventory.md` (what MeshCore Open does), `meshcore-js-eval.md`.

## Product goals

1. **Works with real radios, correctly.** Every frame encoder/decoder is derived from the
   firmware source and covered by byte-exact tests. Quirks listed in
   `companion-protocol.md` §13 are honoured (MSG_WAITING + SYNC_NEXT_MESSAGE flow, ERR
   codes, encoded path_len byte, protocol version via DEVICE_QUERY, etc).
2. **Testable without hardware.** A faithful companion-device emulator (plus a tiny
   virtual mesh of emulated nodes) runs in-process. The client library is tested against
   it in node; the UI is tested against it in a real Chromium.
3. **Everything is recorded.** Every host↔device frame and every over-the-air packet the
   device reports (LOG_RX_DATA / RAW_DATA / TRACE_DATA pushes) is stored in IndexedDB with
   its radio metadata (SNR, RSSI, timestamp, direction, interface). A packet inspector
   explains each byte according to the protocol spec.
4. **Minimal dependencies.** Runtime: `lit` only (map tiles, if added, via a vendored
   minimal loader or `leaflet` as the single exception, decided in Phase 12). Dev:
   typescript, vite, vitest, playwright, fake-indexeddb.
5. **Local-first, privacy-preserving.** No server. All state in IndexedDB keyed by the
   connected radio's public key, so multiple radios can be used from one browser.

## Non-goals (v1)

Android Auto / Wear OS / push notifications / background service, translation, mesh
image codec, TCP transport (not available in browsers), Firefox/Safari support (no Web
Serial / Web Bluetooth).

## Architecture

```
packages/core   @meshcore-web/core   pure TS, no DOM; tested in node with vitest
  src/util/        bytes, hex, crc, sha256 (crypto.subtle), event emitter, async queue
  src/protocol/    constants (CMD/RESP/PUSH/ERR codes), encoders (host→device),
                   decoders (device→host) → discriminated-union typed frames
  src/framing/     serial '<'/'>' length-prefixed framer/deframer; BLE = 1 write = 1 frame
  src/transport/   FrameTransport interface; LoopbackTransport (in-process, to emulator);
                   WebSerialTransport; WebBluetoothTransport (both only touch
                   navigator.* through injectable factories so tests can mock them)
  src/client/      CompanionClient: request/response correlation, push dispatch,
                   message sync loop, contact sync, send-with-retry + ack matching,
                   remote (repeater/sensor) request mutex, typed API for every command
  src/packet/      Mesh packet parser + byte annotator (offset/len/name/value/meaning
                   tree) for the inspector; advert/txt/grp/ack/path/trace/req/resp
                   payloads; CayenneLPP; channel-message decryption when PSK known
  src/emulator/    CompanionEmulator (device state machine mirroring MyMesh.cpp),
                   VirtualMesh (several EmulatedNode instances sharing an "air", real
                   packet encoding, Ed25519/X25519-less fake crypto where allowed by tests
                   but real hashing for ack codes), scenario builders
  src/store/       IndexedDB schema + typed repositories: packets, frames, messages,
                   contacts, channels, devices, settings
  src/app/         Framework-agnostic application model (ConnectionManager, ChatModel,
                   ContactsModel, ChannelsModel, PacketLogModel, DeviceSettingsModel)
                   that the UI binds to. Observable via a tiny signal/event helper.

packages/web    @meshcore-web/web    Vite + Lit; tested with vitest browser mode in Chromium
  src/components/  <mc-app> shell + router, connect panel, contacts, chat, channels,
                   device settings, repeater admin, packet log, packet inspector, map
  src/testing/     mocks for navigator.serial / navigator.bluetooth that route frames to
                   an in-process CompanionEmulator, so UI tests are end-to-end
```

Principles: core has zero UI knowledge; UI components are thin and bind to `src/app`
models; every feature lands with tests first (core) and a browser test (web); no feature
is "done" until it works end-to-end against the emulator in Chromium.

## Delivery process

Each phase below is one or more subagent tasks. A phase is complete when:
`npm run typecheck && npm test && npm run build` pass, new behaviour has tests, the
docs under `docs/` are updated if the phase discovered protocol facts, and a commit is
made on `main`. Phases are sequential unless marked parallelisable.

## Roadmap

| # | Phase | Deliverable | Status |
|---|-------|-------------|--------|
| 0 | Research & scaffold | Protocol docs, feature inventory, monorepo with node + Chromium test pipelines | done |
| 1 | Protocol codec | `protocol/`: all CMD encoders, RESP/PUSH decoders, SELF_INFO/DEVICE_INFO/contact/channel/stats records, error mapping; byte-exact tests from firmware layouts | done |
| 2 | Framing & transports | Serial framer; `FrameTransport` interface; `LoopbackTransport`; `WebSerialTransport`; `WebBluetoothTransport` (MTU-aware, 1 frame per write/notify); browser tests with mocked `navigator.serial`/`navigator.bluetooth` | done |
| 3 | Companion emulator + virtual mesh | `CompanionEmulator` implementing the firmware behaviour for every command in Phase 1 (contacts DB, msg queue + MSG_WAITING, ack hashing, protocol-version gating, ERR semantics, remote-request mutex); `VirtualMesh` with emulated chat/repeater/room/sensor nodes producing real on-air packets (adverts, txt, grp txt, acks, path, trace, status/telemetry responses); scenario helpers | 3a packet codec + 3b emulator done; 3c virtual mesh pending |
| 4 | CompanionClient | Typed client over any `FrameTransport`: handshake (APP_START, DEVICE_QUERY), contacts sync (since-timestamp), message sync loop, send DM/channel with retry + ack/SEND_CONFIRMED matching + timeouts, adverts, time, radio/advert/other params, channels, repeater/sensor requests, signing, key export/import; full integration test suite against the emulator | |
| 5 | Packet decoder & store | `packet/` parser + annotator covering all payload types and `mesh-packet-format.md`; `store/` IndexedDB schema and repositories with migration; capture pipeline: every frame and every LOG_RX/RAW/TRACE push persisted with metadata; tests with fake-indexeddb | |
| 6 | App model + web shell | `app/` models; `<mc-app>` with router, connect panel (Serial / BLE / Emulator), device info header, connection state, error toasts; e2e browser tests using in-process emulator via mocked navigator APIs | |
| 7 | Contacts & direct messages | Contact list (type icons, last seen, path, SNR), add/remove/share/reset path, DM chat with status (pending/sent/delivered/failed), retries, unread counts, message persistence | |
| 8 | Channels | Channel list from device (GET_CHANNEL), add/edit (name + PSK / hashtag channels), group chat with "sender: text" convention, reply/reaction conventions from `feature-inventory.md` | |
| 9 | Packet log & inspector | Packet log view with filters (direction, type, node, time), live tail, per-packet inspector showing hex dump with the annotation tree, decrypted view when key known, frame-level log of host↔device traffic, export/import JSON | |
| 10 | Repeater / room / sensor admin | Login, status, telemetry, CLI (send command text, show replies), trace path, path discovery, neighbours; room-server posts | |
| 11 | Device settings | Name, lat/lon, radio params (freq/bw/sf/cr/tx power), advert interval/flood settings, other params, tuning, time sync, battery, stats, export/import private key, reboot/factory reset, manual-add / auto-add flags, advert send (flood / zero-hop) | |
| 12 | Map & polish | Node map (contacts with location, own location), PWA manifest + offline shell, keyboard/accessibility pass, settings export, README user guide, release build | |

Cross-cutting, tracked per phase: protocol version gating (V1/V3 message pushes),
multiple-radio support (store keyed by pubkey), error handling and reconnect.

## Risks and open questions

- BLE behaviour on nRF52 (notification splitting) and ESP32 (4-frame TX queue) is only
  partly verified; Phase 2 keeps the BLE transport conservative (MTU ≥ 179 request, reassembly
  tolerant of split notifications if ever observed) and Phase 10/11 features will be
  validated on real hardware by the user.
- Decrypting over-the-air DMs in the inspector requires the device's private key
  (exportable via EXPORT_PRIVATE_KEY, 64-byte expanded key) and X25519 — kept optional
  and off by default; channel decryption only needs the PSK.
- Map tiles need a tile source; decided in Phase 12.
