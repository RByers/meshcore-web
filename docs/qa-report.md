# QA report: hands-on browser pass (2026-10-16)

The app was driven as a user in real Chrome through the chrome-devtools MCP, using the
in-page **Emulator** connection. The pass was cut short when the coordinator asked for a
wrap-up after about 3 hours. Sections marked *not covered* were not exercised.

## Environment notes

- `npm run dev` (port 5180) is not a stable target while other agents edit files. Each edit
  triggers a Vite full reload (Lit custom elements cannot hot-swap), which drops the emulator
  session and sends you back to Connect. Most of the pass therefore ran against a production
  build served by `vite preview` on port 5181.
- Because 5181 is a different origin from 5180, its IndexedDB started empty. That gave a clean
  first run.

## What was tested

| Area | Covered | Result |
|---|---|---|
| Connect → Emulator; "Previously connected" + Reconnect | yes | OK |
| Messages overview (unread badges, previews) | yes | OK (preview bug fixed, see below) |
| Contacts: search, type/unread filters, sort, actions menu, Share/Export dialog | yes | OK |
| Alice DM: send, pending → sent → delivered (✓✓ + RTT), reply affordance, byte counter (UTF-8 aware) | yes | OK (bubble bug fixed) |
| Carol DM (via repeater): flood send → PATH learned → header switches to "1 hop", delivered | yes | OK |
| Channels: Public + #test send, mute (🔕 in list), add #hiking via dialog, edit, delete | yes | edit bug fixed |
| Packets: list, frames tab, inspector, hover highlights (hex ↔ tree), export (frames JSON downloaded) | yes | 2 bugs fixed |
| Repeater page: login with `password`, Status refresh | yes | OK |
| Repeater CLI `ver`, trace, neighbours; room server; sensor | **not covered** | |
| Settings (name, radio preset, advert, time sync, theme), Device page | **not covered** | |
| Disconnect/reconnect | partly (reconnect after reload) | see open issue O1 |
| Narrow viewport (390px) and dark mode screenshots | **not covered** | |

Console: no errors or warnings from the app on any page visited. The only messages were
Chrome's "A form field element should have an id or name attribute" issue (count 4 to 7),
Lit's dev-mode warning (dev server only) and Vite's reconnect logs.

Screenshots (desktop, light) are in `docs/screenshots/`: connect, messages, contacts, chat,
channels, packets, packet-inspector, frames, repeater.

## Bugs fixed

1. **Chat bubbles rendered with a big leading indent.** `white-space: pre-wrap` on `.bubble`
   preserved the Lit template's indentation and newlines. It now applies only to the message
   text span. (`packages/web/src/pages/messaging/chat-page.ts`)
2. **Delivery status had no accessible name.** `aria-label` on a plain `<span>` is ignored, so
   screen readers heard "✓✓". The status spans now have `role="img"`, and "delivered" announces
   "Delivered in 361 ms". (`chat-page.ts`)
3. **List previews showed the raw reply convention**, e.g. "You: @[Alice] Yes, all day". The
   preview is now "You: ↪ Yes, all day". (`packages/core/src/app/contacts-model.ts`
   `messagePreview`; unit test added in `messaging-models.test.ts`)
4. **Renaming a hashtag channel kept the old key.** Editing `#hiking` to `#hike` with the key
   left blank produced a channel labelled `#hike` (kind "hashtag") that still used `#hiking`'s
   PSK, so it silently talked to the wrong channel. Renaming to a different `#name` without an
   explicit key now derives that hashtag's key. The dialog hint says so.
   (`channels-model.ts` `edit`, `channels-page.ts`; test "renaming a #hashtag channel without
   a key joins the new hashtag")
5. **Inspector bit diagrams for decrypted fields showed ciphertext bits.** For a GRP_TXT, the
   `flags` byte is 0x00 (PLAIN), but the `txt_type` diagram showed `110111··`, which are the
   bits of the encrypted byte at the same offset. Decrypted bit fields now use the plaintext
   value. (`packages/web/src/pages/packets/packet-inspector.ts`; assertion added in
   `test/packets-page.test.ts`)
6. **The packet inspector stayed open after switching to the Frames tab.** It kept showing a
   packet next to the frame list. The inspector now belongs to its tab: it is hidden on the
   other tab and shown again on return. (`packets-page.ts`; assertion added)

## Open issues (not fixed)

- **O1. Emulator re-seeds its history on every start.** Starting the emulator again, or
  reconnecting after a page reload, delivers the scenario's welcome messages again with new
  timestamps. Because the store is keyed by the same deterministic pubkey, Alice, Town Square
  and Public end up with duplicate messages and unread counts. Repro: connect Emulator, reload,
  click "Reconnect to Emulator", open Alice. Fix belongs in the emulator scenario (seed once,
  or dedupe on sender timestamp + text) and is out of scope for UI/app changes.
- **O2. Hop count disagrees between list and message (emulator).** Alice's contact shows
  "1 hop", but her messages show "zero hop". This is probably a path_len inconsistency in the
  emulator scenario.
- **O3. Renaming or re-keying a channel leaves the old conversation in the list** as an
  off-radio entry. This is by design, to keep history, but nothing in the UI explains it.
- **O4. Packets table clips the Summary column when the inspector is open** at 1280px.
  Long summaries are cut mid-word with no ellipsis or tooltip.
- **O5. Accessibility nits.**
  - The Share dialog's read-only textarea has no label.
  - Inspector tree items repeat "bits 00000011" in their accessible names (range plus diagram
    `aria-label`).
  - Contact rows' accessible names run "seen just now" and the preview together with no
    space ("…seen just nowWelcome…").
  - The byte counter is `aria-live` and announces on every keystroke.
- **O6. Unrelated test breakage from concurrent agents** (see below).

## UX suggestions (ranked)

1. Show "N bytes over" instead of a negative "-38 / 160 bytes left" when the draft is too long.
2. Keep composer drafts per conversation. Navigating away currently loses the text.
3. Header connection pill reads "Emulator (Emulator)": drop the transport suffix when it
   equals the device name.
4. In the DM header, show which repeater the path goes through (hop hashes, or names when
   known), not just "1 hop".
5. Channel sends stay at "✓ sent" forever. Show "heard N repeats" when the radio logs the
   message echoed back.
6. Contacts heading stays "Contacts (6)" while filtered. Show "1 of 6".
7. Packets: offer an ellipsis or tooltip for long summaries, and let the table scroll
   horizontally when the inspector is open.
8. Packets: collapse the From/To datetime filters behind a "Time range" disclosure. They take
   a full row.

## Build/test status at hand-off

- `npm run typecheck`: passes.
- `npm run build`: passes.
- `npm test`: **fails, but not because of this pass.**
  - Core: 5 failures in `protocol/encode.test.ts`, `protocol/decode-command.test.ts`,
    `client/companion-client.test.ts` and `emulator/companion-emulator.test.ts`. They come from
    in-progress edits by the core-client review agent (`encode.ts`, `writer.ts`, `types.ts`,
    `companion-client.ts` are modified in the working tree).
  - Web: `mc-app.test.ts` expects 7 nav entries, but the new Map page makes 8 (Map agent).
  - Other web failures were reload flakes ("Vite unexpectedly reloaded a test") caused by
    concurrent edits. `packets-page.test.ts` and `messaging.test.ts` pass when rerun.
  - All tests touching the files changed in this pass pass:
    - core `messaging-models.test.ts` (16/16)
    - web `packets-page.test.ts` + `messaging.test.ts` (20/20)
