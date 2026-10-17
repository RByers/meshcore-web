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
   its radio metadata (SNR, RSSI, timestamp, direction, interface). Packets the app asks the
   radio to send are logged too (direction `tx`, from the command frame: the device does not
   echo them, so firmware-built packets such as DMs and channel messages are recorded as the
   requested fields without on-air bytes, `format: 'none'`). A packet inspector
   explains each byte according to the protocol spec.
4. **Minimal dependencies.** Runtime: `lit` only (Phase 12 decided against Leaflet: the
   map is an in-house tile view, see "Phase 12 notes"). Dev:
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
                   VirtualMesh (MeshNode chat/repeater/room/sensor nodes sharing an "air":
                   real packets via packet/, real Ed25519/X25519/AES/HMAC crypto run
                   synchronously (crypto-sync.ts) so ManualClock tests stay deterministic),
                   scenario builders
  src/store/       IndexedDB schema + typed repositories: packets, frames, messages,
                   contacts, channels, devices, settings
  src/app/         Framework-agnostic application model (ConnectionManager, ChatModel,
                   ContactsModel, ChannelsModel, PacketLogModel, DeviceSettingsModel,
                   MapModel + geo maths)
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
| 3 | Companion emulator + virtual mesh | `CompanionEmulator` implementing the firmware behaviour for every command in Phase 1 (contacts DB, msg queue + MSG_WAITING, ack hashing, protocol-version gating, ERR semantics, remote-request mutex); `VirtualMesh` with emulated chat/repeater/room/sensor nodes producing real on-air packets (adverts, txt, grp txt, acks, path, trace, status/telemetry responses); scenario helpers | done (3a packet codec, 3b emulator, 3c virtual mesh) |
| 4 | CompanionClient | Typed client over any `FrameTransport`: handshake (APP_START, DEVICE_QUERY), contacts sync (since-timestamp), message sync loop, send DM/channel with retry + ack/SEND_CONFIRMED matching + timeouts, adverts, time, radio/advert/other params, channels, repeater/sensor requests, signing, key export/import; full integration test suite against the emulator | done |
| 5 | Packet decoder & store | `packet/` parser + annotator covering all payload types and `mesh-packet-format.md`; `store/` IndexedDB schema and repositories with migration; capture pipeline: every frame and every LOG_RX/RAW/TRACE push persisted with metadata; tests with fake-indexeddb | done (capture pipeline wiring in Phase 6) |
| 6 | App model + web shell | `app/` models; `<mc-app>` with router, connect panel (Serial / BLE / Emulator), device info header, connection state, error toasts; e2e browser tests using in-process emulator via mocked navigator APIs | done |
| 7 | Contacts & direct messages | Contact list (type icons, last seen, path, SNR), add/remove/share/reset path, DM chat with status (pending/sent/delivered/failed), retries, unread counts, message persistence | done |
| 8 | Channels | Channel list from device (GET_CHANNEL), add/edit (name + PSK / hashtag channels), group chat with "sender: text" convention, reply/reaction conventions from `feature-inventory.md` | done |
| 9 | Packet log & inspector | Packet log view with filters (direction, type, node, time), live tail, per-packet inspector showing hex dump with the annotation tree, decrypted view when key known, frame-level log of host↔device traffic, export/import JSON | done; DM text in rows (with the opt-in radio key) added for issue #10; sent (tx) entries for issue #9 |
| 10 | Repeater / room / sensor admin | Login, status, telemetry, CLI (send command text, show replies), trace path, path discovery, neighbours; room-server posts | done |
| 11 | Device settings | Name, lat/lon, radio params (freq/bw/sf/cr/tx power), advert interval/flood settings, other params, tuning, time sync, battery, stats, export/import private key, reboot/factory reset, manual-add / auto-add flags, advert send (flood / zero-hop) | done |
| 12 | Map & polish | Node map (contacts with location, own location), PWA manifest + offline shell, keyboard/accessibility pass, settings export, README user guide, release build | done (see Phase 12 notes; settings export not done) |

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
- Map tiles: decided in Phase 12 (OpenStreetMap tiles by default, configurable template; see below).

## Phase 12 notes and decisions

