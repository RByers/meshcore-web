# Packet log "Stats" tab — design

A third tab on `/packets` (next to *Packets* and *Frames*) that visualises the logged over-the-air
packets so a user can get a feel for what the radio traffic is: who is talking, when, how far
away, how strong, and how much airtime it consumes.

Ground truth for packet structure: `docs/mesh-packet-format.md`. Ground truth for the companion
side: `docs/companion-protocol.md`. Existing pieces reused: `packet-summary.ts` (`viewPacket`,
`SummaryContext`), `path-resolver.ts` (`resolveHop`), `geo.ts` (`haversineMeters`, `hasLocation`,
`formatDistance`), `packet-log-model.ts` (the summary context and the packet log view).

## 1. Core: `PacketStatsModel` (`packages/core/src/app/packet-stats-model.ts`, `app.packetStats`)

A `StoreBoundModel`. It loads **every** packet record in the selected date range into memory
(the log is already bounded by the retention policy), derives one compact `StatPacket` per
record, and exposes aggregations as `computed` signals. No DOM, no d3.

### 1.1 Date range

```ts
interface StatsRange { from: number | null; to: number | null } // epoch ms, inclusive; null = unbounded
range: ReadonlySignal<StatsRange>           // default { from: null, to: null } = whole log
setRange(r: StatsRange): Promise<void>      // reloads
bounds: ReadonlySignal<{ first: number; last: number } | null> // ts of the oldest / newest logged packet (whole log, not the range)
loading: ReadonlySignal<boolean>
```

Loading uses `store.packets.export({ from, to })` is NOT appropriate (it hex-encodes bytes);
instead use the store's `query` with a large `limit`/`order: 'asc'` or add a small
`PacketLog.all(q)` helper that iterates the index and returns `PacketRecord[]` — whichever is
cleaner, with a test. Live updates: subscribe to `store.events` `packet` and append the derived
point when it falls inside the range (`to === null || ts <= to`); on `packetsCleared` /
import / contact / channel changes reload (coalesced, like the other models). The summary
context (names, channel PSKs) comes from `PacketLogModel.context` — reuse it (pass the
`PacketLogModel` or its context signal into the constructor) rather than duplicating
`#loadContext`.

### 1.2 Per-packet point

```ts
interface NodeRef {
  /** 1-byte (or longer) hash hex, or the public key / prefix the packet carried. */
  hash: string;
  /** Full public key hex when uniquely resolved to a contact or to this radio. */
  key?: string;
  /** Display label: contact name, `self` name, or the hex ('a3?' style when ambiguous, per resolveHop). */
  label: string;
  /** True when resolved uniquely to a contact / self. */
  resolved: boolean;
}

type TrafficCategory = 'dm' | 'channel' | 'advert' | 'ack' | 'trace' | 'path' | 'control' | 'other';

interface StatPacket {
  id: number;             // PacketRecord.id — the UI links to /packets/:id
  ts: number;
  direction: 'in' | 'out';
  bytes: number;          // full on-air size (record bytes length for format 'packet'; payload length otherwise)
  payloadType: number;    // -1 unknown
  typeName: string;       // 'TXT_MSG', … 'UNKNOWN'
  routeType: number;      // -1 unknown
  routeName: string;      // '' unknown
  hops: number | null;    // path entry count (TRACE: snr entry count) — from viewPacket
  snr: number | null;     // dB
  rssi: number | null;    // dBm
  category: TrafficCategory;
  channel: string | null; // GRP_TXT / GRP_DATA: channel name when the hash matches a known channel, else `channel xx`
  source: NodeRef | null; // who originated the packet (see 1.3); null when unattributable
  lastHop: NodeRef | null;// last forwarder (see 1.3); null when unknown
  direct: boolean;        // path is empty (heard straight from the source)
  distanceM: number | null; // see 1.4
  airtimeMs: number | null; // see 1.5
}
points: ReadonlySignal<readonly StatPacket[]> // ascending ts, within range
```

### 1.3 Source and last hop attribution

Packets do not carry a full source identity, so attribution is best effort and must be honest:

| payload | source |
|---|---|
| ADVERT | the advertised public key → contact (or self) |
| TXT_MSG, REQ, RESPONSE, PATH | `srcHash` (1 byte) via `resolveHop` against contacts + self (unique → resolved; ambiguous → label like `a3?`, `resolved: false`) |
| ANON_REQ | the sender public key |
| GRP_TXT with a known channel PSK | decrypt; the plaintext is `"name: text"` → `label = name`, match a contact by exact name when unique |
| GRP_TXT without key, ACK, TRACE, CONTROL, MULTIPART, RAW_CUSTOM, unknown | `null` |
| any `direction: 'out'` | self |

