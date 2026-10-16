/**
 * Remote CLI command reference for repeaters / room servers / sensors (autocomplete and help).
 *
 * Derived (read-only) from firmware companion-v1.18.0:
 *  - `src/helpers/CommonCLI.cpp` `handleCommand` / `handleGetCmd` / `handleSetCmd` / `handleRegionCmd`
 *  - `src/helpers/CommonRadioPrefs.cpp` (radio / tx / delays / af / multi.acks …)
 *  - `examples/simple_repeater/MyMesh.cpp` (`setperm`, `get acl`, `discover.neighbors`)
 *  - `examples/simple_room_server/MyMesh.cpp` (`room.post`)
 *  - `docs/cli_commands.md` for argument descriptions.
 * CLI commands are only accepted from admins (they arrive as TXT_MSG CLI_DATA, unacknowledged).
 */

export type CliNodeKind = 'repeater' | 'room' | 'sensor';

export interface CliCommandDef {
  /** The literal command text to complete to (arguments as `<placeholders>`). */
  usage: string;
  description: string;
  /** Node kinds that implement it (default: all). */
  only?: readonly CliNodeKind[];
  /** Firmware `get` / `set` pair (the key after "get "/"set "). */
  pref?: string;
}

const R: readonly CliNodeKind[] = ['repeater'];
const ROOM: readonly CliNodeKind[] = ['room'];

/** Read/write preferences (`get <key>` / `set <key> <value>`). */
const PREFS: ReadonlyArray<{ key: string; value: string; description: string; readOnly?: boolean; only?: readonly CliNodeKind[] }> = [
  { key: 'name', value: '<name>', description: 'Node name' },
  { key: 'lat', value: '<degrees>', description: 'Advertised latitude' },
  { key: 'lon', value: '<degrees>', description: 'Advertised longitude' },
  { key: 'radio', value: '<freq>,<bw>,<sf>,<cr>', description: 'Radio parameters (MHz, kHz, SF 5-12, CR 5-8; reboot to apply)' },
  { key: 'freq', value: '<MHz>', description: 'Frequency' },
  { key: 'tx', value: '<dBm>', description: 'Transmit power' },
  { key: 'radio.rxgain', value: 'on|off', description: 'RX boosted gain' },
  { key: 'af', value: '<factor>', description: 'Airtime factor (duty cycle budget)' },
  { key: 'dutycycle', value: '<percent>', description: 'Duty cycle limit' },
  { key: 'rxdelay', value: '<base>', description: 'RX delay base (flood re-transmit scoring)' },
  { key: 'txdelay', value: '<factor>', description: 'Flood TX delay factor' },
  { key: 'direct.txdelay', value: '<factor>', description: 'Direct TX delay factor' },
  { key: 'int.thresh', value: '<dB>', description: 'Interference threshold' },
  { key: 'cad', value: '<n>', description: 'Channel activity detection setting' },
  { key: 'agc.reset.interval', value: '<secs>', description: 'AGC reset interval' },
  { key: 'multi.acks', value: '0|1', description: 'Send extra (multipart) ACKs' },
  { key: 'path.hash.mode', value: '0|1|2', description: 'Path hash size mode (1-3 bytes per hop)' },
  { key: 'repeat', value: 'on|off', description: 'Packet forwarding' },
  { key: 'allow.read.only', value: 'on|off', description: 'Allow read-only guest logins' },
  { key: 'guest.password', value: '<password>', description: 'Guest password' },
  { key: 'advert.interval', value: '<minutes>', description: 'Zero-hop advert interval' },
  { key: 'flood.advert.interval', value: '<hours>', description: 'Flood advert interval' },
  { key: 'flood.max', value: '<hops>', description: 'Max flood hops forwarded' },
  { key: 'flood.max.advert', value: '<hops>', description: 'Max flood hops for adverts' },
  { key: 'flood.max.unscoped', value: '<hops>', description: 'Max flood hops for unscoped packets' },
  { key: 'loop.detect', value: 'off|minimal|moderate|strict', description: 'Flood loop detection' },
  { key: 'owner.info', value: '<text>', description: 'Owner info (GET_OWNER_INFO)' },
  { key: 'extra.sf', value: '<sf,…>', description: 'Extra spreading factors' },
  { key: 'adc.multiplier', value: '<factor>', description: 'Battery ADC calibration' },
  { key: 'bridge.enabled', value: 'on|off', description: 'Bridge enabled' },
  { key: 'bridge.delay', value: '<ms>', description: 'Bridge delay' },
  { key: 'bridge.source', value: 'rx|tx', description: 'Bridge packet source' },
  { key: 'bridge.baud', value: '<baud>', description: 'RS232 bridge baud rate' },
  { key: 'bridge.channel', value: '<n>', description: 'ESP-NOW bridge channel' },
  { key: 'bridge.secret', value: '<secret>', description: 'ESP-NOW bridge secret' },
  { key: 'prv.key', value: '<hex>', description: 'Private key (takes effect after reboot)' },
  { key: 'public.key', value: '', description: 'Public key', readOnly: true },
  { key: 'role', value: '', description: 'Firmware role', readOnly: true },
  { key: 'bridge.type', value: '', description: 'Bridge type', readOnly: true },
  { key: 'bootloader.ver', value: '', description: 'Bootloader version', readOnly: true },
  { key: 'pwrmgt.support', value: '', description: 'Power management support', readOnly: true },
  { key: 'pwrmgt.source', value: '', description: 'Power source', readOnly: true },
  { key: 'pwrmgt.bootreason', value: '', description: 'Boot / shutdown reason', readOnly: true },
  { key: 'pwrmgt.bootmv', value: '', description: 'Boot voltage', readOnly: true },
  { key: 'acl', value: '', description: 'Access control list', readOnly: true, only: R },
];

