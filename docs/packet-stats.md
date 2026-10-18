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
  lastHop: NodeRef | null;// the node this radio heard transmit it (see 1.3); null when unknown
  direct: boolean;        // flood with an empty path (heard straight from the source)
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

`lastHop`: the node whose transmission this radio heard, so the received packet's `snr` / `rssi`
measure the link from it to this radio. For a flood it is the last entry of the packet's path
(`viewPacket(...).path` is ordered oldest → newest forwarder, see mesh-packet-format.md §1.3)
resolved with `resolveHop` (repeaters / rooms preferred). When a flood's path is empty the packet
was heard directly: `direct = true` and `lastHop = source` (may be `null`). TRACE packets' path
holds SNRs, not hashes: `lastHop = null`. DIRECT / TRANSPORT_DIRECT packets carry the route still
to travel and each forwarder removes itself from it, so the transmitter is not recorded:
`lastHop = null` and `direct = false` (even with no hops left: the sender may have been the source
or a forwarder). An unknown route type is read as a flood.

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

**Decode limit.** `loraSnrFloorDb(sf)` is the LoRa demodulation SNR floor (Semtech SX126x / SX127x
datasheets): SF5 −2.5, SF6 −5, SF7 −7.5, SF8 −10, SF9 −12.5, SF10 −15, SF11 −17.5, SF12 −20 dB, null
for any other SF. `PacketStatsModel.decodeLimit` (`{ sf, snrDb } | null`, via `loraDecodeLimit(radio)`)
is that floor at the connected radio's SF, null when the radio params are unknown; the SNR dot plot
and the signal-by-last-hop box plot draw it as a reference line (§3). Packets near or below it are marginal links.

### 1.6 Aggregations (all `computed` from `points`, i.e. after the §6 filters)

```ts
summary: { packets, bytes, airtimeMs, airtimeFraction /* airtime / range span, null if unknown */, sources /* unique resolved + unresolved labels */, spanMs }
bySource: { top: { node: NodeRef; count: number; bytes: number; airtimeMs: number }[] /* top 50, count desc */, unattributed: number, others: number /* beyond the top 50 */ }
pathStarts / pathEnds: same shape as bySource (nodeStats), per first / last `path` entry (path order, oldest forwarder first); `unattributed` = packets with no path
lastHops: LastHopStats   // signal per last hop (lastHopSignalStats(points, decodeLimit)), received packets only, see below:
  // { top: LastHopSignal[] /* top 50, count desc, then label */, decodeLimit: DecodeLimit | null,
  //   unattributed /* received, lastHop null: TRACE, direct routes, unattributed zero-hop */, others, othersPackets }
  // LastHopSignal = SnrSummary & { node: NodeRef; lastTs; direct /* zero hop: the node is the source */; relayed /* count − direct */;
  //   medianRssi /* over those with an RSSI, null when none */;
  //   margin /* snr.median − decodeLimit.snrDb; null without an SNR or when the SF is unknown */;
  //   level: 'comfortable' /* margin ≥ 10 dB */ | 'ok' /* ≥ 5 dB */ | 'marginal' /* < 5 dB */ | null }
  // SnrSummary = { count, snrCount /* with an SNR */, meanSnr, minSnr, maxSnr /* null when no SNR */, meanRssi /* over those with an RSSI */,
  //               snr: BoxStats | null /* Tukey box over the SNR values; null when none */ }
  // BoxStats (app/box-stats.ts, boxStats(values), null for an empty sample) = { n, min, q1, median, q3, max, mean,
  //   whiskerLow, whiskerHigh /* most extreme values within 1.5·IQR of the box */, outliers /* beyond, ascending, uncapped */ }
  //   Quartiles by linear interpolation between closest ranks (R type 7 / numpy default: h = (n − 1)·p).
  // Grouped by nodeId(lastHop), so an ambiguous hop hash (resolveHop label `a3?`) is a row of its own
  // rather than being dropped or split: it is still one radio link, just not attributable to one contact.
timeline: { binMs: number; bins: { t: number; series: Record<string, number> }[]; series: string[] }
   // series (non-empty only, by count desc, 'Other' last): one per known channel name (GRP_TXT/GRP_DATA), 'Unknown channels', 'DMs' (TXT_MSG), 'Adverts', 'ACKs', 'Paths', 'Traces', 'Requests' (REQ/RESPONSE/ANON_REQ), 'Control', 'Other' (MULTIPART, RAW_CUSTOM, unknown). Bin size picked from the span: aim for 60–150 bins on round steps (1 min … 1 day). Expose `setBin(ms | 'auto')` too.
utilization: {
  overTime: { t: number; airtimeMs: number; fraction: number }[]   // same bins as timeline
  byType: { name: string; count: number; bytes: number; airtimeMs: number }[]      // payload type
  byRoute: …  byDirection: …  byCategory: …  byChannel: …  byRegion: …   // byRegion: TRANSPORT_FLOOD only, by StatPacket.region (name or '?')
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

**Signal and link margin per last hop** (`lastHops`, `lastHopSignalStats(pts, decodeLimit)`):
"which nodes do I hear directly, and how reliably?". One aggregation over the filtered, in-range
**received** packets (sent packets are skipped), grouped by `nodeId(lastHop)`; a zero-hop flood counts
its source as the last hop (§1.3, `direct`), so a neighbour's own packets and the ones it relayed are
one link. Each node's `margin` is its median SNR (the box's median) over the decode limit (§1.5) and
`level` its `linkMarginLevel(margin)`; `LINK_MARGIN_COMFORTABLE_DB` / `LINK_MARGIN_OK_DB` hold the
thresholds. The median RSSI is by `quantileSorted(…, 0.5)` (box-stats.ts). The 50 nodes with the most
packets are kept, by count desc. **Unresolved hops** are kept, not dropped or pooled: an unknown or
ambiguous hop hash is its own row (`a3?`, `node.resolved` false) and its `lastHop` drill-down still
works (`#a3`).

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

