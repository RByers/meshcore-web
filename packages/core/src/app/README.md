# `src/app` — application model

Framework-agnostic state for the UI. No DOM: the web package injects browser objects
(transport factories, `indexedDB`, `localStorage`) through `AppModelOptions`.

## Pieces

| File | What |
|---|---|
| `signal.ts` | `signal`, `computed`, `effect`, `batch`, `untracked`, `when`, `Watcher` (used by the Lit `SignalController`) |
| `notifications.ts` | `NotificationsModel`: toasts (`info/success/warning/error`), auto-dismiss, cap |
| `connection.ts` | `ConnectionModel`: `idle → connecting → handshaking → connected → disconnecting → disconnected`, `error`; transport factories per kind (`serial`, `ble`, `emulator`); opens the `RadioStore` for the radio's pubkey |
| `capture.ts` | `CapturePipeline`: client events → store (frames, packets, messages + unread, contacts, self info). Buffers until the store is open, then runs one serial queue |
| `store-bound.ts` | `StoreBoundModel`: base class for models fed by the connected radio's store |
| `contacts-model.ts`, `channels-model.ts`, `unread-model.ts`, `chat-model.ts`, `packet-log-model.ts`, `device-settings-model.ts`, `remote-admin-model.ts` | Feature models (Phase 6 state only; later phases extend them) |
| `device-settings-model.ts`, `radio-presets.ts` | `DeviceSettingsModel` (Phase 11): validated setters with unit conversion (MHz/kHz → kHz/Hz), stats polling, time sync, advert cooldown, key export/import, reboot / factory reset (via `connection.expectDisconnect`); regional LoRa presets from MeshCore Open |
| `app-settings-model.ts` | `AppSettingsModel`: local preferences (theme, time format, packet retention, store private key) |
| `messaging.ts` | Pure helpers: byte budgets (160 B; channel minus `"name: "`), `@[name]` replies, `"sender: text"`, path labels, `meshcore://` contact shares, channel PSK parsing (hex / base64, #hashtag, Public), `outboundText` (SMAZ `s:` envelope for outgoing text, feature-inventory.md §2.4a; codec in `util/smaz.ts`) |
| `reactions.ts` | Emoji reactions (MeshCore Open compatible, feature-inventory.md §2.4b): the 184-emoji table, `computeReactionHash` (Dart `String.hashCode` port), MeshCoreOne hash, `encodeReaction` / `parseReaction`, `reactionMessageHash` / `reactionMatches`, `reactionChips`. The capture pipeline attaches incoming `r:` texts to their target; `ChatModel.react` / `retryReaction` send them |
| `contacts-model.ts` | Phase 7: `views` / `visible` (search, type filter, sort), refresh, add (share / pubkey), remove, resetPath, share, export |
| `chat-model.ts` | Phase 7/8: paging (`loadMore`), `send` / `retry` with status persisted (pending → sent → delivered / failed), `setActive` read tracking, `byteLimit`, `setReplyTo` / `quotedMessage`; `compression` / `setCompression` (per-conversation SMAZ, budget counts the on-air bytes) |
| `channels-model.ts` | Phase 8: slot-synced list, add / edit / remove (clears the slot), mute, `freeSlot` |
| `remote-admin-model.ts`, `remote-cli-commands.ts` | Phase 10: `RemoteAdminModel.node(key)` → `RemoteNodeModel` (login / remembered password, status fields, LPP telemetry, sensor min/max, neighbours, ACL, owner info, CLI transcript, trace, path discovery, reset path); firmware CLI command reference + autocomplete |
| `geo.ts` | Phase 12: pure map maths — Web Mercator projection (`latLonToWorld` / `worldToLatLon`, `TILE_SIZE`), tile coordinates and `tileUrl` templating, `haversineMeters`, `bearingDegrees` / `compassPoint`, `formatDistance`, `boundsOf` / `boundsCenter` / `fitBoundsZoom`, `hasLocation` (0,0 = no location) |
| `map-model.ts` | Phase 12: `MapModel` (`app.map`): markers for contacts with a location plus the own position from SELF_INFO (never browser GPS), kind and max-age filters, selection and `focus(key)` ("Show on map"), distance / bearing from the own position, `withoutLocation` count; the tile URL template (default `OSM_TILE_URL`, `validateTileUrl`) and filters persist in preferences |
| `path-geometry.ts` | Issue #2: pure path layout — `matchPathHash` (hop hash → contacts, repeaters preferred), `resolvePathEndpoint`, `interpolatePositions` (Mercator-linear interpolation / extrapolation), `buildPathGeometry` (stops with names, candidates, known / ambiguous / estimated positions, bounds, length) |
| `path-model.ts` | Issue #2: `PathModel` (`app.paths`): `PathRequest` → `PathSpec` for a contact's out_path, a logged packet, or a message (hashes recovered from the packet log via `findMessagePacket`), and `geometry(spec)` |
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
6. Test against the emulator in node: `new AppModel({ indexedDB: new IDBFactory(), keyRange:
   IDBKeyRange, createEmulatorTransport: createEmulatorTransportFactory() })`, connect with
   `app.connection.connect('emulator')`, then `await app.connection.capture!.idle()` and
   `await model.settled()` before asserting (see `app-model.test.ts`).

## Conventions

- Signals hold immutable values; replace arrays/objects instead of mutating.
- Models expose `ReadonlySignal`s; only the model writes its own signals.
- `ConnectionModel.connect()` never rejects: it resolves `false` and surfaces the error via
  `connection.error` and a toast. A dismissed browser chooser (`NotFoundError`) is not an error.
- Reconnect: `connection.reconnect(deviceRecord)` reuses a granted device where the API allows
  (`reconnectableKinds`: the emulator always; Web Serial via `getPorts()` in the browser).
  Automatic reconnect after link loss is not implemented yet.