`lastHop`: the last entry of the packet's path (`viewPacket(...).path` is ordered oldest → newest
forwarder, see mesh-packet-format.md §1.3) resolved with `resolveHop` (repeaters / rooms
preferred). When the path is empty the packet was heard directly: `direct = true` and `lastHop =
source` (may be `null`). TRACE packets' path holds SNRs, not hashes: `lastHop = null`.

### 1.4 Distance

`distanceM` is the haversine distance from the radio's own position (`connection.selfInfo` lat /
lon; `hasLocation` from geo.ts, 0,0 = none) to the first of: the resolved source contact's
position, else the **earliest** path entry (index 0 — the node nearest the source) that resolves
uniquely to a contact with a location, walking forward through the path. `null` when the radio
has no position, nothing in the chain is located, or `direction === 'out'`.

### 1.5 Airtime and utilisation

`packages/core/src/app/airtime.ts`: `loraAirtimeMs(bytes, { sf, bwKhz, cr, preambleSymbols,
explicitHeader: true, crc: true, lowDataRateOptimize: auto })` — the Semtech SX127x formula
(symbol time `2^SF / BW`, `8 + max(ceil((8·PL − 4·SF + 28 + 16 − 20·IH) / (4·(SF − 2·DE))) · (CR + 4), 0)`
payload symbols, with `DE = 1` when the symbol time ≥ 16 ms). Take the preamble length from the
firmware (`.ref/MeshCore` — look for the LoRa preamble constant used by the radio drivers; if
MeshCore uses a non-default value, cite the file in a comment) and the current radio params from
`connection.selfInfo` (`radioSf`, `radioBwHz`, `radioCr`). Byte-exact tests against values
computed by hand for a couple of (SF, BW, CR, length) combinations, with the formula cited.
`airtimeMs` is `null` when no radio params are known.

### 1.6 Aggregations (all `computed` from `points`, i.e. after the §6 filters)

```ts
summary: { packets, bytes, airtimeMs, airtimeFraction /* airtime / range span, null if unknown */, sources /* unique resolved + unresolved labels */, spanMs }
bySource: { top: { node: NodeRef; count: number; bytes: number; airtimeMs: number }[] /* top 50, count desc */, unattributed: number, others: number /* beyond the top 50 */ }
timeline: { binMs: number; bins: { t: number; series: Record<string, number> }[]; series: string[] }
   // series (non-empty only, by count desc, 'Other' last): one per known channel name (GRP_TXT/GRP_DATA), 'Unknown channels', 'DMs' (TXT_MSG), 'Adverts', 'ACKs', 'Paths', 'Traces', 'Requests' (REQ/RESPONSE/ANON_REQ), 'Control', 'Other' (MULTIPART, RAW_CUSTOM, unknown). Bin size picked from the span: aim for 60–150 bins on round steps (1 min … 1 day). Expose `setBin(ms | 'auto')` too.
utilization: {
  overTime: { t: number; airtimeMs: number; fraction: number }[]   // same bins as timeline
  byType: { name: string; count: number; bytes: number; airtimeMs: number }[]      // payload type
  byRoute: …  byDirection: …  byCategory: …  byChannel: …
}
hops: { hops: number; count: number }[]
```

Keep the series naming stable (color follows the entity: the UI maps series name → palette slot).

### 1.7 Tests (`packet-stats-model.test.ts`, node vitest)

Build records with `store.packets.append(...)` (real packets via `buildPacket` and the payload
encoders, like the other model tests) for a radio with a position and a few contacts with
positions: assert attribution for each row of the table in 1.3, `lastHop`/`direct`, distance
(including the earliest-located-hop fallback), channel naming, the date range filtering (`setRange`),
live append, bin selection and the top-50 cut. No sleeps: `await model.settled()`.

## 2. Web: charts (`packages/web/src/charts/`)

d3 is allowed as a dependency, but only the data-side modules: `d3-scale`, `d3-shape`, `d3-array`
(plus `d3-time` if `scaleTime` ticks need it) and their `@types/*`. **No `d3-selection` / `d3-axis`**:
charts are Lit elements that render SVG with Lit's `svg` template from d3 scales, so they stay
reactive and testable. Each chart measures itself with a `ResizeObserver` (height fixed per chart,
width fluid), renders a recessive grid, axis ticks from `scale.ticks()`, and a hover tooltip (HTML
positioned over the SVG; hit targets ≥ 12 px even when the mark is smaller). Light/dark via the
`--mc-*` tokens plus a chart palette defined once in `charts/palette.ts`:

| slot | light | dark |
|---|---|---|
| 1 blue | `#2a78d6` | `#3987e5` |
| 2 orange | `#eb6834` | `#d95926` |
| 3 aqua | `#1baf7a` | `#199e70` |
| 4 yellow | `#eda100` | `#c98500` |
| 5 magenta | `#e87ba4` | `#d55181` |
| 6 green | `#008300` | `#008300` |
| 7 violet | `#6250d6` | `#9085e9` |
| 8 red | `#e34948` | `#e66767` |
| other | `--mc-text-muted` | `--mc-text-muted` |

