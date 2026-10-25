# Changelog

All notable changes to this project. Sections: **Added** (new features), **Improved**
(quality-of-life and performance), **Fixed** (bug fixes). Versions follow
[Semantic Versioning](https://semver.org).

## [Unreleased]

### Added

- Starts on the best audio track in your languages: the first of your languages that
  the file has audio in, then lossless first and the most channels. If another language
  has clearly better audio, the message after pressing Play says so. Plex's subtitle
  choice is used, so you rarely need to switch tracks in IINA, which makes it download
  its buffer again. Turn it off in the popup to use Plex's audio choice.
- Subtitles for other languages: when the audio isn't in one of your languages and Plex
  picked no subtitles, the best subtitles in your language are turned on (full before
  forced-only, regular before SDH). Set your languages in the popup, or leave it empty
  to use your browser's languages.

### Improved

- Rewinding plays from memory instead of downloading again: IINA keeps a fifth of the
  buffer size of what you just watched (1 GB at the 5 GB setting, about 90 seconds of
  a 4K remux).
- After jumping to a part that isn't buffered yet, playback resumes once 2 seconds are
  loaded and the rest fills in the background, instead of waiting for IINA's cache
  setting (up to 10 seconds).

### Fixed

- When Plex shows its own Resume Playback dialog, choosing **Resume from …** or
  **Start from the beginning** now plays in IINA, from that point, instead of in Plex's
  player. If the file can't be found, Plex plays it as before.

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
