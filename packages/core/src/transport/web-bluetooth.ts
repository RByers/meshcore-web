import { MAX_FRAME_SIZE } from '../framing/serial-framer.js';
import { BaseTransport, checkFrameSize } from './base.js';
import type { FrameTransport, TransportInfo } from './transport.js';
import { TransportError, toError } from './transport.js';
import type {
  BluetoothDeviceLike,
  BluetoothLEScanFilter,
  BluetoothLike,
  BluetoothRemoteGATTCharacteristicLike,
  BluetoothRemoteGATTServerLike,
} from './web-api-types.js';

/** Nordic UART Service, companion-protocol.md §1.2 (lower-case: Web Bluetooth canonical form). */
export const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
/** RX characteristic: the host WRITES command frames here. */
export const NUS_RX_CHARACTERISTIC_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
/** TX characteristic: the device NOTIFIES response/push frames here. */
export const NUS_TX_CHARACTERISTIC_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
/** Advertised name is `"MeshCore-" + node_name` (`BLE_NAME_PREFIX`). */
export const MESHCORE_BLE_NAME_PREFIX = 'MeshCore';

export interface WebBluetoothTransportOptions {
  /** `navigator.bluetooth` (injected). Needed only if no `device`. */
  bluetooth?: BluetoothLike;
  /** A device already chosen by the user. If omitted, `connect()` calls `requestDevice()`. */
  device?: BluetoothDeviceLike;
  /**
   * Largest frame `send` accepts. Default 176 (firmware MAX_FRAME_SIZE; ESP32 drops larger
   * writes). See the MTU note on the class.
   */
  maxFrameLength?: number;
  /** Force write-with-response even if the RX characteristic allows write-without-response. */
  preferWriteWithResponse?: boolean;
}

export interface RequestBleDeviceOptions {
  /** Also match devices by advertised name prefix (default "MeshCore"); `null` disables. */
  namePrefix?: string | null;
}

/**
 * Companion link over Web Bluetooth using the Nordic UART Service (companion-protocol.md §1.2).
 *
 * - No length header: one GATT write = one command frame; one TX notification = one frame.
 *   Notifications are emitted as frames unchanged, with no reassembly (firmware does none). A
 *   zero-length notification is ignored. If nRF52 ever splits a frame longer than MTU-3 across
 *   notifications (UNVERIFIED in the doc), the pieces would surface as separate short frames;
 *   the companion client's decoder must treat an undecodable frame as an error, not a crash.
 * - MTU: a 176-byte frame needs ATT MTU >= 179 (176 + 3-byte ATT header). Web Bluetooth gives
 *   no MTU control or visibility; Chrome negotiates automatically (typically 247 or 517), so we
 *   can only enforce the protocol limit (`maxFrameLength`, 176) and rely on the OS. RP2040
 *   drops notifications with `len + 3 > MTU`; ESP32 sets MTU 176 on its side.
 * - Writes are serialized (Chrome rejects concurrent GATT operations with "GATT operation
 *   already in progress"). Write-without-response is used only when the RX characteristic
 *   advertises it; firmware RX is WRITE (with response), so that is the normal path.
 * - The device queue is small (4-12 frames), so the client should send one command at a time.
 */
export class WebBluetoothTransport extends BaseTransport implements FrameTransport {
  readonly kind = 'ble' as const;
  readonly #bluetooth: BluetoothLike | undefined;
  #device: BluetoothDeviceLike | undefined;
  readonly #max: number;
  readonly #preferWithResponse: boolean;
  #server: BluetoothRemoteGATTServerLike | undefined;
  #rx: BluetoothRemoteGATTCharacteristicLike | undefined;
  #tx: BluetoothRemoteGATTCharacteristicLike | undefined;
  #writeChain: Promise<void> = Promise.resolve();
  /** True while we initiate the disconnect, so `gattserverdisconnected` is not an error. */
  #intentionalDisconnect = false;

