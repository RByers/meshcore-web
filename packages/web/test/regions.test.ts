import { afterEach, describe, expect, it } from 'vitest';
import { toHex } from '@meshcore-web/core/util/bytes';
import { channelKeyForPsk } from '@meshcore-web/core/store';
import { publicChannelSecret } from '@meshcore-web/core/emulator';
import { RouteType, matchRegionCode, parsePacket, type ParsedPacket } from '@meshcore-web/core/packet';
import { regionKeySync } from '@meshcore-web/core/app';
import '../src/mc-app.js';
import '../src/pages/messaging/index.js';
import { createHarness, type Harness } from '../src/testing/harness.js';

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function connected(): Promise<Harness> {
  const t = (h = createHarness());
  await t.mount();
  await t.click('[data-connect="emulator"]');
  await t.until(() => t.app.connection.phase.value === 'connected', 5000, 'connected');
  await t.app.connection.capture!.idle();
  return t;
}

function savedRegions(t: Harness): string[] {
  return t.queryAll('[data-section="regions"] [data-region]').map((e) => e.dataset['region'] ?? '');
}

/** GRP_TXT packets the radio put on air from `start` on. */
function sentGroupPackets(t: Harness, start: number): ParsedPacket[] {
  return t
    .emulatorScenario()
    .emulator.airLog.slice(start)
    .filter((e) => e.type === 'grpTxt')
    .map((e) => parsePacket((e as unknown as { raw: Uint8Array }).raw));
}

/** The saved region whose key gives the packet's transport code. */
function packetRegionName(p: ParsedPacket, names: string[]): string | null {
  const keys = new Map(names.map((n) => [n, regionKeySync(n)]));
  return matchRegionCode(keys, p.transportCodes![0], p.payloadType, p.payload);
}

describe('Settings: Regions card', () => {
  it('edits the saved list without a radio, validates names and keeps it across a reload', async () => {
    const t = (h = createHarness());
    await t.mount();
    location.hash = '#/settings';
    await t.until(() => t.query('[data-section="regions"]'), 2000, 'regions card');
    expect(t.query('[data-field="no-regions"]')).not.toBeNull();
    expect(t.query('[data-section="regions"] [data-action="fetch-regions"]')).toBeNull();

    await t.fill('[data-form="add-region"] input[name="region"]', 'East Side');
    await t.click('[data-action="add-region"]');
    await t.until(() => t.query('[data-error="region"]'), 2000, 'validation error');
    expect(t.query('[data-error="region"]')!.textContent).toMatch(/lowercase/);
    expect(t.query('[data-form="add-region"] input')!.getAttribute('aria-invalid')).toBe('true');

    await t.fill('[data-form="add-region"] input[name="region"]', '#east');
    await t.click('[data-action="add-region"]');
    await t.until(() => savedRegions(t).includes('east'), 2000, 'east saved');
    expect(t.query('[data-error="region"]')).toBeNull();
    expect(t.query<HTMLInputElement>('[data-form="add-region"] input')!.value).toBe('');
    await t.fill('[data-form="add-region"] input[name="region"]', 'west');
    await t.click('[data-action="add-region"]');
    await t.until(() => savedRegions(t).length === 2, 2000, 'west saved');
    await t.fill('[data-form="add-region"] input[name="region"]', 'east');
    await t.click('[data-action="add-region"]');
    await t.until(() => t.query('[data-error="region"]')?.textContent?.includes('already saved'), 2000, 'duplicate');

    await t.reload();
    location.hash = '#/settings';
    await t.until(() => savedRegions(t).length === 2, 2000, 'list after reload');
    expect(savedRegions(t)).toEqual(['east', 'west']);
    await t.click('[data-region="east"] [data-action="remove-region"]');
    await t.until(() => savedRegions(t).join() === 'west', 2000, 'east removed');
    expect(t.app.regions.names.value).toEqual(['west']);
  });

  it('offers the saved regions for the default flood scope', async () => {
    const t = await connected();
    t.app.regions.addAll(['west', 'east']);
    await t.go('/settings', '[data-form="flood-scope"] input[name="scope"]');
    await t.until(() => t.queryAll('datalist#saved-regions option').length === 2, 2000, 'datalist');
    expect(t.queryAll('datalist#saved-regions option').map((o) => o.getAttribute('value'))).toEqual(['east', 'west']);
    expect(t.query('[data-form="flood-scope"] input[name="scope"]')!.getAttribute('list')).toBe('saved-regions');
  });
});

describe('Node page: Fetch regions', () => {
  it("lists a repeater's regions with per-name add and Add all", async () => {
    const t = await connected();
    t.emulatorScenario().nodes.repeater.remote.config.regions = ['north', 'south'];
    const rep = toHex(t.emulatorScenario().keys.repeater);
    await t.go(`/node/${rep}/tools`, '[data-card="regions"] [data-action="fetch-regions"]');
    await t.click('[data-card="regions"] [data-action="fetch-regions"]');
    await t.until(() => t.queryAll('[data-field="regions-result"] [data-region]').length === 2, 5000, 'regions result');
    await t.click('[data-field="regions-result"] [data-region="south"] [data-action="add-region"]');
    expect(t.app.regions.names.value).toEqual(['south']);
    await t.until(() => t.query('[data-region="south"] [data-field="saved"]'), 2000, 'south saved');
    await t.click('[data-action="add-all-regions"]');
    expect(t.app.regions.names.value).toEqual(['north', 'south']);
    await t.until(() => t.query<HTMLButtonElement>('[data-action="add-all-regions"]')?.disabled, 2000, 'all saved');
  });
});

