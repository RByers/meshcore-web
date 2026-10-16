import { describe, expect, it } from 'vitest';
import { utf8Encode } from '../util/bytes.js';
import { decodeFrame } from '../protocol/decode.js';
import { encodeCommand } from '../protocol/encode.js';
import type { Command, DeviceFrame } from '../protocol/types.js';
import { ManualClock } from './clock.js';
import { basicScenario, emptyScenario, hashtagChannelSecret, scenarioKey } from './scenarios.js';

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function connect(s: ReturnType<typeof basicScenario>, clock: ManualClock) {
  const host = s.emulator.createLoopbackTransport();
  const got: DeviceFrame[] = [];
  const logRx: DeviceFrame[] = [];
  // every packet the radio hears is pushed as LOG_RX_DATA; kept apart from the other frames
  host.events.on('frame', (b) => {
    const f = decodeFrame(b);
    (f.kind === 'logRxData' ? logRx : got).push(f);
  });
  await host.connect();
  return {
    logRx,
    async send(cmd: Command): Promise<DeviceFrame[]> {
      await host.send(encodeCommand(cmd));
      await settle();
      return got.splice(0);
    },
    async advance(ms: number): Promise<DeviceFrame[]> {
      clock.advance(ms);
      await settle();
      return got.splice(0);
    },
  };
}

describe('basicScenario', () => {
  it('self + 3 chats + repeater + room + sensor; Public and #test channels; queued history', async () => {
    const clock = new ManualClock();
    const s = basicScenario({ clock });
    expect(s.emulator.publicKey).toEqual(s.keys.self);
    expect(s.emulator.contacts.map((c) => [c.name, c.type])).toEqual([
      ['Alice', 1],
      ['Bob', 1],
      ['Carol', 1],
      ['Hilltop Repeater', 2],
      ['Town Square', 3],
      ['Weather Station', 4],
    ]);
    expect(s.emulator.channels.slice(0, 3).map((c) => c.name)).toEqual(['Public', '#test', '']);
    expect(s.emulator.channels[1]?.secret).toEqual(hashtagChannelSecret('test'));

    const c = await connect(s, clock);
    expect((await c.send({ kind: 'appStart' }))[0]).toMatchObject({ kind: 'selfInfo', info: { name: 'Emulator' } });
    const msgs: DeviceFrame[] = [];
    for (;;) {
      const [f] = await c.send({ kind: 'syncNextMessage' });
      if (!f || f.kind === 'noMoreMessages') break;
      msgs.push(f);
    }
    expect(msgs.map((m) => m.code)).toEqual([0x10, 0x11, 0x10]); // V3 (app_target_ver 3 preset)
    expect(msgs[1]).toMatchObject({ senderName: 'Dave', route: { hops: 2 } });
    expect(msgs[2]).toMatchObject({ txtType: 2, authorPrefix: s.keys.carol.slice(0, 4) });
  });

  it('nodes answer: repeater login/status, sensor telemetry, Alice replies "pong"', async () => {
    const clock = new ManualClock();
    const s = basicScenario({ clock, history: false });
    const c = await connect(s, clock);
    await c.send({ kind: 'sendLogin', pubKey: s.keys.repeater, password: 'password' });
    expect((await c.advance(1000))[0]).toMatchObject({ kind: 'loginSuccess', isAdmin: true });
    await c.send({ kind: 'sendTelemetryReq', pubKey: s.keys.sensor });
    const tel = await c.advance(1000);
    expect(tel.map((f) => f.kind)).toContain('telemetryResponse');
    await c.send({ kind: 'sendTxtMsg', recipient: s.keys.alice, text: 'ping', timestamp: s.startSecs });
    const fs = await c.advance(2000);
    expect(fs.map((f) => f.kind)).toEqual(['sendConfirmed', 'msgWaiting']);
    const [reply] = await c.send({ kind: 'syncNextMessage' });
    expect(reply).toMatchObject({ kind: 'contactMsg', text: 'pong' });
  });

  it('contacts have increasing lastmod for since-filter tests', () => {
    const s = basicScenario({ clock: new ManualClock(), history: false });
    const mods = s.emulator.contacts.map((c) => c.lastMod);
    expect(mods).toEqual([...mods].sort((a, b) => a - b));
    expect(mods[0]).toBe(s.startSecs - 600);
  });

  it('keys are deterministic and avoid reserved first bytes', () => {
    expect(scenarioKey('alice')).toEqual(scenarioKey('alice'));
    expect(scenarioKey('alice')).not.toEqual(scenarioKey('bob'));
    expect(utf8Encode('x').length).toBe(1);
    expect([0x00, 0xff]).not.toContain(scenarioKey('alice')[0]);
  });

  it('emptyScenario is a fresh device with only Public', () => {
    const e = emptyScenario({ clock: new ManualClock(), seed: 1 });
    expect(e.contacts).toEqual([]);
    expect(e.channels.filter((c) => c.name).map((c) => c.name)).toEqual(['Public']);
  });
});
