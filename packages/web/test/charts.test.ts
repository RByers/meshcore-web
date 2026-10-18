/** Chart elements (docs/packet-stats.md §2), mounted standalone with plain arrays. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assignSlots,
  fixedSlots,
  legendFor,
  OTHER_COLOR,
  seriesColor,
  type BarSelectDetail,
  type DotPoint,
  type SegmentSelectDetail,
  type DotSelectDetail,
  type McBarChart,
  type McBoxPlot,
  type BoxSummary,
  type McBreakdown,
  type McDotPlot,
  type McLineChart,
  type McStatTile,
} from '../src/charts/index.js';

const mounted: HTMLElement[] = [];

afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

/** Mounts `tag` inside a `width`-px box, applies props, waits until it has measured itself. */
async function mount<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]>,
  width = 600,
): Promise<HTMLElementTagNameMap[K]> {
  const box = document.createElement('div');
  box.style.width = `${width}px`;
  document.body.append(box);
  mounted.push(box);
  const el = document.createElement(tag);
  Object.assign(el, props);
  box.append(el);
  await vi.waitFor(() => {
    const w = (el as unknown as { width?: number }).width;
    if (w !== undefined && w <= 0) throw new Error('not measured');
  });
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el;
}

function q<E extends Element = Element>(el: Element, sel: string): E | null {
  return el.shadowRoot!.querySelector<E>(sel);
}
function qa(el: Element, sel: string): Element[] {
  return [...el.shadowRoot!.querySelectorAll(sel)];
}

describe('palette', () => {
  it('assigns slots in order and folds beyond 8 into Other', () => {
    const keys = Array.from({ length: 11 }, (_, i) => `k${i}`);
    const p = assignSlots(keys);
    expect(p.colors.get('k0')).toBe(seriesColor(0));
    expect(p.colors.get('k7')).toBe('var(--viz-8)');
    expect(p.colors.get('k8')).toBe(OTHER_COLOR);
    expect(p.legend.map((e) => e.key)).toEqual([...keys.slice(0, 8), 'Other']);
    expect(seriesColor(8)).toBe(OTHER_COLOR);
  });

  it('a series named Other never takes a slot; fixed slots share legend entries', () => {
    const p = assignSlots(['Other', 'DMs', 'Adverts']);
    expect(p.colors.get('DMs')).toBe('var(--viz-1)');
    expect(p.colors.get('Other')).toBe(OTHER_COLOR);
    const f = fixedSlots({ TXT_MSG: 1, REQ: 7, RESPONSE: 7 });
    expect(f.legend.map((e) => e.label)).toEqual(['TXT_MSG', 'REQ / RESPONSE', 'Other']);
    expect(legendFor(f, new Set(['RESPONSE', 'PATH'])).map((e) => e.label)).toEqual(['REQ / RESPONSE', 'Other']);
  });
});

