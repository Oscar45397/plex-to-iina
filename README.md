# Plex → IINA

A browser extension that sends Plex Web's **Play** button to [IINA](https://iina.io)
instead of the browser player. IINA streams the original file from your Plex Media
Server, so nothing is transcoded. An IINA plugin reports your progress back to Plex,
plays the next episode with an Up Next countdown, and adds Skip Intro and Skip Credits.

Works in Chrome and Safari on macOS, on `app.plex.tv` or your server's own Plex Web.

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

**IINA plugin** (progress sync, next episode, skipping)

In IINA → Settings → Plugins, click **Install Local Package…** and choose
[`iina-plugin/plex-progress.iinaplgz`](iina-plugin/plex-progress.iinaplgz). Install it
again the same way to update.

Then press Play in Plex. The toolbar popup has the settings (resume, full screen, buffer
size, track choice). **Option-click** Play to use Plex's own player.

## Watching a series

When an episode ends, the next one plays, starting where you left off and with the same
audio and subtitle languages. When the end credits start, an **Up Next** card plays the
next episode after 10 seconds; **Watch Credits** keeps you on this one. **Skip Intro**
and **Skip Credits** buttons show up where Plex has found the intro or credits.

- Turn off autoplay: IINA → Settings → General → **Play next item automatically**.
- Skip intros without asking: IINA's Plugin menu → **Skip Intros Automatically**.
- Previous and next buttons in IINA's controls: IINA → Settings → UI → **Use left/right
  button for: Previous / Next Media**.

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

## Troubleshooting

- **Play still opens Plex's player:** the extension isn't active on that page. Reload
  the tab; in Safari, check that the extension is allowed on the site (the toolbar icon
  shows an **on** badge when it is).
- **IINA doesn't open:** allow the browser to open IINA links when it asks.
- **Playback stalls or keeps buffering:** the network is slower than the file's bitrate.
  See [Performance](#performance).
- **Progress doesn't sync:** check that the plugin is installed and ticked in IINA, then
  play the item from Plex again.
- **No Skip Intro, or Up Next only in the last seconds:** the server hasn't found that
  show's intros or credits. Plex detects them on servers with Plex Pass (Settings →
  Library on the server).

## Known limits

- Subtitles in separate files (such as an `.srt` next to the video) aren't passed to IINA.
- Switching the audio or subtitle track in IINA makes it download its buffer again.
- The Skip and Up Next buttons take a mouse click; they have no keyboard shortcut.
- Only items from your own or shared libraries; Plex's free movies and TV play in Plex.
- Plex Web updates can change its Play buttons, which may need an extension update.

## Privacy

The extension talks only to your Plex server and plex.tv, using Plex Web's existing
sign-in. The link handed to IINA contains your server's access token, like any direct
Plex file link; it stays on your Mac. No analytics.

## Development

[`plex-to-iina/`](plex-to-iina) is the extension, [`safari/`](safari) the Safari app and
its build script, [`iina-plugin/`](iina-plugin) the progress plugin, and
[`tools/mock-pms.py`](tools/mock-pms.py) a stand-in Plex server for testing. Conventions
are in [CLAUDE.md](CLAUDE.md), changes in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
