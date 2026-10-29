# Changelog

All notable changes to this project. Sections: **Added** (new features), **Improved**
(quality-of-life and performance), **Fixed** (bug fixes). Versions follow
[Semantic Versioning](https://semver.org).

## [Unreleased]

### Added

- **Downloads play like streams:** an episode opened from the Downloads library or
  from Finder now gets the next episode, Up Next and Skip Intro too (once you've
  streamed from its server in IINA).
- **Skip Intro from chapters:** when Plex hasn't marked an episode's intro or credits,
  chapters named like "Opening", "Intro", "Ending" or "Credits" give the Skip Intro
  button and Up Next, also offline. Chapters in an unlikely place or of an unlikely
  length are ignored, and chapter intros are never skipped automatically.

### Improved

- **New icon:** the app and the extension now show an amber monitor with a play
  symbol, so they're no longer easy to mistake for IINA.

### Fixed

- **Next episode offline:** a downloaded episode now goes on to the next downloaded
  episode of the show when the Plex server can't be reached.
- **Resume from IINA's history:** reopening an episode from IINA's recent files now
  starts where Plex says you stopped, instead of where the original link started.

## [2.0.0] - 2026-10-26

Binge a series in IINA, take episodes with you offline, and a cleaner look throughout.
Reinstall the IINA plugin for this version (see **Upgrading**).

### Added

- **Next episode:** when an episode ends, the next one plays, across seasons, where you
  left off and in the same audio and subtitle languages. It's in IINA's playlist, so
  Next Media reaches it too. IINA's **Play next item automatically** turns it off.
- **Up Next:** when the end credits start, a card plays the next episode after 10
  seconds; **Watch Credits** keeps you on this one.
- **Skip Intro** and **Skip Credits** buttons where Plex has found them (Plex Pass
  servers), and **Skip Intros Automatically** in IINA's Plugin menu.
- **Download** button next to Play: saves a film, a number of episodes or the rest of the
  season to Downloads › Plex to IINA, to watch without the server. It shows the total
  size first, skips what you already have and downloads one at a time.
- **Keep ahead:** the Plex to IINA app keeps a number of unwatched episodes of a show
  downloaded, topping up whenever it can reach your server, also in the background.
- Downloads play from disk, with nothing to buffer, when you press Play or IINA reaches
  them in its playlist. Their progress goes to Plex once the server can be reached, and
  watched downloads move to the Trash (untick **Move Watched Downloads to Trash** in
  IINA's Plugin menu to keep them).
- The Plex to IINA app's window (Safari) is a library of your downloads, with posters and
  one-click Play.
- **Your languages:** audio starts in the first of your languages the file has, lossless
  and most channels first, with a note if another language has clearly better audio.
  When the audio isn't in your language and Plex picked no subtitles, the best ones in
  your language turn on.
- An icon for the app and the extension.

### Improved

- The popup is regrouped into Playback, Audio & subtitles and Downloads, with switches,
  short hints and the version; settings that don't apply are dimmed.
- The message after pressing Play and the Download panel have a cleaner, shared look.
- Reaching the end credits marks an episode or film as watched, even before 90%.
- Rewinding plays from memory: IINA keeps a fifth of the buffer size of what you just
  watched.
- After jumping to a part that isn't buffered yet, playback resumes once 2 seconds are
  loaded, instead of waiting up to 10.

### Fixed

- Plex's own Resume Playback dialog (**Resume from …** or **Start from the beginning**)
  now plays in IINA, from that point.
- IINA starts where Plex says, also when IINA remembers its own position for the file.

### Upgrading

- **BREAKING:** install the new IINA plugin package and allow it to show buttons over
  the video and to access files when IINA asks. With the old plugin, progress still
  syncs but nothing else above works.
- Chrome: click the reload button on the extension in `chrome://extensions`.
- Safari: run `safari/build.sh` again, then restart Safari.

## [1.1.0] - 2026-10-15

First public release.

### Added

- Press Play in Plex Web (Chrome or Safari) to open the original file in IINA, with no
  transcoding: full-bitrate 4K remuxes and lossless TrueHD and DTS-HD MA audio.
- Works with the Play button on item pages, the round play button on posters, and the
  play button on library-grid cards.
- Shows and seasons start at the On Deck or next unwatched episode; items with several
  versions play the highest-quality one.
- Resume from the Plex watch position.
- Buffer size setting (1, 2 or 5 GB of read-ahead).
- Safari companion app that opens IINA without asking for confirmation on every play.
- Plex Progress IINA plugin: reports playback to Plex, saves the resume point on pause and
  stop, and marks items watched past 90%, so Continue Watching stays up to date.
- Option-click Play to use Plex's own player.

### Improved

- The plugin doesn't repeat progress reports while playback is paused.

### Fixed

- Safari: if the companion app doesn't answer (right after a rebuild), the extension
  falls back to a normal link instead of waiting forever.
