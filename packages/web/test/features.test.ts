import { expect, it } from 'vitest';
import { detectFeatures } from '../src/features.js';

it('runs in a real browser', () => {
  expect(navigator.userAgent).toMatch(/Chrome/);
});

it('detects platform features without throwing', () => {
  const f = detectFeatures();
  expect(f.indexedDB).toBe(true);
  expect(typeof f.webSerial).toBe('boolean');
  expect(typeof f.webBluetooth).toBe('boolean');
  expect(f.webSerial).toBe('serial' in navigator);
  expect(f.webBluetooth).toBe('bluetooth' in navigator);
});

it('reports missing features on a bare global', () => {
  expect(detectFeatures({} as typeof globalThis)).toEqual({
    indexedDB: false,
    webSerial: false,
    webBluetooth: false,
  });
});

it('can open an IndexedDB database', async () => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('mc-feature-test', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('s');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  expect(db.objectStoreNames.contains('s')).toBe(true);
  db.close();
});
