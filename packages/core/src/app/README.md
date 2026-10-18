# `src/app` — application model

Framework-agnostic state for the UI. No DOM: the web package injects browser objects
(transport factories, `indexedDB`, `localStorage`) through `AppModelOptions`.

## Pieces

| File | What |
|---|---|
| `signal.ts` | `signal`, `computed`, `effect`, `batch`, `untracked`, `when`, `Watcher` (used by the Lit `SignalController`) |
| `notifications.ts` | `NotificationsModel`: toasts (`info/success/warning/error`), auto-dismiss, cap |
| `connection.ts` | `ConnectionModel`: `idle → connecting → handshaking → connected → disconnecting → disconnected`, `error`; transport factories per kind (`serial`, `ble`, `emulator`); opens the `RadioStore` for the radio's pubkey; `handshake` signal (`HandshakeProgress`: step, label, done/total, monotonic `fraction`) while connecting, fed by the client's `connectProgress` event |
| `capture.ts` | `CapturePipeline`: client events → store (frames, packets, messages + unread, contacts, self info). Buffers until the store is open, then runs one serial queue. On attach it starts the once-per-radio sent-packet backfill (`store/send-backfill.ts`, `sendBackfill` promise) in the background; live send outcomes (`PacketRecord.send`) are correlated in `RadioStore.captureFrame` (`store/send-correlator.ts`) |
| `store-bound.ts` | `StoreBoundModel`: base class for models fed by the connected radio's store |
| `contacts-model.ts`, `channels-model.ts`, `unread-model.ts`, `chat-model.ts`, `packet-log-model.ts`, `device-settings-model.ts`, `remote-admin-model.ts` | Feature models (Phase 6 state only; later phases extend them) |
| `device-settings-model.ts`, `radio-presets.ts` | `DeviceSettingsModel` (Phase 11): validated setters with unit conversion (MHz/kHz → kHz/Hz), stats polling, time sync, advert cooldown, key export/import, reboot / factory reset (via `connection.expectDisconnect`); regional LoRa presets from MeshCore Open |
| `app-settings-model.ts` | `AppSettingsModel`: local preferences (theme, time format, packet retention, store private key, show path as node names, approximate positions, SMAZ auto-enable, `showFrames`: Frames tab on /packets, off by default) |
| `messaging.ts` | Pure helpers: byte budgets (160 B; channel minus `"name: "`), `@[name]` replies, `"sender: text"`, path labels, `meshcore://` contact shares, channel PSK parsing (hex / base64, #hashtag, Public), `outboundText` (SMAZ `s:` envelope for outgoing text, feature-inventory.md §2.4a; codec in `util/smaz.ts`) |
| `reactions.ts` | Emoji reactions (MeshCore Open compatible, feature-inventory.md §2.4b): the 184-emoji table, `computeReactionHash` (Dart `String.hashCode` port), MeshCoreOne hash, `encodeReaction` / `parseReaction`, `reactionMessageHash` / `reactionMatches`, `reactionChips`. The capture pipeline attaches incoming `r:` texts to their target; `ChatModel.react` / `retryReaction` send them |
| `contacts-model.ts` | Phase 7: `views` / `visible` (search by name / key prefix / note, type filter, sort), `noteFor` / `setNote` (local notes), refresh, add (share / pubkey), remove, resetPath, share, export; bulk-selection helpers `contactsNotHeardSince` (`STALE_PERIODS`) and `contactsFartherThan` / `contactDistance` (`DISTANCE_PRESETS`) |
| `chat-model.ts` | Phase 7/8: paging (`loadMore`), `send` / `retry` with status persisted (pending → sent → delivered / failed), `setActive` read tracking, `firstUnreadId` (the "New messages" divider: captured on open before marking read, fixed while open, cleared on send / close), `byteLimit`, `setReplyTo` / `quotedMessage`; `compression` / `setCompression` (per-conversation SMAZ, budget counts the on-air bytes) |
| `channels-model.ts` | Phase 8: slot-synced list, add / edit / remove (clears the slot), mute, `freeSlot` |
| `remote-admin-model.ts`, `remote-cli-commands.ts` | Phase 10: `RemoteAdminModel.node(key)` → `RemoteNodeModel` (login / remembered password, status fields, LPP telemetry, sensor min/max, neighbours, ACL, owner info, CLI transcript, trace, path discovery, reset path); firmware CLI command reference + autocomplete |
| `geo.ts` | Phase 12: pure map maths — Web Mercator projection (`latLonToWorld` / `worldToLatLon`, `TILE_SIZE`), tile coordinates and `tileUrl` templating, `haversineMeters`, `destinationPoint`, `bearingDegrees` / `compassPoint`, `formatDistance`, `boundsOf` / `boundsCenter` / `fitBoundsZoom`, `hasLocation` (0,0 = no location) |
| `map-model.ts` | Phase 12: `MapModel` (`app.map`): markers for contacts with a location plus the own position from SELF_INFO (never browser GPS), kind and max-age filters, selection and `focus(key)` ("Show on map"), distance / bearing from the own position, `withoutLocation` count, `approximate` markers from `estimates` (issue #7), `hasMarker`; the tile URL template (default `OSM_TILE_URL`, `validateTileUrl`) and filters persist in preferences |
| `position-estimator.ts` | Issue #7: approximate positions for contacts without a location — `packetEvidence` / `messageEvidence` / `outPathEvidence` (which repeater a node was heard through), `estimatePositions` (most recent located repeater wins, ambiguous hashes ignored, fixed distance on a key-derived bearing, fanned out to avoid other markers); `PositionEstimatorModel` (`app.positions`, bounded lookback, follows store events) while `AppSettingsModel.approximatePositions` is on; `MapModel` shows them as `approximate` markers |
| `path-resolver.ts` | `resolvePath(hashes, contacts, {hashSize})` → `ResolvedHop[]` (hop hash → contact name, repeaters / rooms preferred; unknown → hex, shared prefix → "a3?" + candidates), `formatResolvedPath` ("Alice > Bob"), `pathLabel` (name chain or hop count per the "Show path as node names" setting). `ContactsModel.resolvePath` / `.pathLabel` / `.outPathLabel` bind it to the stored contacts; `path-geometry.ts` uses `resolveHop` for its candidates |
| `path-geometry.ts` | Issue #2: pure path layout — `matchPathHash` (hop hash → candidate contacts via `path-resolver.ts`'s `resolveHop`), `resolvePathEndpoint`, `interpolatePositions` (Mercator-linear interpolation / extrapolation), `buildPathGeometry` (stops with names, candidates, known / ambiguous (nearest candidate to the estimate) / estimated positions (the guesses only with `estimate: true`, which `PathModel.geometry` takes from the "approximate positions" setting), bounds, length) |
| `path-model.ts` | Issue #2: `PathModel` (`app.paths`): `PathRequest` → `PathSpec` for a contact's out_path, a logged packet, or a message (its stored `MessageRecord.path` when the capture pipeline matched it, else hashes recovered from the packet log via `findMessagePacket`), and `geometry(spec)` |
| `packet-relations.ts` | Request ↔ reply pairing between packet log entries (exact, key-less rules): our DM (`send.tag` = ACK code) ↔ ACK / MULTIPART ACK, TRACE by tag (our trace ↔ the completed trace back; mid-path copies are `hop`s), DISCOVER_REQ ↔ DISCOVER_RESP by tag. With the radio's private key stored (opt-in), `decryptedRelationKeysOf` adds: our REQ / non-login ANON_REQ ↔ the RESPONSE or PATH-with-RESPONSE echoing its tag (scoped to the contact), a received DM ↔ the ACKs for it (code computed as the firmware does), PATH-with-ACK ↔ the DM it acknowledges; decrypted off the event path, cached per record, rebuilt when the key or contact keys change. `relationKeysOf(record)` → `RelationKey`s, `PacketRelationIndex` (key → members). `PacketLogModel.related(id)` / `answered(id)` (sync, reactive; index built on first use, live after) and `PacketInspection.related` |
| `rx-path-correlator.ts` | `RxPathCorrelator` (used by the capture pipeline): remembers recent LOG_RX_DATA packets; zero-hop adverts → per-contact direct SNR (`directSnr` / `directSnrAt`); matches incoming flood messages to their packet to store `MessageRecord.path` (best effort) |
| `path-history.ts` | Issue #6: `ContactPathsModel` (`app.contactPaths`): `setPath(key, hops \| 'flood')` (ADD_UPDATE_CONTACT / RESET_PATH), `current` / `history` (per-path attempts, successes, failures, last used, round trip; recorded from ChatModel DM send progress and paths the device learns), `candidatesFor` (repeaters / rooms), `resolvePathHops` |
| `airtime.ts` | LoRa time on air (`loraAirtimeMs`, Semtech SX127x / SX126x formula) with MeshCore's preamble (32 symbols for SF ≤ 8, else 16, firmware RadioLibWrappers.h); `loraParamsFromSelfInfo`; `loraSnrFloorDb` / `loraDecodeLimit` (demodulation SNR floor per SF, Semtech datasheets). The emulator's whole-ms estimate delegates to it |
| `box-stats.ts` | Tukey box-plot statistics: `boxStats(values)` → `BoxStats` (n, min, q1, median, q3, max, mean, whiskers within 1.5·IQR, outliers; null when empty) and `quantileSorted` (linear interpolation, R type 7 / numpy default). Used for the SNR boxes in `packet-stats-model.ts` |
| `packet-stats-model.ts` | Packet log Stats tab (docs/packet-stats.md): `PacketStatsModel` (`app.packetStats`) loads every packet in a date range (`setRange`, `bounds`; `PacketLog.all`), derives one `StatPacket` per record (source / last hop / path attribution via `resolveHop`, GRP_TXT sender from the decrypted text, distance from the own position, airtime), live-tails, exposes `decodeLimit` (SNR floor at the radio's SF) and `noiseFloor` / `noiseFloorSummary` (the stored noise-floor samples in the range, live-tailed), and aggregates: `summary`, `bySource` / `pathStarts` / `pathEnds` (top 50, `nodeStats`), `lastHops` (SNR / RSSI per last hop of the received packets, `lastHopSignalStats`, with a Tukey SNR box from `box-stats.ts` `boxStats`), `linkQuality` (`linkQualityStats`: per neighbour = last hop of the received packets with an SNR, median / min / max SNR, median RSSI, margin over `decodeLimit` and its `linkMarginLevel`, top 50 by count sorted by median SNR), `timeline` (auto / `setBin` bins), `utilization`, `hops`, and `forContact(key)` (from / via / paths / signal, plus `lastHopOf` / `lastHopSignal` / `lastHopSummary` / `lastHopBoxes` (all / direct / relayed SNR boxes): how well this radio hears the node as last hop, for the contact page). Names and channel PSKs come from `PacketLogModel.context`, contacts from `ContactsModel.contacts`. The date range and drill-down filters live in the packet log's filter (`PacketLogModel.sharedFilter`, shared with the List tab; `PacketFilter.drill`, `packetFilterChips`) |
| `noise-floor.ts` | `NoiseFloorSampler` (`app.noiseFloor`): while connected, GET_STATS radio (`DeviceSettingsModel.readRadioStats`) 5 s after connect and every 60 s on `app.clock` into the radio's `noiseFloor` store (`store/noise-floor.ts`); skips a tick while a request is outstanding, ignores failures, stops quietly when the firmware refuses (`supported`); `NOISE_FLOOR_GAP_MS` for charts (docs/packet-stats.md §1.8) |
| `storage-model.ts` | `StorageModel` (`app.storage`): per known radio (`app.devices`) record counts and approximate size of its IndexedDB database (`store/db-stats.ts` `radioDbStats`: one read-only cursor pass per store summing `approxValueBytes`, index / on-disk overhead ignored; a missing database is not created); `refresh()` coalesces, never rejects (per-radio `status: 'error'`); `byDevice` lists only radios still in `devices` (a forgotten radio drops out at once). A stats pass never creates a database (an open that would create one is aborted). Shown on the Connect page's known-radios list, whose two-click Remove calls `app.forgetDevice(key, { deleteData: true })` |
| `node-model.ts` | The `/node/:key[/:tab]` page: `NodeModel` (`app.node(ref)`, LRU-cached per normalised ref) resolves a full key, key prefix or 1-byte hash (`normalizeNodeRef`, `resolveContactRef`) to a `NodeIdentity` — one stored contact, a node only heard advertising (`PacketLogModel.heardNodes`: the newest logged ADVERT per key, `PacketLog.latestAdverts`), several candidates (`ambiguous`) or `unknown`; follows the contacts list and the packet log, so add / remove flip it in place. `tabs` / `nodeTabs` / `nodeTabFor` (per kind: chat info·messages·path·stats, room / repeater / sensor add the admin tabs, heard info·stats), `entryTab` (contacts-list clicks: messages for chat / room; Messages-list clicks always open messages), `addContact` (`ContactsModel.addFromAdvert`: ADD_UPDATE_CONTACT with the advert's fields, works in manual-add mode where IMPORT_CONTACT is ignored), `removeContact`, `canAddContact` |
| `regions-model.ts` | Regions (flood scopes, mesh-packet-format.md §1.2): `RegionsModel` (`app.regions`) — the saved region names (global, `PREF_REGIONS`; sorted, deduped, '#' stripped; `add` / `addAll` / `remove`, which also clears channels scoped to that name), `radioDefault` (GET_DEFAULT_FLOOD_SCOPE, loaded on connect via `DeviceSettingsModel.loadDefaultFloodScope`), `keys` (name → 16-byte key: the saved names' public keys `regionKeySync` plus the radio default's stored key), `resolveCode(code, payloadType, payload)` (the unique matching region, ambiguous → null; pure version `matchRegionCode` / `packetRegion` in packet/regions.ts), `fetchFromRepeater(key)` (one repeater, from its node page; anon request 0x01, answered only direct-routed: a repeater without a path is asked zero-hop and its path reset afterwards, the temporary path kept out of its path history via `ContactPathsModel.ignorePath`; results are not auto-added). Pure helpers: `normalizeRegionName`, `validateRegionName`, `parseRegionsReply`, `regionsRequestData`. Per channel: `ChannelRecord.region` (a name or `UNSCOPED_REGION`), `ChatModel.region` / `effectiveRegion` / `unscopedSupported` (fw v12+) / `setRegion`, `send(text, {region})`; channel sends and reactions go through `CompanionClient.withFloodScope` (serialised SET key → send → reset), and the outgoing `MessageRecord.region` records the scope used. Packet decoding (`keys` → `PacketLogModel` `regionKeys` → `SummaryContext.regions`): `PacketView.region` / `PacketRow.region` (name or `UNKNOWN_REGION` '?' for TRANSPORT_FLOOD), `AnnotateKeys.regions` (transport code meaning), `PacketFilter.region` (chip 'region'; stats drill field 'region'), `StatPacket.region`, `utilization.byRegion`; rows and stats re-identify when the list changes. Received channel messages store the region they arrived in (`MessageRecord.region`, resolved at receive time via `CapturePipelineOptions.resolveRegion` ← `RxPathCorrelator.claimChannelPacket`) |
| `conversations-model.ts` | Recent DMs + channels for the `/messages` overview |
| `app-model.ts` | `AppModel` root: `notifications`, `connection`, `devices` (known radios), lazily created feature models, `createEmulatorTransportFactory()` |

## Data flow

```
transport ──frames──▶ CompanionClient ──events──▶ CapturePipeline ──▶ RadioStore (IndexedDB)
                                                                        │ store.events
ConnectionModel.store (signal) ──▶ StoreBoundModel.bind/load ◀──────────┘
                                         │ signals
                                         ▼
                               Lit components (SignalController)
```

The capture pipeline is the only writer of device-derived data. Feature models *read* the
store and listen to `store.events`; they never duplicate what the pipeline persists. Actions
that talk to the device go through `connection.client.peek()` (a `CompanionClient`).

## Extending a feature model (Phases 7-11)

1. Add state as private writable signals, expose read-only views:
   ```ts
   readonly #filter = signal<'all' | 'favourites'>('all');
   readonly filter = this.#filter.readonly;
   readonly visible = computed(() => this.contacts.value.filter(/* … */));
   ```
2. Store-backed state: load it in `load(store)`, clear it in `reset()`, subscribe to the relevant
   `store.events` in `bind(store)` (return the unsubscribe), and call `this.reload()` (coalesced)
   or patch the signal from the event payload.
3. Device actions are async methods that use the client and let the capture pipeline persist the
   result, e.g.
   ```ts
   async removeContact(key: string): Promise<void> {
     const client = this.connection.client.peek();
     if (!client) throw new Error('not connected');
     await client.removeContact(fromHex(key)); // → contactsChanged → pipeline → store → reload()
   }
   ```
   Report user-facing failures with `app.notifications.error('Could not …', err)` from the UI
   layer (or pass `NotificationsModel` into the model's constructor if it acts on its own).
4. Purely local data (favourites, notes, muted) goes straight to the repo (`store.contacts.updateLocal`).
5. New models: subclass `StoreBoundModel` (or plain class for client-only state), add a lazy
   getter on `AppModel` that calls `.start()`, and dispose it in `AppModel.dispose()`.
6. Test against the emulator in node with `connectedApp()` from `testing.ts`: an `AppModel` on a
   `basicScenario({ timing: FAST_TIMING })` emulator (fake IndexedDB), connected, with the initial
   sync captured and contacts loaded; it is disposed (and the emulator's timers cleared) when the
   test finishes. Then `await model.settled()` before asserting, and wait for state transitions
   (`vi.waitFor` on a predicate), never for a fixed time. `testApp()` gives an unconnected app.

## Conventions

- Signals hold immutable values; replace arrays/objects instead of mutating.
- Models expose `ReadonlySignal`s; only the model writes its own signals.
- `ConnectionModel.connect()` never rejects: it resolves `false` and surfaces the error via
  `connection.error` and a toast. A dismissed browser chooser (`NotFoundError`) is not an error.
- Reconnect: `connection.reconnect(deviceRecord)` reuses a granted device where the API allows
  (`reconnectableKinds`: the emulator always; Web Serial via `getPorts()`; Web Bluetooth via
  `getDevices()` when the browser has persistent permissions, matched by `DeviceRecord.bleDeviceId`
  and waiting for the radio to advertise first). Where Bluetooth can't skip the chooser (no
  `getDevices()`, e.g. Chrome without the persistent-permissions flag), the chooser is filtered to
  the radio's advertised name (`DeviceRecord.bleName`) so it lists only that radio.
- Resume on load: with `autoReconnect` (on in the browser) `AppModel.init()` calls
  `connection.resume(mostRecentDevice)`, which reconnects without a chooser (`TransportRequest.auto`:
  factories must not open one) if the previous page was connected or lost its link. A user
  `disconnect()` turns that off until the next successful connect (`PREF_RESUME`); `dispose()` keeps it.
  A failed resume goes back to `idle` with a warning toast. Automatic reconnect after link loss
  (without a reload) is not implemented yet.
