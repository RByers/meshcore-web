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
  /** True when the node is this radio. */
  self?: boolean;
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
  compression: 'smaz' | 'plain' | 'unknown' | null; // text messages only, see below
  textBytes: { plain: number; sent: number } | null; // UTF-8 sizes of the text / of what went on air
  destHash: string | null; // payload dest hash hex (TXT_MSG, REQ, RESPONSE, PATH, ANON_REQ), else null — see 1.7
  // path / pathKey: see §5
}
points: ReadonlySignal<readonly StatPacket[]> // ascending ts, within range
```

**Compression** (SMAZ, feature-inventory.md §2.4a). There is no protocol flag: a text counts as
compressed when the decrypted text is a canonical `"s:" + base64` envelope, checked with
`decodeReceivedText` (`smazTryDecode`), exactly as received messages are, so stats and chat agree.
Only the classification and sizes are kept, never the text.

- *Text* = TXT_MSG and GRP_TXT whose txt_type is plain or signed plain (signed: the text after
  the 4-byte author prefix). CLI data / commands (and every other payload type) → `null`.
- GRP_TXT: decrypted with the known channel PSKs (stage 1, as for the sender); the envelope is the
  part after `"sender: "`. TXT_MSG: decrypted with `PacketLogModel.dmKeys` (only when the radio's
  private key is stored, opt-in), for packets between this radio and a known contact, either
  direction. Not decrypted (no PSK / no DM keys / not for us / malformed) → `'unknown'`.
- Outgoing texts the radio builds itself are logged as `format: 'none'` records with no bytes; the
  wire text (the envelope when compressed) is read back from the JSON-quoted text in
  `decodedSummary`. The packet log cuts that copy to 59 characters + `…`: a cut copy is still
  classified (`'smaz'` when it is `s:` + base64 characters) but `textBytes` is null. A summary that
  doesn't parse → `'unknown'`; an outgoing CLI DM → `null`.
- `textBytes`: `'smaz'` → `{ plain: decoded text, sent: envelope }`; `'plain'` → `plain === sent`.
- Stage 1 depends on the channel PSKs (GRP_TXT) and the DM keys (TXT_MSG: this radio's public key +
  the contact key list). A change of either reloads; cached points of other kinds are reused.

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
channelMessages: { channel: string; count: number; sent: number; bytes: number }[] // GRP_TXT per channel (name, or `channel xx`), count desc; no channel (sent, no bytes) left out
compression: CompressionStats   // text messages only (compression !== null)
routes: readonly PathUsageRoute[] // the "packet paths" map's routes, see 1.7
interface CompressionCounts { text: number; smaz: number; plain: number; unknown: number }
interface CompressionStats extends CompressionCounts {
  compressedShare: number | null;   // smaz / (smaz + plain); null when nothing decrypted
  smazPlainBytes: number;           // totals over 'smaz' packets with known textBytes
  smazSentBytes: number;
  bytesSaved: number;               // smazPlainBytes − smazSentBytes
  savingsRatio: number | null;      // bytesSaved / smazPlainBytes; null without sizes
  byCategory: { dm: CompressionCounts; channel: CompressionCounts };
  byDirection: { in: CompressionCounts; out: CompressionCounts };
  compressedSources: number;        // distinct nodeId(source) with ≥ 1 'smaz' packet (this radio included)
}
```

Keep the series naming stable (color follows the entity: the UI maps series name → palette slot).

### 1.7 Routes (the "packet paths" map)

Each point's path is turned into a route `from → hashes → to` (`PathUsageRoute`, path-usage.ts)
by `statPacketRoute(p)`, following the path semantics of mesh-packet-format.md §1.3 (as
`packetPathSpec` does for one packet):