**Map (no Leaflet).** The map is `<mc-tile-map>` (`packages/web/src/components/tile-map.ts`), a
small Web Mercator raster-tile view with drag/touch pan, wheel/pinch and keyboard zoom, and
focusable markers. The maths (projection, tile maths, haversine distance, bearing, fit-bounds)
is in `packages/core/src/app/geo.ts`; state (markers from contacts with a location, own
position from SELF_INFO, kind / max-age filters, selection, distance + bearing) is
`MapModel` (`map-model.ts`). This keeps the runtime dependency list at `lit` only. Tiles come
from OpenStreetMap's standard tile server (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`,
attribution always shown) by default; the template is configurable on the Map page
("Tile source") and stored in preferences, so users can point at their own or a commercial
tile server (OSM's tile usage policy is not meant for heavy use). Tiles are fetched directly
by the browser and are never cached by the service worker.

**PWA.** `packages/web/public/manifest.webmanifest` (standalone, theme `#0b63c9`, background
`#f6f7f9`, SVG + 192/512 PNG icons rendered from `icon.svg` by
`packages/web/scripts/render-icons.mjs` with playwright's Chromium). `public/sw.js` is a
hand-written service worker (no Workbox): on install it fetches `./` and caches it plus every
`./assets/…` URL referenced in it and the manifest/icons; navigations are network-first with
the cached `index.html` as offline fallback; `assets/` (content-hashed) are cache-first with
a background refresh; everything else (tiles, other origins, non-GET) passes through. The SW
is registered only in production builds (`import.meta.env.PROD`) as
`./sw.js?v=<__BUILD_ID__>`; the build id is injected by vite `define`, so each deploy installs
a new worker with a new cache (`meshcore-web-<build id>`) and old caches are deleted on
activate. All paths are relative, so the build works from any base path. "Install app" on
the Settings page appears only when Chromium fires `beforeinstallprompt`.

**Polish.** App-level error boundary (`packages/web/src/error-boundary.ts`: window `error` /
`unhandledrejection` → deduplicated error toast + `console.error`), `prefers-reduced-motion`
guard (shared styles and `index.html`), About section in Settings (version from
`packages/web/package.json`, build date, repository link via the single `REPO_URL` constant in
`packages/web/src/build-info.ts`, MIT licence, MeshCore credits). Docs: `docs/user-guide.md`,
rewritten `README.md`, `LICENSE`.

**Message signal (issue #11).** A relayed message's SNR describes only the last hop, so the
message meta shows the hop count and the SNR only for zero-hop messages (last-hop SNR in the
tooltip; 0xFF path_len reads "direct route"). The capture pipeline records a per-contact direct
signal (`ContactRecord.directSnr` / `directSnrAt`, local fields kept across syncs) from zero-hop
adverts and messages, shown as "direct SNR" in the contacts list, chat header and node page.

**Contact info (issue #12).** `/contact/:key` shows a contact's type, key, path, direct signal,
last seen, location and notes, with links to chat / node / map. Channel sender names link to it
when exactly one contact has the name (several → the contacts list searched by name; core
`resolveSenderName`, `ContactsModel.senderTarget` / `showByName`); the DM header name links too.

**Show on map (issue #13).** `/map/node/:key` (same page, nav highlights Map via the route's
`navParent`) calls `MapModel.focus(key)`, which selects the contact's marker and re-enables a
kind / age filter that would hide it; the page centres on it at zoom ≥ 14. The chat header
(contacts) and the node page header show a "Map" link when the contact has a location; the map's
details card links back to the chat / node page.

**Path views (issue #2).** Every "N hops" label (message meta in DM / channel chats, the chat
subtitle and node header path, the map card, packet log rows and the packet inspector's Path
row) is an `<mc-hops-link>` that fires `mc-show-path` with a core `PathRequest`; `<mc-app>`
opens its single `<mc-path-dialog>`: the stops in order (origin, hops, destination) with the
resolved name, the candidates when several contacts share a hash, or the hex hash, plus the
route drawn on `<mc-tile-map>` (new `.lines` polylines and `approximate` / `glyph` markers).
Maths is core: `path-geometry.ts` (hash → contacts, preferring repeaters for hops; Mercator-linear
interpolation between located stops and extrapolation past the first / last; ambiguous hops
take the candidate nearest the estimate; no map when nothing is located) and `path-model.ts`
(`app.contactPaths`: contact out_path, logged packets, messages). Messages only carry path_len, so their
hashes are recovered from the packet log (the TXT_MSG from the contact / GRP_TXT with the channel
hash and the same path_len heard nearest the arrival); otherwise only the hop count is shown.
Not linked: the contacts list row (the row is itself a link). Hop hashes are matched by issue #3's
`path-resolver.ts` (`resolveHop`); a message's stored `MessageRecord.path` is used before the
packet-log search.

**Path as node names (issue #3).** App setting `AppSettingsModel.pathNames` ("Show path as node
names", Settings page): paths render as "Alice > Bob > a3" (hop hash → contact via
`path-resolver.ts`, repeaters / rooms preferred, unknown → hex, shared hash → "a3?" with the
candidates in the tooltip) in message meta, the chat header, contacts list, contact info, node
page and packet log; still wrapped in the hops link. The capture pipeline matches each incoming
flood message to its LOG_RX_DATA packet (`rx-path-correlator.ts`) and stores the path bytes in
`MessageRecord.path` (optional, best effort).

**Approximate positions (issue #7).** App setting `AppSettingsModel.approximatePositions`
(default off; Settings page and the map filter bar): contacts without a location get a dashed "?"
marker near the located repeater / room server they were most recently heard through (the issue
author's follow-up: recency over averaging, since nodes move). Core `position-estimator.ts`:
sightings come from received flood packets whose source is identifiable (ADVERT / ANON_REQ
public key, REQ / RESPONSE / TXT_MSG / PATH src_hash; path[0] heard the source), incoming
messages with a stored `MessageRecord.path` (DM conversation key, channel "sender:" name) and the
LAST hop of the contact's out_path; a zero-hop sighting anchors at this radio when it has a
location. Hashes go through `resolveHop`; ambiguous ones are ignored. The estimate is 400 m from
the anchor on a bearing hashed from the key, stepped around rings so it stays ≥ 240 m from
located nodes and other estimates. `app.positions` loads the last 500 rx packets + 500 adverts
and 50 messages per DM (unlocated contacts) / channel within 7 days, then follows store events
incrementally; out_paths never expire. `MapModel` adds them as `approximate` markers (kind /
age filters and `focus` apply; not counted in `withoutLocation`); the card reads
"Approximate: near <repeater>, last heard <time>"; "Show on map" links appear for them while
the setting is on (`MapModel.hasMarker`). Not done: multi-repeater triangulation (the issue's
first idea) and estimates in the path dialog.

**Not done in Phase 12:** settings export/import (app preferences + per-radio local data as a
file); a dedicated keyboard/accessibility audit beyond what earlier phases added; `REPO_URL`
is a placeholder until the repository is published.

## Contact paths (issue #6)

`/path/:key` (from the chat header "Path…" and the contacts menu "Set path…") shows the
contact's current path with hops resolved to repeater / room names (hop hash = public key
prefix; ambiguous hops show "A | B", unknown ones the hex), a hop-list editor (searchable
repeater list with add / reorder / remove, or tap repeaters on a `<mc-tile-map>`), "Use
flood", and previously used paths with delivered / attempted counts, round trip, last use and
a "Use" button. Logic is `ContactPathsModel` (`app.contactPaths`, `packages/core/src/app/path-history.ts`),
mirroring MeshCore Open's routing sheet / `path_history_service.dart`: a hop list is set with
ADD_UPDATE_CONTACT (the contact's own type / flags / name / last_advert, new out_path_len /
out_path; hash size = the radio's path hash mode + 1), flood with RESET_PATH. Each DM counts
one attempt per distinct path it went out on (the device's out_path at each SENT, or flood);
the ACK's path gets the success and the message's other paths a failure; a final timeout is a
failure for all of them; a late ACK turns the failure into a success. Paths the device learns
(PATH_UPDATED, adverts) are added with 0/0 ("learnt from the radio"). History is stored on the
contact record (`ContactRecord.pathHistory`, local field, kept across device syncs, no
migration), newest first, capped at 20. Not mirrored: MeshCore Open's auto route rotation /
path scoring, route weights and the per-path trace button; there is no free-form hex hop entry.
