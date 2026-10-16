/**
 * Device settings (Phase 11 adds editing: name, location, radio params, tx power, advert,
 * other params, time sync, key export/import, reboot). Read-only views for now.
 */

import type { ConnectionModel } from './connection.js';
import { computed } from './signal.js';

export interface RadioParamsView {
  freqMhz: number;
  bwKhz: number;
  sf: number;
  cr: number;
  txPowerDbm: number;
}

export class DeviceSettingsModel {
  constructor(private readonly connection: ConnectionModel) {}

  readonly selfInfo = computed(() => this.connection.selfInfo.value);
  readonly deviceInfo = computed(() => this.connection.deviceInfo.value);
  readonly radioParams = computed((): RadioParamsView | null => {
    const si = this.connection.selfInfo.value;
    if (!si) return null;
    return { freqMhz: si.radioFreqKhz / 1000, bwKhz: si.radioBwHz / 1000, sf: si.radioSf, cr: si.radioCr, txPowerDbm: si.txPowerDbm };
  });

  /** Re-reads SELF_INFO from the device. */
  async refresh(): Promise<void> {
    await this.connection.client.peek()?.refreshSelfInfo();
    await this.connection.refreshBattery();
  }
}
