/**
 * Identifying the region (flood scope) of a TRANSPORT_FLOOD packet. docs/mesh-packet-format.md §1.2
 *
 * `transport_code[0]` = HMAC-SHA256(region key, payload_type ‖ payload)[0..2] cannot be inverted,
 * so a decoder can only test the region keys it knows: the region is the one whose key gives the
 * packet's code. 16 bits collide, so a code more than one known key gives is ambiguous.
 */

import { transportCodeSync } from '../emulator/crypto-sync.js';
import { toHex } from '../util/bytes.js';
import { RouteType } from './constants.js';

/** Region name (no '#') → its 16-byte transport key. */
export type RegionKeys = ReadonlyMap<string, Uint8Array>;

/**
 * Display key of a TRANSPORT_FLOOD packet whose code no known region key gives (or more than one
 * does). Region names only use `[a-z0-9-]`, so it cannot collide with a name.
 */
export const UNKNOWN_REGION = '?';

/**
 * The known region whose key gives transport code `code` for this payload, or null when none or
 * more than one (distinct key) does.
 */
export function matchRegionCode(keys: RegionKeys, code: number, payloadType: number, payload: Uint8Array): string | null {
  let hit: string | null = null;
  const seen = new Set<string>();
  for (const [name, key] of keys) {
    const kh = toHex(key);
    if (seen.has(kh)) continue;
    seen.add(kh);
    if (transportCodeSync(key, payloadType, payload) !== code) continue;
    if (hit !== null) return null;
    hit = name;
  }
  return hit;
}

/**
 * The region of a packet: its name, {@link UNKNOWN_REGION} for a TRANSPORT_FLOOD packet no known
 * key matches, undefined for other route types (TRANSPORT_DIRECT codes are not region scopes) or
 * when the codes are not known.
 */
export function packetRegion(
  p: { routeType: number; payloadType: number; payload: Uint8Array; transportCodes?: readonly [number, number] | undefined },
  keys: RegionKeys | undefined,
): string | undefined {
  if (p.routeType !== RouteType.TRANSPORT_FLOOD || !p.transportCodes) return undefined;
  return (keys && matchRegionCode(keys, p.transportCodes[0], p.payloadType, p.payload)) ?? UNKNOWN_REGION;
}

/** '#name', or 'unknown region' for {@link UNKNOWN_REGION}. */
export function regionLabel(region: string): string {
  return region === UNKNOWN_REGION ? 'unknown region' : `#${region}`;
}