### 1.8 Noise floor

**Collection** (`app/noise-floor.ts`, `NoiseFloorSampler`, `app.noiseFloor`): while a radio is
connected (phase `connected`, store open), the app reads GET_STATS radio (companion-protocol.md
§4 cmd 56 / §5.6, via `DeviceSettingsModel.readRadioStats`) 5 s after the connection is up and
then every 60 s on `app.clock`, and stores `{ t, noiseFloorDbm, lastRssiDbm, lastSnr }` (`t` = when
the request was sent) in the radio's `noiseFloor` IndexedDB store (schema v4, keyPath `t`,
`store/noise-floor.ts` `NoiseFloorLog`: `add`, `range({ from, to })`, `prune(before)`, `clear`;
events `noiseFloor` / `noiseFloorChanged`). A tick that finds the previous request outstanding is
skipped; a failed request is skipped; firmware that answers ERR (no GET_STATS before v8) stops
sampling for that connection (`supported` → false). Nothing raises a notification. Samples follow
the packet retention setting (`AppSettingsModel` prunes both) and go with the database when a radio
is removed; `radioDbStats` counts them. `AppModelOptions.noiseFloorSampling: false` turns it off.

**Model**: `PacketStatsModel.noiseFloor` holds the samples in the date range (ascending `t`,
loaded with the packets, live-tailed from `noiseFloor` events, reloaded on `noiseFloorChanged`; the
drill-down filters don't apply), `noiseFloorSummary` their `noiseFloorSummary()` (samples, median,
min, max, latest dBm; null when none). Charts treat samples more than `NOISE_FLOOR_GAP_MS` (3 min)
apart as a gap (not connected).