| packet | route |
|---|---|
| FLOOD / TRANSPORT_FLOOD, received | `nodeEndpoint(source)` → hops so far → this radio (0 hops: source → this radio; 0 hops and no source: none) |
| FLOOD / TRANSPORT_FLOOD, sent | none (a flood leaves with an empty path) |
| DIRECT / TRANSPORT_DIRECT | (sent: this radio; received: unknown origin) → hops still to travel → `destHash` (unknown when null) |
| DIRECT received with no hops left, or DIRECT with neither hops nor `destHash` | none |
| TRACE (path = SNRs), `hops === null` | none |
| unknown route type | as a flood when it has hops, else none |

`nodeEndpoint(n)`: null → unknown origin; `self` → this radio; a resolved `key` → that contact;
else the `hash` (hex prefix / key); else (a channel sender known only by name) the name. An
advert's own position is not used (the point does not keep it): an advertiser is placed only once
it is a contact with a location.

`packetRoutes(points)` groups identical (from, pathKey, to) routes with a count, busiest first;
`routes` is `packetRoutes(points)`, so it follows the date range and the §6 filters.
`app.paths.routesUsage(routes)` merges them with `buildRouteUsageMap` (path-usage.ts) into stops
and segments weighted by packet count, as the contact "paths heard via" map does (stops merge by
node key, else hash + position; estimated positions only with the "approximate positions"
setting). An `unknown` endpoint is never drawn and doesn't count the route as incomplete.

### 1.8 Tests (`packet-stats-model.test.ts`, node vitest)

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
   range is the shared packet filter's `from` / `to` (§6), so the Packets tab's *From* / *To*
   follow it; the bin is kept in the stats model (neither in the URL). A line of stat tiles: packets, bytes, airtime %
   (with the radio params in the tooltip, "—" when unknown), unique sources, span.
2. **Packet paths** (`data-section="paths"`, from `routes`, §1.7): hidden by default behind a
   *Map* / *Hide map* toggle (`aria-pressed`); while hidden, one line "N packets with a known
   route, M distinct paths". Shown, it is an `<mc-tile-map>` of `app.paths.routesUsage(routes)`
   drawn like the contact "paths heard via" map (§5, shared `usageLines` in
   `components/path-usage-lines.ts`): one line per hop segment, 2–14 px wide in proportion to the
   packets that crossed it (busiest 14 px), dashed when it leads to an estimated position or skips
   an unplaced hop; one marker per stop (kind from its node, so this radio is `self`) with its
   packet count in the tooltip, its diameter 1.1–2 rem ∝ √(count / busiest stop) via the marker's
   `--marker-size`; a note with the total, the busiest count and how many packets crossed hops
   with no known location; the "Approximate positions of nodes without a location" checkbox
   (shown when estimating or anything is incomplete); nothing placeable → a one-line empty state.
   The map fits its bounds when opened, when the checkbox changes and when the routes change
   (range / filters), and follows the §6 filters like every other chart.
3. **Packets per source node** (`mc-bar-chart`, top 50, count desc): the label links to
   `/node/:key` (via `hrefFor`) when the node resolved to a contact, plain text for self /
   unresolved; footer line "n packets could not be attributed, m more nodes".
   **Group messages per channel** (`mc-bar-chart`, `channelMessages`): one bar per channel, by
   name or `channel xx` (hash) when the PSK is unknown; tooltip "n received, m sent · bytes".
4. **Packets over time** (`mc-dot-plot`): x = time (range or log bounds), y selector
   (*SNR* default, *RSSI*, *Distance*, *Hops*, *Size*), colour selector (*Packet type* default,
   *Route type*, *Last hop*, *Source*, *Channel*, *Direction*, *Compression*), dot area ∝ bytes. Clicking a dot
   navigates to `/packets/:id`. Payload types get a fixed slot map (TXT_MSG 1, GRP_TXT 2, ADVERT 3,
   ACK 4, PATH 5, TRACE 6, REQ/RESPONSE 7, CONTROL 8, rest Other); for node / channel colourings
   the top 8 by count in the current points take slots in count order, rest "Other". *Compression*
   uses fixed slots (Compressed 1, Plain 2, Not decrypted / non-text packets "Other").
