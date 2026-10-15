/**
 * Serial / TCP companion framing (docs/companion-protocol.md §1.1, firmware `ArduinoSerialInterface`):
 *
 *   offset 0  u8      marker: 0x3C '<' = host→device, 0x3E '>' = device→host
 *   offset 1  u16 LE  payload length N (max 176 = MAX_FRAME_SIZE)
 *   offset 3  N bytes one companion frame (code byte + body)
 */

import { writeU16LE } from '../util/bytes.js';

/** `'<'` — marker on frames written by the host (app) to the device. */
export const SERIAL_MARKER_HOST_TO_DEVICE = 0x3c;
/** `'>'` — marker on frames written by the device to the host (app). */
export const SERIAL_MARKER_DEVICE_TO_HOST = 0x3e;
/** Firmware `MAX_FRAME_SIZE` (`src/helpers/BaseSerialInterface.h`). */
export { MAX_FRAME_SIZE } from "../protocol/constants.js";
import { MAX_FRAME_SIZE } from "../protocol/constants.js";
export const SERIAL_HEADER_SIZE = 3;

export interface EncodeSerialFrameOptions {
  /** Marker byte; defaults to host→device `'<'`. The emulator uses `'>'`. */
  marker?: number;
  /** Maximum payload length; defaults to 176. */
  maxFrameLength?: number;
}

/**
 * Wraps one companion frame in the serial header.
 *
 * Throws `RangeError` for an empty payload or one longer than `maxFrameLength`: the firmware
 * would treat N = 0 as "reset" and silently truncate N > 176, so neither is ever useful to send.
 */
export function encodeSerialFrame(payload: Uint8Array, options: EncodeSerialFrameOptions = {}): Uint8Array {
  const marker = options.marker ?? SERIAL_MARKER_HOST_TO_DEVICE;
  const max = options.maxFrameLength ?? MAX_FRAME_SIZE;
  if (payload.length === 0) throw new RangeError('encodeSerialFrame: empty frame');
  if (payload.length > max) {
    throw new RangeError(`encodeSerialFrame: frame of ${payload.length} bytes exceeds max ${max}`);
  }
  const out = new Uint8Array(SERIAL_HEADER_SIZE + payload.length);
  out[0] = marker;
  writeU16LE(out, 1, payload.length);
  out.set(payload, SERIAL_HEADER_SIZE);
  return out;
}

export interface SerialDeframerOptions {
  /**
   * Marker bytes accepted as frame starts. Default: device→host `'>'` only. The emulator's
   * device side uses `['<']`. (meshcore.js accepts both; we stay strict by default so an echoed
   * host frame is never mistaken for a device frame.)
   */
  markers?: readonly number[];
  /** Maximum accepted payload length; defaults to 176. */
  maxFrameLength?: number;
}

export interface SerialDeframerStats {
  /** Bytes discarded while searching for a marker or after a bad header. */
  skippedBytes: number;
  /** Headers rejected because N was 0 or above `maxFrameLength`. */
  badHeaders: number;
  frames: number;
}

/**
 * Streaming decoder for serial frames. Feed arbitrary chunks with `push`; complete frames are
 * returned in order. Tolerates any chunk boundary (including mid-header).
 *
 * Resync rules (mirrors meshcore.js `onDataReceived`, compatible with the firmware): bytes
 * before a marker are skipped; a header with N = 0 or N > `maxFrameLength` is treated as noise:
 * only its marker byte is dropped and scanning restarts at the next byte, so a real frame that
 * follows a stray marker is still found. There is no inter-byte timeout: a partial frame stays
 * buffered until more data arrives or `reset()` is called (e.g. on reconnect).
 */
export class SerialDeframer {
  readonly #markers: ReadonlySet<number>;
  readonly #max: number;
  #buf: Uint8Array;
  #len = 0;
  readonly stats: SerialDeframerStats = { skippedBytes: 0, badHeaders: 0, frames: 0 };

  constructor(options: SerialDeframerOptions = {}) {
    this.#markers = new Set(options.markers ?? [SERIAL_MARKER_DEVICE_TO_HOST]);
    this.#max = options.maxFrameLength ?? MAX_FRAME_SIZE;
    this.#buf = new Uint8Array(SERIAL_HEADER_SIZE + this.#max);
  }

  /** Number of bytes currently buffered (partial frame / unscanned data). */
  get bufferedBytes(): number {
    return this.#len;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    let i = 0;
    while (i < chunk.length) {
      // Copy as much as fits into the working buffer (never more than one max frame + header).
      const n = Math.min(chunk.length - i, this.#buf.length - this.#len);
      this.#buf.set(chunk.subarray(i, i + n), this.#len);
      this.#len += n;
      i += n;
      this.#drain(frames);
    }
    return frames;
  }

  reset(): void {
    this.#len = 0;
  }

  #drain(frames: Uint8Array[]): void {
    let pos = 0;
    const buf = this.#buf;
    for (;;) {
      // Find a marker.
      while (pos < this.#len && !this.#markers.has(buf[pos]!)) {
        pos++;
        this.stats.skippedBytes++;
      }
      if (this.#len - pos < SERIAL_HEADER_SIZE) break;
      const n = buf[pos + 1]! | (buf[pos + 2]! << 8);
      if (n === 0 || n > this.#max) {
        this.stats.badHeaders++;
        this.stats.skippedBytes++;
        pos++;
        continue;
      }
      if (this.#len - pos < SERIAL_HEADER_SIZE + n) break;
      frames.push(buf.slice(pos + SERIAL_HEADER_SIZE, pos + SERIAL_HEADER_SIZE + n));
      this.stats.frames++;
      pos += SERIAL_HEADER_SIZE + n;
    }
    if (pos > 0) {
      buf.copyWithin(0, pos, this.#len);
      this.#len -= pos;
    }
  }
}
