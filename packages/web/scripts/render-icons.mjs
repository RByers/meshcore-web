#!/usr/bin/env node
/**
 * Renders public/icon.svg to the PNG app icons (public/icon-192.png, public/icon-512.png)
 * with headless Chromium via playwright (already a dev dependency for the browser tests).
 *
 *   node packages/web/scripts/render-icons.mjs
 *
 * Re-run after editing icon.svg and commit the PNGs.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const svg = await readFile(join(pub, 'icon.svg'), 'utf8');
const browser = await chromium.launch();
try {
  for (const size of [192, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    await page.setContent(
      `<html><body style="margin:0;background:transparent"><img src="${src}" width="${size}" height="${size}" style="display:block"></body></html>`,
    );
    await page.waitForFunction(() => document.images[0]?.complete);
    const out = join(pub, `icon-${size}.png`);
    await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log(`wrote ${out}`);
    await page.close();
  }
} finally {
  await browser.close();
}
