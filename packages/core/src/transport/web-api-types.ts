/**
 * Minimal structural types for the parts of Web Serial and Web Bluetooth the transports use.
 * TypeScript's DOM lib does not ship these APIs, and core must not reference `navigator`, so the
 * transports take objects matching these shapes; real `navigator.serial` / `navigator.bluetooth`
 * objects satisfy them (cast at the call site), as do the mocks in `packages/web/src/testing/`.
 */

export interface EventTargetLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

// ---- Web Serial ----

export interface SerialPortFilter {
  usbVendorId?: number;
  usbProductId?: number;
  bluetoothServiceClassId?: number | string;
}

export interface SerialPortRequestOptions {
  filters?: SerialPortFilter[];
}

export interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
  bluetoothServiceClassId?: number | string;
}

export interface SerialOpenOptions {
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: 'none' | 'even' | 'odd';
  bufferSize?: number;
  flowControl?: 'none' | 'hardware';
}

export interface SerialPortLike extends EventTargetLike {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: SerialOpenOptions): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfo;
}

export interface SerialLike extends EventTargetLike {
  requestPort(options?: SerialPortRequestOptions): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}

// ---- Web Bluetooth ----

export interface BluetoothLEScanFilter {
  services?: (string | number)[];
  name?: string;
  namePrefix?: string;
}

export interface BluetoothRequestDeviceOptions {
  filters?: BluetoothLEScanFilter[];
  optionalServices?: (string | number)[];
  acceptAllDevices?: boolean;
}

export interface BluetoothCharacteristicPropertiesLike {
  readonly write: boolean;
  readonly writeWithoutResponse: boolean;
  readonly notify: boolean;
}

export interface BluetoothRemoteGATTCharacteristicLike extends EventTargetLike {
  readonly uuid: string;
  readonly value?: DataView | null;
  readonly properties: BluetoothCharacteristicPropertiesLike;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristicLike>;
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristicLike>;
  writeValue(value: BufferSource): Promise<void>;
  writeValueWithResponse?(value: BufferSource): Promise<void>;
  writeValueWithoutResponse?(value: BufferSource): Promise<void>;
}

export interface BluetoothRemoteGATTServiceLike {
  readonly uuid: string;
  getCharacteristic(uuid: string): Promise<BluetoothRemoteGATTCharacteristicLike>;
}

export interface BluetoothRemoteGATTServerLike {
  readonly connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServerLike>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<BluetoothRemoteGATTServiceLike>;
}

export interface BluetoothDeviceLike extends EventTargetLike {
  readonly id: string;
  readonly name?: string | undefined;
  readonly gatt?: BluetoothRemoteGATTServerLike | undefined;
}

export interface BluetoothLike {
  requestDevice(options: BluetoothRequestDeviceOptions): Promise<BluetoothDeviceLike>;
}
