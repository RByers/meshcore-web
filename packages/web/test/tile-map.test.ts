import { afterEach, describe, expect, it } from 'vitest';
import { latLonToWorld } from '@meshcore-web/core/app';
import '../src/components/tile-map.js';
import type { McTileMap, TileMapView } from '../src/components/tile-map.js';

const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

let el: McTileMap | undefined;
afterEach(() => {
  el?.remove();
  el = undefined;
});

async function mount(): Promise<McTileMap> {
  el = document.createElement('mc-tile-map');
  el.tileUrl = GIF;
  el.style.width = '400px';
  el.style.height = '300px';
  el.setView(47.6, -122.3, 12);
  for (const [lat, lon, label] of [
    [47.61, -122.33, 'a'],
    [47.62, -122.35, 'b'],
  ] as const) {
    const m = document.createElement('mc-map-marker');
    m.lat = lat;
    m.lon = lon;
    m.label = label;
    m.dataset['id'] = label;
    el.append(m);
  }
  document.body.append(el);
  await until(() => el!.size.width === 400);
  await el.updateComplete;
  return el;
}

async function until(cond: () => unknown, ms = 3000): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => requestAnimationFrame(r));
  }
}

function markerPos(map: McTileMap, id: string): { x: number; y: number } {
  const m = map.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
  const r = m.getBoundingClientRect();
  const base = map.getBoundingClientRect();
  return { x: r.left - base.left, y: r.top - base.top };
}

function viewport(map: McTileMap): HTMLElement {
  return map.shadowRoot!.querySelector<HTMLElement>('.viewport')!;
}

function pointer(target: HTMLElement, type: string, x: number, y: number, id = 1): void {
  const r = target.getBoundingClientRect();
  target.dispatchEvent(
    new PointerEvent(type, { pointerId: id, clientX: r.left + x, clientY: r.top + y, bubbles: true, composed: true, button: 0, pointerType: 'touch' }),
  );
}

