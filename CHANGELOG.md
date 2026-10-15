# Changelog

All notable changes to this project. Sections: **Added** (new features), **Improved**
(quality-of-life and performance), **Fixed** (bug fixes). Versions follow
[Semantic Versioning](https://semver.org).

## [Unreleased]

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
