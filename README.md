# FieldAssist — live transcripts and raw audio from Mentra Live to your Mac

A MentraOS **miniapp** for Mentra Live glasses. The glasses talk to the phone over Bluetooth, the
Mentra App runs this miniapp's background code on the phone, and two things come back to your Mac:

- **Console lines** via the CLI's dev server (`mentra-miniapp dev`, run by `bun dev`): session events,
  transcripts, location. This is the "is the connection good" signal.
- **Raw microphone audio + transcripts** via HTTP POST from the phone to `server/ingest.ts` on the Mac,
  which prints what it receives and writes the audio to `recordings/`. (WebSockets from this iPhone to the
  Mac fail, even from Safari; plain HTTP from the miniapp's background works, see Troubleshooting.)

```
Mentra Live ──BT──► Mentra App (phone) ──runs──► src/background/index.ts
                                         │              │
                   same Wi-Fi ◄──────────┘              └─ HTTP POST http://<mac>:3100/ingest/{hello,event,audio}
                   `bun dev` prints the phone's console       `bun run ingest` prints transcripts,
                   (QR, reload, [MentraJS] lines)             audio stats, writes recordings/*.wav
```

## Why this is not a cloud SDK + ngrok app

The cloud SDK (`@mentra/sdk`, `AppServer`, webhooks, dev console) is retired:

- npm marks `@mentra/sdk` **deprecated**: "retired cloud SDK ... not compatible with the current Mentra App".
- `@mentraos/sdk` is not on npm (404).
- Mentra's roadmap post (mentraglass.com/blogs/blog/mentra-roadmap-update-moving-to-miniapps-on-the-phone):
  MentraOS 3.0 shipped **2026-08-03** and removed cloud apps from the Mentra App; the "MentraOS Legacy"
  build that kept them alive ended support in **October 2026**.
- The current docs (https://docs.mentraglass.com) cover only the **Miniapp SDK** (`@mentra/miniapp`) and the
  **Bluetooth SDK**. The old cloud docs are at https://mentraglass.com/legacy.

There is no API key and no public URL. ngrok is installed but not needed: the phone and the Mac only have
to share a Wi-Fi network. The only configuration is the ingest server address, which `run.sh` derives from
the Mac's LAN IP (override in `.env`, see `.env.example`).

## Run it

```bash
./run.sh            # starts the ingest server, then the dev server (one terminal)
./run.sh --usb      # Android only: reach the phone over USB (adb reverse) instead of Wi-Fi
```

Or in two terminals: `bun run ingest`, and `MENTRA_PUBLIC_INGEST_URL=http://<lan-ip>:3100 bun dev`.

- **Package name:** edit `packageName` in `miniapp.json` (default `com.fieldassist.app`). The CLI and
  `run.sh` read it from there, and the phone keys dev installs by it.
- **Ingest URL is baked in at build time.** `build.ts` turns `MENTRA_PUBLIC_INGEST_URL` into a constant in
  the background bundle. `run.sh` sets it to `http://<your LAN IP>:3100` on every start, so after
  changing Wi-Fi networks, restart `run.sh` (it rebuilds and the phone reloads). Audio frames are batched
  (10 frames or 250 ms) into one POST each; transcripts and speech events are posted as they happen.
- `bun dev` validates `miniapp.json`, builds both layers, serves `http://<lan-ip>:3000/` (a `miniapp.json`
  that names `bundle.zip` and its SHA-256) plus a WebSocket "sidecar" on port 3001 for live reload **and the
  phone's console output back to this terminal**. It prints a QR code, the same URL as `Miniapp URL:`, and a
  `PNG QR:` path. If 3000/3001 are busy it picks the next free pair and prints
  `Port 3000 was unavailable; using 3002 instead.`

On the phone, in the Mentra App: **Settings → Miniapp Developer Settings → Scan Miniapp QR Code**.
If you do not see that menu, update the Mentra App. Scan once; every saved change rebuilds and reloads on
the phone. The miniapp's background starts right after the scan. The UI tile is optional: it only shows
status and the latest transcript.

## What you should see

Dev server and phone console (`[MentraJS]`):

```
Starting dev server for FieldAssist (com.fieldassist.app) on port 3000...
[__mentra_dev] sidecar listening on :3001
01:40:03.510 [ingest] listening on http://0.0.0.0:3100/ingest  (recordings -> /Users/you/.../fieldassist/recordings)
╔═ To test your miniapp on glasses: ... ═╗
<QR code>
Miniapp URL: http://192.168.1.23:3000/
PNG QR: /var/folders/.../T/mentra-dev-qr-com.fieldassist.app-3000.png

01:40:12 [MentraJS] log [fieldassist 3f9a1c2e] 2026-11-14T09:40:12.101Z SESSION STARTING run=3f9a1c2e
01:40:12 [MentraJS] log [fieldassist 3f9a1c2e] ... cloud disconnected audio=none
01:40:12 [MentraJS] log [fieldassist 3f9a1c2e] ... SESSION READY package=com.fieldassist.app userId=... display=none micDeclared=true locationDeclared=true
01:40:12 [MentraJS] log [fieldassist 3f9a1c2e] ... capabilities={...}
01:40:13 [MentraJS] log [fieldassist 3f9a1c2e] ... cloud connected audio=udp
01:40:13 [MentraJS] log [fieldassist 3f9a1c2e] ... glasses connected model=Mentra Live
01:40:14 [MentraJS] log [fieldassist 3f9a1c2e] ... audio first chunk format=... sampleRate=... bytes~640
01:40:19 [MentraJS] log [fieldassist 3f9a1c2e] ... audio 248 chunks 155 kB in 5s; uplink connected ok=20 failed=0
01:40:20 [MentraJS] log [fieldassist 3f9a1c2e] ... interim [cloud en-US] testing one two
01:40:21 [MentraJS] log [fieldassist 3f9a1c2e] ... FINAL   [cloud en-US] Testing, one, two, three.
```

Ingest server (`[ingest]`, what actually arrived over the uplink):

```
01:40:12.523 [ingest] run 3f9a1c2e started
01:40:12.529 [ingest] hello run=3f9a1c2e userId=... package=com.fieldassist.app via=http
01:40:14.534 [ingest] audio format=... sampleRate=... firstChunkBytes=640 -> /Users/you/.../fieldassist/recordings/2026-11-14T09-40-12-3f9a1c2e.wav
01:40:15.521 [ingest] audio 50 chunks/s 31.2 kB/s total=1.0s
01:40:19.900 [ingest] speech started
01:40:20.517 [ingest] interim [cloud en-US] testing one two
01:40:21.088 [ingest] FINAL   [cloud en-US] Testing, one, two, three.
01:40:22.300 [ingest] speech stopped (quiet for 400ms)
...
01:45:02.635 [ingest] phone session ended: ...; run 3f9a1c2e: 14890 chunks, 9306 kB in 1489 posts -> /Users/you/.../recordings/2026-11-14T09-40-12-3f9a1c2e.wav (298.0s, 9306 kB)
```

Notes on that output:

- The first `cloud disconnected audio=none` line is the SDK's default snapshot, delivered before the
  connect handshake. It is expected; `cloud connected` should follow within a few seconds.
- The leading HH:MM:SS is the phone's log timestamp, rendered in this Mac's local timezone by the dev
  sidecar (which also adds `[MentraJS] log`); the ISO timestamp inside the line is the same phone clock,
  written by the miniapp's logger. `[ingest]` lines carry this Mac's own clock, also local time; recording
  file names use UTC. `[fieldassist <id>]` identifies one background run; a new id means the context
  restarted (dev reload, crash recovery, or re-install).
- The order of the `cloud` and `glasses` lines varies. A run is finalized on the phone's `end` event or after
  15 s without audio (`no data for 15s`), whichever comes first; a new run id makes a new file.
- The audio format is only known at runtime. The SDK says frames are "PCM or LC3 depending on the phone's
  mic mode", with `sampleRate` and `format` present only "when reported". The ingest server writes 16-bit
  mono PCM to `.wav` (sample rate from the phone, or 16000 if it does not say) and LC3 frames raw to `.lc3`.
  Check the `audio format=` line.
- Audio is never written to the console; the phone logs counts every 5 s, the Mac logs rates every 1 s.
- `SESSION ENDED reason=... uptime=...s` is logged from the SDK's `beforeDisconnect` hook when the phone
  announces a teardown (disable, uninstall, dev respawn), while `bun dev` is still running. The docs do not
  say whether the host sends that notice before a dev `respawn-bg`, so a missing `SESSION ENDED` followed by
  a fresh `SESSION STARTING` with a new run id is not itself a failure.

## Verification checklist

1. `./run.sh` prints `[ingest] listening on http://0.0.0.0:3100/ingest` and `sidecar listening on :3001` (or the
   pair it chose; the two servers start as separate processes, so either line can come first), the QR and
   `Miniapp URL:`.
2. Phone and Mac are on the same Wi-Fi; the glasses show as connected in the Mentra App.
3. Scan the QR: the terminal shows `[ingest] run <id> started` and `hello run=<id> ...` (and, if the console
   bridge works on your phone, `SESSION STARTING` / `SESSION READY` lines tagged `[MentraJS]`).
4. Accept the phone's microphone (and location) prompts if it asks.
5. `cloud connected` appears (transcription defaults to the cloud).
6. Speak: `interim` lines stream, then one `FINAL` line per utterance, under both `[MentraJS]` and `[ingest]`.
   The `[ingest]` copy proves the phone → Mac uplink carries data.
7. `audio first chunk format=... sampleRate=...` on the phone side, `[ingest] audio format=... -> recordings/...`
   on the Mac side, then `audio N chunks/s` lines once per second while audio flows.
8. `speech started` / `speech stopped` lines bracket what you say.
9. Open the tile on the phone: it shows `Background: ready (user ...)` and the latest transcript.
10. Move around (or toggle location on the phone): `location lat=... lng=...` lines appear.
11. Ctrl+C. The run is finalized by the phone's `end` event or, at the latest, 15 s of silence on the Mac
    (`no data for 15s`): `[ingest] ... run <id>: N chunks, N kB in N posts -> .../recordings/<file>.wav (Ns, N kB)`.
    Then `afinfo recordings/<file>.wav` (format, duration) and `afplay recordings/<file>.wav` (listen).
12. Disable FieldAssist in the Mentra App (or save a file under `src/background/`): expect
    `SESSION ENDED reason=...`; after a save the dev server prints `respawn-bg` and a fresh
    `[fieldassist <new id>] SESSION STARTING` follows. (See the note above: the end line may be skipped on a
    dev respawn.) Each uplink connection writes its own recording file, so a respawn or a reconnect starts a
    new file; a mid-stream format or sample-rate change starts a `-part2` file.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| QR scan does nothing / install fails | Phone cannot reach `http://<lan-ip>:3000` (different Wi-Fi, guest network with client isolation, VPN on the Mac, macOS firewall) | Same Wi-Fi; disconnect the VPN; System Settings → Network → Firewall: allow `bun`; re-scan after the CLI prints `LAN IP changed`; on Android use `./run.sh --usb` |
| `Port 3000 was unavailable; using 3002 instead.` | Another dev server holds 3000/3001 (for example a second miniapp project) | Fine: scan the new QR. Or stop the other `bun dev` |
| `miniapp.json validation failed:` | Bad permission / hardware type, or a missing required field | Fix the listed field (valid types are in https://docs.mentraglass.com/app-devs/reference/cli). A typo in `packageName` passes validation but creates a second dev entry on the phone |
| `SESSION READY` but no transcript lines | Phone denied the microphone prompt; `cloud disconnected` persists (transcription defaults to `preferCloud`); glasses not connected (`glasses disconnected`); or `MICROPHONE` removed from `miniapp.json` (`PERMISSION_NOT_DECLARED`) | Re-grant the mic in the phone's settings; get the phone online; connect the glasses in the Mentra App; keep `MICROPHONE` declared |
| Phone tile shows uplink `connecting`/`stalled` with a `fetch:` error, and no `[ingest] run ... started` | The ingest server is not running, or the phone cannot reach port 3100 on the Mac (firewall, different network), or the baked URL points at an old IP | `./run.sh` starts the server; open `http://<lan-ip>:3100/health` in the phone's browser; restart `run.sh` after changing networks (the URL is baked at build time) |
| No `[MentraJS]` lines in the terminal although the tile says dev install = yes | The CLI's console bridge is a WebSocket to port 3001, and WebSockets from this iPhone to this Mac fail (Safari fails too, close code 1006; the Mentra App reports "bad response from the server"). Plain HTTP works, which is why the ingest path uses POST | Use the `[ingest]` lines as the terminal view. Hot reload also depends on that WebSocket: rescan the QR after edits. The app only opens that bridge when the miniapp is spawned, so after a scan also disable and re-enable FieldAssist in the Mentra App; forwarded logs are throttled (100/min) and lines containing key/token/auth/secret are redacted |
| `no ingest URL baked in` | `bun dev` was started without `MENTRA_PUBLIC_INGEST_URL` | Use `./run.sh`, or export the variable before `bun dev` |
| Transcripts arrive but no `audio` lines | OS mic prompt denied (subscription "succeeds but no chunks arrive"); or the phone's voice-activity gate / loudness gate ("Barrier") is suppressing quiet audio | Re-grant the mic; speak; for continuous capture the SDK exposes `session.mic.setVoiceActivityDetectionEnabled(false)` and `setLoudnessGateEnabled(false)` (subject to the user's phone settings) |
| `audio format=...lc3` and a `.lc3` file | The phone's mic mode is LC3 | Decode with an LC3 decoder (liblc3). Where the mic mode is set is not documented |
| `[ingest] cannot write audio: ...` | `recordings/` not writable, disk full, or a bad `INGEST_DIR` | Fix the path/disk; transcripts keep flowing, audio for that connection is discarded until you restart |
| `afplay` sounds wrong (pitch/speed) | The phone did not report `sampleRate`; the server assumed 16000 | Read the `audio format=` line; change `DEFAULT_SAMPLE_RATE` in `server/ingest.ts` |
| `audio ... dropped=N` on the phone, `missing=N` on the Mac | The phone keeps at most 30 pending posts; older ones are dropped when the Mac is unreachable | Expected after a Wi-Fi blip; persistent drops mean the link is bad |
| Port 3100 in use | Another process on the Mac | `INGEST_PORT=3101 ./run.sh` (run.sh bakes the matching URL) |
| Transcripts show on the phone tile but not in the terminal | Sidecar (port 3001) unreachable | Check `sidecar listening`; firewall; same Wi-Fi |
| No `location` lines | `LOCATION` not declared or the OS location prompt was denied; or the phone has not moved | Check manifest and phone permission; walk around |
| Miniapp stops or the Mentra App reports a missing entry right after an edit | The rebuild failed (error printed above the `reload` / `respawn-bg` line). `build.ts` wipes `dist/` first, so a failed build ships an empty bundle | Fix the error and save again; the next rebuild reinstalls |
| Phone shows a stale name or icon | The home screen caches them per package | Rescan the QR |
| Two FieldAssist entries on the phone | `packageName` was changed; dev entries are keyed by it | Remove the old entry in the Mentra App |
| `--usb could not establish an ADB tunnel` | `adb` missing or USB debugging off (USB mode is Android only) | `brew install --cask android-platform-tools`, enable USB debugging. If the Mac has a LAN IP the CLI falls back to it (phone must share the Wi-Fi); with no LAN IP it exits. In USB mode `run.sh` bakes `http://127.0.0.1:3100` and keeps `adb reverse tcp:3100 tcp:3100` asserted itself (the CLI only reverses its own two ports); if adb sees no phone it falls back to the Wi-Fi address before building |

## Project layout

```
fieldassist/
├── miniapp.json              # identity, permissions (MICROPHONE, LOCATION), hardware (MICROPHONE), port 3000
├── build.ts                  # scaffolder's Bun.build script + the __INGEST_URL__ constant + the CLI's background runtime guard
├── run.sh                    # starts server/ingest.ts, bakes the ingest URL, then `bun dev` (extra args go to the CLI)
├── .env.example              # optional overrides: MENTRA_PUBLIC_INGEST_URL, INGEST_PORT, INGEST_DIR
├── icon.png                  # generated 512x512 PNG (the scaffolder's placeholder was a corrupt file)
├── src/background/index.ts   # runs on the phone: logging, transcripts, location, raw audio uplink
├── src/shared/channels.ts    # typed background → UI messages
├── src/ui/                   # tiny status page shown when the tile is opened
├── server/ingest.ts          # runs on the Mac: WebSocket receiver, prints transcripts/stats, writes recordings
├── server/wav.ts             # 16-bit PCM WAV writer (header patched on every write)
└── server/wav.test.ts        # `bun test`
```

Versions: `@mentra/miniapp` 3.4.0 (npm `latest`), `@mentra/miniapp-cli` 0.1.0-dev.2 (npm `dev` tag; it
is the CLI the docs describe: served manifest with bundle SHA-256, `--usb`, `keys`, `--sign`. The
scaffolder still pins the older 0.1.0-dev.0 and an obsolete 0.3.0-dev.0 SDK), `@types/bun` for the server.

## Raw audio facts (from `@mentra/miniapp@3.4.0` types and docs)

- `session.mic.onAudioChunk(handler: (data: AudioChunkData) => void): UnsubscribeFn` with
  `AudioChunkData { data: string /* base64 PCM or LC3 */; sampleRate?: number; format?: string }`.
  Docs: https://docs.mentraglass.com/app-devs/core-concepts/microphone/audio-chunks
- Sample rate, bit depth, channels and chunk cadence are **not documented** for the Miniapp SDK; the
  16 kHz / 16-bit / mono figure in the docs belongs to the separate Bluetooth SDK. Read them off the
  `audio format=` line.
- VAD: `session.mic.onVoiceActivity` (`{status, silentForMs?, timestamp?}`). Glasses-side knobs in the types:
  `setVoiceActivityDetectionEnabled(boolean)` (GX8002 VAD) and `setLoudnessGateEnabled(boolean)` (the
  center-mic loudness gate "Barrier", which the docs describe for Mentra Live).
- Diarization: `session.transcription.configure({diarization: true})` exists, but `TranscriptionData` has no
  speaker id in 3.4.0 (only `TranslationData.speakerId`). Speaker identification needs the raw audio plus
  your own model.
- Whether raw audio keeps flowing with the phone offline is undocumented (only transcription, translation
  and cloud TTS are listed as cloud-dependent).

## Next milestones — exact APIs

- **Audio / TTS out**: `session.speaker.speak(text, options?): Promise<SpeakResult>`,
  `session.speaker.play({audioUrl})`, `session.speaker.createStream(options?): Promise<SpeakerStreamWriter>`
  (16-bit LE mono PCM at 16000|24000|48000 Hz; requires `minHostVersion` ≥ `2.13.0`). Routing: "Playback
  follows the phone's media route, including connected Bluetooth audio glasses"; no API picks the speaker.
  Docs: https://docs.mentraglass.com/app-devs/core-concepts/speakers/text-to-speech
- **Photo**: `session.camera.takePhoto(options?): Promise<PhotoTaken>` → `{requestId, photoUrl, mimeType, size}`
  (`photoUrl` is a signed URL, ~30 min); `session.camera.warmUp()`. Needs the `CAMERA` permission and a
  `CAMERA` hardware requirement. To get the bytes here: `fetch(photoUrl)` in the background, then POST the
  `arrayBuffer()` to the ingest server. Docs: https://docs.mentraglass.com/app-devs/core-concepts/camera/photos

The full verified research report (TTS, photos, lifecycle, dev loop, troubleshooting facts, open questions)
is in `../notes/mentraos-research-report.md`.