Expose them as CSS custom properties (`--viz-1` … `--viz-8`, `--viz-other`) with `light-dark()`
like `styles.ts` does, and a `seriesColor(index)` helper. Rules: hues are assigned in fixed slot
order to entities, never cycled past 8 (fold into "Other"); a legend whenever there are ≥ 2
series; text is never coloured by series; thin marks; `tabular-nums` for ticks.

Elements (all `data-chart="…"` for tests, all accept plain arrays so they can be unit-tested
without the app):

- `<mc-bar-chart>` horizontal bars: `items: { label, value, href?, title?, key?, selected? }[]`; label column is a link when `href` is set; value label at the bar end; sorted as given; keyed rows dispatch `bar-select` (§3 drill-down).
- `<mc-dot-plot>` `points: { x: number, y: number | null, size: number, color: string /* series key */, id }[]`, `xDomain`, `yLabel`, `yFormat`; dot radius ∝ `sqrt(size)` (area ∝ bytes, 2–9 px); nulls in `y` dropped with a count shown ("n packets without SNR"); click → `dot-select` event with the id; legend with series → colour (≤ 8 + Other).
- `<mc-line-chart>` `series: { key, points: { t, v }[] }[]`, `xDomain`, `stacked?: boolean`; crosshair tooltip listing all series at the hovered bin; legend.
- `<mc-breakdown>` a single horizontal 100 % stacked bar per dimension: `segments: { label, value, title?, key?, selected? }[]` with a legend / inline labels; 2 px gaps between segments; keyed segments dispatch `segment-select`.
- `<mc-stat-tile>` label + big value + optional sub-text.

Browser tests (`packages/web/test/charts.test.ts`): each element renders the expected number of
marks for a small dataset, links appear, dot click dispatches the id, series beyond 8 fold.

## 3. Web: the Stats tab (`packages/web/src/pages/packets/packet-stats.ts`, `<mc-packet-stats>`)

`LogTab` gains `'stats'`; the packets page renders `<mc-packet-stats>` for it (the toolbar /
filters of the list tabs are not shown; the inspector split is hidden). Layout, top to bottom:

1. **Filter row**: date range — presets *All* (default), *Last hour*, *24 h*, *7 d*, and two
   `datetime-local` inputs for a custom range; bin size *auto / 1 min / 5 min / 1 h / 1 d*. The
   range and bin are kept in the model (not URL). A line of stat tiles: packets, bytes, airtime %
   (with the radio params in the tooltip, "—" when unknown), unique sources, span.
2. **Packets per source node** (`mc-bar-chart`, top 50, count desc): the label links to
   `/contact/:key` (via `hrefFor`) when the node resolved to a contact, plain text for self /
   unresolved; footer line "n packets could not be attributed, m more nodes".
3. **Packets over time** (`mc-dot-plot`): x = time (range or log bounds), y selector
   (*SNR* default, *RSSI*, *Distance*, *Hops*, *Size*), colour selector (*Packet type* default,
   *Route type*, *Last hop*, *Source*, *Channel*, *Direction*), dot area ∝ bytes. Clicking a dot
   navigates to `/packets/:id`. Payload types get a fixed slot map (TXT_MSG 1, GRP_TXT 2, ADVERT 3,
   ACK 4, PATH 5, TRACE 6, REQ/RESPONSE 7, CONTROL 8, rest Other); for node / channel colourings
   the top 8 by count in the current points take slots in count order, rest "Other".
4. **Packet rate** (`mc-line-chart`): the `timeline` series (per channel, unknown channels, DMs,
   adverts, ACKs, paths, traces, requests, control); the 8 biggest get a line, the rest are summed into *Other*; toggle *stacked*.
5. **Network utilisation**: `mc-line-chart` of airtime fraction over time (single series, %), then
   `mc-breakdown` rows for payload type, route type, direction, channel / category — each showing
   airtime share (with packet count in the tooltip). When airtime is unknown, fall back to bytes
   and say so.
6. **Hop count** distribution (`mc-bar-chart`, vertical-ish is fine as horizontal rows 0,1,2…).

**Drill-down** (model side in §6): clicking a source bar, a hop-count bar, or a breakdown segment /
legend entry (type, route, direction, category, channel) adds a filter for that value; clicking the
active value again removes it. On source bars the *bar* filters and the *label* stays the contact
link. Charts opt in per item with a `key` (`<mc-bar-chart>` dispatches `bar-select`, keyed rows
are `role=button` hit rects with Enter / Space; `<mc-breakdown>` dispatches `segment-select` from
segments and from legend `<button>`s), with `selected` marking the active value; items without a
key (e.g. the contact Stats tab) stay plain. While filters are active a sticky filter bar sits
under the range: a chip per filter ("Source: Alice ×"), "Showing X of Y packets" and a *Clear
filters* button. Filters matching nothing → "No packets match these filters." with the bar kept.