  readonly #onNotification = (event: Event): void => {
    const target = event.target as BluetoothRemoteGATTCharacteristicLike | null;
    const value = target?.value ?? this.#tx?.value;
    if (!value || value.byteLength === 0) return;
    // Copy: Chrome may reuse the underlying buffer for the next notification.
    const frame = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    this.emitSafe('frame', frame);
  };

  readonly #onGattDisconnected = (): void => {
    const unexpected = !this.#intentionalDisconnect && this.state !== 'disconnected';
    this.#cleanup();
    this.setState('disconnected');
    if (unexpected) this.emitSafe('error', new TransportError('BLE device disconnected'));
  };

  constructor(options: WebBluetoothTransportOptions = {}) {
    super();
    this.#bluetooth = options.bluetooth;
    this.#device = options.device;
    this.#max = options.maxFrameLength ?? MAX_FRAME_SIZE;
    this.#preferWithResponse = options.preferWriteWithResponse ?? false;
  }

  /** Shows the browser's device picker (user gesture required). */
  static requestDevice(bluetooth: BluetoothLike, options: RequestBleDeviceOptions = {}): Promise<BluetoothDeviceLike> {
    const prefix = options.namePrefix === undefined ? MESHCORE_BLE_NAME_PREFIX : options.namePrefix;
    // Filters are OR-ed: match either the advertised NUS service or the name prefix. The
    // service must also be in optionalServices for name-matched devices to grant access.
    const filters: BluetoothLEScanFilter[] = [{ services: [NUS_SERVICE_UUID] }];
    if (prefix) filters.push({ namePrefix: prefix });
    return bluetooth.requestDevice({ filters, optionalServices: [NUS_SERVICE_UUID] });
  }

  get device(): BluetoothDeviceLike | undefined {
    return this.#device;
  }

  get info(): TransportInfo {
    const d = this.#device;
    return { kind: 'ble', name: d?.name || 'Bluetooth device', ...(d ? { detail: d.id } : {}) };
  }

  async connect(): Promise<void> {
    if (this.state === 'connected') return;
    if (this.state === 'connecting') throw new TransportError('connect already in progress');
    this.setState('connecting');
    try {
      if (!this.#device) {
        if (!this.#bluetooth) throw new TransportError('no BLE device and no Bluetooth object to request one');
        this.#device = await WebBluetoothTransport.requestDevice(this.#bluetooth);
      }
      const device = this.#device;
      if (!device.gatt) throw new TransportError('BLE device has no GATT server');
      device.addEventListener('gattserverdisconnected', this.#onGattDisconnected);
      this.#intentionalDisconnect = false;
      this.#server = await device.gatt.connect();
      const service = await this.#server.getPrimaryService(NUS_SERVICE_UUID);
      this.#rx = await service.getCharacteristic(NUS_RX_CHARACTERISTIC_UUID);
      this.#tx = await service.getCharacteristic(NUS_TX_CHARACTERISTIC_UUID);
      this.#tx.addEventListener('characteristicvaluechanged', this.#onNotification);
      await this.#tx.startNotifications();
      // A disconnect during setup already reset us to 'disconnected'.
      if (!this.#server.connected) throw new TransportError('BLE device disconnected during connect');
    } catch (err) {
      this.#intentionalDisconnect = true;
      this.#cleanup();
      try {
        this.#device?.gatt?.disconnect();
      } catch {
        // ignore
      }
      this.#intentionalDisconnect = false;
      this.setState('disconnected');
      throw err instanceof TransportError ? err : new TransportError('BLE connect failed', { cause: toError(err) });
    }
    this.#writeChain = Promise.resolve();
    this.setState('connected');
  }

  async disconnect(): Promise<void> {
    if (this.state === 'disconnected') return;
    this.#intentionalDisconnect = true;
    const tx = this.#tx;
    await this.#writeChain;
    if (tx && this.#server?.connected) {
      try {
        await tx.stopNotifications();
      } catch {
        // link may already be gone
      }
    }
    const device = this.#device;
    this.#cleanup();
    if (device?.gatt?.connected) device.gatt.disconnect(); // fires gattserverdisconnected
    this.setState('disconnected');
    this.#intentionalDisconnect = false;
  }

  send(frame: Uint8Array): Promise<void> {
    try {
      this.assertConnected();
      checkFrameSize(frame, this.#max);
    } catch (err) {
      return Promise.reject(err);
    }
    const rx = this.#rx!;
    const data = frame.slice(); // own copy, detached from caller mutations
    const p = this.#writeChain.then(async () => {
      if (this.state !== 'connected') throw new TransportError('BLE transport is not connected');
      if (!this.#preferWithResponse && rx.properties.writeWithoutResponse && rx.writeValueWithoutResponse) {
        await rx.writeValueWithoutResponse(data);
      } else if (rx.writeValueWithResponse) {
        await rx.writeValueWithResponse(data);
      } else {
        await rx.writeValue(data);
      }
    });
    this.#writeChain = p.catch(() => undefined);
    return p;
  }

  #cleanup(): void {
    this.#tx?.removeEventListener('characteristicvaluechanged', this.#onNotification);
    this.#device?.removeEventListener('gattserverdisconnected', this.#onGattDisconnected);
    this.#tx = undefined;
    this.#rx = undefined;
    this.#server = undefined;
  }
}