describe('Channel chat: region picker', () => {
  async function openPublic(t: Harness): Promise<string> {
    const pub = await channelKeyForPsk(publicChannelSecret());
    await t.go(`/channel/${pub}`, '[data-action="region"]');
    return pub;
  }

  async function pick(t: Harness, option: string): Promise<void> {
    await t.click('[data-action="region"]');
    await t.until(() => t.query<HTMLDialogElement>('#channel-region')?.open, 2000, 'region dialog');
    await t.click(`[data-region-option="${option}"] input`);
    await t.click('[data-action="region-save"]');
  }

  it('picks a region: chip, TRANSPORT_FLOOD on air with the scope reset after, #region tag; default follows the radio', async () => {
    const t = await connected();
    t.app.regions.add('east');
    await openPublic(t);
    expect(t.query('[data-action="region"]')!.textContent!.trim()).toBe('No region');

    await t.click('[data-action="region"]');
    await t.until(() => t.query<HTMLDialogElement>('#channel-region')?.open, 2000, 'region dialog');
    const options = t.queryAll('#channel-region [data-region-option]').map((e) => e.dataset['regionOption']);
    expect(options).toEqual(['default', '!unscoped', 'east']);
    expect(t.query('[data-action="manage-regions"]')!.getAttribute('href')).toBe('#/settings');
    await t.click('[data-region-option="east"] input');
    await t.click('[data-action="region-save"]');
    await t.until(() => t.query('[data-action="region"]')!.textContent!.trim() === '#east', 2000, 'chip #east');

    const start = t.emulatorScenario().emulator.airLog.length;
    await t.fill('[data-field="composer"]', 'scoped hello');
    await t.click('[data-action="send"]');
    await t.until(() => t.query('.msg[data-dir="out"][data-status="sent"]'), 5000, 'sent');
    const [p] = sentGroupPackets(t, start);
    expect(p!.routeType).toBe(RouteType.TRANSPORT_FLOOD);
    expect(packetRegionName(p!, ['east'])).toBe('east');
    expect(t.emulatorScenario().emulator.floodScope.key.every((b) => b === 0)).toBe(true);
    expect(t.query('.msg[data-dir="out"] [data-field="region"]')!.textContent).toBe('#east');

    await t.app.deviceSettings.setDefaultFloodScope('home');
    await pick(t, 'default');
    await t.until(() => t.query('[data-action="region"]')!.textContent!.trim() === '#home (radio default)', 2000, 'chip default');
    await pick(t, '!unscoped');
    await t.until(() => t.query('[data-action="region"]')!.textContent!.trim() === 'No region', 2000, 'chip unscoped');

    // the choice is stored on the channel and survives a reload
    await pick(t, 'east');
    await t.until(() => t.query('[data-action="region"]')!.textContent!.trim() === '#east', 2000, 'chip #east again');
    await t.reload();
    await t.click('[data-connect="emulator"]');
    await t.until(() => t.app.connection.phase.value === 'connected', 5000, 'reconnected');
    await openPublic(t);
    await t.until(() => t.query('[data-action="region"]')!.textContent!.trim() === '#east', 2000, 'chip after reload');
  });

  it('a reply goes out in the quoted message\'s region unless "in #region" is unticked', async () => {
    const t = await connected();
    t.app.regions.add('east');
    await openPublic(t);
    await pick(t, 'east');
    await t.until(() => t.query('[data-action="region"]')!.textContent!.trim() === '#east', 2000, 'chip #east');
    await t.fill('[data-field="composer"]', 'first');
    await t.click('[data-action="send"]');
    await t.until(() => t.query('.msg[data-dir="out"][data-status="sent"] [data-field="region"]'), 5000, 'sent in east');
    await pick(t, '!unscoped');
    await t.until(() => t.query('[data-action="region"]')!.textContent!.trim() === 'No region', 2000, 'chip unscoped');

    await t.click('.msg[data-dir="out"] [data-action="reply"]');
    await t.until(() => t.query('[data-field="reply-in-region"]'), 2000, 'reply toggle');
    const box = t.query<HTMLInputElement>('[data-field="reply-in-region"]')!;
    expect(box.checked).toBe(true);
    expect(box.closest('label')!.textContent).toContain('in #east');
    let start = t.emulatorScenario().emulator.airLog.length;
    await t.fill('[data-field="composer"]', 'reply in east');
    await t.click('[data-action="send"]');
    await t.until(() => sentGroupPackets(t, start).length === 1, 5000, 'reply sent');
    let p = sentGroupPackets(t, start)[0]!;
    expect(p.routeType).toBe(RouteType.TRANSPORT_FLOOD);
    expect(packetRegionName(p, ['east'])).toBe('east');

    await t.click('.msg[data-dir="out"] [data-action="reply"]');
    await t.until(() => t.query('[data-field="reply-in-region"]'), 2000, 'reply toggle again');
    await t.click('[data-field="reply-in-region"]');
    expect(t.query<HTMLInputElement>('[data-field="reply-in-region"]')!.checked).toBe(false);
    start = t.emulatorScenario().emulator.airLog.length;
    await t.fill('[data-field="composer"]', 'reply everywhere');
    await t.click('[data-action="send"]');
    await t.until(() => sentGroupPackets(t, start).length === 1, 5000, 'second reply sent');
    p = sentGroupPackets(t, start)[0]!;
    expect(p.routeType).toBe(RouteType.FLOOD);
  });
});
