/**
 * The chart palette (docs/packet-stats.md §2): eight categorical slots plus a neutral "Other",
 * exposed as `--viz-1` … `--viz-8` / `--viz-other` with `light-dark()` so they follow the same
 * `color-scheme` as the `--mc-*` tokens in styles.ts (and the `data-theme` override, theme.ts).
 *
 * Rules: hues go to entities in fixed slot order and are never cycled past 8 (the rest fold into
 * "Other"); colour follows the entity, not its rank; text is never coloured by series.
 */
import { css, unsafeCSS } from 'lit';

export interface PaletteSlot {
  name: string;
  light: string;
  dark: string;
}

/** Slot table, slot 1 first. */
export const PALETTE: readonly PaletteSlot[] = [
  { name: 'blue', light: '#2a78d6', dark: '#3987e5' },
  { name: 'orange', light: '#eb6834', dark: '#d95926' },
  { name: 'aqua', light: '#1baf7a', dark: '#199e70' },
  { name: 'yellow', light: '#eda100', dark: '#c98500' },
  { name: 'magenta', light: '#e87ba4', dark: '#d55181' },
  { name: 'green', light: '#008300', dark: '#008300' },
  { name: 'violet', light: '#6250d6', dark: '#9085e9' },
  { name: 'red', light: '#e34948', dark: '#e66767' },
];

/** Number of categorical slots; further series fold into "Other". */
export const MAX_SERIES = PALETTE.length;

/** Series key / legend label of the folded remainder. */
export const OTHER_KEY = 'Other';

/** Colour of "Other" (and of keys a palette does not know). */
export const OTHER_COLOR = 'var(--viz-other)';

/** `--viz-*` custom properties; included in every chart's `static styles`. */
export const vizTokens = css`
  :host {
    ${unsafeCSS(PALETTE.map((s, i) => `--viz-${i + 1}: light-dark(${s.light}, ${s.dark});`).join('\n    '))}
    --viz-other: var(--mc-text-muted, light-dark(#59626e, #a0a9b4));
  }
`;

/** CSS colour of slot `index` (0-based: 0 → `--viz-1`); out of range → "Other". */
export function seriesColor(index: number): string {
  return Number.isInteger(index) && index >= 0 && index < MAX_SERIES ? `var(--viz-${index + 1})` : OTHER_COLOR;
}

export interface LegendEntry {
  key: string;
  /** Every series key the entry stands for (several when keys share a slot, or for "Other"). */
  keys: readonly string[];
  label: string;
  color: string;
}

/** Series key → colour, plus the legend in slot order ("Other" last when anything folds). */
export interface SeriesPalette {
  colors: ReadonlyMap<string, string>;
  /** Slot entries (≤ 8) in slot order, then one "Other" entry when any key folds. */
  legend: readonly LegendEntry[];
}

/** Colour for `key` in `palette` (unknown keys are "Other"). */
export function colorOf(palette: SeriesPalette, key: string): string {
  return palette.colors.get(key) ?? OTHER_COLOR;
}

/**
 * Gives the first 8 keys (in the given order — e.g. count desc) slots 1…8 and folds the rest
 * into "Other". A key equal to {@link OTHER_KEY} never takes a slot. `labels` maps key → legend
 * label (default: the key).
 */
export function assignSlots(orderedKeys: Iterable<string>, labels?: ReadonlyMap<string, string>): SeriesPalette {
  const colors = new Map<string, string>();
  const legend: LegendEntry[] = [];
  let slot = 0;
  let folded = false;
  for (const key of orderedKeys) {
    if (colors.has(key)) continue;
    if (key !== OTHER_KEY && slot < MAX_SERIES) {
      const color = seriesColor(slot++);
      colors.set(key, color);
      legend.push({ key, keys: [key], label: labels?.get(key) ?? key, color });
    } else {
      colors.set(key, OTHER_COLOR);
      folded = true;
    }
  }
  if (folded) legend.push(otherEntry());
  return { colors, legend };
}

function otherEntry(): LegendEntry {
  return { key: OTHER_KEY, keys: [OTHER_KEY], label: OTHER_KEY, color: OTHER_COLOR };
}

/**
 * A fixed key → slot map (slots 1-based, 1…8; anything else is "Other"), e.g. payload types.
 * Keys not in the map are "Other" via {@link colorOf}. Keys sharing a slot share one legend entry
 * (label: `labels.get(firstKey)`, else the keys joined with " / "). The legend lists slots in
 * order, then "Other".
 */
export function fixedSlots(slots: Readonly<Record<string, number>>, labels?: ReadonlyMap<string, string>): SeriesPalette {
  const colors = new Map<string, string>();
  const bySlot = new Map<number, string[]>();
  for (const [key, slot] of Object.entries(slots)) {
    const color = seriesColor(slot - 1);
    colors.set(key, color);
    if (color === OTHER_COLOR) continue;
    const keys = bySlot.get(slot) ?? [];
    keys.push(key);
    bySlot.set(slot, keys);
  }
  const legend: LegendEntry[] = [...bySlot.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slot, keys]) => {
      const key = keys[0] ?? '';
      return { key, keys, label: labels?.get(key) ?? keys.join(' / '), color: seriesColor(slot - 1) };
    });
  legend.push(otherEntry());
  return { colors, legend };
}

/** Distinct keys ordered by occurrence count, descending (ties: first seen first). */
export function keysByCount(keys: Iterable<string>): string[] {
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

/**
 * The legend for the keys actually present: palette entries whose key is present (slot order),
 * then "Other" when any present key maps to the "Other" colour.
 */
export function legendFor(palette: SeriesPalette, present: ReadonlySet<string>): LegendEntry[] {
  const out = palette.legend.filter((e) => e.color !== OTHER_COLOR && e.keys.some((k) => present.has(k)));
  for (const k of present) {
    if (colorOf(palette, k) === OTHER_COLOR) {
      out.push(otherEntry());
      break;
    }
  }
  return out;
}
