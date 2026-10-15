import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from '@meshcore-web/core/util/bytes';
import {
  NUS_SERVICE_UUID,
  WebBluetoothTransport,
  type FrameTransport,
  type TransportState,
} from '@meshcore-web/core/transport';
import { createMockBluetooth } from '../src/testing/mock-bluetooth.js';

function collectFrames(t: FrameTransport): string[] {
  const out: string[] = [];
  t.events.on('frame', (f) => out.push(toHex(f)));
  return out;
}

async function until(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe('WebBluetoothTransport + mock bluetooth', () => {
  it('requestDevice filters by NUS service or "MeshCore" name prefix', async () => {
    const mock = createMockBluetooth();
    const dev = await WebBluetoothTransport.requestDevice(mock.bluetooth);
    expect(dev).toBe(mock.device);
    expect(mock.bluetooth.lastRequestOptions).toEqual({
      filters: [{ services: [NUS_SERVICE_UUID] }, { namePrefix: 'MeshCore' }],
      optionalServices: [NUS_SERVICE_UUID],
    });
    await WebBluetoothTransport.requestDevice(mock.bluetooth, { namePrefix: null });
    expect(mock.bluetooth.lastRequestOptions?.filters).toEqual([{ services: [NUS_SERVICE_UUID] }]);
    // A device that does not advertise NUS is still found by name.
    const quiet = createMockBluetooth({ advertisesService: false });
    await expect(WebBluetoothTransport.requestDevice(quiet.bluetooth)).resolves.toBe(quiet.device);
  });

  it('connects, writes one frame per GATT write, and receives one frame per notification', async () => {
    const mock = createMockBluetooth({
      onFrameFromHost: (frame, dev) => dev.pushFrameToHost(Uint8Array.of(0x80 | frame[0]!, ...frame.subarray(1))),
    });
    const t = new WebBluetoothTransport({ bluetooth: mock.bluetooth });
    const states: TransportState[] = [];
    t.events.on('state', (s) => states.push(s));
    const frames = collectFrames(t);
    await t.connect();
    expect(t.info).toEqual({ kind: 'ble', name: 'MeshCore-mock', detail: 'mock-ble-device-id' });
    expect(mock.tx.notifying).toBe(true);
    await t.send(fromHex('1603'));
    await t.send(fromHex('0a'));
    expect(mock.framesFromHost.map(toHex)).toEqual(['1603', '0a']);
    expect(mock.writeModes).toEqual(['with-response', 'with-response']); // firmware RX is WRITE only
    await until(() => frames.length === 2);
    expect(frames).toEqual(['9603', '8a']);
    await t.disconnect();
    expect(states).toEqual(['connecting', 'connected', 'disconnected']);
    expect(mock.device.gatt.connected).toBe(false);
  });

  it('receives a burst of pushes as separate frames', async () => {
    const mock = createMockBluetooth();
    const t = new WebBluetoothTransport({ device: mock.device });
    const frames = collectFrames(t);
    await t.connect();
    const burst = [fromHex('83'), fromHex('88' + '11'.repeat(20)), new Uint8Array(176).fill(0x8a), fromHex('80')];
    for (const f of burst) mock.pushFrameToHost(f);
    mock.tx.notify(new Uint8Array(0)); // empty notification is ignored
    await until(() => frames.length === 4);
    expect(frames).toEqual(burst.map(toHex));
    await t.disconnect();
  });

  it('serializes concurrent writes (mock rejects overlapping GATT operations)', async () => {
    const mock = createMockBluetooth({ writeLatencyMs: 2 });
    const t = new WebBluetoothTransport({ device: mock.device });
    await t.connect();
    await Promise.all([1, 2, 3, 4].map((n) => t.send(Uint8Array.of(n))));
    expect(mock.framesFromHost.map(toHex)).toEqual(['01', '02', '03', '04']);
    await t.disconnect();
  });

  it('uses write-without-response only when the characteristic supports it', async () => {
    const mock = createMockBluetooth({ writeWithoutResponse: true });
    const t = new WebBluetoothTransport({ device: mock.device });
    await t.connect();
    await t.send(fromHex('01'));
    await t.disconnect();
    const t2 = new WebBluetoothTransport({ device: mock.device, preferWriteWithResponse: true });
    await t2.connect();
    await t2.send(fromHex('02'));
    await t2.disconnect();
    expect(mock.writeModes).toEqual(['without-response', 'with-response']);
  });

  it('rejects frames above 176 bytes before writing', async () => {
    const mock = createMockBluetooth();
    const t = new WebBluetoothTransport({ device: mock.device });
    await expect(t.send(fromHex('01'))).rejects.toThrow(/not connected/);
    await t.connect();
    await expect(t.send(new Uint8Array(177))).rejects.toThrow(/exceeds the 176-byte limit/);
    await expect(t.send(new Uint8Array(0))).rejects.toThrow(/empty/);
    await t.send(new Uint8Array(176));
    expect(mock.droppedWrites).toEqual([]);
    expect(mock.framesFromHost).toHaveLength(1);
    await t.disconnect();
  });

  it('reports an unexpected link loss and can reconnect', async () => {
    const mock = createMockBluetooth();
    const t = new WebBluetoothTransport({ device: mock.device });
    const errors: string[] = [];
    t.events.on('error', (e) => errors.push(e.message));
    const frames = collectFrames(t);
    await t.connect();
    mock.disconnectDevice();
    expect(t.state).toBe('disconnected');
    expect(errors).toEqual(['BLE device disconnected']);
    await expect(t.send(fromHex('01'))).rejects.toThrow(/not connected/);
    await t.connect();
    expect(mock.device.gatt.connectCount).toBe(2);
    mock.pushFrameToHost(fromHex('82'));
    await until(() => frames.length === 1);
    await t.disconnect();
    expect(errors).toHaveLength(1); // requested disconnect is not an error
  });

  it('a failed GATT connect leaves the transport disconnected', async () => {
    const mock = createMockBluetooth();
    mock.device.gatt.failNextConnect = new DOMException('Connection attempt failed.', 'NetworkError');
    const t = new WebBluetoothTransport({ device: mock.device });
    await expect(t.connect()).rejects.toThrow(/BLE connect failed/);
    expect(t.state).toBe('disconnected');
    await t.connect();
    expect(t.state).toBe('connected');
    await t.disconnect();
  });

  it('does not deliver notifications after disconnect', async () => {
    const mock = createMockBluetooth();
    const t = new WebBluetoothTransport({ device: mock.device });
    const frames = collectFrames(t);
    await t.connect();
    await t.disconnect();
    mock.tx.notifying = true;
    mock.device.gatt.connected = true;
    mock.tx.notify(fromHex('83'));
    expect(frames).toEqual([]);
  });
});
