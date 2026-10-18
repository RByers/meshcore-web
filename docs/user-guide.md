# MeshCore Web user guide

MeshCore Web is a companion app for [MeshCore](https://meshcore.co.uk/) radios that runs
entirely in your browser. It talks to a radio running **companion firmware** (USB or BLE
variant) over USB (Web Serial) or Bluetooth LE (Web Bluetooth). There is no server: your
contacts, messages and packet log are stored in this browser (IndexedDB), separately for each
radio you connect.

- [Requirements](#requirements)
- [Connecting](#connecting)
- [Messaging and contacts](#messaging-and-contacts)
- [Channels](#channels)
- [Map](#map)
- [Packet log and inspector](#packet-log-and-inspector)
- [Repeater, room server and sensor admin](#repeater-room-server-and-sensor-admin)
- [Device and app settings](#device-and-app-settings)
- [Installing the app (PWA)](#installing-the-app-pwa)
- [Troubleshooting](#troubleshooting)

## Requirements

- **Chrome or Edge** (or another Chromium browser) on desktop for USB; Chrome/Edge on
  desktop or Android for Bluetooth. Firefox and Safari do not implement Web Serial or Web
  Bluetooth; the app still opens there, and the **Emulator** works, but you cannot connect a
  radio.
- The page must be served over **HTTPS** or from `localhost` (browsers only expose these
  APIs in secure contexts).
- A MeshCore radio flashed with companion firmware: *USB companion* for a cable connection,
  *BLE companion* for Bluetooth. Repeater and room-server firmware cannot be used as a
  companion, but you can administer them over the mesh from here.

## Connecting

Open the app; the **Connect** page offers three options. The one you used last is
highlighted and marked "Last used".

### USB (Web Serial)

1. Plug the radio in with a data-capable USB cable.
2. Click **Connect via USB Serial**. Chrome shows a port chooser listing serial devices.
   Pick your radio (it usually shows as a CP210x, CH340/CH9102, or the board's own USB name,
   e.g. "nRF52 / RAK4631") and click **Connect**.
3. The app opens the port at 115200 baud, performs the companion handshake and syncs
   contacts and queued messages. The header chip turns green and shows the radio's name.

Chrome remembers the permission for that port. Next time, the radio appears under
**Previously connected** and **Reconnect** opens it without the chooser (as long as the same
port is plugged in). You can revoke the permission from the site settings (padlock icon →
Site settings → Serial ports).

Only one program can hold a serial port. Close other MeshCore apps, serial monitors or
flashing tools first.

#### Linux notes

- Your user needs read/write access to the serial device (`/dev/ttyUSB*` or
  `/dev/ttyACM*`). On Debian/Ubuntu/Fedora add yourself to the `dialout` group
  (`sudo usermod -aG dialout $USER`, on Arch the group is `uucp`), then log out and back in.
- Alternatively, a udev rule grants access to just your radio, e.g.
  `/etc/udev/rules.d/99-meshcore.rules`:

  ```
  # CP210x; adjust idVendor/idProduct to your board (see `lsusb`)
  SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", ATTRS{idProduct}=="ea60", MODE="0666", ENV{ID_MM_DEVICE_IGNORE}="1"
  ```

  then `sudo udevadm control --reload-rules && sudo udevadm trigger`.
- `ModemManager` may probe new serial devices and garble the first seconds of traffic;
  the `ID_MM_DEVICE_IGNORE` flag above stops that (or disable ModemManager if you do not
  use a mobile modem).
- Chromium installed as a **snap** cannot see serial ports until you run
  `sudo snap connect chromium:raw-usb`. The Chrome `.deb`/`.rpm` package has no such
  restriction.

### Bluetooth (Web Bluetooth)

1. Make sure Bluetooth is on and the radio is running BLE companion firmware and not
   connected to another phone or app (a MeshCore radio accepts one BLE connection at a
   time).
2. Click **Connect via Bluetooth**. Chrome shows a device chooser filtered to MeshCore
   radios (Nordic UART service or a `MeshCore` name prefix). Pick yours and click **Pair**.
3. The first time, your operating system may ask for a **pairing PIN**. Use the PIN shown on
   the radio's screen, or the PIN configured for the radio (many builds default to
   `123456`).

Notes:

- On **Android**, Chrome needs the Location/Nearby devices permission for Bluetooth scanning;
  accept the prompt.
- On **Linux**, Web Bluetooth needs BlueZ 5.41+; if the Bluetooth option says it is not
  available, enable `chrome://flags/#enable-experimental-web-platform-features`.
- Web Bluetooth does not let a page reconnect silently to a remembered device in all
  browsers, so **Reconnect** for a Bluetooth radio may show the chooser again.

### Emulator

**Start emulator** runs a simulated companion radio inside the page with a small virtual
mesh: chat contacts (Alice, Bob, and Carol behind a repeater), "Hilltop Repeater", the
"Town Square" room server and the "Weather Station" sensor, all answering with real MeshCore
packets and real cryptography. Nothing is transmitted. Use it to explore the app, try the
packet inspector, or practise admin (the emulated nodes' admin password is `password`). Data from the emulator is
stored like any other radio, under the emulator's own key.

### Disconnecting

**Disconnect** in the header closes the link and returns to Connect. If the cable is pulled
or the radio resets, the app shows an error toast and returns to Connect; use
**Reconnect** to resume. Your data stays in the browser.

While a radio is connected, the Connect tab shows only that connection (name, transport)
with a **Disconnect** button; disconnect first to connect to a different radio.

## Messaging and contacts

- **Messages** lists recent direct messages and channels with unread counts.
- **Contacts** lists the contacts stored on the radio, with type icons (chat, repeater,
  room, sensor), last heard, route (direct with hop count, or flood) and SNR. Search,
  filter by type or unread, and sort. The actions menu per contact offers chat, admin (for
  repeaters/rooms/sensors), share, set path, reset path and remove.
- **Set path** (contacts menu, or a contact's **Path** tab): shows the current route with repeater
  names and a **Reset path** button, lets you build a hop list from the known repeaters (search the list, or tap them on
  the map) or switch to flood, and lists previously used paths with how many messages each
  delivered; **Use** switches back to one.
- **Add a contact** from a `meshcore://` share link or a public key. Contacts also appear
  when their adverts are heard (unless the radio's auto-add is off; see Settings).
- **Chat**: type and send; the counter shows the remaining bytes (a MeshCore text message
  holds about 160 bytes, measured in UTF-8). Status shows pending → sent → delivered (✓✓
  with round-trip time) or failed (with **Retry**). A message to a contact with no known
  route is flooded; once a path comes back the header switches to the hop count.
- Reply to a message to quote its sender (`@[name]` convention used by other MeshCore apps).

## Channels

**Channels** lists the radio's channel slots. The **Public** channel exists by default.

- **Add** a channel by name and pre-shared key (hex or base64), or join a **#hashtag**
  channel: its key is derived from the name, so everyone who joins `#hiking` can read it.
- **Edit** a channel's name/key, **mute** it (no unread badge), or **delete** it (frees the
  slot on the radio).
- Channel messages use the `sender: text` convention and show the sender's name. Anyone
  with the key can read a channel; use a random key for a private group.

## Map

**Map** shows contacts that advertised a location, plus this radio's own position (set in
Settings → Identity; the app never uses your browser's GPS for this). Drag or swipe to pan,
scroll/pinch or use the +/− buttons (and arrow / `+` / `-` keys when the map is focused) to
zoom. Click a marker for its details, distance and bearing from you, and links to chat or
admin. Filter by node type and by how recently the node was heard.

Map tiles come from OpenStreetMap by default and are downloaded by your browser directly
from `tile.openstreetmap.org` (so that server sees your IP address and the area you view).
Under **Tile source** you can enter another XYZ template (`https://…/{z}/{x}/{y}.png`), for
example your own tile server. Tiles are not stored for offline use.

## Packet log and inspector

The radio reports every packet it hears while the app is connected (and the app logs every
frame exchanged with it). **Packets** shows them live:

- **Packets** tab: time, direction (↓ rx received, ↑ tx sent), type, route, path/hops,
  SNR/RSSI, size and a summary. Filter by direction (all / rx / tx), type, node and time.
  Click a row to open the **inspector**: a hex dump and a tree explaining every byte (header
  bits, path, payload fields); hovering a field highlights its bytes and vice versa, and shows a
  tooltip explaining the field from the protocol specification (dotted-underlined names have one).
- **Sent packets** (tx) are logged when the app asks the radio to transmit (messages, channel
  posts, adverts, logins and requests, traces, raw data). The radio does not report what it
  actually put on air, so for packets it builds and encrypts itself (DMs, channel messages,
  adverts, requests) the entry shows what was requested and has no bytes (size "—"); for
  traces, raw data and raw packets the bytes are the ones the app supplied.
  Each sent entry also records what happened to it: pending (no answer from the radio yet),
  sent (the radio accepted it; for DMs and requests also whether it went flood or direct, which
  fills in the route, and the timeout it expects), failed (the radio refused it, with the
  reason) or, for DMs, confirmed when the recipient's ACK came back (with the round-trip time).
  The row shows it next to "↑ tx": `…` pending, `✓` sent, `✓✓ 1.2 s` confirmed (round trip),
  `✗ NOT_FOUND` failed, and `no ACK` for a DM still unconfirmed after the radio's estimated
  timeout (hover for details). The inspector's **Send** entry lists the route, ACK tag,
  estimated timeout, how long the radio took to answer, when the ACK arrived and any error.
  Because the packet log is kept and frames are not, it is the lasting record of what you sent:
  the first time a radio is connected with this version, sends found in its older frame log
  are added to the packet log (with their outcome) in the background.
- Messages the radio received while no app was connected (delivered later from its message
  queue) have no packet in the log: the radio only reports packets as it hears them.
- Direct messages show as `TXT_MSG sender → recipient (encrypted)` unless the radio key is
  stored (below), in which case the row shows the text.
- **Frames** tab: the raw host↔radio companion-protocol frames.
- **Export** / **Import** the log as JSON; **Clear** deletes it. Packets are kept forever by
  default; set a retention in Settings to remove older ones.
- Channel messages are decrypted automatically when you have that channel's key.

### Decrypting direct messages (optional)

Direct messages are encrypted to the recipient's key. To see the plaintext of DMs to or from
your radio in the inspector, the app needs your **radio's private key**. **Decrypt DMs…**
(or Settings → App → "Store an exported private key") exports it from the radio and stores
it in this browser.

Risks — read before enabling:

- Anyone with that key can impersonate your radio and read its direct messages. It is
  stored unencrypted in this browser's IndexedDB for this site; anyone with access to this
  browser profile (or malware, or a browser extension with access to the site) can read it.
- Do not enable it on shared or untrusted computers.
- The key cannot be "rotated" without generating a new identity on the radio.

It is off by default. **Forget radio key** (Packets) or unticking the setting deletes the
stored key for the connected radio.

## Repeater, room server and sensor admin

Open a repeater, room server or sensor from **Contacts** (actions → Admin) or from the map.

- **Login** with the node's admin password (or guest password where supported). The app can
  remember the password in this browser.
- **Overview**: status (uptime, battery, airtime, queue, packet counters, noise floor, last
  SNR/RSSI) and owner info.
- **Telemetry**: Cayenne LPP sensor readings, and min/max/average over the last hour for
  sensors.
- **CLI**: send firmware CLI commands (`ver`, `get radio`, `set name …`, `neighbors`, …)
  and see replies; the field autocompletes known commands.
- **Tools**: trace path, path discovery, reset path, neighbours list, access list (ACL).
- **Messages** (room servers): read and post to the room.

Remote requests go over the mesh and can take several seconds or time out on a busy or
distant path; the app runs one remote request at a time, as the firmware requires.

## Device and app settings

**Device** shows the connected radio's identity, firmware and status. **Settings** has:

- **Identity**: name, latitude/longitude (or "use my location" to fill them once).
- **Radio**: frequency, bandwidth, spreading factor, coding rate, TX power; regional presets.
  All nodes in a mesh must use the same radio settings. Changing them asks for confirmation.
- **Adverts**: send an advert now (flood or zero-hop), advert interval and location sharing.
- **Device**: battery, storage, stats, clock drift with **Sync time**, BLE PIN.
- **Contacts**: auto-add policy and telemetry permissions.
- **Advanced**: tuning, export/import private key, reboot, factory reset (requires typing a
  confirmation).
- **App** (works without a radio): theme (system/light/dark), time format, packet-log
  retention, and the stored-private-key option.
- **About**: app version, build date, source link, licence and credits.

## Installing the app (PWA)

In Chrome/Edge, when the site is installable an **Install app** button appears on the
Settings page (you can also use the install icon in the address bar or the browser menu →
"Install MeshCore Web"). The installed app opens in its own window. After the first visit
the app shell is cached by a service worker, so the app opens without a network
connection; connecting a radio over USB/Bluetooth needs no internet either. Map tiles do
need a network connection. New versions are picked up automatically on the next load.

## Troubleshooting

| Problem | What to try |
|---|---|
| "Web Serial / Web Bluetooth is not available" | Use Chrome or Edge, over HTTPS or `localhost`. On iOS no browser supports these APIs. |
| The USB chooser is empty | Check the cable carries data; install the CP210x/CH34x driver on Windows/macOS if needed; on Linux check the `dialout` group / udev rule and the snap note above. |
| "Failed to open serial port" | Another program (other app, serial monitor, flasher, a second browser tab) has the port. Close it and retry. |
| Connected but the handshake times out | Make sure the radio runs **companion** firmware (not repeater/room server) and the matching variant (USB vs BLE). Reset the radio and reconnect. |
| Bluetooth radio not listed | The radio may already be connected to a phone; disconnect it there. Move closer; check OS Bluetooth is on. On Android grant the Nearby devices permission. |
| Bluetooth pairing fails | Remove the radio from the OS Bluetooth settings and pair again with the correct PIN. |
| Messages stay "sent" and never "delivered" | The recipient may be out of range or its path stale: **reset path** on the contact and resend (it will flood). |
| Map is blank | Tiles need internet access; check the **Tile source** template. Nodes appear only if they advertise a location. |
| An error toast "Something went wrong" | An unexpected error happened; details are in the browser console. Reloading the page is safe (data is in IndexedDB). Please report it with the console output. |
| Start over | Settings → site data in Chrome (padlock → Site settings → Delete data) clears all stored radios, messages and logs for this site. |
