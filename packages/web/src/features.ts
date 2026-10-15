/** Runtime feature detection for the platform APIs the client relies on. */
export interface PlatformFeatures {
  indexedDB: boolean;
  webSerial: boolean;
  webBluetooth: boolean;
}

export function detectFeatures(g: typeof globalThis = globalThis): PlatformFeatures {
  const nav = (g as { navigator?: Navigator }).navigator as
    | (Navigator & { serial?: unknown; bluetooth?: unknown })
    | undefined;
  return {
    indexedDB: typeof (g as { indexedDB?: unknown }).indexedDB !== 'undefined',
    webSerial: !!nav && 'serial' in nav && nav.serial != null,
    webBluetooth: !!nav && 'bluetooth' in nav && nav.bluetooth != null,
  };
}
