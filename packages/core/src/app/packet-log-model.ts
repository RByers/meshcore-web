/**
 * Packet log and frame log (roadmap goal 3, Phase 9): filtered, paged, live-tailing views of the
 * radio's PacketLog (over-the-air packets reported by the device) and FrameLog (every host ↔
 * device companion frame), byte-level inspection, JSON export / import, clear and prune.
 *
 * Inspection uses the packet annotator (packet/annotate.ts) with keys assembled from the store:
 * channel PSKs (ChannelsRepo), contact public keys (ContactsRepo) and, only when the user opted in
 * by storing it, the radio's own private key (setting {@link SELF_PRIVATE_KEY_SETTING}) so DMs to
 * and from this radio can be decrypted. Frames are annotated with protocol/annotate-frame.ts.
 */

import { fromHex, toHex } from '../util/bytes.js';
import { annotatePacket, annotatePayload, type AnnotateKeys, type Annotation } from '../packet/annotate.js';
import { calcSharedSecret } from '../packet/crypto.js';
import { channelHash, parseAdvertPayload } from '../packet/payloads.js';
import { parsePacket } from '../packet/packet.js';
import { PayloadType } from '../packet/constants.js';
import { annotateFrame } from '../protocol/annotate-frame.js';
import { PRIVATE_KEY_SIZE } from '../protocol/constants.js';
import { payloadTypeName, routeTypeName } from '../packet/constants.js';
import { decodeFrame } from '../protocol/decode.js';
import { tryDecodeCommand } from '../protocol/decode-command.js';
import type { Command, DeviceFrame } from '../protocol/types.js';
import type { FrameQuery } from '../store/frame-log.js';
import { PacketLog, type PacketQuery } from '../store/packet-log.js';
import { sourceMatches } from '../store/packet-source.js';
import type { RadioStore } from '../store/radio-store.js';
import type { FrameDirection, FrameRecord, PacketDirection, PacketRecord } from '../store/schema.js';
import { ImportError, isObject, type LogExport, type LogPage } from '../store/time-log.js';
import type { ConnectionModel } from './connection.js';
import {
  EMPTY_SUMMARY_CONTEXT,
  frameCodeName,
  packetMentionsNode,
  summarizePacket,
  viewPacket,
  type DmKeys,
  type PacketEndpoints,
  type PacketView,
  type SummaryContext,
} from './packet-summary.js';
import { contactTypeName, type ContactKind } from './messaging.js';
import { STATS_FIELD_LABEL, filterKey, type StatPacket, type StatsFilter } from './packet-stats-model.js';
import { StoreBoundModel } from './store-bound.js';
import { batch, computed, signal, type ReadonlySignal, type Signal } from './signal.js';
import type { Unsubscribe } from '../util/events.js';

/**
 * Settings key holding the radio's 64-byte expanded private key (hex) for DM decryption in the
 * inspector. Absent by default; set only on explicit user action.
 */
export const SELF_PRIVATE_KEY_SETTING = 'packetLog.selfPrivateKey';

export const BUNDLE_FORMAT = 'meshcore-web/log-bundle';

/** Explains `format: 'none'` packet records (sent packets logged from the host command). */
export const NO_BYTES_MEANING =
  'Logged from the command the app sent to the radio. The radio builds (and encrypts) the on-air packet itself and does not report it back, so its bytes are unknown; the fields shown are what was requested.';

// ---------------------------------------------------------------------------
// Filters and rows
// ---------------------------------------------------------------------------

export interface PacketFilter {
  /** 'rx' / 'tx'; undefined = both. */
  direction?: PacketDirection;
  /** Payload types to show; empty / undefined = all. */
  payloadTypes?: readonly number[];
  /** Route types to show; empty / undefined = all. */
  routeTypes?: readonly number[];
  /** Inclusive epoch-ms window. */
  from?: number;
  to?: number;
  /** Case-insensitive search over hex bytes, type / route names and the summary. */
  text?: string;
  /** Hex node reference: a path / src / dest hash, or a public key (prefix). */
  node?: string;
  /**
   * Source node public key (or key prefix) hex: only packets this node originated (searched
   * through the packet log's source index; see store/packet-source.ts).
   */
  src?: string;
  /**
   * Packet statistics drill-downs (docs/packet-stats.md §6) on the fields the log has no native
   * criterion for (source, category, channel, hops, compression; and type / route when the key
   * maps to no number, e.g. 'UNKNOWN'), at most one per field. Matched against the stats model's
   * derived point of the record (see {@link PacketLogModel.attachStats}); a record without a
   * derived point never matches.
   */
  drill?: readonly StatsFilter[];
}

export interface FrameFilter {
  direction?: FrameDirection;
  /** Frame codes to show; empty / undefined = all. */
  codes?: readonly number[];
  from?: number;
  to?: number;
  /** Case-insensitive search over the code name, kind, summary and hex bytes. */
  text?: string;
}

export interface PacketRow {
  id: number;
  record: PacketRecord;
  typeName: string;
  routeName: string;
  /** Relay hops only: the count and path entries never include the payload's endpoints. */
  hops: number | null;
  path: readonly string[];
  /** Source / destination named by the payload ({@link PacketEndpoints}): the path column's ends. */
  endpoints: PacketEndpoints;
  /** Decoded one-line summary (with decrypted channel text when a PSK is known). */
  summary: string;
}

/** A node known only from a logged ADVERT (its newest one), see {@link PacketLogModel.heardNodes}. */
export interface HeardNode {
  /** Full public key hex. */
  key: string;
  /** Advertised name ('' when the advert has none). */
  name: string;
  /** ADV_TYPE (= contact type: 1 chat, 2 repeater, 3 room, 4 sensor). */
  type: number;
  typeName: ContactKind;
  /** Degrees, when the advert carries a location. */
  lat?: number;
  lon?: number;
  /** The advert's own timestamp, epoch seconds (a contact's `lastAdvert`). */
  advertTimestamp: number;
  /** When the packet was logged, epoch ms. */
  heardAt: number;
  /** The packet record's id. */
  packetId: number;
  snr?: number;
  /** Path hop count; null for a record without the packet envelope. */
  hops: number | null;
}

