/**
 * A mock of Web Bluetooth (`Bluetooth`, `BluetoothDevice`, `BluetoothRemoteGATTServer`, the
 * Nordic UART service and its RX/TX characteristics) for browser tests. Each host write to RX is
 * one frame handed to `onFrameFromHost`; each `pushFrameToHost` is one TX notification
 * (companion-protocol.md §1.2: no length header, no reassembly).
 *
 * Mirrors behaviour that matters to transports:
 * - GATT calls reject with NetworkError when the server is not connected.
 * - Overlapping writes reject with "GATT operation already in progress" (as Chrome does), so
 *   transports must serialize writes.
 * - Writes larger than `maxWriteLength` (176) are dropped, as the firmware does.
 * - `disconnectDevice()` (out of range / device reboot) and `gatt.disconnect()` fire
 *   `gattserverdisconnected` on the device.
 * - Notifications are dispatched one per task with `value` set to a fresh DataView.
 * - `getDevices()` returns the device once `requestDevice()` picked it (or `granted: true`), as
 *   persistent permissions do; `watchAdvertisements()` fires `advertisementreceived` while the
 *   device is `advertising` (in range; see `setAdvertising`).
 */
import {
  NUS_RX_CHARACTERISTIC_UUID,
  NUS_SERVICE_UUID,
  NUS_TX_CHARACTERISTIC_UUID,
} from '@meshcore-web/core/transport';
import type {
  BluetoothCharacteristicPropertiesLike,
  BluetoothDeviceLike,
  BluetoothLike,
  BluetoothRemoteGATTCharacteristicLike,
  BluetoothRemoteGATTServerLike,
  BluetoothRemoteGATTServiceLike,
  BluetoothRequestDeviceOptions,
} from '@meshcore-web/core/transport';

export interface MockBleDevice {
  /** One frame = one TX notification to the host (dropped if not subscribed). */
  pushFrameToHost(frame: Uint8Array): void;
}

export interface MockBluetoothOptions {
  onFrameFromHost?: (frame: Uint8Array, device: MockBleDevice) => void | Promise<void>;
  /** Advertised name; default "MeshCore-mock". */
  name?: string;
  id?: string;
  /** Whether RX advertises write-without-response (firmware: false, WRITE only). */
  writeWithoutResponse?: boolean;
  /** Firmware drops writes above this; default 176. */
  maxWriteLength?: number;
  /** Simulated time for each GATT write to complete; default 0 (next task). */
  writeLatencyMs?: number;
  /** Whether the device advertises the NUS service UUID (affects `requestDevice` filters). */
  advertisesService?: boolean;
  /** Start out granted (as if picked on an earlier visit); default false. */
  granted?: boolean;
  /** Provide `getDevices()` (persistent permissions); default true. */
  getDevices?: boolean;
  /** Initially in range and advertising; default true. */
  advertising?: boolean;
}

/**
 * Resolves on the next macrotask (`ms` 0) or after a simulated delay. A MessageChannel hop is used
 * for the zero case: nested `setTimeout(0)` chains get clamped to ≥4 ms by browsers, which would make
 * a burst of notifications take tens of ms for no reason.
 */
const tick = (ms = 0): Promise<void> =>
  ms > 0
    ? new Promise<void>((r) => setTimeout(r, ms))
    : new Promise<void>((r) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => {
          ch.port1.close();
          r();
        };
        ch.port2.postMessage(0);
      });
const networkError = (msg: string) => new DOMException(msg, 'NetworkError');

function toBytes(value: BufferSource): Uint8Array {
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  return new Uint8Array(value).slice();
}

export class MockCharacteristic extends EventTarget implements BluetoothRemoteGATTCharacteristicLike {
  value: DataView | null = null;
  notifying = false;
  #busy = false;

  constructor(
    readonly uuid: string,
    readonly properties: BluetoothCharacteristicPropertiesLike,
    readonly server: MockGattServer,
    private readonly onWrite: (bytes: Uint8Array, withResponse: boolean) => void,
    private readonly writeLatencyMs: number,
  ) {
    super();
  }

  async startNotifications(): Promise<this> {
    this.#requireConnected();
    if (!this.properties.notify) throw new DOMException('Notify not supported', 'NotSupportedError');
    this.notifying = true;
    return this;
  }

