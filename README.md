# Plex → IINA

Press **Play** in Plex Web and the movie or episode opens in [IINA](https://iina.io)
instead of Plex's browser player. IINA streams the **original file** straight from your
Plex Media Server: no transcoding, no quality cap, and every audio track (TrueHD,
DTS-HD MA, E-AC-3) arrives exactly as it is on disk. A companion IINA plugin reports your
progress back to Plex, so Continue Watching and watched status keep working.

Works in **Chrome** and **Safari** on macOS, on `app.plex.tv` and on Plex Web served by
your own server (`http://<server>:32400/web`).

> Not affiliated with Plex Inc. or the IINA project.

## Contents

- [What you get](#what-you-get)
- [How it works](#how-it-works)
- [Install](#install)
- [Using it](#using-it)
- [Spatial audio and HDR](#spatial-audio-and-hdr)
- [Troubleshooting](#troubleshooting)
- [Privacy](#privacy)
- [Project layout and development](#project-layout-and-development)
- [Known limits](#known-limits)

## What you get

- **Full-quality playback.** 4K HDR remuxes at their full bitrate, with lossless TrueHD
  and DTS-HD MA decoded by IINA rather than transcoded by the server.
- **Every Play button.** The Play button on a movie or episode page, the round play button
  on posters (Home, Continue Watching) and the play button on library-grid cards all open
  IINA.
- **Plays what Plex would.** Shows and seasons start at the On Deck or next unwatched
  episode. Items with several versions (say a 4K remux and a 1080p copy) play the highest
  resolution and bitrate. Playback resumes from your Plex watch position.
- **Progress syncs back to Plex** (with the IINA plugin): Continue Watching, resume points,
  watched status and the server dashboard's Now Playing.
- **Large read-ahead buffer** (1, 2 or 5 GB) that rides out network hiccups on
  high-bitrate files.
- Music, photos and anything it can't resolve still play in Plex. **Option-click** Play
  to use Plex's own player for one item.

## How it works

1. A content script catches the Play click on the Plex Web page before Plex handles it.
2. It finds your server (directly from the page on a local Plex Web, or through your Plex
   account's server list on app.plex.tv) and asks the server for the item's media file.
3. It opens `iina://open?url=<server>/library/parts/…` with resume and buffer options. The
   file is served by Plex as-is, with HTTP range requests, so seeking works.
4. In Safari, the extension's companion Mac app opens that link, so Safari doesn't ask
   "Allow this page to open IINA?" on every play. Chrome opens it as a normal link.
5. The **Plex Progress** IINA plugin recognises these streams and reports the playback
   position to the same server, like any Plex player.

## Install

You need macOS with **IINA 1.5 or later**, Chrome or Safari, and access to a Plex Media
Server.

### Chrome

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose the [`plex-to-iina`](plex-to-iina) folder.
3. Reload any open Plex tab.
4. The first time you press Play, Chrome asks to open IINA. Tick **Always allow … to open
   links of this type**, then click **Open IINA**.

After pulling changes, click the reload icon on the extension in `chrome://extensions`.

### Safari

Safari extensions ship inside a small Mac app. Building it needs Xcode.

1. Build and install it:
   ```bash
   safari/build.sh
   ```
   This puts **Plex to IINA.app** in `~/Applications` and opens it once, which registers
   the extension with Safari. It's signed with your Apple Development certificate if you
   have one (add any Apple ID in Xcode → Settings → Accounts to get one); set
   `DEVELOPMENT_TEAM` to choose a team.
2. If Safari was open, **quit it (⌘Q) and reopen it**. Replacing the app while Safari runs
   can stop Safari from starting the part that opens IINA until it restarts.
3. In **Safari → Settings → Extensions**, tick **Plex → IINA**. If it isn't listed, open
   **Settings → Advanced**, turn on **Show features for web developers**, then in the
   **Developer** tab turn on **Allow unsigned extensions**.
4. Open Plex, click the extension's toolbar button and choose **Always Allow on This
   Website**. Plex on your server's own address (for example `192.168.1.20:32400`) needs
   its own permission, separate from app.plex.tv.

A red **on** badge on the toolbar icon means the extension is active on that page. Run
`safari/build.sh` again whenever files in `plex-to-iina` change.

### IINA plugin (progress sync)

1. Open **IINA → Settings → Plugins**.
2. Click **Install Local Package…** and choose
   [`iina-plugin/plex-progress.iinaplgz`](iina-plugin/plex-progress.iinaplgz).
   Double-clicking the file in Finder does the same.
3. IINA lists the plugin's permissions: **network requests** and **on-screen messages**.
   Confirm to install. It may contact any host because your server's address differs per
   setup, but it only ever contacts the server the file is streamed from.
4. Make sure **Plex Progress** is ticked in the plugin list. It applies from the next file
   you open.

## Using it

Press Play anywhere in Plex Web. A small message in the bottom-right corner shows what's
happening, ending with the title and the file's quality, for example
`4K HEVC · TrueHD 7.1 · 91 Mbps`.

The toolbar popup has:

| Setting | What it does |
|---|---|
| Open Play in IINA | Turns the extension on or off. |
| Resume where Plex left off | Starts at your Plex watch position. |
| Open full screen | Opens IINA in full screen. |
| Buffer size | How much of the file IINA reads ahead, kept in memory: 1, 2 or 5 GB (default 5). |

How long the buffer lasts depends on the bitrate:

| Buffer | 91 Mbps 4K remux | 55 Mbps 4K remux | 10 Mbps TV episode |
|---|---|---|---|
| 1 GB | ~1.5 min | ~2.5 min | ~14 min |
| 2 GB | ~3 min | ~5 min | ~28 min |
| 5 GB | ~7 min | ~12 min | the whole episode |

The buffer fills only as fast as your network allows, and each IINA window can use that
much memory. It replaces IINA's own cache settings for these streams only.

With the plugin installed, IINA shows **Syncing progress with Plex** once per file. It
reports the position every 10 seconds while playing and right away when you pause, seek or
close the window. Past 90% it marks the item as watched.

## Spatial audio and HDR

The extension's job is to get the untouched video and lossless audio to IINA. IINA does
the rest:

1. **IINA → Settings → Video & Audio → Audio driver: AVFoundation.** This is IINA's
   spatial audio output; it passes the full 5.1 or 7.1 channel layout to macOS.
2. Keep **audio passthrough (S/PDIF) off**. The AVFoundation driver can't pass a bitstream
   through.
3. With AirPods or Beats connected, set **Spatial Audio** in Control Center → Sound.
4. In **Video & Audio**, keep **hardware decoding** on and **Enable HDR** on. On an HDR
   display, use the default display preset.

Worth knowing:

- IINA decodes TrueHD Atmos and DTS:X to their 7.1 (or 5.1) channel bed, which macOS then
  spatializes. You get lossless multichannel spatial audio, but not object-based Atmos or
  DTS:X.
- HDR10 plays as HDR10. Dolby Vision profile 8.1 and profile 7 MEL files play their HDR10
  base layer, and HDR10+ files play as HDR10: correct HDR, without the scene-by-scene
  brightness metadata.

## Troubleshooting

**Play still opens Plex's player.**
- Chrome: reload the extension in `chrome://extensions`, then reload the Plex tab.
- Safari: check for the red **on** badge. No badge means Safari hasn't allowed the
  extension on that site: click the toolbar icon, choose **Always Allow on This Website**,
  and reload.

**Safari: the message stays on "Finding the original file…", or Safari asks to open IINA.**
The companion app didn't start, usually right after a rebuild. Quit Safari (⌘Q) and reopen
it. The extension gives up on the app after a few seconds and falls back to a normal link,
which is why Safari may ask.

**Chrome: Plex shows "unable to connect … securely" and your libraries have warning
signs.** Chrome blocks sites from reaching devices on your local network until you allow
it. Click the icon at the left of the address bar on app.plex.tv, open **Site settings**
and set **Local network access** to **Allow**. Plex itself needs this, not just the
extension.

**The message says "via Plex Relay".** The server couldn't be reached directly. Relay
bandwidth is far too low for remuxes; fix remote access or play on your home network.

**Progress doesn't sync.** Make sure the **Plex Progress** plugin is installed and ticked
in IINA → Settings → Plugins, and play the item from Plex again (files opened before the
plugin was installed aren't tracked). IINA's **Window → Log Viewer** shows the plugin's
messages.

**Safari's step-by-step log.** Every step in Safari is logged without your token:
```bash
/usr/bin/log show --last 10m --predicate 'subsystem == "local.plex-to-iina.app.Extension"'
```

## Privacy

- The extension talks only to your Plex server and to plex.tv (to find your servers, as
  Plex Web itself does), using the sign-in Plex Web already has.
- The link handed to IINA contains the server's access token (`X-Plex-Token`), as all
  direct Plex file links do. It stays on your Mac and your server, but it does appear in
  IINA's playback history.
- The plugin sends that token only to the server the file came from.
- There's no analytics or tracking of any kind.

## Project layout and development

| Path | What it is |
|---|---|
| [`plex-to-iina/`](plex-to-iina) | The browser extension: `content.js` (all the logic), the popup, and Chrome's `manifest.json`. Load this folder in Chrome. |
| [`safari/`](safari) | Safari's `manifest.json` and `background.js`, the Xcode project for the companion app, and `build.sh`. |
| [`iina-plugin/`](iina-plugin) | The Plex Progress IINA plugin (`plex-progress.iinaplugin`) and its installable package. |
| [`tools/mock-pms.py`](tools/mock-pms.py) | A stand-in Plex server that serves a test video and logs the plugin's progress calls. |

- **Safari build:** `safari/build.sh` copies the shared files into `safari/extension/`
  (generated, not committed), then builds and installs the app.
- **Plugin package:** after editing the plugin, rebuild the package:
  ```bash
  cd iina-plugin/plex-progress.iinaplugin && zip -X ../plex-progress.iinaplgz Info.json main.js
  ```
  For development, link the folder instead of installing the package, then restart IINA
  and tick the plugin:
  ```bash
  ln -s "$PWD/iina-plugin/plex-progress.iinaplugin" ~/Library/Application\ Support/com.colliderli.iina/plugins/plex-progress.iinaplugin-dev
  ```
- **Testing the plugin without a server:** see the instructions at the top of
  [`tools/mock-pms.py`](tools/mock-pms.py).

## Known limits

- Only items in your own or shared Plex libraries. Plex's free streaming and Discover
  titles still play in Plex.
- The plugin can't track files opened without the extension's `plexRatingKey` marker,
  such as old entries in IINA's history. Play them from Plex again.
- If IINA quits while a video is playing, Plex may keep the last 10-second update
  instead of the exact stop position.
- If Plex changes its web app, the Play-button markers in
  [`content.js`](plex-to-iina/content.js) may need updating.

## License

[MIT](LICENSE)