/** Builds a {@link HeardNode} from a logged ADVERT record; null when it does not parse. */
export function heardNodeFromRecord(r: PacketRecord): HeardNode | null {
  try {
    let payload = r.bytes;
    let hops: number | null = null;
    if (r.format === 'packet') {
      const p = parsePacket(r.bytes);
      if (p.payloadType !== PayloadType.ADVERT) return null;
      payload = p.payload;
      hops = p.pathHashCount;
    } else if (r.format !== 'payload' || r.payloadType !== PayloadType.ADVERT) {
      return null;
    }
    const a = parseAdvertPayload(payload);
    const node: HeardNode = {
      key: toHex(a.publicKey),
      name: a.app.name ?? '',
      type: a.app.nodeType,
      typeName: contactTypeName(a.app.nodeType),
      advertTimestamp: a.timestamp,
      heardAt: r.ts,
      packetId: r.id,
      hops,
    };
    if (a.app.latitude !== undefined && a.app.longitude !== undefined) {
      node.lat = a.app.latitude;
      node.lon = a.app.longitude;
    }
    if (r.snr !== undefined) node.snr = r.snr;
    return node;
  } catch {
    return null;
  }
}

/** {@link PacketLogModel.heardNodes} against a given store. */
export async function heardNodesIn(store: RadioStore, ref: string): Promise<HeardNode[]> {
  const out: HeardNode[] = [];
  for (const r of await store.packets.latestAdverts(ref)) {
    const h = heardNodeFromRecord(r);
    if (h) out.push(h);
  }
  return out;
}

export interface FrameRow {
  id: number;
  record: FrameRecord;
  /** Protocol name of the code ('DEVICE_QUERY', 'SELF_INFO', …). */
  name: string;
  summary: string;
}

export interface PacketInspection {
  record: PacketRecord;
  /** Byte annotation (whole packet, or the bare payload for payload-only records). */
  annotation: Annotation;
  view: PacketView;
  summary: string;
  /** The frame that carried the packet, if still logged. */
  sourceFrame?: FrameRecord;
  /** Number of logged copies with the same packet hash (re-heard / repeated). */
  copies: number;
}

export interface FrameInspection {
  record: FrameRecord;
  name: string;
  annotation: Annotation;
  /** decodeFrame (in) / decodeCommand (out) result; null when it failed. */
  decoded: DeviceFrame | Command | null;
  decodeError?: string;
  /** The packet log entry this frame carried (LOG_RX_DATA etc) or requested (a tx entry), if any. */
  packetId?: number;
}

export interface ImportResult {
  packets: number;
  frames: number;
}

// ---------------------------------------------------------------------------
// Generic live paged view
// ---------------------------------------------------------------------------

interface ViewSource<R, F, Row> {
  query(store: RadioStore, f: F, offset: number, limit: number): Promise<LogPage<R>>;
  count(store: RadioStore, f: F | null): Promise<number>;
  matches(r: R, f: F): boolean;
  row(r: R): Promise<Row>;
}

/**
 * A filtered view of one log, newest first, that tails new records live. It starts with the newest
 * `pageSize` rows and grows by a page each time {@link loadMore} is called (infinite scroll).
 */
export class LogView<R extends { id: number }, F extends object, Row extends { id: number }> {
  readonly #filter: Signal<F>;
  readonly #rows = signal<readonly Row[]>([]);
  /** How many rows the view holds: the newest `#limit` matching records. */
  #limit: number;
  #loadingMore = false;
  readonly #hasMore = signal(false);
  readonly #total = signal(0);
  readonly #matching = signal(0);
  readonly #live = signal(true);
  readonly #missed = signal(0);
  readonly #loading = signal(false);
  #gen = 0;
  #chain: Promise<void> = Promise.resolve();
  /** The newest reload; an older one that it superseded resolves only once this one has. */
  #latestReload: Promise<void> = Promise.resolve();

  readonly filter: ReadonlySignal<F>;
  /** Loaded rows, newest first. */
  readonly rows: ReadonlySignal<readonly Row[]> = this.#rows.readonly;
  /** Older matching records exist beyond the loaded rows (see {@link loadMore}). */
  readonly hasMore: ReadonlySignal<boolean> = this.#hasMore.readonly;
  /** Records in the log. */
  readonly total: ReadonlySignal<number> = this.#total.readonly;
  /** Records matching the filter. */
  readonly matching: ReadonlySignal<number> = this.#matching.readonly;
  /** Live tail: new matching records are prepended as they are logged. */
  readonly live: ReadonlySignal<boolean> = this.#live.readonly;
  /** Matching records logged while live tail is off. */
  readonly missed: ReadonlySignal<number> = this.#missed.readonly;
  readonly loading: ReadonlySignal<boolean> = this.#loading.readonly;

  constructor(
    private readonly src: ViewSource<R, F, Row>,
    private readonly getStore: () => RadioStore | null,
    initial: F,
    readonly pageSize: number,
  ) {
    this.#filter = signal(initial);
    this.filter = this.#filter.readonly;
    this.#limit = pageSize;
  }