describe('mc-bar-chart', () => {
  it('renders one bar per item, links where href is set, and sizes height from the count', async () => {
    const el = await mount('mc-bar-chart', {
      items: [
        { label: 'Alice', value: 12, href: '#/node/aa' },
        { label: 'self', value: 5 },
        { label: 'a3?', value: 1, title: 'ambiguous' },
      ],
    } satisfies Partial<McBarChart>);
    expect(qa(el, '[data-mark="bar"]')).toHaveLength(3);
    const links = qa(el, '[data-label] a') as HTMLAnchorElement[];
    expect(links.map((a) => a.textContent)).toEqual(['Alice']);
    expect(links[0]!.getAttribute('href')).toBe('#/node/aa');
    expect(el.shadowRoot!.textContent).toContain('12');
    const svgH = Number(q(el, 'svg')!.getAttribute('height'));
    el.items = [...el.items, { label: 'Bob', value: 2 }];
    await el.updateComplete;
    expect(Number(q(el, 'svg')!.getAttribute('height'))).toBeGreaterThan(svgH);
    // every row's hit target is ≥ 12 px tall
    for (const r of qa(el, 'rect.hit')) expect(Number(r.getAttribute('height'))).toBeGreaterThanOrEqual(12);
  });

  it('draws negative values left of the zero line and no bar for a null value', async () => {
    const el = await mount('mc-bar-chart', {
      items: [
        { label: 'up', value: 6 },
        { label: 'down', value: -3 },
        { label: 'none', value: null },
      ],
    } satisfies Partial<McBarChart>);
    const marks = qa(el, '[data-mark="bar"]');
    expect(marks).toHaveLength(2);
    expect(marks[0]!.getAttribute('transform')).toBeNull();
    expect(marks[1]!.getAttribute('transform')).toBe('scale(-1,1)');
    // both bars meet at the zero line, which sits inside the plot
    const up = (marks[0] as SVGGraphicsElement).getBBox();
    const down = (marks[1] as SVGGraphicsElement).getBBox();
    expect(down.width).toBeGreaterThan(0);
    expect(Math.abs(-(down.x) - up.x)).toBeLessThan(0.5);
    expect(up.x).toBeGreaterThan(0);
    expect(up.width / down.width).toBeCloseTo(2, 1);
    const values = qa(el, 'text.value').map((v) => v.textContent);
    expect(values).toEqual(['6', '-3']);
    expect(qa(el, '[data-label]')).toHaveLength(3);
  });

  it('re-renders when resized', async () => {
    const el = await mount('mc-bar-chart', { items: [{ label: 'a', value: 1 }] }, 600);
    const before = Number(q(el, 'svg')!.getAttribute('width'));
    el.parentElement!.style.width = '300px';
    await vi.waitFor(() => {
      expect(Number(q(el, 'svg')!.getAttribute('width'))).toBeLessThan(before);
    });
  });

  it('shows an empty state', async () => {
    const box = document.createElement('div');
    document.body.append(box);
    mounted.push(box);
    const el = document.createElement('mc-bar-chart');
    box.append(el);
    await el.updateComplete;
    expect(q(el, '[data-empty]')).not.toBeNull();
  });

  it('keyed rows dispatch bar-select on click and Enter / Space; the label link still navigates', async () => {
    const el = await mount('mc-bar-chart', {
      items: [
        { label: 'Alice', value: 12, href: '#/node/aa', key: 'aa' },
        { label: 'Bob', value: 5, key: 'bb', selected: true },
      ],
    } satisfies Partial<McBarChart>);
    const seen: BarSelectDetail[] = [];
    // listening on the box: the event bubbles out of the shadow root
    el.parentElement!.addEventListener('bar-select', (e) => seen.push((e as CustomEvent<BarSelectDetail>).detail));
    const hits = qa(el, 'rect.hit[role="button"]') as SVGRectElement[];
    expect(hits).toHaveLength(2);
    expect(hits[1]!.getAttribute('aria-pressed')).toBe('true');
    hits[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen).toEqual([{ key: 'aa', index: 0 }]);
    // keyboard: bars are focusable buttons
    hits[1]!.focus();
    expect(el.shadowRoot!.activeElement).toBe(hits[1]);
    hits[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    hits[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    hits[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(seen.map((d) => d.key)).toEqual(['aa', 'bb', 'bb']);
    // the non-link label selects too; the link label is untouched
    (qa(el, '[data-label] span')[0] as HTMLElement).click();
    expect(seen.at(-1)).toEqual({ key: 'bb', index: 1 });
    expect((qa(el, '[data-label] a')[0] as HTMLAnchorElement).getAttribute('href')).toBe('#/node/aa');
  });

  it('rows without keys are not selectable', async () => {
    const el = await mount('mc-bar-chart', { items: [{ label: 'a', value: 1 }] } satisfies Partial<McBarChart>);
    const seen: Event[] = [];
    el.addEventListener('bar-select', (e) => seen.push(e));
    const hit = q<SVGRectElement>(el, 'rect.hit')!;
    expect(hit.getAttribute('role')).toBeNull();
    expect(hit.getAttribute('tabindex')).toBeNull();
    expect(q(el, 'svg')!.getAttribute('role')).toBe('img');
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    (qa(el, '[data-label] span')[0] as HTMLElement).click();
    expect(seen).toHaveLength(0);
  });
});

describe('mc-box-plot', () => {
  const box = (o: Partial<BoxSummary> = {}): BoxSummary => ({
    n: 9, min: -8, q1: -2, median: 1, q3: 4, max: 20, mean: 2, whiskerLow: -8, whiskerHigh: 9, outliers: [15, 20], ...o,
  });
  const fmt = (v: number): string => `${v} dB`;
  const num = (e: Element, a: string): number => Number(e.getAttribute(a));

  it('draws whiskers, box q1–q3, median, mean and outliers on a shared axis with a zero line', async () => {
    const el = await mount('mc-box-plot', {
      rows: [
        { label: 'Hill', box: box(), href: '#/node/aa', title: ['n 9'] },
        { label: 'Quiet', box: null },
        { label: 'Alice', box: box({ min: 3, q1: 5, median: 6, q3: 7, max: 8, mean: 6, whiskerLow: 3, whiskerHigh: 8, outliers: [] }) },
      ],
      format: fmt,
      emptyRowText: 'no SNR',
    } satisfies Partial<McBoxPlot>);
    expect(qa(el, '[data-label]')).toHaveLength(3);
    expect((qa(el, '[data-label] a') as HTMLAnchorElement[]).map((a) => a.getAttribute('href'))).toEqual(['#/node/aa']);
    // the zero line, and one rect width per unit derived from two points on the shared axis
    const zero = q(el, '[data-field="zero"]')!;
    const marks = (row: number, m: string) => qa(el, `g[data-row="${row}"] [data-mark="${m}"]`);
    const rect = marks(0, 'box')[0]!;
    const unit = num(rect, 'width') / 6; // q3 − q1 = 6
    const at = (v: number): number => num(rect, 'x') + (v + 2) * unit;
    // the zero line is pixel-snapped
    expect(Math.abs(num(zero, 'x1') - at(0))).toBeLessThanOrEqual(1);
    expect(num(marks(0, 'median')[0]!, 'x1')).toBeCloseTo(at(1), 0);
    const whisker = marks(0, 'whisker')[0]!;
    expect(num(whisker, 'x1')).toBeCloseTo(at(-8), 0);
    expect(num(whisker, 'x2')).toBeCloseTo(at(9), 0);
    expect(marks(0, 'cap').map((c) => Math.round(num(c, 'x1')))).toEqual([Math.round(at(-8)), Math.round(at(9))]);
    expect(marks(0, 'outlier').map((c) => num(c, 'cx'))).toEqual([expect.closeTo(at(15), 0), expect.closeTo(at(20), 0)]);
    expect(marks(0, 'mean')).toHaveLength(1);
    // the second box sits on the same axis
    expect(num(marks(2, 'box')[0]!, 'x')).toBeCloseTo(at(5), 0);
    expect(marks(2, 'outlier')).toHaveLength(0);
    // no box for the null row, its text instead; medians at the right
    expect(qa(el, 'g[data-row="1"]')).toHaveLength(0);
    expect(qa(el, '[data-field="no-box"]').map((t) => t.textContent)).toEqual(['no SNR']);
    expect(qa(el, '[data-field="median"]').map((t) => t.textContent)).toEqual(['1 dB', '6 dB']);
    expect(qa(el, '.tick').length).toBeGreaterThan(1);
  });

  it('has no zero line when 0 is out of range, and an empty state', async () => {
    const el = await mount('mc-box-plot', { rows: [{ label: 'a', box: box({ min: 3, q1: 4, median: 5, q3: 6, max: 7, whiskerLow: 3, whiskerHigh: 7, outliers: [] }) }] } satisfies Partial<McBoxPlot>);
    expect(q(el, '[data-field="zero"]')).toBeNull();
    el.rows = [];
    await el.updateComplete;
    expect(q(el, '[data-empty]')).not.toBeNull();
  });

  it('keyed rows dispatch bar-select on click and Enter, with a pressed state; unkeyed rows do not', async () => {
    const el = await mount('mc-box-plot', {
      rows: [
        { label: 'Hill', box: box(), key: 'hh', href: '#/node/hh' },
        { label: 'Bob', box: null, key: 'bb', selected: true },
        { label: 'Plain', box: box() },
      ],
      format: fmt,
    } satisfies Partial<McBoxPlot>);
    const seen: BarSelectDetail[] = [];
    el.parentElement!.addEventListener('bar-select', (e) => seen.push((e as CustomEvent<BarSelectDetail>).detail));
    const hits = qa(el, 'rect.hit[role="button"]') as SVGRectElement[];
    expect(hits.map((h) => h.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    expect(hits.map((h) => h.getAttribute('aria-label'))).toEqual(['Hill: median 1 dB', 'Bob: no data']);
    hits[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    hits[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    (qa(el, '[data-label] span')[0] as HTMLElement).click();
    // the unkeyed row: plain hit target, no event
    q<SVGRectElement>(el, 'rect.hit:not([role])')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    (qa(el, '[data-label] span')[1] as HTMLElement).click();
    expect(seen).toEqual([
      { key: 'hh', index: 0 },
      { key: 'bb', index: 1 },
      { key: 'bb', index: 1 },
    ]);
  });

  it('draws a labelled reference line inside the axis, toned boxes, detail lines and value text; none of it by default', async () => {
    const el = await mount('mc-box-plot', {
      rows: [
        { label: 'Hill', detail: '4 pkts', box: box({ min: 3, q1: 4, median: 5, q3: 6, max: 7, whiskerLow: 3, whiskerHigh: 7, outliers: [] }), tone: 'bad', valueText: '+2 dB', valueSub: 'marginal' },
        { label: 'Plain', box: box({ min: 3, q1: 4, median: 5, q3: 6, max: 7, whiskerLow: 3, whiskerHigh: 7, outliers: [] }) },
      ],
      refLine: { value: -10, label: 'SF9 limit −10 dB' },
      label: 'SNR',
      format: fmt,
    } satisfies Partial<McBoxPlot>);
    const ref = q(el, '[data-ref-line]')!;
    expect(ref.querySelector('[data-field="ref-label"]')!.textContent).toBe('SF9 limit −10 dB');
    // the axis reaches the reference value: the line sits left of every box
    const refX = num(ref.querySelector('line')!, 'x1');
    expect(refX).toBeGreaterThanOrEqual(0);
    for (const b of qa(el, '[data-mark="box"]')) expect(refX).toBeLessThan(num(b, 'x'));
    expect(q(el, 'svg')!.getAttribute('aria-label')).toBe('SNR; SF9 limit −10 dB');
    expect(qa(el, '[data-tone]').map((g) => g.getAttribute('data-tone'))).toEqual(['bad']);
    expect(qa(el, '[data-detail]').map((d) => d.textContent)).toEqual(['4 pkts']);
    expect(qa(el, '[data-field="value"]').map((v) => v.textContent)).toEqual(['+2 dB']);
    expect(qa(el, '[data-field="value-sub"]').map((v) => v.textContent)).toEqual(['marginal']);
    expect(qa(el, '[data-field="median"]').map((v) => v.textContent)).toEqual(['5 dB']);

    el.refLine = null;
    el.rows = [el.rows[1]!];
    await el.updateComplete;
    expect(q(el, '[data-ref-line]')).toBeNull();
    expect(qa(el, '[data-tone], [data-detail], [data-field="value"]')).toHaveLength(0);
    expect(q(el, 'svg')!.getAttribute('aria-label')).toBe('SNR');
  });
});

function dots(n: number, keys: string[], nullEvery = 0): DotPoint[] {
  const t0 = Date.UTC(2026, 9, 1, 12);
  return Array.from({ length: n }, (_, i) => ({
    x: t0 + i * 60_000,
    y: nullEvery && i % nullEvery === 0 ? null : -10 + (i % 20),
    size: 10 + (i % 5) * 20,
    color: keys[i % keys.length]!,
    id: i + 1,
  }));
}

describe('mc-dot-plot', () => {
  it('draws a dot per non-null point and counts the nulls', async () => {
    const el = await mount('mc-dot-plot', {
      points: dots(10, ['TXT_MSG', 'ADVERT'], 5),
      yLabel: 'SNR',
    } satisfies Partial<McDotPlot>);
    expect(qa(el, '[data-mark="dot"]')).toHaveLength(8);
    expect(q(el, '[data-field="nulls"]')!.textContent).toContain('2 packets without SNR');
    expect(q(el, '[data-field="y-label"]')!.textContent).toBe('SNR');
    expect(qa(el, '[data-legend-key]').map((e) => e.getAttribute('data-legend-key')).sort()).toEqual(['ADVERT', 'TXT_MSG']);
    for (const c of qa(el, '[data-mark="dot"]')) {
      const r = Number(c.getAttribute('r'));
      expect(r).toBeGreaterThanOrEqual(2);
      expect(r).toBeLessThanOrEqual(9);
    }
  });

  it('dispatches dot-select with the id of the clicked dot (also when clicking next to a small dot)', async () => {
    const el = await mount('mc-dot-plot', { points: dots(3, ['a']), yLabel: 'SNR' } satisfies Partial<McDotPlot>);
    const got: (number | string)[] = [];
    el.addEventListener('dot-select', (e: CustomEvent<DotSelectDetail>) => got.push(e.detail.id));
    const circle = qa(el, '[data-mark="dot"]')[1]!;
    const svgEl = q(el, 'svg')!;
    const r = circle.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    svgEl.dispatchEvent(new MouseEvent('click', { clientX: cx + 5, clientY: cy, bubbles: true }));
    expect(got).toEqual([2]);
    svgEl.dispatchEvent(new MouseEvent('click', { clientX: cx, clientY: cy + 40, bubbles: true }));
    expect(got).toEqual([2]);
  });

  it('folds series beyond 8 into Other in the legend', async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `n${i}`);
    const el = await mount('mc-dot-plot', { points: dots(40, keys), yLabel: 'Hops' } satisfies Partial<McDotPlot>);
    const legend = qa(el, '[data-legend-key]').map((e) => e.getAttribute('data-legend-key'));
    expect(legend).toHaveLength(9);
    expect(legend.at(-1)).toBe('Other');
  });

  it('handles ~10k points', async () => {
    const el = await mount('mc-dot-plot', { points: dots(10_000, ['a', 'b', 'c']), yLabel: 'SNR' } satisfies Partial<McDotPlot>);
    expect(qa(el, '[data-mark="dot"]')).toHaveLength(10_000);
  });
});

describe('mc-line-chart', () => {
  const t0 = Date.UTC(2026, 9, 1);
  const pts = (k: number) => Array.from({ length: 6 }, (_, i) => ({ t: t0 + i * 3_600_000, v: (i + 1) * k }));

  it('draws a line per series with a legend, and a crosshair tooltip listing every series', async () => {
    const el = await mount('mc-line-chart', {
      series: [
        { key: 'Public', points: pts(1) },
        { key: 'DMs', points: pts(2) },
        { key: 'Adverts', points: pts(3) },
      ],
      stacked: true,
    } satisfies Partial<McLineChart>);
    expect(qa(el, '[data-mark="line"]')).toHaveLength(3);
    expect(qa(el, '[data-legend-key]')).toHaveLength(3);
    const svgEl = q(el, 'svg')!;
    const r = svgEl.getBoundingClientRect();
    svgEl.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width / 2, clientY: r.top + 50, bubbles: true }));
    await el.updateComplete;
    const tip = q(el, '[data-tip]')!;
    expect(tip.textContent).toContain('Public');
    expect(tip.textContent).toContain('DMs');
    expect(tip.textContent).toContain('Adverts');
    expect(tip.textContent).toContain('total');
  });

  it('a single series has no legend', async () => {
    const el = await mount('mc-line-chart', { series: [{ key: 'Airtime', points: pts(1) }] } satisfies Partial<McLineChart>);
    expect(qa(el, '[data-mark="line"]')).toHaveLength(1);
    expect(q(el, '[data-legend]')).toBeNull();
  });
});

describe('mc-breakdown', () => {
  it('renders one segment per non-zero value with 2 px gaps', async () => {
    const el = await mount('mc-breakdown', {
      label: 'Route type',
      segments: [
        { label: 'FLOOD', value: 30 },
        { label: 'DIRECT', value: 10 },
        { label: 'none', value: 0 },
      ],
    } satisfies Partial<McBreakdown>);
    expect(qa(el, '[data-mark="segment"]')).toHaveLength(2);
    expect(getComputedStyle(q(el, '.track')!).columnGap).toBe('2px');
    expect(q(el, '[data-legend]')!.textContent).toContain('75');
  });

  it('folds beyond 8 segments into Other', async () => {
    const el = await mount('mc-breakdown', {
      segments: Array.from({ length: 11 }, (_, i) => ({ label: `t${i}`, value: 11 - i })),
    } satisfies Partial<McBreakdown>);
    expect(qa(el, '[data-mark="segment"]')).toHaveLength(9);
    expect(qa(el, '[data-legend-key]').at(-1)!.getAttribute('data-legend-key')).toBe('Other');
  });

  it('keyed segments and their legend buttons dispatch segment-select; unkeyed ones do not', async () => {
    const el = await mount('mc-breakdown', {
      segments: [
        { label: 'Received', value: 30, key: 'in' },
        { label: 'Sent', value: 10, key: 'out', selected: true },
        { label: 'plain', value: 5 },
      ],
    } satisfies Partial<McBreakdown>);
    const seen: SegmentSelectDetail[] = [];
    el.parentElement!.addEventListener('segment-select', (e) => seen.push((e as CustomEvent<SegmentSelectDetail>).detail));
    const segs = qa(el, '[data-mark="segment"]') as HTMLElement[];
    segs[0]!.click();
    segs[2]!.click();
    expect(seen).toEqual([{ key: 'in', index: 0 }]);
    const buttons = qa(el, '[data-legend] button') as HTMLButtonElement[];
    expect(buttons.map((b) => b.dataset['key'])).toEqual(['in', 'out']);
    expect(buttons[1]!.getAttribute('aria-pressed')).toBe('true');
    buttons[1]!.click();
    expect(seen.at(-1)).toEqual({ key: 'out', index: 1 });
    expect(q(el, '[data-legend-key="plain"] button')).toBeNull();
  });
});

describe('mc-stat-tile', () => {
  it('shows label, compact value and sub-text', async () => {
    const box = document.createElement('div');
    document.body.append(box);
    mounted.push(box);
    const el = document.createElement('mc-stat-tile');
    Object.assign(el, { label: 'Packets', value: 12_900, sub: 'in range' } satisfies Partial<McStatTile>);
    box.append(el);
    await el.updateComplete;
    expect(q(el, '[data-field="value"]')!.textContent).toMatch(/12\.9\s?K/);
    expect(q(el, '[data-field="sub"]')!.textContent).toBe('in range');
    el.value = null;
    await el.updateComplete;
    expect(q(el, '[data-field="value"]')!.textContent).toBe('—');
  });
});
