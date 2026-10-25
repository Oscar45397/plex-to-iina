# Plex → IINA

A browser extension that sends Plex Web's **Play** button to [IINA](https://iina.io)
instead of the browser player. IINA streams the original file from your Plex Media
Server, so nothing is transcoded, and an IINA plugin reports your progress back to Plex.

Works in Chrome and Safari on macOS, on `app.plex.tv` or your server's own Plex Web.
A **Download** button saves episodes and films to watch in IINA without the server.

> Not affiliated with Plex Inc. or the IINA project.

## Install

You need macOS, IINA 1.5 or later, and Chrome or Safari.

**Chrome**

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the [`plex-to-iina`](plex-to-iina) folder.
3. The first time you press Play, allow Chrome to open IINA.

**Safari** (needs Xcode)

1. Run `safari/build.sh`. It builds a small Mac app that carries the extension.
2. Restart Safari, tick **Plex → IINA** in Safari → Settings → Extensions, and choose
   **Always Allow on This Website** on your Plex page. If the extension isn't listed,
   turn on **Allow unsigned extensions** in Safari's developer settings.

**IINA plugin** (progress sync)

In IINA → Settings → Plugins, click **Install Local Package…** and choose
[`iina-plugin/plex-progress.iinaplgz`](iina-plugin/plex-progress.iinaplgz).

Then press Play in Plex. The toolbar popup has the settings (resume, full screen, buffer
size, track choice). **Option-click** Play to use Plex's own player.

## Performance

The server sends the file as it is, so it does almost no work: no transcoding, just
reading from disk. What matters is whether the network keeps up with the file's bitrate.
Typical bitrates:

| File | Bitrate |
|---|---|
| 4K Blu-ray copy | 50–100 Mbps |
| 1080p Blu-ray copy | 20–40 Mbps |
| Streaming-quality file | 5–25 Mbps |

Wired gigabit Ethernet handles all of these with room to spare. Wi-Fi is usually fine,
but can struggle with high-bitrate 4K. Plex Relay, used when the server can't be reached
directly, is limited to a few Mbps and too slow for most files.

IINA reads ahead into memory to ride out slow moments. How long the buffer lasts:

| Buffer | 20 Mbps | 50 Mbps | 100 Mbps |
|---|---|---|---|
| 1 GB | ~7 min | ~3 min | ~1.5 min |
| 2 GB | ~14 min | ~6 min | ~3 min |
| 5 GB | ~35 min | ~14 min | ~7 min |

Each IINA window can use that much memory, plus a fifth more to make rewinding instant.

## Downloading to watch offline

On a film, show, season or episode page, **Download** (next to Play) saves the original
files to **Downloads › Plex to IINA**, so you can watch them in IINA where the server
can't be reached, for example away from home. Choose how many episodes next to the
button, or **Season** for the rest of that season: a show or season page starts at the
next episode to watch, an episode page at that episode. You see the total size before
it starts. Files you already have are skipped,
and the rest download one at a time, so the first episodes are ready first.

- **Chrome** shows progress in its downloads list.
- **Safari:** the Plex to IINA app downloads the files, checks free disk space first, and
  shows progress in its window. The first time, macOS may ask to let it use the local
  network; allow it. The app's window is also your downloads library: shows and films
  with posters, each with a Play button that opens it in IINA.
- **Progress:** the IINA plugin remembers where you stopped and what you finished, and
  tells Plex when the server can be reached again. It reaches the server the way your
  last stream from it did, so stream from that server in IINA at least once, and keep
  the `{plex-…}` tag in the file names.
- **Play** in Plex Web plays your downloaded copy from disk when there is one, so there's
  nothing to buffer. So does any other Plex episode IINA opens, such as the next one in
  its playlist. Progress goes to Plex as when streaming.
- **After watching:** once you've watched a downloaded episode or film in IINA, the
  plugin moves the file to the Trash. To keep downloads, untick **Move Watched Downloads
  to Trash** in IINA's Plugin menu. The plugin asks for file access for this when you
  install it.

Over wired gigabit Ethernet a 5 GB episode takes about a minute, over Wi-Fi a few
minutes; Plex Relay is too slow. If the server's owner hasn't allowed downloads for your
account, the server refuses them. Items split into several files download only the
first part, and subtitles in separate files aren't included.

## Troubleshooting

- **Play still opens Plex's player:** the extension isn't active on that page. Reload
  the tab; in Safari, check that the extension is allowed on the site (the toolbar icon
  shows an **on** badge when it is).
- **IINA doesn't open:** allow the browser to open IINA links when it asks.
- **Playback stalls or keeps buffering:** the network is slower than the file's bitrate.
  See [Performance](#performance).
- **Progress doesn't sync:** check that the plugin is installed and ticked in IINA, then
  play the item from Plex again.

## Known limits

- Subtitles in separate files (such as an `.srt` next to the video) aren't passed to IINA.
- Switching the audio or subtitle track in IINA makes it download its buffer again.
- Only items from your own or shared libraries; Plex's free movies and TV play in Plex.
- Plex Web updates can change its Play buttons, which may need an extension update.

## Privacy

The extension talks only to your Plex server and plex.tv, using Plex Web's existing
sign-in. The link handed to IINA contains your server's access token, like any direct
Plex file link; it stays on your Mac. To sync progress of downloaded files, the IINA
plugin keeps the address and access token of each server you stream from in IINA's
plugin settings, also only on your Mac. No analytics.

## Development

[`plex-to-iina/`](plex-to-iina) is the extension, [`safari/`](safari) the Safari app and
its build script, [`iina-plugin/`](iina-plugin) the progress plugin, and
[`tools/mock-pms.py`](tools/mock-pms.py) a stand-in Plex server for testing. Conventions
are in [CLAUDE.md](CLAUDE.md), changes in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