Everything renders from the model's signals (read in `render()` → auto re-render). Empty log →
one empty-state line. Browser tests (`packages/web/test/packet-stats.test.ts`, harness +
emulator scenario that produces packets): the tab appears and renders tiles and the four chart
elements; the source chart has links to `/contact/…`; the y/colour selectors change the dot plot's
axis label / legend; a date preset shrinks the packet count tile; source-bar / segment / keyboard
filtering, chip removal, *Clear filters* and the no-match state.

## 4. Docs

Add a row to `docs/roadmap.md` (Phase 9 area) and a line to `packages/core/src/app/README.md`
for `packet-stats-model.ts` / `airtime.ts`.

## 5. Contact page "Stats" tab

`/contact/:key` gets a tab row (*Info* | *Stats*) above its cards; *Info* is the existing content.
*Stats* is `<mc-contact-stats key=…>` (`packages/web/src/pages/messaging/contact-stats.ts`) fed by
`app.packetStats.forContact(key)` and the same global date range (reuse the same filter row
element as the packets Stats tab — extract it to `packages/web/src/charts/` or
`components/` as `<mc-stats-range>` bound to the model). To support it, `StatPacket` also carries:

```ts
path: readonly NodeRef[]   // every path entry resolved (oldest forwarder first); [] when direct / TRACE
pathKey: string            // hop hashes joined with '>' ('' = direct) — identity of a path
```

and the model exposes

```ts
forContact(key: string): ReadonlySignal<ContactStats>   // cached per key, computed from `allPoints` (§6 filters don't apply)
interface ContactStats {
  from: readonly StatPacket[];     // source.key === key
  via: readonly StatPacket[];      // path contains the contact (it forwarded the packet) and source is not the contact
  timeline: { binMs; bins: { t; series: Record<string, number> }[]; series: string[] } // packets *from* the contact per bin, same series as the global timeline
  paths: { pathKey: string; hops: readonly NodeRef[]; count: number; lastTs: number; meanSnr: number | null; share: number }[] // count desc; pathKey '' = direct
  signal: { ts: number; snr: number | null; rssi: number | null; hops: number | null; pathKey: string; id: number }[] // from, ascending
  hops: { hops: number; count: number }[]
}
```

The tab shows: stat tiles (packets from the contact, via the contact as a forwarder, distinct
paths, share heard directly, mean SNR); *Heard over time* (`mc-line-chart`, series by category);
*Paths heard via* (`mc-bar-chart`: label = resolved hop names joined with " > ", or *direct*;
value = count; footer "last heard" via tooltip; the label links to the path page `/path/:key`
only for the contact's current out_path row, otherwise plain text); *Signal over time*
(`mc-dot-plot`: x time, y SNR (selector SNR / RSSI / Hops), colour = path (top 8 paths, rest
Other), dot size = bytes); *Hop count* distribution. Browser test in
`packages/web/test/contact-stats.test.ts`: the tab appears, the paths chart lists the direct row
and a repeated path from the emulator scenario, the timeline renders.

## 6. Drill-down filters

Clicking a bar on the packets Stats tab narrows every statistic to the matching packets. The model
holds the filters (in memory only, not persisted; they survive range changes):

```ts
type StatsFilterField = 'source' | 'type' | 'route' | 'direction' | 'category' | 'channel' | 'hops';
interface StatsFilter { field: StatsFilterField; value: string; label: string /* chip text, from the caller */ }
filters: ReadonlySignal<readonly StatsFilter[]>
addFilter(f) / removeFilter(field) / clearFilters()
allPoints: ReadonlySignal<readonly StatPacket[]>   // range only
points: ReadonlySignal<readonly StatPacket[]>      // allPoints matching every filter
unfilteredCount: ReadonlySignal<number>           // allPoints.length ("showing X of Y")
matchesFilter(p, f) / filterKey(p, field) / filterPoints(points, filters)   // pure helpers
```

- `value` is the key the aggregations already produce: source → `nodeId(source)` (`''` =
  unattributed), type → `typeName`, route → `routeName || 'unknown'`, direction → `'in'`/`'out'`,
  category, channel → the channel name (channel packets only), hops → `String(hops)` (packets with
  unknown hops never match).
- Filters AND together; at most one per field — adding one on a field that already has one
  replaces it.
- `summary`, `bySource`, `timeline`, `utilization` and `hops` count the filtered `points`.
  `window` (and so the bins and `summary.spanMs`) comes from the range and `allPoints`, so axes
  don't move while drilling down.
- `forContact()` reads `allPoints`: the packets page's filters don't leak into the contact page.