  async stopNotifications(): Promise<this> {
    this.#requireConnected();
    this.notifying = false;
    return this;
  }

  writeValue(value: BufferSource): Promise<void> {
    return this.#write(value, true);
  }

  writeValueWithResponse(value: BufferSource): Promise<void> {
    return this.#write(value, true);
  }

  writeValueWithoutResponse(value: BufferSource): Promise<void> {
    if (!this.properties.writeWithoutResponse) {
      return Promise.reject(new DOMException('GATT operation not permitted.', 'NotSupportedError'));
    }
    return this.#write(value, false);
  }

  /** Device side: emit one notification. */
  notify(bytes: Uint8Array): void {
    if (!this.notifying || !this.server.connected) return;
    this.value = new DataView(bytes.slice().buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }

  async #write(value: BufferSource, withResponse: boolean): Promise<void> {
    this.#requireConnected();
    if (!this.properties.write && !this.properties.writeWithoutResponse) {
      throw new DOMException('GATT operation not permitted.', 'NotSupportedError');
    }
    if (this.#busy) throw networkError('GATT operation already in progress.');
    this.#busy = true;
    try {
      const bytes = toBytes(value);
      await tick(this.writeLatencyMs);
      this.#requireConnected();
      this.onWrite(bytes, withResponse);
    } finally {
      this.#busy = false;
    }
  }

  #requireConnected(): void {
    if (!this.server.connected) throw networkError('GATT Server is disconnected.');
  }
}

export class MockGattService implements BluetoothRemoteGATTServiceLike {
  readonly uuid = NUS_SERVICE_UUID;
  constructor(
    readonly server: MockGattServer,
    readonly rx: MockCharacteristic,
    readonly tx: MockCharacteristic,
  ) {}

  async getCharacteristic(uuid: string): Promise<MockCharacteristic> {
    if (!this.server.connected) throw networkError('GATT Server is disconnected.');
    const u = uuid.toLowerCase();
    if (u === NUS_RX_CHARACTERISTIC_UUID) return this.rx;
    if (u === NUS_TX_CHARACTERISTIC_UUID) return this.tx;
    throw new DOMException(`No Characteristics matching UUID ${uuid} found in Service.`, 'NotFoundError');
  }
}

export class MockGattServer implements BluetoothRemoteGATTServerLike {
  connected = false;
  connectCount = 0;
  service!: MockGattService;
  /** When set, the next `connect()` rejects with this error. */
  failNextConnect: Error | undefined;

  constructor(readonly device: MockBluetoothDevice) {}

  async connect(): Promise<this> {
    await tick();
    if (this.failNextConnect) {
      const e = this.failNextConnect;
      this.failNextConnect = undefined;
      throw e;
    }
    this.connected = true;
    this.connectCount++;
    return this;
  }

  disconnect(): void {
    if (!this.connected) return;
    this.#drop();
  }

  async getPrimaryService(uuid: string): Promise<MockGattService> {
    if (!this.connected) throw networkError('GATT Server is disconnected.');
    if (uuid.toLowerCase() !== NUS_SERVICE_UUID) {
      throw new DOMException(`No Services matching UUID ${uuid} found in Device.`, 'NotFoundError');
    }
    return this.service;
  }

  /** Link lost (either side). */
  drop(): void {
    if (this.connected) this.#drop();
  }

  #drop(): void {
    this.connected = false;
    this.service.tx.notifying = false;
    this.device.dispatchEvent(new Event('gattserverdisconnected'));
  }
}

export class MockBluetoothDevice extends EventTarget implements BluetoothDeviceLike {
  readonly gatt: MockGattServer;
  watchingAdvertisements = false;
  advertising = true;
  constructor(
    readonly id: string,
    readonly name: string | undefined,
  ) {
    super();
    this.gatt = new MockGattServer(this);
  }

  async watchAdvertisements(options: { signal?: AbortSignal } = {}): Promise<void> {
    await tick();
    if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    this.watchingAdvertisements = true;
    options.signal?.addEventListener('abort', () => (this.watchingAdvertisements = false), { once: true });
    if (this.advertising) this.#advertise();
  }

  /** Device comes into / goes out of range. */
  setAdvertising(on: boolean): void {
    this.advertising = on;
    if (on && this.watchingAdvertisements) this.#advertise();
  }