describe('<mc-tile-map>', () => {
  it('renders tiles from the template covering the viewport and positions markers by projection', async () => {
    const map = await mount();
    const imgs = [...map.shadowRoot!.querySelectorAll('img')];
    // 400×300 at an integer zoom needs at most 3×3 tiles
    expect(imgs.length).toBeGreaterThanOrEqual(4);
    expect(imgs.length).toBeLessThanOrEqual(9);
    expect(imgs.every((i) => i.src === GIF)).toBe(true);
    for (const id of ['a', 'b']) {
      const p = markerPos(map, id);
      const want = map.project(id === 'a' ? 47.61 : 47.62, id === 'a' ? -122.33 : -122.35);
      expect(Math.abs(p.x - want.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(p.y - want.y)).toBeLessThanOrEqual(1);
    }
    // relative positions match the Mercator pixel offsets
    const a = markerPos(map, 'a');
    const b = markerPos(map, 'b');
    const wa = latLonToWorld(47.61, -122.33, 12);
    const wb = latLonToWorld(47.62, -122.35, 12);
    expect(b.x - a.x).toBeCloseTo(wb.x - wa.x, -0.5);
    expect(b.y - a.y).toBeCloseTo(wb.y - wa.y, -0.5);
    // labels appear from labelZoom (13)
    expect(map.querySelector('[data-id="a"]')!.hasAttribute('data-show-label')).toBe(false);
  });

  it('zoom buttons step one level about the centre and emit view changes', async () => {
    const map = await mount();
    const views: TileMapView[] = [];
    map.addEventListener('mc-view-change', (e) => views.push((e as CustomEvent<TileMapView>).detail));
    const before = markerPos(map, 'b').x - markerPos(map, 'a').x;
    map.shadowRoot!.querySelector<HTMLButtonElement>('[data-zoom="in"]')!.click();
    await map.updateComplete;
    expect(map.zoom).toBe(13);
    expect(map.lat).toBeCloseTo(47.6, 9);
    const after = markerPos(map, 'b').x - markerPos(map, 'a').x;
    expect(after / before).toBeCloseTo(2, 1);
    expect(map.querySelector('[data-id="a"]')!.hasAttribute('data-show-label')).toBe(true);
    map.shadowRoot!.querySelector<HTMLButtonElement>('[data-zoom="out"]')!.click();
    map.shadowRoot!.querySelector<HTMLButtonElement>('[data-zoom="out"]')!.click();
    await map.updateComplete;
    expect(map.zoom).toBe(11);
    expect(views.map((v) => v.zoom)).toEqual([13, 12, 11]);
  });

  it('drag pans the map; a drag does not click a marker', async () => {
    const map = await mount();
    let clicks = 0;
    map.querySelector('[data-id="a"]')!.addEventListener('click', () => clicks++);
    const vp = viewport(map);
    const before = markerPos(map, 'a');
    pointer(vp, 'pointerdown', 200, 150);
    pointer(vp, 'pointermove', 230, 160);
    pointer(vp, 'pointermove', 260, 190);
    pointer(vp, 'pointerup', 260, 190);
    map.querySelector<HTMLElement>('[data-id="a"]')!.click();
    await map.updateComplete;
    const after = markerPos(map, 'a');
    expect(after.x - before.x).toBeCloseTo(60, -0.5);
    expect(after.y - before.y).toBeCloseTo(40, -0.5);
    expect(clicks).toBe(0);
    // a tap without movement still clicks
    map.querySelector<HTMLElement>('[data-id="a"]')!.click();
    expect(clicks).toBe(1);
  });

  it('wheel zooms around the cursor; pinch zooms; keyboard pans and zooms', async () => {
    const map = await mount();
    const vp = viewport(map);
    const under = map.unproject(100, 80);
    const r = vp.getBoundingClientRect();
    vp.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, clientX: r.left + 100, clientY: r.top + 80, bubbles: true, cancelable: true }));
    await map.updateComplete;
    expect(map.zoom).toBeCloseTo(12.5, 6);
    const p = map.project(under.lat, under.lon);
    expect(p.x).toBeCloseTo(100, 4);
    expect(p.y).toBeCloseTo(80, 4);

    pointer(vp, 'pointerdown', 150, 150, 1);
    pointer(vp, 'pointerdown', 250, 150, 2);
    pointer(vp, 'pointermove', 300, 150, 2);
    await map.updateComplete;
    // distance 100 → 150 px: +log2(1.5)
    expect(map.zoom).toBeCloseTo(12.5 + Math.log2(1.5), 2);
    pointer(vp, 'pointerup', 300, 150, 2);
    pointer(vp, 'pointerup', 150, 150, 1);

    map.setView(47.6, -122.3, 12);
    await map.updateComplete;
    vp.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
    expect(map.zoom).toBe(13);
    const lon = map.lon;
    vp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(map.lon).toBeGreaterThan(lon);
  });

  it('fitBounds frames the bounds (deferred until sized)', async () => {
    const map = document.createElement('mc-tile-map');
    el = map;
    map.tileUrl = GIF;
    map.fitBounds({ south: 47.6, west: -122.36, north: 47.63, east: -122.32 });
    map.style.width = '800px';
    map.style.height = '600px';
    document.body.append(map);
    await until(() => map.size.width === 800);
    await map.updateComplete;
    expect(map.zoom).toBe(14);
    const sw = map.project(47.6, -122.36);
    const ne = map.project(47.63, -122.32);
    expect(sw.x).toBeGreaterThan(0);
    expect(ne.x).toBeLessThan(800);
    expect(ne.y).toBeGreaterThan(0);
    expect(sw.y).toBeLessThan(600);
    expect(map.shadowRoot!.querySelector('.attribution a')?.getAttribute('href')).toBe('https://www.openstreetmap.org/copyright');
  });

  it('lines with arrow draw an arrowhead per segment pointing in point order; offset shifts a line to its right', async () => {
    const map = await mount();
    const a = { lat: 47.61, lon: -122.33 };
    const b = { lat: 47.62, lon: -122.35 };
    const c = { lat: 47.6, lon: -122.37 };
    map.lines = [
      { points: [a, b], id: 'ab', arrow: true, width: 6 },
      { points: [b, a], id: 'ba', arrow: true, width: 2, offset: 4 },
      { points: [a, c], id: 'plain' },
      // a.lat/lon nudged: far too short on screen for an arrow
      { points: [a, { lat: 47.6101, lon: -122.33 }], id: 'short', arrow: true },
    ];
    await map.updateComplete;
    const root = map.shadowRoot!;
    const heads = (id: string) => [...root.querySelectorAll<SVGPolygonElement>(`polygon[data-arrow="${id}"]`)];
    expect(heads('ab')).toHaveLength(1);
    expect(heads('ba')).toHaveLength(1);
    expect(heads('plain')).toHaveLength(0);
    expect(heads('short')).toHaveLength(0);
    // the plain line is unchanged: no arrow attribute, path through the projected points
    const pa = map.project(a.lat, a.lon);
    const pb = map.project(b.lat, b.lon);
    const pc = map.project(c.lat, c.lon);
    expect(root.querySelector('path[data-line="plain"]')!.getAttribute('d')).toBe(`M${pa.x.toFixed(1)} ${pa.y.toFixed(1)} L${pc.x.toFixed(1)} ${pc.y.toFixed(1)}`);

    const pts = (el: SVGPolygonElement) => el.getAttribute('points')!.split(' ').map((p) => p.split(',').map(Number) as [number, number]);
    const along = (from: { x: number; y: number }, to: { x: number; y: number }, p: [number, number]) => {
      const len = Math.hypot(to.x - from.x, to.y - from.y);
      return ((p[0] - from.x) * (to.x - from.x) + (p[1] - from.y) * (to.y - from.y)) / len / len;
    };
    // a→b: the tip (first point) is nearer b than the base corners, past the middle
    const [tip, l, r] = pts(heads('ab')[0]!);
    expect(along(pa, pb, tip!)).toBeGreaterThan(along(pa, pb, l!));
    expect(along(pa, pb, l!)).toBeCloseTo(along(pa, pb, r!), 2);
    expect(along(pa, pb, l!)).toBeGreaterThan(0.5);
    expect(along(pa, pb, tip!)).toBeLessThan(1);
    // the arrow is wider than its 6px line
    expect(Math.hypot(l![0] - r![0], l![1] - r![1])).toBeGreaterThan(6);
    expect(heads('ab')[0]!.getAttribute('fill')).toBe('var(--mc-accent)');
    // b→a points the other way, at a different spot along the hop
    const [tip2, l2] = pts(heads('ba')[0]!);
    expect(along(pa, pb, tip2!)).toBeLessThan(along(pa, pb, l2!));
    expect(along(pa, pb, tip2!)).toBeLessThan(0.5);
    // offset 4: its path runs 4px to the right of b→a (screen y down)
    const d = root.querySelector('path[data-line="ba"]')!.getAttribute('d')!;
    const [x0, y0] = d.slice(1).split(' L')[0]!.split(' ').map(Number) as [number, number];
    const len = Math.hypot(pa.x - pb.x, pa.y - pb.y);
    const right = { x: -(pa.y - pb.y) / len, y: (pa.x - pb.x) / len };
    expect(x0).toBeCloseTo(pb.x + right.x * 4, 0);
    expect(y0).toBeCloseTo(pb.y + right.y * 4, 0);
  });
});
