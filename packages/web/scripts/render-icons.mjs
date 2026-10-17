#!/usr/bin/env node
/**
 * Renders the SVG app icons to PNGs with headless Chromium via playwright (already a dev
 * dependency for the browser tests):
 *   public/icon.svg          -> icon-192.png, icon-512.png                    (purpose "any")
 *   public/icon-maskable.svg -> icon-maskable-192.png, icon-maskable-512.png  (purpose "maskable")
 *
 *   node packages/web/scripts/render-icons.mjs
 *
 * Re-run after editing either SVG and commit the PNGs.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const browser = await chromium.launch();
try {
  for (const [name, size] of [['icon', 192], ['icon', 512], ['icon-maskable', 192], ['icon-maskable', 512]]) {
    const svg = await readFile(join(pub, `${name}.svg`), 'utf8');
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    await page.setContent(
      `<html><body style="margin:0;background:transparent"><img src="${src}" width="${size}" height="${size}" style="display:block"></body></html>`,
    );
    await page.waitForFunction(() => document.images[0]?.complete);
    const out = join(pub, `${name}-${size}.png`);
    await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log(`wrote ${out}`);
    await page.close();
  }
} finally {
  await browser.close();
}