const COMMANDS: readonly CliCommandDef[] = [
  { usage: 'ver', description: 'Firmware version and build date' },
  { usage: 'board', description: 'Hardware / manufacturer name' },
  { usage: 'power', description: 'Battery, USB, solar and charger state' },
  { usage: 'clock', description: 'Current node time (UTC)' },
  { usage: 'clock sync', description: "Set the node clock from this client's time" },
  { usage: 'time <epoch_secs>', description: 'Set the node clock (cannot go backwards)' },
  { usage: 'advert', description: 'Send a flood advert' },
  { usage: 'advert.zerohop', description: 'Send a zero-hop advert' },
  { usage: 'neighbors', description: 'List zero-hop neighbours', only: R },
  { usage: 'neighbor.remove <pubkey_prefix>', description: 'Remove neighbours matching a key prefix', only: R },
  { usage: 'discover.neighbors', description: 'Discover zero-hop neighbours', only: R },
  { usage: 'setperm <pubkey_hex> <perms>', description: 'Set ACL permissions for a client (0 guest … 3 admin)', only: R },
  { usage: 'room.post <text>', description: 'Post a message as the room server', only: ROOM },
  { usage: 'stats-core', description: 'Battery, uptime, queue, error flags' },
  { usage: 'stats-radio', description: 'Noise floor, last RSSI/SNR, airtime, RX errors' },
  { usage: 'stats-packets', description: 'Packet counters' },
  { usage: 'clear stats', description: 'Reset statistics' },
  { usage: 'log start', description: 'Begin capturing the RX log to storage' },
  { usage: 'log stop', description: 'Stop capturing the RX log' },
  { usage: 'log erase', description: 'Erase the captured log' },
  { usage: 'log', description: 'Dump the captured log (serial only)' },
  { usage: 'password <new_password>', description: 'Change the admin password' },
  { usage: 'tempradio <freq>,<bw>,<sf>,<cr>,<timeout_mins>', description: 'Temporary radio parameters' },
  { usage: 'region', description: 'Show the region table' },
  { usage: 'region list allowed', description: 'Regions with flood allowed' },
  { usage: 'region list denied', description: 'Regions with flood denied' },
  { usage: 'region get <name>', description: 'Show one region' },
  { usage: 'region put <name> <parent>', description: 'Add a region' },
  { usage: 'region remove <name>', description: 'Remove a region' },
  { usage: 'region allowf <name>', description: 'Allow flood for a region' },
  { usage: 'region denyf <name>', description: 'Deny flood for a region' },
  { usage: 'region home', description: 'Show the home region' },
  { usage: 'region home <name>', description: 'Set the home region' },
  { usage: 'region default', description: 'Show the default scope' },
  { usage: 'region default <name>', description: 'Set the default scope (<null> clears)' },
  { usage: 'region load', description: 'Reload the region table' },
  { usage: 'region save', description: 'Save the region table' },
  { usage: 'gps', description: 'GPS status (GPS builds)' },
  { usage: 'gps on', description: 'Enable GPS' },
  { usage: 'gps off', description: 'Disable GPS' },
  { usage: 'gps sync', description: 'Sync the clock from GPS' },
  { usage: 'gps setloc', description: 'Use the GPS position as the advert location' },
  { usage: 'gps advert none|share|prefs', description: 'Location policy in adverts' },
  { usage: 'sensor list', description: 'List sensor settings' },
  { usage: 'sensor get <key>', description: 'Read a sensor setting' },
  { usage: 'sensor set <key> <value>', description: 'Change a sensor setting' },
  { usage: 'powersaving', description: 'Power saving state' },
  { usage: 'powersaving on', description: 'Enable power saving' },
  { usage: 'powersaving off', description: 'Disable power saving' },
  { usage: 'start ota', description: 'Start an OTA firmware update' },
  { usage: 'reboot', description: 'Reboot the node' },
  { usage: 'clkreboot', description: 'Reset the clock and reboot' },
  { usage: 'poweroff', description: 'Power off the node' },
];

