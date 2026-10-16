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
});
