/**
 * LoRa radio presets and option lists for the device settings UI.
 *
 * Source: MeshCore Open `lib/models/radio_settings.dart` (`RadioSettings.presets`, commit 3bee159,
 * .ref/meshcore-open), which mirrors the community-recommended regional settings. The Russian
 * city presets are left out for brevity; the "Off-Grid" presets are the firmware's default
 * client-repeat frequencies (`GET_ALLOWED_REPEAT_FREQ` default {433000, 869495, 918000} kHz,
 * docs/companion-protocol.md §4 cmd 60) and are applied with client repeat on.
 */

export interface RadioPreset {
  id: string;
  name: string;
  freqMhz: number;
  bwKhz: number;
  sf: number;
  /** 5..8 = 4/5..4/8 */
  cr: number;
  /** Suggested TX power (MeshCore Open applies it with the preset; we only show it). */
  txPowerDbm: number;
  /** Client repeat (off-grid) preset; needs firmware v9+. */
  clientRepeat?: boolean;
}

const p = (id: string, name: string, freqMhz: number, bwKhz: number, sf: number, cr: number, txPowerDbm: number, clientRepeat = false): RadioPreset => ({
  id,
  name,
  freqMhz,
  bwKhz,
  sf,
  cr,
  txPowerDbm,
  ...(clientRepeat ? { clientRepeat } : {}),
});

export const RADIO_PRESETS: readonly RadioPreset[] = [
  p('au', 'Australia', 915.8, 250, 10, 5, 20),
  p('au-narrow', 'Australia (Narrow)', 916.575, 62.5, 7, 5, 20),
  p('au-mid', 'Australia (Mid)', 915.075, 125, 9, 5, 20),
  p('au-sa-wa-qld', 'Australia SA, WA, QLD', 923.125, 62.5, 8, 5, 20),
  p('cz', 'Czech Republic', 869.432, 62.5, 7, 5, 14),
  p('eu-433', 'EU 433MHz', 433.65, 250, 11, 5, 20),
  p('eu-long', 'EU/UK (Long Range)', 869.525, 250, 11, 5, 14),
  p('eu-medium', 'EU/UK (Medium Range)', 869.525, 250, 10, 5, 14),
  p('eu-narrow', 'EU/UK (Narrow)', 869.618, 62.5, 8, 5, 14),
  p('nz', 'New Zealand', 917.375, 250, 11, 5, 20),
  p('nz-narrow', 'New Zealand (Narrow)', 917.375, 62.5, 7, 5, 20),
  p('pt-433', 'Portugal 433', 433.375, 62.5, 9, 5, 20),
  p('pt-869', 'Portugal 869', 869.618, 62.5, 7, 5, 14),
  p('ch', 'Switzerland', 869.618, 62.5, 8, 5, 14),
  p('us-az', 'USA Arizona', 908.205, 62.5, 9, 8, 22),
  p('us-philly', 'USA Philly', 902.25, 500, 11, 5, 22),
  p('us', 'USA/Canada', 910.525, 62.5, 7, 5, 22),
  p('vn', 'Vietnam', 920.25, 250, 11, 5, 20),
  p('offgrid-433', 'Off-Grid 433', 433.0, 250, 11, 8, 20, true),
  p('offgrid-869', 'Off-Grid 869', 869.495, 250, 11, 8, 14, true),
  p('offgrid-918', 'Off-Grid 918', 918.0, 250, 11, 8, 20, true),
];

/** Standard LoRa bandwidths in kHz (SX127x/SX126x). */
export const LORA_BANDWIDTHS_KHZ: readonly number[] = [7.8, 10.4, 15.6, 20.8, 31.25, 41.7, 62.5, 125, 250, 500];
export const LORA_SPREADING_FACTORS: readonly number[] = [5, 6, 7, 8, 9, 10, 11, 12];
export const LORA_CODING_RATES: readonly number[] = [5, 6, 7, 8];

/** The preset whose freq/bw/sf/cr equal these values (wire precision: 1 kHz / 1 Hz). */
export function findRadioPreset(r: { freqMhz: number; bwKhz: number; sf: number; cr: number }): RadioPreset | undefined {
  const f = Math.round(r.freqMhz * 1000);
  const b = Math.round(r.bwKhz * 1000);
  return RADIO_PRESETS.find((x) => Math.round(x.freqMhz * 1000) === f && Math.round(x.bwKhz * 1000) === b && x.sf === r.sf && x.cr === r.cr);
}
