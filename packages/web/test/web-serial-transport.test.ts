import { describe, expect, it } from 'vitest';
import { concatBytes, fromHex, toHex } from '@meshcore-web/core/util/bytes';
import { encodeSerialFrame } from '@meshcore-web/core/framing';
import { WebSerialTransport, type TransportState } from '@meshcore-web/core/transport';
import { createMockSerial } from '../src/testing/mock-serial.js';

import { collectFrames, stateReached } from './transport-helpers.js';

describe('WebSerialTransport + mock serial', () => {
  it('opens at 115200, sends "<" framed commands and receives ">" frames', async () => {
    // Echo device: replies to each command with [0x80 | code, ...body].
    const mock = createMockSerial({
      onFrameFromHost: (frame, dev) => dev.pushFrameToHost(concatBytes(Uint8Array.of(0x80 | frame[0]!), frame.subarray(1))),
      info: { usbVendorId: 0x239a, usbProductId: 0x8029 },
    });
    const t = new WebSerialTransport({ port: mock.port });
    const states: TransportState[] = [];
    t.events.on('state', (s) => states.push(s));
    const frames = collectFrames(t);
    await t.connect();
    expect(mock.port.openOptions).toEqual({ baudRate: 115200 });
    expect(t.info.name).toBe('USB serial 239a:8029');
    await t.send(fromHex('1603'));
    await t.send(fromHex('0a'));
    expect(toHex(Uint8Array.from(mock.port.bytesFromHost))).toBe('3c020016033c01000a');
    await frames.count(2);
    expect(frames.hex).toEqual(['9603', '8a']);
    await t.disconnect();
    expect(states).toEqual(['connecting', 'connected', 'disconnected']);
    expect(mock.port.isOpen).toBe(false);
    expect(mock.port.closeCount).toBe(1);
  });

  it('reassembles frames delivered in tiny chunks, with noise', async () => {
    const mock = createMockSerial({ chunkSize: 1 });
    const t = new WebSerialTransport({ port: mock.port });
    const frames = collectFrames(t);
    await t.connect();
    const big = new Uint8Array(176).map((_, i) => i);
    mock.pushBytesToHost(new TextEncoder().encode('noise\r\n'));
    mock.pushFrameToHost(fromHex('0501020304'));
    mock.pushFrameToHost(big);
    mock.pushFrameToHost(fromHex('83'));
    await frames.count(3);
    expect(frames.hex).toEqual(['0501020304', toHex(big), '83']);
    await t.disconnect();
  });

  it('delivers frames split across odd chunk sizes', async () => {
    const mock = createMockSerial({ chunkSize: 7 });
    const t = new WebSerialTransport({ port: mock.port });
    const frames = collectFrames(t);
    await t.connect();
    const payloads = [fromHex('00'), fromHex('0c112233445566778899aa'), fromHex('8a' + 'ee'.repeat(40))];
    mock.pushBytesToHost(concatBytes(...payloads.map((p) => encodeSerialFrame(p, { marker: 0x3e }))));
    await frames.count(3);
    expect(frames.hex).toEqual(payloads.map(toHex));
    await t.disconnect();
  });

  it('serializes concurrent sends in order', async () => {
    const mock = createMockSerial();
    const t = new WebSerialTransport({ port: mock.port });
    await t.connect();
    await Promise.all([1, 2, 3, 4, 5].map((n) => t.send(Uint8Array.of(n, n))));
    expect(mock.framesFromHost.map(toHex)).toEqual(['0101', '0202', '0303', '0404', '0505']);
    await t.disconnect();
  });

  it('rejects sends when disconnected or too large', async () => {
    const mock = createMockSerial();
    const t = new WebSerialTransport({ port: mock.port });
    await expect(t.send(fromHex('01'))).rejects.toThrow(/not connected/);
    await t.connect();
    await expect(t.send(new Uint8Array(177))).rejects.toThrow(/exceeds/);
    await t.disconnect();
  });

  it('can reconnect after a clean disconnect, without leftover partial data', async () => {
    const mock = createMockSerial();
    const t = new WebSerialTransport({ port: mock.port });
    const frames = collectFrames(t);
    await t.connect();
    mock.pushBytesToHost(fromHex('3e0500aabb')); // partial frame, then disconnect
    await mock.port.whenReaderIdle(); // the transport has consumed the partial frame
    await t.disconnect();
    await t.disconnect(); // idempotent
    await t.connect();
    mock.pushFrameToHost(fromHex('01'));
    await frames.count(1);
    expect(frames.hex).toEqual(['01']);
    expect(mock.port.openCount).toBe(2);
    await t.disconnect();
  });

  it('requests a port through the injected Serial when none is given', async () => {
    const mock = createMockSerial();
    const t = new WebSerialTransport({ serial: mock.serial });
    await t.connect();
    expect(t.port).toBe(mock.port);
    await t.disconnect();
    await WebSerialTransport.requestPort(mock.serial, [{ usbVendorId: 0x10c4 }]);
    expect(mock.serial.lastRequestOptions).toEqual({ filters: [{ usbVendorId: 0x10c4 }] });
  });

  it('fails connect cleanly when the chooser is cancelled or open fails', async () => {
    const mock = createMockSerial();
    mock.serial.cancelChooser = true;
    const t = new WebSerialTransport({ serial: mock.serial });
    await expect(t.connect()).rejects.toThrow(/failed to open/);
    expect(t.state).toBe('disconnected');
    await mock.port.open({ baudRate: 9600 }); // someone else holds it open
    const t2 = new WebSerialTransport({ port: mock.port });
    await expect(t2.connect()).rejects.toThrow(/failed to open/);
    expect(t2.state).toBe('disconnected');
  });

  it('reports unplug as an error and goes disconnected', async () => {
    const mock = createMockSerial();
    const t = new WebSerialTransport({ port: mock.port });
    const errors: string[] = [];
    t.events.on('error', (e) => errors.push(e.message));
    await t.connect();
    const disconnected = stateReached(t, 'disconnected');
    mock.unplug();
    await disconnected;
    expect(errors).toEqual(['serial device disconnected']);
    await expect(t.send(fromHex('01'))).rejects.toThrow(/not connected/);
    await t.disconnect();
  });
});