5. **Packet rate** (`mc-line-chart`): the `timeline` series (per channel, unknown channels, DMs,
   adverts, ACKs, paths, traces, requests, control); the 8 biggest get a line, the rest are summed into *Other*; toggle *stacked*.
6. **Network utilisation**: `mc-line-chart` of airtime fraction over time (single series, %), then
   `mc-breakdown` rows for payload type, route type, direction, channel / category — each showing
   airtime share (with packet count in the tooltip). When airtime is unknown, fall back to bytes
   and say so.
7. **Text compression** (`compression`, §1.6): a summary line ("X% of decrypted text messages
   compressed · N B saved (Y%) across M compressed messages · S senders using compression"), a
   muted "n messages could not be decrypted (no key)" note when any are `'unknown'`, then
   `mc-breakdown` rows of message counts — all text, DMs, Channels, Sent, Received (rows with no
   text omitted) — each with segments *Compressed* / *Plain* / *Not decrypted* (grey; its legend
   tooltip says why: no channel PSK, or no stored private key / unknown contact for DMs). Every
   segment is keyed by the compression filter value (chip "Compression: Compressed"). No text
   messages in the shown packets → one-line empty state.
8. **Hop count** distribution (`mc-bar-chart`, vertical-ish is fine as horizontal rows 0,1,2…).

**Drill-down** (model side in §6): clicking a source bar, a channel bar, a hop-count bar, or a breakdown segment /
legend entry (type, route, direction, category, channel, compression) adds a filter for that value; clicking the
active value again removes it. On source bars the *bar* filters and the *label* stays the contact
link. Charts opt in per item with a `key` (`<mc-bar-chart>` dispatches `bar-select`, keyed rows
are `role=button` hit rects with Enter / Space; `<mc-breakdown>` dispatches `segment-select` from
segments and from legend `<button>`s), with `selected` marking the active value; items without a
key (e.g. the contact Stats tab) stay plain. The filter is **shared with the Packets tab** (§6):
switching tabs never clears it. While any criterion other than the range is active a sticky
filter bar sits under the range: a chip per criterion from the core `packetFilterChips` — the
drill-downs and the Packets tab's own filters alike ("Source: Alice ×", "Type: ADVERT ×",
"Text: foo ×"), each removed with `packetLog.removeFilterChip(key)` — "Showing X of Y packets" and
a *Clear filters* button (`clearFilters()`: everything but the range). Filters matching nothing →
"No packets match these filters." with the bar kept. Active-segment highlighting reads
`stats.filters`. On the Packets tab, drill-downs set here show in its controls (direction, a single
type, a single route) or, for the fields it has no control for (source, category, channel, hops,
compression), as removable chips in its filter row (`data-filter="drill-<field>"`); its *Reset*
clears everything, the range included.

Everything renders from the model's signals (read in `render()` → auto re-render). Empty log →
one empty-state line. Browser tests (`packages/web/test/packet-stats.test.ts`, harness +
emulator scenario that produces packets): the tab appears and renders tiles and the four chart
elements; the source chart has links to `/node/…`; the y/colour selectors change the dot plot's
axis label / legend; a date preset shrinks the packet count tile; source-bar / segment / keyboard
filtering, chip removal, *Clear filters* and the no-match state; the shared filter across tabs (a
source drill-down filters the Packets tab and its chip there removes it; a Packets-tab text filter
narrows Stats with a chip; a date preset is the Packets tab's *From*, cleared by *Reset*); the
compression section's counts, summary, *Compressed* filter, empty state and the *Compression* dot
colouring; the paths card's summary, map lines and widths, sized markers with counts (this radio
`self`), note, filter narrowing, the approximate toggle's dashed lines and *Hide map*.

## 4. Docs

Add a row to `docs/roadmap.md` (Phase 9 area) and a line to `packages/core/src/app/README.md`
for `packet-stats-model.ts` / `airtime.ts`.

## 5. Node page "Stats" tab