  /** Replaces the filter (or merges `patch` into it) and reloads the newest page. */
  setFilter(patch: Partial<F>, opts: { replace?: boolean } = {}): Promise<void> {
    const next = (opts.replace ? { ...patch } : { ...this.#filter.peek(), ...patch }) as F;
    for (const k of Object.keys(next) as (keyof F)[]) if (next[k] === undefined) delete next[k];
    this.#filter.value = next;
    this.#limit = this.pageSize;
    return this.reload();
  }

  clearFilter(): Promise<void> {
    return this.setFilter({}, { replace: true });
  }

  /**
   * Appends the next page of older matching rows. A no-op when there are none or a load is already
   * running. Queued behind live-tail updates so the offset into the log is current.
   */
  loadMore(): Promise<void> {
    if (!this.#hasMore.peek() || this.#loadingMore) return Promise.resolve();
    const store = this.getStore();
    if (!store) return Promise.resolve();
    this.#loadingMore = true;
    const gen = this.#gen;
    const p = this.#chain.then(async () => {
      if (gen !== this.#gen) return;
      // records logged while not tailing sit above the loaded rows
      const offset = this.#rows.peek().length + this.#missed.peek();
      const res = await this.src.query(store, this.#filter.peek(), offset, this.pageSize);
      const more = await Promise.all(res.items.map((r) => this.src.row(r)));
      if (gen !== this.#gen) return;
      const have = new Set(this.#rows.peek().map((x) => x.id));
      const rows = [...this.#rows.peek(), ...more.filter((x) => !have.has(x.id))];
      this.#limit = Math.max(this.#limit, rows.length);
      batch(() => {
        this.#rows.value = rows;
        this.#hasMore.value = res.hasMore;
      });
    });
    this.#chain = p.catch((err: unknown) => console.error('LogView:', err));
    return p.finally(() => {
      this.#loadingMore = false;
    });
  }

  /** Turning live tail on jumps back to the newest page. */
  setLive(on: boolean): Promise<void> {
    this.#live.value = on;
    if (!on) return Promise.resolve();
    this.#limit = this.pageSize;
    return this.reload();
  }

  /**
   * Reloads the loaded rows and counts. Resolves once the page is current: if another reload
   * (e.g. a context reload after a contact change) supersedes this one, after that one.
   */
  async reload(): Promise<void> {
    let p = this.#reloadOnce();
    this.#latestReload = p;
    await p;
    while (this.#latestReload !== p) {
      p = this.#latestReload;
      await p;
    }
  }

  async #reloadOnce(): Promise<void> {
    const store = this.getStore();
    if (!store) return;
    const gen = ++this.#gen;
    this.#loading.value = true;
    try {
      const f = this.#filter.peek();
      const [res, total, matching] = await Promise.all([
        this.src.query(store, f, 0, this.#limit),
        this.src.count(store, null),
        this.src.count(store, f),
      ]);
      const rows = await Promise.all(res.items.map((r) => this.src.row(r)));
      if (gen !== this.#gen) return;
      batch(() => {
        this.#rows.value = rows;
        this.#hasMore.value = res.hasMore;
        this.#total.value = total;
        this.#matching.value = matching;
        this.#missed.value = 0;
      });
    } finally {
      if (gen === this.#gen) this.#loading.value = false;
    }
  }

  /** A record was appended to the log. */
  onRecord(r: R): void {
    this.countRecord();
    this.offer(r);
  }

  /** Counts a record appended to the log without matching it yet (see {@link offer}). */
  countRecord(): void {
    this.#total.update((n) => n + 1);
  }

  /** Shows an appended (already counted) record when it matches the filter. */
  offer(r: R): void {
    if (!this.src.matches(r, this.#filter.peek())) return;
    this.#matching.update((n) => n + 1);
    if (!this.#live.peek()) {
      this.#missed.update((n) => n + 1);
      return;
    }
    const gen = this.#gen;
    // keep arrival order even though building a row is async
    this.#chain = this.#chain
      .then(async () => {
        const row = await this.src.row(r);
        if (gen !== this.#gen) return;
        const rows = [row, ...this.#rows.peek().filter((x) => x.id !== row.id)];
        // Showing only the newest page: keep it a page (the oldest row drops off the end). Once older
        // rows were loaded the list grows instead, so rows the reader scrolled to don't unload.
        if (this.#limit > this.pageSize) this.#limit = Math.max(this.#limit, rows.length);
        batch(() => {
          this.#hasMore.value = this.#hasMore.peek() || rows.length > this.#limit;
          this.#rows.value = rows.slice(0, this.#limit);
        });
      })
      .catch((err: unknown) => console.error('LogView:', err));
  }

  /**
   * A stored record changed in place (same id): its row is rebuilt where it is shown; when the
   * change flips whether it matches the filter, the rows and counts are reloaded.
   */
  onUpdate(r: R, previous: R): void {
    const f = this.#filter.peek();
    const now = this.src.matches(r, f);
    if (now !== this.src.matches(previous, f)) {
      this.#chain = this.#chain.then(() => this.reload()).catch((err: unknown) => console.error('LogView:', err));
      return;
    }
    if (!now || !this.#rows.peek().some((x) => x.id === r.id)) return;
    const gen = this.#gen;
    this.#chain = this.#chain
      .then(async () => {
        const row = await this.src.row(r);
        if (gen !== this.#gen) return;
        this.#rows.value = this.#rows.peek().map((x) => (x.id === row.id ? row : x));
      })
      .catch((err: unknown) => console.error('LogView:', err));
  }

  /** Resolves when live-tail updates queued so far have been applied. */
  settled(): Promise<void> {
    return this.#chain;
  }

  reset(): void {
    this.#gen++;
    this.#limit = this.pageSize;
    batch(() => {
      this.#rows.value = [];
      this.#hasMore.value = false;
      this.#total.value = 0;
      this.#matching.value = 0;
      this.#missed.value = 0;
      this.#loading.value = false;
    });
  }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

function hexNorm(s: string): string {
  return s.toLowerCase().replace(/[^0-9a-f]/g, '');
}

function nonEmpty(xs: readonly number[] | undefined): xs is readonly number[] {
  return xs !== undefined && xs.length > 0;
}

function hasDrill(f: PacketFilter): boolean {
  return f.drill !== undefined && f.drill.length > 0;
}

/**
 * What the log needs from the packet statistics model to match {@link PacketFilter.drill}
 * (implemented by PacketStatsModel; bound late because the stats model is built from the log).
 */
export interface DrillSource {
  /** The derived statistics point of a record; undefined when not (yet) derived or out of range. */
  point(id: number): StatPacket | undefined;
  /**
   * Resolves once the load for the current date range has finished. Must not wait for the packet
   * log (it is awaited from inside a log query).
   */
  loaded(): Promise<void>;
  /** `appended`: a live record's point was derived; `reloaded`: a load (or re-derivation) completed. */
  watch(l: { appended(rec: PacketRecord): void; reloaded(): void }): Unsubscribe;
}

/**
 * The packet log's filter as shared with the statistics model: the Packets and Stats tabs of
 * /packets read and write the same {@link PacketFilter}.
 */
export interface SharedPacketFilter {
  readonly filter: ReadonlySignal<PacketFilter>;
  setFilter(patch: Partial<PacketFilter>, opts?: { replace?: boolean }): Promise<void>;
  /** The log's predicate (`PacketLogModel.packetMatches`). */
  matches(r: PacketRecord, f: PacketFilter): boolean;
}

export class PacketLogModel extends StoreBoundModel {
  readonly #ctx = signal<SummaryContext>(EMPTY_SUMMARY_CONTEXT);
  readonly #channelPsks = signal<readonly Uint8Array[]>([]);
  readonly #contactKeys = signal<readonly Uint8Array[]>([]);
  readonly #selfKey = signal<Uint8Array | null>(null);
  /** Decrypted summaries by packet id (search uses them for already-seen packets). */
  readonly #summaries = new Map<number, string>();
  /** ECDH shared secrets by contact key hex (only while the radio key is stored). */
  readonly #secrets = new Map<string, Promise<Uint8Array | null>>();

  /** Names / channel hashes used to describe packets. */
  readonly context: ReadonlySignal<SummaryContext> = this.#ctx.readonly;
  /** True when the radio's private key is stored for DM decryption (opt-in). */
  readonly selfKeyStored: ReadonlySignal<boolean> = computed(() => this.#selfKey.value !== null);
  /**
   * Keys for decrypting DMs to / from this radio (summaries, packet statistics), null unless the
   * radio's private key is stored (opt-in). Shared secrets are cached per contact until the key
   * changes. A new object whenever the key or the contact key list changes.
   */
  readonly dmKeys: ReadonlySignal<DmKeys | null> = computed(() => {
    const priv = this.#selfKey.value;
    const pub = this.connection.store.value?.pubKey;
    const contacts = this.#contactKeys.value;
    if (!priv || !pub) return null;
    return {
      selfPublicKey: fromHex(pub),
      contacts,
      sharedSecret: (peer: Uint8Array) => {
        const k = toHex(peer);
        let s = this.#secrets.get(k);
        if (!s) {
          s = calcSharedSecret(priv, peer).catch(() => null);
          this.#secrets.set(k, s);
        }
        return s;
      },
    };
  });

  /** The statistics model matching drill-downs; see {@link attachStats}. */
  #stats: DrillSource | null = null;
  /** Drill-down queries waiting for a stats load (which they will see when they resume). */
  #drillWaiting = 0;

  /** Over-the-air packets. */
  readonly packets: LogView<PacketRecord, PacketFilter, PacketRow>;
  /** `packets`' filter, shared with the statistics model. */
  readonly sharedFilter: SharedPacketFilter;
  /** Host ↔ device frames. */
  readonly frames: LogView<FrameRecord, FrameFilter, FrameRow>;

  constructor(connection: ConnectionModel, opts: { pageSize?: number } = {}) {
    super(connection);
    const pageSize = opts.pageSize ?? 100;
    const getStore = (): RadioStore | null => this.store;
    this.packets = new LogView<PacketRecord, PacketFilter, PacketRow>(
      {
        query: async (s, f, offset, limit) => {
          await this.#drillReady(f);
          return s.packets.query({ ...this.#packetQuery(f), offset, limit });
        },
        count: async (s, f) => {
          if (!f) return s.packets.count({});
          await this.#drillReady(f);
          return s.packets.count(this.#packetQuery(f));
        },
        matches: (r, f) => this.packetMatches(r, f),
        row: (r) => this.#packetRow(r),
      },
      getStore,
      {},
      pageSize,
    );
    this.sharedFilter = {
      filter: this.packets.filter,
      setFilter: (patch, o) => this.packets.setFilter(patch, o),
      matches: (r, f) => this.packetMatches(r, f),
    };
    this.frames = new LogView<FrameRecord, FrameFilter, FrameRow>(
      {
        query: (s, f, offset, limit) => s.frames.query({ ...this.#frameQuery(f), offset, limit }),
        count: (s, f) => s.frames.count(f ? this.#frameQuery(f) : {}),
        matches: (r, f) => this.frameMatches(r, f),
        row: (r) => Promise.resolve(frameRow(r)),
      },
      getStore,
      {},
      pageSize,
    );
  }

  protected override bind(store: RadioStore) {
    const offs = [
      store.events.on('packet', (r) => {
        // with a drill-down active the record can only be matched once the stats model has derived
        // its point: it is offered then (`attachStats`)
        if (this.#stats && hasDrill(this.packets.filter.peek())) this.packets.countRecord();
        else this.packets.onRecord(r);
      }),
      store.events.on('packetUpdated', (e) => {
        this.#summaries.delete(e.record.id);
        this.packets.onUpdate(e.record, e.previous);
      }),
      store.events.on('frame', (r) => this.frames.onRecord(r)),
      store.events.on('logChanged', (e) => {
        if (e.store === 'packets') void this.packets.reload();
        else void this.frames.reload();
      }),
      store.events.on('contact', () => void this.reload()),
      store.events.on('channel', () => void this.reload()),
      store.events.on('setting', (e) => {
        if (e.key !== SELF_PRIVATE_KEY_SETTING) return;
        this.#selfKey.value = parseKey(e.value);
        this.#secrets.clear();
        this.#summaries.clear();
        void this.packets.reload(); // DM rows gain / lose their decrypted text
      }),
    ];
    return () => offs.forEach((off) => off());
  }

  protected async load(store: RadioStore): Promise<void> {
    await this.#loadContext(store);
    await Promise.all([this.packets.reload(), this.frames.reload()]);
  }

  protected reset(): void {
    this.#ctx.value = EMPTY_SUMMARY_CONTEXT;
    this.#channelPsks.value = [];
    this.#contactKeys.value = [];
    this.#selfKey.value = null;
    this.#summaries.clear();
    this.#secrets.clear();
    this.packets.reset();
    this.frames.reset();
  }

  /** Resolves once loads and queued live-tail updates have been applied. */
  override async settled(): Promise<void> {
    await super.settled();
    await Promise.all([this.packets.settled(), this.frames.settled()]);
  }

  /**
   * Binds the statistics model that matches {@link PacketFilter.drill} (AppModel, once, when it
   * creates `packetStats`). While a drill-down is active, live records are shown once their point
   * is derived, and the page reloads when the stats model reloads (range, channel or DM key change).
   */
  attachStats(stats: DrillSource): Unsubscribe {
    this.#stats = stats;
    const off = stats.watch({
      appended: (rec) => {
        if (hasDrill(this.packets.filter.peek())) this.packets.offer(rec);
      },
      reloaded: () => {
        if (this.#drillWaiting === 0 && hasDrill(this.packets.filter.peek())) void this.packets.reload();
      },
    });
    return () => {
      off();
      if (this.#stats === stats) this.#stats = null;
    };
  }

  /** With a drill-down, waits until the stats model has loaded the current range. */
  async #drillReady(f: PacketFilter): Promise<void> {
    const stats = this.#stats;
    if (!stats || !hasDrill(f)) return;
    this.#drillWaiting++;
    try {
      await stats.loaded();
    } finally {
      this.#drillWaiting--;
    }
  }

  /** Removes one criterion shown by {@link packetFilterChips}. */
  removeFilterChip(key: string): Promise<void> {
    return this.packets.setFilter(withoutChip(this.packets.filter.peek(), key), { replace: true });
  }

  async #loadContext(store: RadioStore): Promise<void> {
    const [contacts, channels, self] = await Promise.all([
      store.contacts.list(),
      store.channels.list(),
      store.settings.get<unknown>(SELF_PRIVATE_KEY_SETTING),
    ]);
    const chans = await Promise.all(
      channels.map(async (c) => ({ name: c.name || `slot ${c.deviceIndex ?? '?'}`, psk: c.psk, hash: await channelHash(c.psk).catch(() => -1) })),
    );
    const selfName = this.connection.selfInfo.peek()?.name ?? 'self';
    batch(() => {
      this.#ctx.value = {
        nodes: [{ key: store.pubKey, name: selfName }, ...contacts.map((c) => ({ key: c.key, name: c.name }))],
        channels: chans.filter((c) => c.hash >= 0),
      };
      this.#channelPsks.value = channels.map((c) => c.psk);
      this.#contactKeys.value = contacts.map((c) => c.pubKey);
      this.#selfKey.value = parseKey(self);
    });
    this.#summaries.clear();
  }

  // ---- filtering ----

  #packetQuery(f: PacketFilter): PacketQuery {
    const q: PacketQuery = {};
    if (f.src !== undefined) q.src = f.src;
    if (f.direction) q.direction = f.direction;
    if (f.from !== undefined) q.from = f.from;
    if (f.to !== undefined) q.to = f.to;
    if (nonEmpty(f.payloadTypes) && f.payloadTypes.length === 1) q.payloadType = f.payloadTypes[0]!;
    if (nonEmpty(f.routeTypes) && f.routeTypes.length === 1) q.routeType = f.routeTypes[0]!;
    if ((nonEmpty(f.payloadTypes) && f.payloadTypes.length > 1) || (nonEmpty(f.routeTypes) && f.routeTypes.length > 1) || f.text || f.node || hasDrill(f)) {
      q.match = (r) => this.packetMatches(r, f);
    }
    return q;
  }

  #frameQuery(f: FrameFilter): FrameQuery {
    const q: FrameQuery = {};
    if (f.direction) q.direction = f.direction;
    if (f.from !== undefined) q.from = f.from;
    if (f.to !== undefined) q.to = f.to;
    if (nonEmpty(f.codes) && f.codes.length === 1) q.code = f.codes[0]!;
    if ((nonEmpty(f.codes) && f.codes.length > 1) || f.text) q.match = (r) => this.frameMatches(r, f);
    return q;
  }

  /** Full filter predicate for one packet record (also used for live-tail events). */
  packetMatches(r: PacketRecord, f: PacketFilter): boolean {
    if (f.direction && r.direction !== f.direction) return false;
    if (f.from !== undefined && r.ts < f.from) return false;
    if (f.to !== undefined && r.ts > f.to) return false;
    if (nonEmpty(f.payloadTypes) && !f.payloadTypes.includes(r.payloadType)) return false;
    if (nonEmpty(f.routeTypes) && !f.routeTypes.includes(r.routeType)) return false;
    if (f.src !== undefined && !sourceMatches(r, PacketLog.srcQuery(f.src) ?? '')) return false;
    if (f.drill && f.drill.length) {
      const p = this.#stats?.point(r.id);
      if (!p || !f.drill.every((d) => filterKey(p, d.field) === d.value)) return false;
    }
    if (!f.text && !f.node) return true;
    const view = viewPacket(r, this.#ctx.peek());
    if (f.node && !packetMentionsNode(view, hexNorm(f.node))) return false;
    if (f.text) {
      const t = f.text.trim().toLowerCase();
      const hay = `${view.typeName} ${view.routeName} ${view.summary} ${this.#summaries.get(r.id) ?? ''} ${r.decodedSummary ?? ''}`.toLowerCase();
      if (!hay.includes(t)) {
        const h = hexNorm(t);
        if (!h || h.length !== t.replace(/\s/g, '').length || !toHex(r.bytes).includes(h)) return false;
      }
    }
    return true;
  }

  frameMatches(r: FrameRecord, f: FrameFilter): boolean {
    if (f.direction && r.direction !== f.direction) return false;
    if (f.from !== undefined && r.ts < f.from) return false;
    if (f.to !== undefined && r.ts > f.to) return false;
    if (nonEmpty(f.codes) && !f.codes.includes(r.code)) return false;
    if (f.text) {
      const t = f.text.trim().toLowerCase();
      const row = frameRow(r);
      const hay = `${row.name} ${r.kind} ${row.summary}`.toLowerCase();
      if (!hay.includes(t)) {
        const h = hexNorm(t);
        if (!h || h.length !== t.replace(/\s/g, '').length || !toHex(r.bytes).includes(h)) return false;
      }
    }
    return true;
  }

  async #packetRow(r: PacketRecord): Promise<PacketRow> {
    const ctx = this.#ctx.peek();
    const view = viewPacket(r, ctx);
    let summary = this.#summaries.get(r.id);
    if (summary === undefined) {
      summary = await summarizePacket(r, ctx, view, this.#dmKeys());
      if (this.#summaries.size > 20_000) this.#summaries.clear();
      this.#summaries.set(r.id, summary);
    }
    return { id: r.id, record: r, typeName: view.typeName, routeName: view.routeName, hops: view.hops, path: view.path, endpoints: view.endpoints, summary };
  }

  /** DM decryption keys for summaries, when the radio's private key is stored (opt-in). */
  #dmKeys(): DmKeys | undefined {
    return this.dmKeys.peek() ?? undefined;
  }

  /**
   * Nodes heard advertising whose public key starts with `ref` (key or key prefix hex, at least
   * one byte): the newest logged ADVERT of each, newest first. Unparsable adverts are skipped.
   */
  async heardNodes(ref: string): Promise<HeardNode[]> {
    const store = this.store;
    return store ? heardNodesIn(store, ref) : [];
  }

  // ---- inspection ----

  /** The keys the inspector decrypts with. */
  annotateKeys(): AnnotateKeys {
    const keys: AnnotateKeys = { channelPsks: this.#channelPsks.peek(), contacts: this.#contactKeys.peek() };
    const priv = this.#selfKey.peek();
    const pub = this.store?.pubKey;
    if (priv && pub) keys.self = { publicKey: fromHex(pub), privateKey: priv };
    return keys;
  }

  /** Loads a packet with its byte annotation (decrypted where keys allow). Null if not found. */
  async inspect(id: number): Promise<PacketInspection | null> {
    const store = this.store;
    if (!store) return null;
    const record = await store.packets.get(id);
    if (!record) return null;
    const keys = this.annotateKeys();
    const annotation: Annotation =
      record.format === 'packet'
        ? await annotatePacket(record.bytes, { keys })
        : record.format === 'payload'
          ? await annotatePayload(record.payloadType, record.bytes, { keys })
          : { offset: 0, length: 0, name: 'requested transmission', value: record.decodedSummary ?? '', meaning: NO_BYTES_MEANING, errors: [] };
    const ctx = this.#ctx.peek();
    const view = viewPacket(record, ctx);
    const summary = await summarizePacket(record, ctx, view, this.#dmKeys());
    const [sourceFrame, copies] = await Promise.all([
      record.sourceFrameId !== undefined ? store.frames.get(record.sourceFrameId) : Promise.resolve(undefined),
      record.hash ? store.packets.count({ hash: record.hash }) : Promise.resolve(1),
    ]);
    const out: PacketInspection = { record, annotation, view, summary, copies };
    if (sourceFrame) out.sourceFrame = sourceFrame;
    return out;
  }

  /** Loads a frame with its decoded fields and byte annotation. Null if not found. */
  async inspectFrame(id: number): Promise<FrameInspection | null> {
    const store = this.store;
    if (!store) return null;
    const record = await store.frames.get(id);
    if (!record) return null;
    const out: FrameInspection = {
      record,
      name: frameCodeName(record.direction, record.code),
      annotation: annotateFrame(record.direction, record.bytes),
      decoded: null,
    };
    try {
      if (record.direction === 'in') out.decoded = decodeFrame(record.bytes);
      else {
        const r = tryDecodeCommand(record.bytes);
        if (r.ok) out.decoded = r.command;
        else out.decodeError = r.error.message;
      }
    } catch (e) {
      out.decodeError = e instanceof Error ? e.message : String(e);
    }
    // the packet an 'in' push carried, or the tx packet an 'out' command asked the radio to send
    const page = await store.packets.query({ from: record.ts, to: record.ts, limit: 1, match: (p) => p.sourceFrameId === record.id });
    const p = page.items[0];
    if (p) out.packetId = p.id;
    return out;
  }

  // ---- self key (opt-in DM decryption) ----

  /** Stores (or with null, forgets) the radio's 64-byte expanded private key for DM decryption. */
  async setSelfPrivateKey(key: Uint8Array | null): Promise<void> {
    const store = this.store;
    if (!store) throw new Error('not connected');
    if (key === null) {
      await store.settings.delete(SELF_PRIVATE_KEY_SETTING);
      return;
    }
    if (key.length !== PRIVATE_KEY_SIZE) throw new Error(`private key must be ${PRIVATE_KEY_SIZE} bytes`);
    await store.settings.set(SELF_PRIVATE_KEY_SETTING, toHex(key));
  }

  /** Asks the radio for its private key (EXPORT_PRIVATE_KEY) and stores it for DM decryption. */
  async storeSelfKeyFromDevice(): Promise<void> {
    const client = this.connection.client.peek();
    if (!client) throw new Error('not connected');
    await this.setSelfPrivateKey(await client.exportPrivateKey());
  }

  // ---- export / import / maintenance ----

  /** Packets as a `meshcore-web/packets` export; `filtered` applies the current filter. */
  async exportPackets(opts: { filtered?: boolean } = {}): Promise<LogExport<PacketRecord>> {
    const store = this.#requireStore();
    return store.packets.export(opts.filtered ? this.#packetQuery(this.packets.filter.peek()) : {});
  }

  async exportFrames(opts: { filtered?: boolean } = {}): Promise<LogExport<FrameRecord>> {
    const store = this.#requireStore();
    return store.frames.export(opts.filtered ? this.#frameQuery(this.frames.filter.peek()) : {});
  }

  /** Both logs in one JSON-safe object. */
  async exportAll(): Promise<{ format: typeof BUNDLE_FORMAT; version: 1; radio: string; packets: LogExport<PacketRecord>; frames: LogExport<FrameRecord> }> {
    const store = this.#requireStore();
    const [packets, frames] = await Promise.all([store.packets.export(), store.frames.export()]);
    return { format: BUNDLE_FORMAT, version: 1, radio: store.pubKey, packets, frames };
  }

  /**
   * Imports a packets export, a frames export or a bundle (object or JSON text). Records get new
   * ids. Throws ImportError for anything else.
   */
  async importJson(data: unknown): Promise<ImportResult> {
    const store = this.#requireStore();
    const parsed: unknown = typeof data === 'string' ? safeParse(data) : data;
    if (!isObject(parsed)) throw new ImportError('not a meshcore-web log export');
    const fmt = parsed['format'];
    if (fmt === BUNDLE_FORMAT) {
      const packets = parsed['packets'] !== undefined ? await store.packets.import(parsed['packets']) : 0;
      const frames = parsed['frames'] !== undefined ? await store.frames.import(parsed['frames']) : 0;
      return { packets, frames };
    }
    if (fmt === 'meshcore-web/packets') return { packets: await store.packets.import(parsed), frames: 0 };
    if (fmt === 'meshcore-web/frames') return { packets: 0, frames: await store.frames.import(parsed) };
    throw new ImportError(`unknown export format ${JSON.stringify(fmt)}`);
  }

  clearPackets(): Promise<number> {
    this.#summaries.clear();
    return this.#requireStore().packets.clear();
  }

  clearFrames(): Promise<number> {
    return this.#requireStore().frames.clear();
  }

  /** Applies the retention policies of both logs. */
  prune(): Promise<{ frames: number; packets: number }> {
    return this.#requireStore().prune();
  }

  #requireStore(): RadioStore {
    const s = this.store;
    if (!s) throw new Error('not connected');
    return s;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new ImportError(`invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function parseKey(v: unknown): Uint8Array | null {
  if (typeof v !== 'string') return null;
  try {
    const b = fromHex(v);
    return b.length === PRIVATE_KEY_SIZE ? b : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Filter chips
// ---------------------------------------------------------------------------

/** One active criterion of a {@link PacketFilter}, for a removable chip. */
export interface PacketFilterChip {
  /**
   * 'direction', 'types', 'routes', 'src', 'node', 'text', or `drill-<field>` (one per
   * {@link PacketFilter.drill} entry); pass to {@link withoutChip}.
   */
  key: string;
  /** What is filtered, e.g. 'Direction', 'Types', 'Source'. */
  name: string;
  /** The criterion, e.g. 'Received', 'ADVERT, TXT_MSG', the drill entry's label. */
  value: string;
  /** `${name}: ${value}`. */
  label: string;
}

export interface PacketFilterChipContext {
  /** Display name of the `src` key (e.g. the contact's name); default: the first 8 hex digits + '…'. */
  srcLabel?: (key: string) => string;
}

const DIRECTION_LABEL: Readonly<Record<PacketDirection, string>> = { rx: 'Received', tx: 'Sent' };

/**
 * The chips of a filter's active criteria, in a fixed order: direction, types, routes, src, node,
 * text, then each drill entry. The date range (`from` / `to`) is not a chip.
 */
export function packetFilterChips(f: PacketFilter, ctx: PacketFilterChipContext = {}): PacketFilterChip[] {
  const out: PacketFilterChip[] = [];
  const add = (key: string, name: string, value: string): void => {
    out.push({ key, name, value, label: `${name}: ${value}` });
  };
  if (f.direction) add('direction', 'Direction', DIRECTION_LABEL[f.direction]);
  if (nonEmpty(f.payloadTypes)) add('types', f.payloadTypes.length > 1 ? 'Types' : 'Type', f.payloadTypes.map((t) => payloadTypeName(t)).join(', '));
  if (nonEmpty(f.routeTypes)) add('routes', f.routeTypes.length > 1 ? 'Routes' : 'Route', f.routeTypes.map((t) => routeTypeName(t)).join(', '));
  if (f.src !== undefined) add('src', 'From', ctx.srcLabel?.(f.src) ?? `${f.src.slice(0, 8)}…`);
  if (f.node) add('node', 'Node', f.node);
  if (f.text) add('text', 'Text', f.text);
  for (const d of f.drill ?? []) add(`drill-${d.field}`, STATS_FIELD_LABEL[d.field], d.label);
  return out;
}

/** `f` without the criterion of chip `key` (an unknown key: `f` unchanged). */
export function withoutChip(f: PacketFilter, key: string): PacketFilter {
  const out: PacketFilter = { ...f };
  switch (key) {
    case 'direction':
      delete out.direction;
      break;
    case 'types':
      delete out.payloadTypes;
      break;
    case 'routes':
      delete out.routeTypes;
      break;
    case 'src':
      delete out.src;
      break;
    case 'node':
      delete out.node;
      break;
    case 'text':
      delete out.text;
      break;
    default: {
      if (!key.startsWith('drill-') || !f.drill) return f;
      const drill = f.drill.filter((d) => `drill-${d.field}` !== key);
      if (drill.length) out.drill = drill;
      else delete out.drill;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Frame rows
// ---------------------------------------------------------------------------

/** One-line description of a frame's decoded content. Never throws. */
export function summarizeFrame(r: FrameRecord): string {
  try {
    if (r.direction === 'out') {
      const res = tryDecodeCommand(r.bytes);
      if (!res.ok) return `rejected by firmware: ${res.error.message}`;
      return commandSummary(res.command);
    }
    return deviceFrameSummary(decodeFrame(r.bytes));
  } catch (e) {
    return `undecodable: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function frameRow(r: FrameRecord): FrameRow {
  return { id: r.id, record: r, name: frameCodeName(r.direction, r.code), summary: summarizeFrame(r) };
}

const short = (b: Uint8Array, n = 6): string => toHex(b.subarray(0, n));
const q = (s: string): string => JSON.stringify(s.length > 60 ? `${s.slice(0, 59)}…` : s);

function commandSummary(c: Command): string {
  switch (c.kind) {
    case 'appStart':
      return `app ${q(c.appName ?? '')} v${c.appVersion ?? 0}`;
    case 'deviceQuery':
      return `app target ver ${c.appTargetVer ?? '?'}`;
    case 'sendTxtMsg':
      return `to ${short(c.recipient)}: ${q(c.text)}`;
    case 'sendChannelTxtMsg':
      return `channel ${c.channelIdx}: ${q(c.text)}`;
    case 'getContacts':
      return c.since !== undefined ? `since ${c.since}` : 'all';
    case 'setDeviceTime':
      return new Date(c.epochSecs * 1000).toISOString();
    case 'sendSelfAdvert':
      return c.flood ? 'flood' : 'zero-hop';
    case 'setAdvertName':
      return q(c.name);
    case 'getChannel':
      return `slot ${c.index}`;
    case 'setChannel':
      return `slot ${c.index} ${q(c.name)}`;
    case 'getStats':
      return `type ${c.statsType}`;
    case 'runCliCommand':
      return q(c.command);
    case 'resetPath':
    case 'removeContact':
    case 'shareContact':
    case 'sendStatusReq':
    case 'hasConnection':
    case 'logout':
    case 'getContactByKey':
    case 'getAdvertPath':
    case 'sendPathDiscoveryReq':
      return short(c.pubKey);
    case 'sendLogin':
      return `to ${short(c.pubKey)}`;
    case 'sendBinaryReq':
    case 'sendAnonReq':
      return `to ${short(c.pubKey)}, ${c.data.length} B`;
    case 'sendTracePath':
      return `tag ${c.tag}, ${c.path.length} B path`;
    case 'sendRawPacket':
      return `${c.packet.length} B packet`;
    default:
      return '';
  }
}

function deviceFrameSummary(f: DeviceFrame): string {
  switch (f.kind) {
    case 'err':
      return f.errName;
    case 'selfInfo':
      return `${q(f.info.name)} ${short(f.info.pubKey, 4)}`;
    case 'deviceInfo':
      return `fw ${f.info.firmwareVersion ?? `v${f.info.firmwareVerCode}`}${f.info.manufacturer ? ` · ${f.info.manufacturer}` : ''}`;
    case 'contactsStart':
      return `${f.total} contacts`;
    case 'contact':
    case 'newAdvert':
      return `${q(f.contact.name)} ${short(f.contact.pubKey, 4)}`;
    case 'sent':
      return `${f.flood ? 'flood' : 'direct'}, tag ${toHex(f.tagBytes)}, timeout ${f.estTimeoutMs} ms`;
    case 'contactMsg':
      return `from ${short(f.senderPrefix)}: ${q(f.text)}`;
    case 'channelMsg':
      return `channel ${f.channelIdx}: ${q(f.text)}`;
    case 'currTime':
      return new Date(f.epochSecs * 1000).toISOString();
    case 'battAndStorage':
      return `${f.batt.batteryMv} mV`;
    case 'channelInfo':
      return `slot ${f.channel.index} ${q(f.channel.name)}`;
    case 'sendConfirmed':
      return `ack ${toHex(f.ackBytes)}, ${f.roundTripMs} ms`;
    case 'logRxData':
      return `SNR ${f.snr} dB, RSSI ${f.rssi} dBm, ${f.packet.length} B packet`;
    case 'rawData':
    case 'controlData':
      return `SNR ${f.snr} dB, RSSI ${f.rssi} dBm, ${f.payload.length} B`;
    case 'traceData':
      return `tag ${f.tag}, ${f.hops.length} hops, final SNR ${f.finalSnr} dB`;
    case 'advert':
    case 'pathUpdated':
    case 'contactDeleted':
      return short(f.pubKey);
    case 'loginSuccess':
    case 'loginFail':
    case 'statusResponse':
    case 'telemetryResponse':
    case 'pathDiscoveryResponse':
      return short(f.pubKeyPrefix);
    case 'binaryResponse':
      return `tag ${f.tag}, ${f.data.length} B`;
    case 'cliReply':
      return q(f.text);
    case 'stats':
      return f.stats.type;
    default:
      return '';
  }
}