/** Every command, `get`/`set` pref pairs included. */
export const REMOTE_CLI_COMMANDS: readonly CliCommandDef[] = [
  ...COMMANDS,
  ...PREFS.flatMap((p): CliCommandDef[] => {
    const base = p.only ? { only: p.only } : {};
    const get: CliCommandDef = { usage: `get ${p.key}`, description: p.description, pref: p.key, ...base };
    if (p.readOnly) return [get];
    return [get, { usage: `set ${p.key} ${p.value}`, description: `Set: ${p.description.toLowerCase()}`, pref: p.key, ...base }];
  }),
];

/** Quick commands shown as buttons in the CLI tab. */
export const QUICK_CLI_COMMANDS: readonly string[] = ['ver', 'clock', 'get name', 'get radio', 'get tx', 'neighbors', 'stats-core', 'advert', 'clock sync'];

/** Commands available on `kind` (all when undefined). */
export function cliCommandsFor(kind?: CliNodeKind): CliCommandDef[] {
  return REMOTE_CLI_COMMANDS.filter((c) => !kind || !c.only || c.only.includes(kind));
}

/**
 * Autocomplete: commands whose usage starts with the typed text (case-insensitive), then those that
 * merely contain it (queries of 3+ characters). The completion text is the usage up to its first `<placeholder>`.
 */
export function completeCliCommand(input: string, kind?: CliNodeKind, limit = 12): Array<CliCommandDef & { completion: string }> {
  const q = input.trimStart().toLowerCase();
  if (!q) return [];
  const all = cliCommandsFor(kind);
  const starts = all.filter((c) => c.usage.toLowerCase().startsWith(q));
  // substring matches only once the query is specific enough to be useful
  const contains = q.length < 3 ? [] : all.filter((c) => !starts.includes(c) && c.usage.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, limit).map((c) => {
    const i = c.usage.indexOf('<');
    const alt = c.usage.search(/ \S+\|/);
    const cut = [i, alt >= 0 ? alt + 1 : -1].filter((n) => n >= 0);
    return { ...c, completion: cut.length ? c.usage.slice(0, Math.min(...cut)) : c.usage };
  });
}
