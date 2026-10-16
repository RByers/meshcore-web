/** Log of every host↔device companion frame (roadmap goal 3). */

import { decodeFrame } from '../protocol/decode.js';
import { tryDecodeCommand } from '../protocol/decode-command.js';
import { INDEX, STORE, type FrameDirection, type FrameRecord } from './schema.js';
import { safeEmit } from './events.js';
import { TimeLog, reqNumber, reqOneOf, reqString, type LogQueryBase, type QueryPlan } from './time-log.js';

export interface FrameInput {
  direction: FrameDirection;
  bytes: Uint8Array;
  /** Default `Date.now()`. */
  ts?: number;
  /** Decoded frame / command kind; derived from the bytes when omitted. */
  kind?: string;
}

export interface FrameQuery extends LogQueryBase {
  direction?: FrameDirection;
  code?: number;
  kind?: string;
}

/** Best-effort frame kind: `DeviceFrame['kind']` for 'in', `Command['kind']` for 'out'. */
export function frameKind(direction: FrameDirection, bytes: Uint8Array): string {
  if (bytes.length === 0) return 'unknown';
  try {
    if (direction === 'in') return decodeFrame(bytes).kind;
    const r = tryDecodeCommand(bytes);
    return r.ok ? r.command.kind : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function frameRecordFromInput(input: FrameInput, now = Date.now()): Omit<FrameRecord, 'id'> {
  return {
    ts: input.ts ?? now,
    direction: input.direction,
    bytes: input.bytes,
    code: input.bytes.length > 0 ? input.bytes[0]! : -1,
    kind: input.kind ?? frameKind(input.direction, input.bytes),
    size: input.bytes.length,
  };
}

export class FrameLog extends TimeLog<FrameRecord, FrameQuery> {
  protected readonly storeName = STORE.frames;
  protected readonly tsIndex = INDEX.frames.ts;
  protected readonly exportFormat = 'meshcore-web/frames';

  protected emitRecord(record: FrameRecord): void {
    safeEmit(this.emitter, 'frame', record);
  }

  async append(input: FrameInput): Promise<FrameRecord> {
    const [rec] = await this.insert([frameRecordFromInput(input)]);
    return rec!;
  }

  /** Appends several frames in one transaction. */
  appendMany(inputs: readonly FrameInput[]): Promise<FrameRecord[]> {
    const now = Date.now();
    return this.insert(inputs.map((i) => frameRecordFromInput(i, now)));
  }

  protected plan(q: FrameQuery): QueryPlan<FrameRecord> {
    const kind = q.kind;
    const kindFilter = kind === undefined ? undefined : (r: FrameRecord) => r.kind === kind;
    if (q.code !== undefined) {
      const direction = q.direction;
      const filters = [kindFilter, direction === undefined ? undefined : (r: FrameRecord) => r.direction === direction];
      return { index: INDEX.frames.codeTs, query: this.tsRange([q.code], q), ...combine(filters) };
    }
    if (q.direction !== undefined) {
      return { index: INDEX.frames.directionTs, query: this.tsRange([q.direction], q), ...combine([kindFilter]) };
    }
    return { index: INDEX.frames.ts, query: this.tsRange([], q), ...combine([kindFilter]) };
  }

  protected validateImported(o: Record<string, unknown>, bytes: Uint8Array): Omit<FrameRecord, 'id'> {
    return {
      ts: reqNumber(o, 'ts'),
      direction: reqOneOf(o, 'direction', ['in', 'out'] as const),
      bytes,
      code: bytes.length > 0 ? bytes[0]! : -1,
      kind: typeof o['kind'] === 'string' ? reqString(o, 'kind') : frameKind(o['direction'] as FrameDirection, bytes),
      size: bytes.length,
    };
  }
}

/** Combines optional predicates into a `{ filter }` fragment (or `{}` when none). */
export function combine<R>(filters: readonly (((r: R) => boolean) | undefined)[]): { filter?: (r: R) => boolean } {
  const fs = filters.filter((f): f is (r: R) => boolean => f !== undefined);
  if (fs.length === 0) return {};
  if (fs.length === 1) return { filter: fs[0]! };
  return { filter: (r) => fs.every((f) => f(r)) };
}