### 1.9 Tests (`packet-stats-model.test.ts`, node vitest)

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
- `<mc-box-plot>` horizontal box-and-whisker rows on one value axis (tick labels below, zero line when 0 is in range): `rows: { label, box: BoxStats | null, detail?, tone?: 'good' | 'ok' | 'bad', valueText?, valueSub?, href?, title?: string | string[], key?, selected? }[]`, `refLine: { value, label } | null`, `label` (the SVG's aria-label; the ref label is appended), `format`, `empty-row-text`; per row whiskers with end caps, box q1–q3, median line, mean diamond, outlier dots, the median printed at the right (`valueText` / `valueSub` instead when set, the sub line in the tone colour); a null box shows `empty-row-text`. A row's `tone` colours its box and outliers `--mc-ok` / `--mc-warn` / `--mc-danger` (`data-tone` on the row group; the chart colour when none); `detail` is a muted second label line (rows grow to two lines when any row has a `detail` or `valueSub`). `refLine` is a vertical dashed `--mc-danger` line across every row, labelled above them (`data-ref-line`), always inside the axis. Label links, tooltip and keyed-row `bar-select` / pressed state as `<mc-bar-chart>`.
- `<mc-dot-plot>` `points: { x: number, y: number | null, size: number, color: string /* series key */, id }[]`, `xDomain`, `yLabel`, `yFormat`; dot radius ∝ `sqrt(size)` (area ∝ bytes, 2–9 px); nulls in `y` dropped with a count shown ("n packets without SNR"); click → `dot-select` event with the id; legend with series → colour (≤ 8 + Other). `refLines: RefLine[]` draws reference lines under the dots (muted label above the right end, `data-ref-line=key`, labels appended to the SVG's aria-label) and widens the y domain so each line is always visible: `{ value, label, key? }` is a horizontal dashed line (`--mc-warn` stroke); `{ kind: 'series', points: { t, v }[], holdMs?, label, key? }` a step path (each sample held until the next, or for `holdMs` → a gap; clipped to the plot; `data-ref-kind="series"`, `stepPath`).
- `<mc-line-chart>` `series: { key, points: { t, v }[] }[]`, `xDomain`, `stacked?: boolean`; crosshair tooltip listing all series at the hovered bin; legend. `fit-y` fits the y range to the data instead of starting at 0 (not stacked); `gap-ms` breaks the line between points further apart (`splitAtGaps`).
- `<mc-breakdown>` a single horizontal 100 % stacked bar per dimension: `segments: { label, value, title?, key?, selected? }[]` with a legend / inline labels; 2 px gaps between segments; keyed segments dispatch `segment-select`.
- `<mc-stat-tile>` label + big value + optional sub-text.

Browser tests (`packages/web/test/charts.test.ts`): each element renders the expected number of
marks for a small dataset, links appear, dot click dispatches the id, series beyond 8 fold.

## 3. Web: the Stats tab (`packages/web/src/pages/packets/packet-stats.ts`, `<mc-packet-stats>`)

**Page layout.** `/packets` renders, top to bottom: one **shared filter area**
(`<mc-packet-filters>`, `packages/web/src/pages/packets/packet-filters.ts`, rendered once by the
page so switching tabs keeps it mounted; sticky under the app header on wide viewports), then the
tab row *Stats | List* (*| Frames* only with the `showFrames` app setting, off by default),
then the tab content. The page opens on *Stats*; the *List* tab is the packet log table. A page
reopened in the same session (e.g. back from `/packets/:id`) shows the tab it last showed, and
`/packets/node/:key` opens *List*. The filter area edits the shared packet filter (§6): date range — presets
*All* (default), *Last hour*, *24 h*, *7 d*, and one pair of `datetime-local` *From* / *To* inputs
(`<mc-stats-range parts="range">`; the range is the filter's `from` / `to`) — direction, types,
route, node, text, removable chips for criteria with no control of their own (the
`/packets/node/:key` source, `data-filter="src"`, and Stats drill-downs, `data-filter="drill-<field>"`
/ `data-chip="<field>"`), and *Reset* (`data-action="clear-filters"`), which clears everything, the
range included. The chips sit on their own row after the controls (`data-filter-chips`), so adding
one never shifts the controls. On the Frames tab the area is hidden: frames keep their own filter row in the
Frames panel, since the packet filter does not apply to them.

`LogTab` gains `'stats'`; the packets page renders `<mc-packet-stats>` for it (the list toolbar
is not shown; the inspector split is hidden). The Stats panel, top to bottom:

1. **Bin size** *auto / 1 min / 5 min / 1 h / 1 d* (`<mc-stats-range parts="bin">`; kept in the
   stats model, not in the URL), and, while any criterion other than the range is active,
   "Showing X of Y packets" (`data-field="filter-count"`). A line of stat tiles: packets, bytes, airtime %
   (with the radio params in the tooltip, "—" when unknown), unique sources, span.
2. **Packet rate** (`mc-line-chart`): the `timeline` series (per channel, unknown channels, DMs,
   adverts, ACKs, paths, traces, requests, control); the 8 biggest get a line, the rest are summed into *Other*; hovering a legend entry lists the payload types it counts (`timelineSeriesDescription`; a folded *Other* lists the series it sums); always stacked, so the top edge is the total rate.
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
   On *SNR*, a dashed line marks the radio's decode limit (`decodeLimit`, §1.5), labelled e.g.
   "SF10 decode limit −15 dB"; no line when the SF is unknown (`dotRefLines`). On *RSSI*, the
   noise floor (`noiseFloor`, §1.8) is a step line labelled "Noise floor" (gaps where not
   connected), so each packet's RSSI can be compared with the noise at that moment.
   **Noise floor** (`data-section="noise-floor"`): a summary line (`noiseFloorText`: median,
   min to max, latest, sample count), an `mc-line-chart` (`fit-y`, `gap-ms` =
   `NOISE_FLOOR_GAP_MS`, same `xDomain` as the other time charts) of the samples in the range, and
   a muted note (background noise level; higher = noisier; sampled every minute while connected;
   gaps = not connected). Empty state `data-empty="noise-floor"` (or, when the firmware refused
   GET_STATS, says so).
5. **Network utilisation**: `mc-line-chart` of airtime fraction over time (single series, %), then
   `mc-breakdown` rows for payload type, route type, direction, channel / category — each showing
   airtime share (with packet count in the tooltip). When airtime is unknown, fall back to bytes
   and say so.
6. **Text compression** (`compression`, §1.6): a summary line ("X% of decrypted text messages
   compressed · N B saved (Y%) across M compressed messages · S senders using compression"), a
   muted "n messages could not be decrypted (no key)" note when any are `'unknown'`, then
   `mc-breakdown` rows of message counts — all text, DMs, Channels, Sent, Received (rows with no
   text omitted) — each with segments *Compressed* / *Plain* / *Not decrypted* (grey; its legend
   tooltip says why: no channel PSK, or no stored private key / unknown contact for DMs). Every
   segment is keyed by the compression filter value (chip "Compression: Compressed"). No text
   messages in the shown packets → one-line empty state.
7. **Hop count** distribution (`mc-bar-chart`, vertical-ish is fine as horizontal rows 0,1,2…).
8. **Packet paths** (`data-section="paths"`, from `routes`, §1.7): hidden by default behind a
   *Map* / *Hide map* toggle (`aria-pressed`); while hidden, one line "N packets with a known
   route, M distinct paths". Shown, it is an `<mc-tile-map>` of
   `app.paths.routesUsage(routes, { directed: true })` drawn like the contact "paths heard via" map
   (§5, shared `directedUsageLines` in `components/path-usage-lines.ts`): one line per hop segment
   and direction, with an arrowhead at its middle showing travel direction (a hop crossed both ways
   draws two lines side by side), 2–14 px wide in proportion to the packets that crossed it that
   way (busiest 14 px), dashed when it leads to an estimated position or skips
   an unplaced hop; one marker per stop (kind from its node, so this radio is `self`) with its
   packet count in the tooltip, its diameter 1.1–2 rem ∝ √(count / busiest stop) via the marker's
   `--marker-size`; a note with the total, the busiest count and how many packets crossed hops
   with no known location; the "Approximate positions of nodes without a location" checkbox
   (shown when estimating or anything is incomplete); nothing placeable → a one-line empty state.
   The map fits its bounds when opened, when the checkbox changes and when the routes change
   (range / filters), and follows the §6 filters like every other chart.
9. **Most common first nodes in path** (`data-section="path-starts"`, `pathStarts`) and **Most common
   final nodes in path** (`data-section="path-ends"`, `pathEnds`): `mc-bar-chart`s like the source
   chart (top 50, contact links), footer "n packets had no path, m more nodes". For a received flood
   the first node is the repeater nearest the source and the final one is the repeater this radio
   heard; for a direct packet they are the next and last hops still to travel. A bar filters by that
   node (chips "First in path: X" / "Last in path: X").
   Each card has its own *Map* / *Hide map* toggle (`data-action="path-starts-map"` /
   `"path-ends-map"`, `aria-pressed`), shown above the bars: an `<mc-tile-map>` with one marker per
   node (`placeNodeCounts`: the node's stop in the paths map's `routesUsage`, by key else the busiest
   stop of its hash, so the maps agree, estimates included), its diameter 1.1–2 rem ∝ √(count /
   busiest) like the paths map (dot area ∝ packets), the count in its tooltip; a note with the
   busiest count and how many nodes (packets) have no known location; the shared "Approximate
   positions" checkbox. Each map fits its markers when opened / when the checkbox changes, and
   re-fits only when filters move its bounds.
10. **Signal by last hop** (`data-section="last-hops"`, `lastHops` §1.6, `mc-box-plot`), right after the first / final
   path node charts (the last card): how well this radio hears each neighbour, and its margin over
   the decode limit. One horizontal box plot per last hop (`LastHopSignal.snr`; top 50 by packet
   count, contact links like the source chart, `a3?` rows for ambiguous hashes) on a shared SNR axis
   (dB): box = q1–q3, a line at the median, whiskers to `whiskerLow` / `whiskerHigh`, a dot per
   outlier and a mean marker; nodes whose packets carried no SNR show no box. The radio's decode
   limit is a dashed vertical line across all rows ("SF10 limit −15 dB", none when the SF is
   unknown). The label has a muted "n pkts · −95 dBm" line (count, median RSSI); each box is
   coloured by its margin level (comfortable `--mc-ok`, ok `--mc-warn`, marginal `--mc-danger`) and
   at the right the margin ("+12.5 dB") over the level word, so it is not colour-only (the median,
   uncoloured, when the SF is unknown). Tooltip with n, median, IQR, range (min–max), mean, margin,
   median RSSI, the packet count (direct / relayed) and last heard; footer "n received packets had
   no last hop, m more nodes"; a muted note explains the margin. Clicking a row filters by that last
   hop (chip "Last hop: X", field `lastHop`). Fits a phone-width card (the page grid is
   `minmax(0, 1fr)` so measured charts shrink after a resize).

**Drill-down** (model side in §6): clicking a source bar, a channel bar, a hop-count bar, a first / final path node bar, a last-hop signal row, or a breakdown segment /
legend entry (type, route, direction, category, channel, compression) adds a filter for that value; clicking the
active value again removes it. On source bars the *bar* filters and the *label* stays the contact
link. Charts opt in per item with a `key` (`<mc-bar-chart>` dispatches `bar-select`, keyed rows
are `role=button` hit rects with Enter / Space; `<mc-breakdown>` dispatches `segment-select` from
segments and from legend `<button>`s), with `selected` marking the active value; items without a
key (e.g. the contact Stats tab) stay plain. The filter is **shared with the List tab** (§6):
switching tabs never clears it. Drill-downs show in the shared filter area above the tabs: in its
controls (direction, a single type, a single route) or, for the fields it has no control for
(source, category, channel, hops, compression, path start / end, last hop), as removable chips ("Source: Alice ✕", removed with
`packetLog.removeFilterChip(key)`); its *Reset* clears everything, the range included. Filters
matching nothing → "No packets match these filters." with the "Showing 0 of Y" line kept.
Active-segment highlighting reads `stats.filters`.

Everything renders from the model's signals (read in `render()` → auto re-render). Empty log →
one empty-state line. Browser tests (`packages/web/test/packet-stats.test.ts`, harness +
emulator scenario that produces packets): the tab appears and renders tiles and the four chart
elements; the source chart has links to `/node/…`; the y/colour selectors change the dot plot's
axis label / legend; a date preset shrinks the packet count tile; source-bar / segment / keyboard
filtering, chip removal in the top area, *Reset* and the no-match state; the shared filter across tabs (a
source drill-down filters the List tab and its chip removes it; a text filter narrows Stats with
the filtered count; one preset / *From* pair for both tabs, cleared by *Reset*); the
compression section's counts, summary, *Compressed* filter, empty state and the *Compression* dot
colouring; the paths card's summary, map lines and widths, sized markers with counts (this radio
`self`), note, filter narrowing, the approximate toggle's dashed lines and *Hide map*; the link
quality rows (order, labels, detail, margin text and tone, the decode-limit line, row click → lastHop
filter), its empty state and its phone-width fit.

## 4. Docs

Add a row to `docs/roadmap.md` (Phase 9 area) and a line to `packages/core/src/app/README.md`
for `packet-stats-model.ts` / `airtime.ts`.

## 5. Node page "Stats" tab

The node page (`/node/:key`, see roadmap "Node page") has a *Stats* tab (`/node/:key/stats`) next
to *Info* and the other tabs.
*Stats* is `<mc-contact-stats key=…>` (`packages/web/src/pages/messaging/contact-stats.ts`) fed by
`app.packetStats.forContact(key)` and the same global date range (the same
`components/stats-range.ts` element as `/packets`, bound to the model, with every part shown: presets,
*From* / *To* and bin size). To support it, `StatPacket` also carries:

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
  lastHopOf: readonly StatPacket[]   // received packets whose lastHop.key === key, whatever their source (ascending)
  lastHopSignal: { ts: number; snr: number | null; rssi: number | null; direct: boolean /* zero hop from this node */; id: number }[] // lastHopOf, ascending
  lastHopSummary: SnrSummary         // { count, snrCount, meanSnr, minSnr, maxSnr, meanRssi, snr: BoxStats | null } over lastHopOf
  lastHopBoxes: { all: BoxStats | null; direct: BoxStats | null /* zero hop: this node is the source */; relayed: BoxStats | null }
                                     // SNR boxes over lastHopOf (packets without an SNR skipped; null when no values)
}
```

`lastHopOf` is "how well our radio hears this node": every packet whose final transmission came
from it, its own (zero hop) and the ones it relayed. It matters most for repeaters, which rarely
originate packets but relay many.

The tab shows: stat tiles (packets from the contact, via the contact as a forwarder, distinct
paths, share heard directly, mean SNR); *Heard over time* (`mc-line-chart`, series by category);
*Paths heard via* (`mc-bar-chart`: label = resolved hop names joined with " > ", or *direct*;
value = count; footer "last heard" via tooltip; the label links to the node page's Path tab `/node/:key/path`
only for the contact's current out_path row, otherwise plain text; a *Map* button swaps the chart
for `mc-tile-map` showing every path at once: `app.paths.usage()` (core `path-usage.ts`) lays
each path out like the path dialog (contact → hops → this radio), merges stops by node (or hash +
estimated position) and sums packets per hop segment (`directed`: kept in travel order), and each
line's width is proportional to its count, the busiest hop 14 px, minimum 2 px, with an arrowhead
at its middle pointing towards this radio. Hops without a location are only estimated while
the "approximate positions" setting is on (a checkbox under the map, as in the path dialog);
otherwise the segment skips them. A segment is dashed only when every packet over it had an
estimated end or skipped a hop); *Signal over time*
(`mc-dot-plot`: x time, y SNR (selector SNR / RSSI / Hops), colour = path (top 8 paths, rest
Other), dot size = bytes); *Hop count* distribution; *Heard via this node (last hop)*
(`data-section="last-hop"`, shown when `lastHopOf` is non-empty): a packets tile
(`lastHopSummary.count`), a box plot from `lastHopBoxes` with rows *All* / *Direct* / *Relayed*
(rows without data omitted, and only the one row when just direct or just relayed packets have an SNR,
since *All* would repeat it; same marks and tooltip SNR lines as the §3 item 10 chart; it replaces the
former mean / min–max SNR tiles), then an SNR-over-time `mc-dot-plot` of `lastHopSignal`
(x time, y SNR, colour = *Direct* (zero hop from this node) / *Relayed*; points without an SNR
left out). The section comes right after the tiles when `lastHopOf` outnumbers the packets from the
contact (repeaters), otherwise last; the tab shows its empty state only when `from`, `via` and
`lastHopOf` are all empty. Browser test in
`packages/web/test/contact-stats.test.ts`: the tab appears, the paths chart lists the direct row
and a repeated path from the emulator scenario, the timeline renders, and a repeater's page leads
with the last-hop section (packets tile, a *Relayed* box row, dots).

## 6. Drill-down filters

Clicking a bar on the packets Stats tab narrows every statistic to the matching packets. The
List and Stats tabs share **one filter**, owned by the packet log
(`app.packetLog.packets.filter`, a `PacketFilter`; in memory only, not persisted; drill-downs
survive range changes). The stats model reads and writes it through `PacketLogModel.sharedFilter`
(`PacketStatsDeps.filter`); `stats.filters` is a computed drill-down view of it:

```ts
type StatsFilterField = 'source' | 'type' | 'route' | 'direction' | 'category' | 'channel' | 'hops' | 'compression' | 'pathStart' | 'pathEnd' | 'lastHop' | 'region';
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
  never match), pathStart / pathEnd → `nodeId` of the first / last `path` entry (packets with no
  path never match), lastHop → `nodeId(lastHop)` (sent packets and those with no last hop never
  match; chip label "Last hop"), region → `StatPacket.region` (the saved region whose key gives the
  TRANSPORT_FLOOD code, `'?'` when none / several do; other packets never match). Region is a
  native packet log criterion (`PacketFilter.region`, chip `Region: #name`), like direction.
- Filters AND together; at most one per field — adding one on a field that already has one
  replaces it.
- `summary`, `bySource`, `pathStarts`, `pathEnds`, `lastHops`, `timeline`, `utilization`, `hops` and `compression` count the filtered `points`.
  `window` (and so the bins and `summary.spanMs`) comes from the range and `allPoints`, so axes
  don't move while drilling down.
- `forContact()` reads `allPoints`: the packets page's filters don't leak into the node page's Stats tab.

Mapping onto `PacketFilter` (`statsFiltersOf` / `withStatsFilter` / `withoutStatsFilter`):

- The range is `from` / `to` (`range` is computed from them; `setRange` sets them, and a change
  from the List tab's date inputs reloads `allPoints` too).
- direction → `direction` (`'in'` ↔ `'rx'`, `'out'` ↔ `'tx'`); type → `payloadTypes: [n]`; route →
  `routeTypes: [n]` — so the List tab's selects show them. A type / route key with no number
  (`'UNKNOWN'` / `'unknown'`) and every other field (source, category, channel, hops, compression, path start / end)
  go to `PacketFilter.drill` (at most one entry per field). `filters` lists direction, a single
  type, a single route, then `drill`; several types / routes picked on the List tab have no
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