The node page (`/node/:key`, see roadmap "Node page") has a *Stats* tab (`/node/:key/stats`) next
to *Info* and the other tabs.
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
value = count; footer "last heard" via tooltip; the label links to the node page's Path tab `/node/:key/path`
only for the contact's current out_path row, otherwise plain text; a *Map* button swaps the chart
for `mc-tile-map` showing every path at once: `app.paths.usage()` (core `path-usage.ts`) lays
each path out like the path dialog (contact → hops → this radio), merges stops by node (or hash +
estimated position) and sums packets per hop segment, and each line's width is proportional to
its count, the busiest hop 14 px, minimum 2 px. Hops without a location are only estimated while
the "approximate positions" setting is on (a checkbox under the map, as in the path dialog);
otherwise the segment skips them. A segment is dashed only when every packet over it had an
estimated end or skipped a hop); *Signal over time*
(`mc-dot-plot`: x time, y SNR (selector SNR / RSSI / Hops), colour = path (top 8 paths, rest
Other), dot size = bytes); *Hop count* distribution. Browser test in
`packages/web/test/contact-stats.test.ts`: the tab appears, the paths chart lists the direct row
and a repeated path from the emulator scenario, the timeline renders.

## 6. Drill-down filters

Clicking a bar on the packets Stats tab narrows every statistic to the matching packets. The
Packets and Stats tabs share **one filter**, owned by the packet log
(`app.packetLog.packets.filter`, a `PacketFilter`; in memory only, not persisted; drill-downs
survive range changes). The stats model reads and writes it through `PacketLogModel.sharedFilter`
(`PacketStatsDeps.filter`); `stats.filters` is a computed drill-down view of it:

```ts
type StatsFilterField = 'source' | 'type' | 'route' | 'direction' | 'category' | 'channel' | 'hops' | 'compression';
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
  unknown hops never match), compression → `'smaz'` / `'plain'` / `'unknown'` (non-text packets
  never match).
- Filters AND together; at most one per field — adding one on a field that already has one
  replaces it.
- `summary`, `bySource`, `timeline`, `utilization`, `hops` and `compression` count the filtered `points`.
  `window` (and so the bins and `summary.spanMs`) comes from the range and `allPoints`, so axes
  don't move while drilling down.
- `forContact()` reads `allPoints`: the packets page's filters don't leak into the node page's Stats tab.

Mapping onto `PacketFilter` (`statsFiltersOf` / `withStatsFilter` / `withoutStatsFilter`):

- The range is `from` / `to` (`range` is computed from them; `setRange` sets them, and a change
  from the Packets tab's date inputs reloads `allPoints` too).
- direction → `direction` (`'in'` ↔ `'rx'`, `'out'` ↔ `'tx'`); type → `payloadTypes: [n]`; route →
  `routeTypes: [n]` — so the Packets tab's selects show them. A type / route key with no number
  (`'UNKNOWN'` / `'unknown'`) and every other field (source, category, channel, hops, compression)
  go to `PacketFilter.drill` (at most one entry per field). `filters` lists direction, a single
  type, a single route, then `drill`; several types / routes picked on the Packets tab have no
  drill-down equivalent (no segment is highlighted) but still narrow `points`.
- `points` = `allPoints` matching the `drill` entries **and** every packet-log criterion
  (direction, types, routes, `src`, `node`, `text`) via the log's own predicate.
- The log matches `drill` against the stats model's derived point of each record
  (`PacketLogModel.attachStats`, bound by `AppModel`); its queries wait for the stats load of the
  current range, and live records are shown once their point is derived.
- `addFilter` / `removeFilter` / `clearFilters` return promises (the log has reloaded);
  `clearFilters` keeps the range. Chips: `packetFilterChips(f)` (keys `direction`, `types`,
  `routes`, `src`, `node`, `text`, `drill-<field>`; no chip for the range), removed with
  `withoutChip` / `PacketLogModel.removeFilterChip(key)`; `STATS_FIELD_LABEL` names the fields.