  #advertise(): void {
    setTimeout(() => {
      if (this.watchingAdvertisements) this.dispatchEvent(new Event('advertisementreceived'));
    });
  }
}

export class MockBluetooth implements BluetoothLike {
  lastRequestOptions: BluetoothRequestDeviceOptions | undefined;
  cancelChooser = false;
  requestCount = 0;
  /** Whether this origin holds a permission for `device` (what `getDevices()` returns). */
  granted = false;
  getDevices?: () => Promise<MockBluetoothDevice[]>;

  constructor(
    readonly device: MockBluetoothDevice,
    private readonly advertisesService: boolean,
    withGetDevices = true,
  ) {
    if (withGetDevices) this.getDevices = async () => (this.granted ? [this.device] : []);
  }

  async requestDevice(options: BluetoothRequestDeviceOptions): Promise<MockBluetoothDevice> {
    this.lastRequestOptions = options;
    this.requestCount++;
    if (this.cancelChooser) throw new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError');
    const name = this.device.name ?? '';
    const matches =
      options.acceptAllDevices === true ||
      (options.filters ?? []).some(
        (f) =>
          (f.services === undefined ||
            (this.advertisesService && f.services.some((s) => String(s).toLowerCase() === NUS_SERVICE_UUID))) &&
          (f.name === undefined || f.name === name) &&
          (f.namePrefix === undefined || name.startsWith(f.namePrefix)) &&
          (f.services !== undefined || f.name !== undefined || f.namePrefix !== undefined),
      );
    if (!matches) throw new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError');
    this.granted = true;
    return this.device;
  }
}

export interface MockBluetoothHandle extends MockBleDevice {
  bluetooth: MockBluetooth;
  device: MockBluetoothDevice;
  rx: MockCharacteristic;
  tx: MockCharacteristic;
  /** Frames the host wrote (one per GATT write). */
  framesFromHost: Uint8Array[];
  /** Writes the device dropped for being too large. */
  droppedWrites: Uint8Array[];
  /** How each accepted write was performed. */
  writeModes: ('with-response' | 'without-response')[];
  /** Simulates the link dropping (out of range, device reboot). */
  disconnectDevice(): void;
}

export function createMockBluetooth(options: MockBluetoothOptions = {}): MockBluetoothHandle {
  const device = new MockBluetoothDevice(options.id ?? 'mock-ble-device-id', options.name ?? 'MeshCore-mock');
  const server = device.gatt;
  const maxWrite = options.maxWriteLength ?? 176;
  const framesFromHost: Uint8Array[] = [];
  const droppedWrites: Uint8Array[] = [];
  const writeModes: MockBluetoothHandle['writeModes'] = [];
  const latency = options.writeLatencyMs ?? 0;

  // Notifications go out one per task so a burst exercises the host's per-event handling.
  let notifyChain: Promise<void> = Promise.resolve();
  const ble: MockBleDevice = {
    pushFrameToHost: (frame) => {
      const copy = frame.slice();
      notifyChain = notifyChain.then(async () => {
        await tick();
        tx.notify(copy);
      });
    },
  };

  const rx = new MockCharacteristic(
    NUS_RX_CHARACTERISTIC_UUID,
    { write: true, writeWithoutResponse: options.writeWithoutResponse ?? false, notify: false },
    server,
    (bytes, withResponse) => {
      if (bytes.length > maxWrite) {
        droppedWrites.push(bytes);
        return;
      }
      framesFromHost.push(bytes);
      writeModes.push(withResponse ? 'with-response' : 'without-response');
      const handler = options.onFrameFromHost;
      if (handler) queueMicrotask(() => void handler(bytes, ble));
    },
    latency,
  );
  const tx = new MockCharacteristic(
    NUS_TX_CHARACTERISTIC_UUID,
    { write: false, writeWithoutResponse: false, notify: true },
    server,
    () => undefined,
    0,
  );
  server.service = new MockGattService(server, rx, tx);
  const bluetooth = new MockBluetooth(device, options.advertisesService ?? true, options.getDevices ?? true);
  bluetooth.granted = options.granted ?? false;
  device.advertising = options.advertising ?? true;

  return {
    ...ble,
    bluetooth,
    device,
    rx,
    tx,
    framesFromHost,
    droppedWrites,
    writeModes,
    disconnectDevice: () => server.drop(),
  };
}
