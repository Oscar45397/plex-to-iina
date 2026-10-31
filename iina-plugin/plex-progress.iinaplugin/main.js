// Plex Progress for IINA
// When IINA plays a file streamed from Plex Media Server (a /library/parts/… URL, as opened
// by the Plex → IINA extension), report the playback position back to the server, so
// Continue Watching and watched status stay in sync. For episodes, also line up the next
// one in IINA's playlist and show Up Next when the credits start; and where Plex has found
// the intro or credits, offer to skip them.
//
// The extension adds plexRatingKey=<id> to the file URL; Plex ignores it, and we use it to
// know which library item is playing. The server address and token come from the same URL.
// It also adds plexStart=<seconds or none>, where the file should start, and plexAt=<ms>,
// when the link was made (see the on_load hook).
//
// A file downloaded by the extension is treated as the same Plex item (downloadItem): next
// episode, Up Next and markers work the same; its progress goes through the Downloaded files
// section, which keeps it until the server answers.
(() => {
  'use strict';

  const { core, console, event, http, menu, mpv, overlay, playlist, preferences } = iina;

  const VERSION = '2.0.0';
  const PART_PATH = /^\/library\/parts\/(\d+)\//;
  const LIBRARY = 'com.plexapp.plugins.library';
  const SAMPLE_MS = 1000; // read the position this often, so a stop reports a fresh one
  const REPORT_MS = 10000; // tell Plex this often while playing
  const SETTLE_MS = 1000; // fold a burst of seeks or pause toggles into one report
  const WATCHED_AT = 0.9; // Plex's default "video played threshold"
  const LOOKUP_MS = 5000; // how long the next episode may wait for Plex before it starts anyway
  const COUNTDOWN_S = 10; // from the start of the end credits to the next episode
  const UP_NEXT_S = 20; // without end-credits marker: Up Next for the last 20 s (at most 10%)

  // The Plex item playing in this window, or null.
  let item = null;
  // The audio and subtitle streams last played (see playingTracks), so the next episode
  // can start with the same languages.
  let lastTracks = null;
  // Details looked up before an item opens (the next episode, or while it's being opened),
  // so opening it doesn't wait for the server again: ratingKey → { details, at }.
  const prefetched = new Map();
  const PREFETCH_MS = 3 * 3600 * 1000; // older than this, ask again: it may have been watched elsewhere
  const prefetch = (ratingKey, details) => prefetched.set(ratingKey, { details, at: Date.now() });
  const prefetchedDetails = (ratingKey) => {
    const hit = prefetched.get(ratingKey);
    return hit && Date.now() - hit.at < PREFETCH_MS ? hit.details : null;
  };

  // Player events and network replies arrive on IINA's background threads, holding the
  // plugin's lock. Changing the playlist, playing an entry or seeking from there can
  // deadlock IINA, which finishes those on the main thread, where it may be waiting for
  // the same lock. IINA runs timers on the main thread, so those actions go through here.
  const onMain = (fn) => setTimeout(fn, 0);

  // ---- Player events -------------------------------------------------------------

  event.on('iina.file-loaded', (url) => {
    finish();
    const path = mpv.getString('path') || url;
    item = parsePlexUrl(path) || downloadItem(path);
    if (!item) return;
    console.log(item.local
      ? `Downloaded file of /library/metadata/${item.ratingKey}: next episode and markers from ${item.origin}`
      : `Reporting progress of /library/metadata/${item.ratingKey} to ${item.origin}`);
    sample(item);
    item.sampler = setInterval(tick, SAMPLE_MS);
    lookUp(item);
  });

  // Fires when playback starts (after the resume seek) and again after every seek.
  event.on('mpv.playback-restart', () => {
    if (!item) return;
    if (!item.started) {
      item.started = true;
      // The start time was for this file; don't let the next one in this window inherit it.
      mpv.set('start', 'none');
    }
    sample(item);
    const current = item;
    onMain(() => refresh(current));
    reportSoon();
  });
  event.on('mpv.pause.changed', reportSoon);
  // Closing the window stops the player before this fires, so the position is still the
  // last one played. end-file covers the rest: end of file, next playlist item, a new URL.
  event.on('iina.window-will-close', finish);
  event.on('mpv.end-file', finish);

  function tick() {
    if (!item) return;
    sample(item);
    refresh(item);
    // While a settle timer is pending, a report is already on its way. While paused the
    // position doesn't move, and pausing already reported it, so stay quiet until resumed.
    if (item && item.settle === null && !item.paused && Date.now() - item.lastReport >= REPORT_MS) report(item);
  }

  function reportSoon() {
    if (!item || item.settle !== null) return;
    const current = item;
    current.settle = setTimeout(() => {
      current.settle = null;
      if (item !== current) return;
      sample(current);
      report(current);
    }, SETTLE_MS);
  }

  function finish() {
    if (!item) return;
    const done = item;
    item = null;
    clearInterval(done.sampler);
    if (done.settle !== null) clearTimeout(done.settle);
    showOverlay(NOTHING);
    // No fresh sample here: the player may already be tearing down. The last one is at
    // most a second old, and at the end of the file it equals the duration.
    report(done, 'stopped');
  }

  // core.status keeps the last known position after the player stops, unlike mpv's
  // time-pos, which becomes unavailable.
  function sample(it) {
    // Once IINA starts on the next file, its position is that file's: keep the last one.
    if (ratingKeyOf(mpv.getString('path')) !== it.ratingKey) return;
    const position = core.status.position;
    const duration = core.status.duration;
    if (typeof position === 'number' && position >= 0) it.position = position;
    if (typeof duration === 'number' && duration > 0) it.duration = duration;
    it.paused = mpv.getFlag('pause');
    if (it.streams) {
      // No audio track means the file is closing, not a choice to keep for the next one.
      const tracks = playingTracks(it);
      if (tracks.audio !== null) lastTracks = tracks;
    }
  }

  // ---- Reporting to Plex ---------------------------------------------------------

  function report(it, state = it.paused ? 'paused' : 'playing') {
    // Until the first frame plays, the position is 0, not the resume point; reporting it
    // would wipe the item's place in Continue Watching.
    // A downloaded file's progress is saved and sent by the Downloaded files section.
    if (!it.started || it.local) return;
    it.lastReport = Date.now();
    markWatchedIfDone(it);
    const params = {
      ratingKey: it.ratingKey,
      key: `/library/metadata/${it.ratingKey}`,
      identifier: LIBRARY,
      state,
      time: String(Math.round(it.position * 1000)),
    };
    if (it.duration) params.duration = String(Math.round(it.duration * 1000));
    plexGet(it, '/:/timeline', params).then((ok) => {
      if (it.announced || item !== it) return;
      it.announced = true;
      core.osd(ok ? 'Syncing progress with Plex' : "Couldn't reach Plex to save progress");
    });
    // The timeline drives Now Playing. On pause and stop, also write the resume point
    // directly, so Continue Watching updates even if the server ignores this player's
    // timeline. Skipped once watched: a late resume point would put it back on deck.
    if (state !== 'playing' && !it.scrobbled) {
      plexGet(it, '/:/progress', { key: it.ratingKey, identifier: LIBRARY, time: params.time, state });
    }
  }

  // Once per file, the first time playback passes the threshold or reaches the end credits.
  function markWatchedIfDone(it) {
    if (it.scrobbled || !it.duration) return;
    const atCredits = it.endCredits && it.position >= it.endCredits.start;
    if (!atCredits && it.position / it.duration < WATCHED_AT) return;
    it.scrobbled = true;
    plexGet(it, '/:/scrobble', { key: it.ratingKey, identifier: LIBRARY }).then((ok) => {
      if (!ok) {
        it.scrobbled = false; // try again with the next report
        return;
      }
      console.log(`Marked /library/metadata/${it.ratingKey} as watched`);
      if (item === it) core.osd('Marked as watched in Plex');
    });
  }

  // Resolves to true on success. Never logs the URL: it would include the token.
  function plexGet(it, path, params) {
    return plexRequest(it, path, params).then((res) => Boolean(res));
  }

  // Resolves to the response's MediaContainer, or null.
  function plexJson(it, path, params = {}) {
    return plexRequest(it, path, params).then((res) => {
      if (!res) return null;
      try {
        const body = res.data && typeof res.data === 'object' ? res.data : JSON.parse(res.text);
        return body.MediaContainer ?? null;
      } catch {
        console.warn(`${path}: not JSON`);
        return null;
      }
    });
  }

  function plexRequest(it, path, params) {
    if (it.token) params['X-Plex-Token'] = it.token;
    let request;
    try {
      request = http.get(it.origin + path, { params, headers: plexHeaders() });
    } catch (err) {
      console.error(`${path}: ${err}`);
      return Promise.resolve(null);
    }
    // http.get returns nothing when the host isn't in allowedDomains.
    if (!request) return Promise.resolve(null);
    return request.then(
      (res) => res,
      (res) => {
        const status = res && res.statusCode ? `HTTP ${res.statusCode} ${res.reason || ''}` : 'no response';
        console.warn(`${path} failed: ${status.trim()}`);
        return null;
      },
    );
  }

  // Plex lists the player under Settings → Devices and in the dashboard's Now Playing
  // using these. The identifier stays the same across launches.
  let clientId = null;

  function plexHeaders() {
    return {
      Accept: 'application/json',
      'X-Plex-Client-Identifier': clientId || (clientId = clientIdentifier()),
      'X-Plex-Product': 'IINA',
      'X-Plex-Version': VERSION,
      'X-Plex-Platform': 'macOS',
      'X-Plex-Device': 'Mac',
      'X-Plex-Device-Name': 'IINA',
    };
  }

  function clientIdentifier() {
    const saved = preferences.get('clientIdentifier');
    if (saved) return saved;
    const id = 'iina-xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
    preferences.set('clientIdentifier', id);
    preferences.sync();
    return id;
  }

  // ---- Markers and the next episode ----------------------------------------------

  // Plex's intro and credits markers, and for an episode the next one, which goes into
  // IINA's playlist right away: IINA plays it when this one ends (unless "Play next item
  // automatically" is off in its settings), and Next Media reaches it.
  async function lookUp(it) {
    let details = prefetchedDetails(it.ratingKey);
    prefetched.delete(it.ratingKey);
    if (!details) {
      details = (await plexJson(it, `/library/metadata/${it.ratingKey}`, { includeMarkers: '1' }))?.Metadata?.[0];
    }
    if (item !== it) return;
    if (!details) {
      // No answer, for example away from home with a downloaded episode: queue the next
      // download from the same folder instead.
      onMain(() => {
        if (item !== it) return;
        setMoments(it, null);
        refresh(it);
      });
      const next = nextDownload(it);
      if (next) onMain(() => {
        if (item !== it) return;
        it.next = next;
        it.queued = queue(next);
        console.log(`Up next, from your downloads: /library/metadata/${next.ratingKey}${it.queued ? ', added to the playlist' : ''}`);
        addUpNext(it);
        refresh(it);
      });
      return;
    }
    it.streams = streamsOf(partOf(details, it.partId));
    setMoments(it, details);
    if (details.type !== 'episode') return;
    const next = await nextEpisode(it, details);
    if (!next || item !== it) return;
    onMain(() => {
      if (item !== it) return;
      it.next = next;
      it.queued = queue(next);
      console.log(`Up next: /library/metadata/${next.ratingKey}${it.queued ? ', added to the playlist' : ''}`);
      addUpNext(it);
      refresh(it);
    });
  }

  // The next episode in Plex's order: the next one in this season, else the first episode of
  // the next season that has any. Specials (season 0) come first in a show, so they're only
  // reached from another special.
  async function nextEpisode(it, details) {
    const children = async (key) => (await plexJson(it, `/library/metadata/${key}/children`))?.Metadata ?? [];
    const episodes = (await children(details.parentRatingKey)).filter((m) => m.type === 'episode');
    const here = episodes.findIndex((ep) => String(ep.ratingKey) === it.ratingKey);
    if (here < 0) return null;
    let next = episodes[here + 1];
    if (!next) {
      const seasons = (await children(details.grandparentRatingKey)).filter((m) => m.type === 'season');
      const season = seasons.findIndex((s) => String(s.ratingKey) === String(details.parentRatingKey));
      for (const s of season < 0 ? [] : seasons.slice(season + 1)) {
        next = (await children(s.ratingKey)).find((m) => m.type === 'episode');
        if (next) break;
      }
    }
    if (!next) return null;
    // Season lists leave out some details; the episode's own entry has them all. Kept for
    // when it opens (prefetch), so it starts without asking the server again.
    const full = (await plexJson(it, `/library/metadata/${next.ratingKey}`, { includeMarkers: '1' }))?.Metadata?.[0];
    const part = full && bestMedia(full)?.Part?.[0];
    if (!part?.key) return null;
    const ratingKey = String(full.ratingKey);
    prefetch(ratingKey, full);
    // A downloaded episode goes into the playlist as the file itself, not the stream: IINA
    // reads the length of what's next in the playlist ahead of time, and opens a stream URL
    // as a network stream, with buffering, even if the on_load hook then plays the file.
    const local = downloadedCopy(it.origin, ratingKey);
    if (local) console.log(`Next episode /library/metadata/${ratingKey} is downloaded: queued from disk`);
    return {
      ratingKey,
      url: local || `${it.origin}${part.key}?${it.token ? `X-Plex-Token=${encodeURIComponent(it.token)}&` : ''}plexRatingKey=${ratingKey}`,
      label: episodeLabel(full),
      title: full.title ?? '',
      show: full.grandparentTitle ?? '',
      thumb: full.thumb ? thumbUrl(it, full.thumb) : null,
    };
  }

  // The download after this one in its show's folder, in "S01E02 - …" order, for when the
  // server doesn't answer. Its playlist entry is the file itself, which is then a download
  // like any other (downloadItem): its progress is kept until the server answers, and it
  // gets its own Up Next.
  function nextDownload(it) {
    const path = playingDownloads.get(it.ratingKey);
    if (!path) return null;
    const folder = path.slice(0, path.lastIndexOf('/'));
    const order = (name) => {
      const m = /^S(\d+)E(\d+)/i.exec(name);
      return m && DOWNLOAD_TAG.test(name) ? [Number(m[1]), Number(m[2])] : null;
    };
    let files;
    try {
      files = (iina.file.list(folder, {}) || []).filter((e) => !e.isDir && order(e.filename));
    } catch {
      return null;
    }
    files.sort((a, b) => {
      const [x, y] = [order(a.filename), order(b.filename)];
      return x[0] - y[0] || x[1] - y[1];
    });
    const here = files.findIndex((e) => DOWNLOAD_TAG.exec(e.filename)[2] === it.ratingKey);
    const file = here < 0 ? null : files[here + 1];
    if (!file) return null;
    const ratingKey = DOWNLOAD_TAG.exec(file.filename)[2];
    const name = file.filename.replace(/\s*\{plex-[^}]*\}\.[A-Za-z0-9]+$/, '');
    const label = /^S\d+E\d+/i.exec(name)[0].toUpperCase();
    return {
      ratingKey,
      url: `${folder}/${file.filename}`,
      label,
      title: name.replace(/^S\d+E\d+\s*-?\s*/i, ''),
      show: folder.split('/').pop(),
      thumb: null,
    };
  }

  // Add the next episode after the current item, if that's the last one in the playlist.
  // A playlist that already goes on (one the user built, or after going back with Previous
  // Media) stays as it is. Returns whether the next playlist item is that episode.
  function queue(next) {
    const items = playlist.list();
    const current = items.findIndex((p) => p.isCurrent);
    if (current < 0) return false;
    if (current < items.length - 1) return ratingKeyOf(items[current + 1].filename) === next.ratingKey;
    playlist.add(next.url, -1); // the index is required: without it, IINA puts it first
    return true;
  }

  function playNext(it) {
    if (!it.next || it.leaving) return;
    it.leaving = true;
    const items = playlist.list();
    const current = items.findIndex((p) => p.isCurrent);
    let index = items.findIndex((p, i) => i > current && ratingKeyOf(p.filename) === it.next.ratingKey);
    if (index < 0) {
      playlist.add(it.next.url, -1);
      index = items.length;
    }
    console.log(`Playing the next episode, /library/metadata/${it.next.ratingKey}`);
    playlist.play(index);
  }

  // Before IINA opens a file, set where it starts, and for a file from the playlist which
  // tracks it plays. mpv runs this hook after it has loaded IINA's saved position for the
  // file ("Resume last playback position"), so what's set here wins.
  //
  // Files the extension opens replace the playlist, so they're alone in it. The extension
  // has chosen their tracks, and their start is in the link (mpv_start) and in the URL
  // (plexStart). IINA sets the link's start while mpv is already opening the file, so a
  // saved position for the same URL would load on top of it: set it again from the URL.
  //
  // Files from the playlist (the next episode, or Next or Previous Media) would otherwise
  // keep the previous file's settings: its start time and its track numbers, which can
  // mean another language in this file.
  mpv.addHook('on_load', 50, async (next) => {
    try {
      if (mpv.getNumber('playlist-count') < 2) await startWhereLinked();
      else await prepareFromPlaylist();
    } catch (err) {
      console.error(`Preparing the next file: ${err}`);
    }
    next();
  });

  // A link reopened later, from IINA's history or Open Recent, still carries the start it
  // was made with. Then resume where Plex says instead, or, if the server doesn't answer,
  // where IINA saved it.
  async function startWhereLinked() {
    const path = mpv.getString('path');
    const it = parsePlexUrl(path, { quiet: true });
    const start = it && linkedStart(path);
    if (!start) return; // opened some other way, or by an older extension: leave it to IINA
    if (freshLink(path)) {
      mpv.set('start', start);
      console.log(`Opening /library/metadata/${it.ratingKey}: start ${start === 'none' ? 'at the beginning' : `at ${Math.round(Number(start))} s`}, as linked`);
      return;
    }
    const details = (await within(LOOKUP_MS, plexJson(it, `/library/metadata/${it.ratingKey}`, { includeMarkers: '1' })))?.Metadata?.[0];
    if (!details) {
      console.log(`Reopening /library/metadata/${it.ratingKey}: Plex didn't answer, resuming where IINA saved it`);
      return;
    }
    const offset = details.viewOffset > 0 ? details.viewOffset / 1000 : 0;
    mpv.set('start', offset ? String(offset) : 'none');
    prefetch(it.ratingKey, details);
    console.log(`Reopening /library/metadata/${it.ratingKey}: start ${offset ? `at ${Math.round(offset)} s` : 'at the beginning'}, where Plex says`);
  }

  // Whether the link was made in the last minute, so it was just clicked in Plex Web.
  function freshLink(url) {
    const at = Number(/[?&]plexAt=(\d+)/.exec(url || '')?.[1]);
    return Boolean(at) && Math.abs(Date.now() - at) < 60000;
  }

  async function prepareFromPlaylist() {
    const path = mpv.getString('path');
    const it = parsePlexUrl(path, { quiet: true }) || downloadItem(path);
    if (!it) return;
    const details = prefetchedDetails(it.ratingKey)
      || (await within(LOOKUP_MS, plexJson(it, `/library/metadata/${it.ratingKey}`, { includeMarkers: '1' })))?.Metadata?.[0];
    // Resume where Plex says, like the extension does by default.
    const offset = details?.viewOffset > 0 ? details.viewOffset / 1000 : 0;
    const tracks = details ? matchTracks(lastTracks, streamsOf(partOf(details, it.partId))) : { aid: 'auto', sid: 'auto' };
    mpv.set('start', offset ? String(offset) : 'none');
    mpv.set('aid', tracks.aid);
    mpv.set('sid', tracks.sid);
    if (details) prefetch(it.ratingKey, details);
    console.log(`Opening /library/metadata/${it.ratingKey} from the playlist: start ${offset ? `at ${Math.round(offset)} s` : 'at the beginning'}, audio ${tracks.aid}, subtitles ${tracks.sid}`);
  }

  function within(ms, promise) {
    return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
  }

  // ---- Choosing tracks -----------------------------------------------------------

  // A file's audio and subtitle streams, as mpv numbers them: from 1 per type, in file
  // order, which is Plex's `index` order. Separate subtitle files have no index.
  function streamsOf(part) {
    const streams = part?.Stream ?? [];
    const byIndex = (a, b) => a.index - b.index;
    return {
      audio: streams.filter((s) => s.streamType === 2 && s.index != null).sort(byIndex),
      subtitles: streams.filter((s) => s.streamType === 3 && s.index != null).sort(byIndex),
    };
  }

  // The Plex streams playing now: a stream, null when the track is off, or undefined when
  // it can't be told (a subtitle file added in IINA, say).
  function playingTracks(it) {
    const playing = (type, list) => {
      const track = mpv.getNative(`current-tracks/${type}`);
      if (!track) return null;
      return track.external ? undefined : list[track.id - 1];
    };
    return { audio: playing('audio', it.streams.audio), subtitle: playing('sub', it.streams.subtitles) };
  }

  // The next file's tracks that are most like the ones just played: the same language
  // first, then the same kind (commentary or not; forced, SDH or full subtitles), codec,
  // channels and title. Subtitles stay off if they were off, or if this file has none in
  // that language. mpv chooses when nothing is known.
  function matchTracks(previous, streams) {
    const audio = previous?.audio && closest(streams.audio, previous.audio, audioLikeness);
    let sid = 'auto';
    if (previous?.subtitle === null) sid = 'no';
    else if (previous?.subtitle) {
      const subtitle = closest(streams.subtitles, previous.subtitle, subtitleLikeness);
      sid = subtitle ? String(streams.subtitles.indexOf(subtitle) + 1) : 'no';
    }
    return { aid: audio ? String(streams.audio.indexOf(audio) + 1) : 'auto', sid };
  }

  function closest(candidates, target, likeness) {
    const same = candidates.filter((s) => languageOf(s) === languageOf(target));
    return same.reduce((best, s) => (likeness(s, target) > likeness(best, target) ? s : best), same[0]);
  }

  function audioLikeness(s, t) {
    return (isCommentary(s) === isCommentary(t) ? 8 : 0) + (s.codec === t.codec ? 4 : 0)
      + (s.channels === t.channels ? 2 : 0) + (s.title === t.title ? 1 : 0);
  }

  function subtitleLikeness(s, t) {
    return (isForced(s) === isForced(t) ? 8 : 0) + (isSdh(s) === isSdh(t) ? 4 : 0)
      + (s.codec === t.codec ? 2 : 0) + (s.title === t.title ? 1 : 0);
  }

  const labelOf = (s) => `${s.title ?? ''} ${s.displayTitle ?? ''}`;
  const languageOf = (s) => String(s.languageCode || s.languageTag || s.language || '').toLowerCase();
  const isCommentary = (s) => /commentary/i.test(labelOf(s));
  const isForced = (s) => Boolean(s.forced) || /\bforced\b/i.test(labelOf(s));
  const isSdh = (s) => Boolean(s.hearingImpaired) || /\b(sdh|cc)\b/i.test(labelOf(s));

  // ---- Skip Intro, Skip Credits, Up Next -----------------------------------------

  const NOTHING = { kind: 'none' };

  // The stretches of the file where a button shows: Skip Intro, Skip Credits for credits
  // with more to come after them, and Up Next from the start of the end credits. Without
  // an end-credits marker, Up Next shows for the last seconds and the episode plays out.
  // details is null when the server didn't answer; then only the file's chapters count.
  function setMoments(it, details) {
    const markers = (details?.Marker ?? [])
      .map((m) => ({ type: m.type, start: m.startTimeOffset / 1000, end: m.endTimeOffset / 1000, final: m.final }))
      .filter((m) => m.end > m.start);
    it.listedDuration = (details?.duration ?? 0) / 1000;
    // Plex's markers come first; the file's chapters fill in a kind Plex hasn't marked.
    const fromChapters = chapterMarkers(mpv.getNumber('duration') || it.listedDuration)
      .filter((c) => !markers.some((m) => m.type === c.type));
    if (fromChapters.length) {
      console.log(`From the file's chapters: ${fromChapters.map((c) => `${c.type} ${Math.round(c.start)}-${Math.round(c.end)} s`).join(', ')}`);
      markers.push(...fromChapters);
    }
    const credits = markers.filter((m) => m.type === 'credits');
    // Older servers don't mark the end credits: then it's credits that run to the end.
    const end = it.listedDuration || it.duration;
    it.endCredits = credits.find((m) => m.final) ?? credits.filter((m) => m.end >= end - 15).pop() ?? null;
    it.moments = [
      // Only Plex's intros are skipped automatically; a chapter's intro gets the button.
      ...markers.filter((m) => m.type === 'intro').map((m) => ({ ...m, kind: 'skip', label: 'Skip Intro', intro: !m.chapter })),
      ...credits.filter((m) => m !== it.endCredits).map((m) => ({ ...m, kind: 'skip', label: 'Skip Credits' })),
    ];
  }

  // Intro and credits from the file's chapters, as many releases name them ("Opening",
  // "OP", "Intro", "Ending", "ED", "Credits"). A chapter only counts when it's where and as
  // long as an intro or credits would be, so a wrongly named chapter can't skip the episode
  // itself: an intro within the first 35% (at most 10 minutes in) and 10 s to 3 min long,
  // only one of them; credits in the last 40% and 10 s to 10 min long. Credits count as the
  // end credits (for Up Next) when at most 2 minutes follow them, such as a preview.
  const INTRO_CHAPTER = /^(intro|opening|op|opening (song|theme|titles|credits)|title sequence|theme song)( ?\d+)?$/i;
  const CREDITS_CHAPTER = /^(credits|end credits|closing credits|ending|ed|ending (song|theme|credits)|outro)( ?\d+)?$/i;

  function chapterMarkers(duration) {
    let list;
    try {
      list = mpv.getNative('chapter-list') || [];
    } catch {
      return [];
    }
    if (!duration || list.length < 2) return [];
    const intros = [];
    const credits = [];
    list.forEach((c, i) => {
      const title = String(c.title || '').trim();
      const start = Number(c.time);
      const end = i + 1 < list.length ? Number(list[i + 1].time) : duration;
      const length = end - start;
      if (!(length > 0)) return;
      if (INTRO_CHAPTER.test(title)) {
        if (start <= Math.min(600, duration * 0.35) && length >= 10 && length <= 180) intros.push({ type: 'intro', start, end, chapter: true });
        else console.log(`Ignored the chapter "${title}": not where or as long as an intro`);
      } else if (CREDITS_CHAPTER.test(title)) {
        if (start >= duration * 0.6 && length >= 10 && length <= 600) credits.push({ type: 'credits', start, end, chapter: true });
        else console.log(`Ignored the chapter "${title}": not where or as long as credits`);
      }
    });
    const last = credits[credits.length - 1];
    if (last && duration - last.end <= 120) last.final = true;
    return [...(intros.length === 1 ? intros : []), ...credits];
  }

  function addUpNext(it) {
    const duration = it.listedDuration || it.duration;
    if (!duration) return;
    const start = it.endCredits?.start ?? duration - Math.min(UP_NEXT_S, duration * (1 - WATCHED_AT));
    it.moments.push({ kind: 'up-next', start, end: Infinity, credits: Boolean(it.endCredits) });
  }

  // Called every second and after seeks, on the main thread (see onMain): decide what the
  // overlay shows, and act on automatic intro skipping and the Up Next countdown.
  function refresh(it) {
    showOverlay(item === it ? decide(it) : NOTHING);
  }

  function decide(it) {
    if (!it.started || it.leaving) return NOTHING;
    const t = it.position;
    const inside = (m) => t >= m.start && t < m.end - 0.5;
    // A dismissed button comes back if you go back to before it.
    for (const m of it.dismissed) if (!inside(m)) it.dismissed.delete(m);
    const found = it.moments.find(inside);
    const moment = found && !it.dismissed.has(found) ? found : null;
    it.moment = moment;
    if (moment?.kind !== 'up-next') it.deadline = null;
    if (!moment) return NOTHING;

    if (moment.kind === 'skip') {
      // Automatic skipping happens once: going back to watch the intro is left alone.
      if (moment.intro && !it.autoSkipped.has(moment) && autoSkipIntros()) {
        it.autoSkipped.add(moment);
        core.seekTo(moment.end);
        core.osd('Skipped the intro');
        return NOTHING;
      }
      return { kind: 'skip', label: moment.label };
    }

    // Up Next. With autoplay, count down: from the end credits, then play the next
    // episode; without the marker, until the episode ends and IINA plays the next.
    const autoplay = it.queued && mpv.getString('keep-open') !== 'always';
    let left = null;
    let total = null;
    if (autoplay && moment.credits) {
      if (it.deadline === null) it.deadline = Math.max(t, Math.min(t + COUNTDOWN_S, it.duration - 1));
      if (t >= it.deadline) {
        playNext(it);
        return NOTHING;
      }
      left = it.deadline - t;
      total = COUNTDOWN_S;
    } else if (autoplay) {
      left = Math.max(0, it.duration - t);
      total = it.duration - moment.start;
    }
    return {
      kind: 'up-next',
      show: it.next.show,
      label: it.next.label,
      title: it.next.title,
      thumb: it.next.thumb,
      left: left === null ? null : Math.ceil(left),
      // Where the countdown bar should be when the next update comes, a second from now;
      // the page animates to it.
      fraction: left === null ? null : Math.min(1, Math.max(0, (it.paused ? left : left - 1) / total)),
      paused: it.paused,
      dismiss: moment.credits ? 'Watch Credits' : 'Hide',
    };
  }

  function autoSkipIntros() {
    return preferences.get('autoSkipIntros') === true;
  }

  // The overlay page (overlay.html) shows the buttons and sends back clicks. It loads once
  // per window; clicks only reach it while a button shows.
  let overlayReady = false;
  let shown = '';

  event.on('iina.window-loaded', () => {
    try {
      overlay.loadFile('overlay.html');
    } catch (err) {
      console.error(`Overlay: ${err}`);
    }
  });

  // Also fires when another plugin's overlay loads, so only set up once.
  event.on('iina.plugin-overlay-loaded', () => {
    if (overlayReady) return;
    overlayReady = true;
    overlay.onMessage('skip', () => {
      if (item?.moment?.kind === 'skip') core.seekTo(item.moment.end);
    });
    overlay.onMessage('play-next', () => {
      if (item) playNext(item);
      if (item) refresh(item);
    });
    overlay.onMessage('dismiss', () => {
      if (!item?.moment) return;
      item.dismissed.add(item.moment);
      refresh(item);
    });
    overlay.show();
    shown = '';
    if (item) refresh(item);
  });

  function showOverlay(state) {
    const json = JSON.stringify(state);
    if (!overlayReady || json === shown) return;
    shown = json;
    overlay.setClickable(state.kind !== 'none');
    overlay.postMessage('state', state);
  }

  // Plugin menu: a checkbox for skipping intros without asking.
  const autoSkipItem = menu.item('Skip Intros Automatically', () => {
    const on = !autoSkipIntros();
    preferences.set('autoSkipIntros', on);
    preferences.sync();
    autoSkipItem.selected = on;
    menu.forceUpdate();
    if (item) refresh(item);
  }, { selected: autoSkipIntros() });
  menu.addItem(autoSkipItem);
  // Each window has its own menu item; catch up with a change made in another window.
  event.on('iina.window-main.changed', () => {
    autoSkipItem.selected = autoSkipIntros();
  });

  // ---- Recognising Plex files ----------------------------------------------------

  // http(s)://<server>/library/parts/<id>/<ts>/file.mkv?X-Plex-Token=…&plexRatingKey=…
  // (No URL class here: IINA plugins run in plain JavaScriptCore, not a browser.)
  function parsePlexUrl(url, { quiet = false } = {}) {
    const match = /^(https?:\/\/[^/?#]+)(\/[^?#]*)(?:\?([^#]*))?/i.exec(url || '');
    const part = match && PART_PATH.exec(match[2]);
    if (!part) return null;
    const query = parseQuery(match[3] || '');
    const ratingKey = query.plexRatingKey;
    if (!/^\d+$/.test(ratingKey || '')) {
      if (!quiet) console.log('Plex file without plexRatingKey; update the Plex → IINA extension to report progress');
      return null;
    }
    return {
      origin: match[1],
      token: query['X-Plex-Token'] || '',
      ratingKey,
      partId: part[1],
      position: 0,
      duration: 0,
      paused: false,
      started: false,
      lastReport: 0,
      sampler: null,
      settle: null,
      announced: false,
      scrobbled: false,
      streams: null,
      next: null,
      queued: false,
      leaving: false,
      listedDuration: 0,
      endCredits: null,
      moments: [],
      moment: null,
      dismissed: new Set(),
      autoSkipped: new Set(),
      deadline: null,
      local: false,
    };
  }

  // The Plex item of a file the extension downloaded, from the tag in its name, using the
  // server address and token remembered for that server; null for other files, or a server
  // not streamed from yet. Its part ID isn't known, so the first part's details are used.
  function downloadItem(url) {
    const path = localPath(url || '');
    const tag = path && DOWNLOAD_TAG.exec(path.split('/').pop());
    const server = tag && loadPref(SERVERS_KEY)[tag[1]];
    if (!server) return null;
    const it = parsePlexUrl(`${server.origin}/library/parts/0/0/file?plexRatingKey=${tag[2]}`, { quiet: true });
    if (!it) return null;
    it.token = server.token;
    it.local = true;
    playingDownloads.set(it.ratingKey, path);
    return it;
  }

  function ratingKeyOf(url) {
    return /[?&]plexRatingKey=(\d+)/.exec(url || '')?.[1]
      ?? DOWNLOAD_TAG.exec(decode((url || '').split('/').pop()))?.[2] ?? null;
  }

  // The start the extension put in the URL: seconds, or 'none' for the beginning. Null
  // when there's none or it isn't one of those.
  function linkedStart(url) {
    const value = /[?&]plexStart=([^&#]*)/.exec(url || '')?.[1] ?? '';
    return value === 'none' || /^\d+(\.\d+)?$/.test(value) ? value : null;
  }

  function parseQuery(query) {
    const out = {};
    for (const pair of query.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      out[decode(eq < 0 ? pair : pair.slice(0, eq))] = decode(eq < 0 ? '' : pair.slice(eq + 1));
    }
    return out;
  }

  function decode(text) {
    try {
      return decodeURIComponent(text.replace(/\+/g, ' '));
    } catch {
      return text;
    }
  }

  // ---- Plex details --------------------------------------------------------------

  // The part being played, or the first one.
  function partOf(details, partId) {
    const parts = (details.Media ?? []).flatMap((m) => m.Part ?? []);
    return parts.find((p) => String(p.id) === String(partId)) ?? parts[0] ?? null;
  }

  // Like the extension: of several versions, the biggest, highest-bitrate one.
  function bestMedia(details) {
    return [...(details.Media ?? [])].sort(
      (a, b) => (b.width ?? 0) - (a.width ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0),
    )[0];
  }

  function episodeLabel(details) {
    const pad = (n) => String(n ?? '?').padStart(2, '0');
    return `S${pad(details.parentIndex)}E${pad(details.index)}`;
  }

  // A small copy of the thumbnail, made by the server.
  function thumbUrl(it, thumb) {
    const params = { width: '480', height: '270', minSize: '1', upscale: '1', url: thumb };
    if (it.token) params['X-Plex-Token'] = it.token;
    const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    return `${it.origin}/photo/:/transcode?${query}`;
  }

  // ---- Downloaded files ----------------------------------------------------------
  //
  // The extension's Download button saves files as "… {plex-<server>-<ratingKey>}.mkv",
  // where <server> is the first 8 characters of the server's machine identifier. While one
  // of those plays, keep its position and watched state in this plugin's preferences, and
  // send them to Plex whenever the server answers: right away at home, otherwise the next
  // time a downloaded or streamed file from that server plays in IINA.
  //
  // A local file carries no server address or token, so remember both from the last file
  // streamed from each server. Progress of downloads therefore syncs only for servers
  // you've streamed from in IINA at least once.
  //
  // Once you've watched a download (90%, as Plex counts it) and it closes, move it to the
  // Trash, unless "Move Watched Downloads to Trash" is unticked in the Plugin menu.
  //
  // Just before mpv opens a Plex stream, play a downloaded copy of that item from disk
  // instead, if there is one: Play in Plex Web adds its location as plexLocal=<path>
  // (content.js), and for other streams, such as the next episode in IINA's playlist, look
  // for the item's tag in ~/Downloads/Plex to IINA. Progress then goes to Plex as for any
  // stream.

  const DOWNLOAD_TAG = /\{plex-([0-9a-f]{8})-(\d+)\}\.[A-Za-z0-9]+$/;
  const SAVE_EVERY_MS = 30000; // while playing, save (and try to send) this often
  const KEEP_MS = 180 * 24 * 3600 * 1000; // give up on progress that couldn't be sent for this long
  const SERVERS_KEY = 'downloadServers'; // { "<server>": { origin, token } }
  const PENDING_KEY = 'downloadProgress'; // { "<server>-<ratingKey>": { …, time, duration, watched, at } }
  const TRASH_KEY = 'trashWatchedDownloads'; // on unless set to false

  // The downloaded file playing in this window, or null.
  let download = null;
  const syncing = new Set(); // servers with requests on their way
  const localCopies = new Map(); // stream URL → the downloaded file playing instead
  const playingDownloads = new Map(); // ratingKey → that file, for nextDownload

  // mpv's default for a file on disk: no read-ahead into memory, even if the network cache
  // is turned on in IINA's settings. Only for this file; the next stream keeps the cache.
  const noCacheForThisFile = () => mpv.set('file-local-options/cache', 'auto');

  mpv.addHook('on_load', 40, () => {
    const url = mpv.getString('stream-open-filename') || '';
    const stream = /^(https?:\/\/[^/?#]+)(\/[^?#]*)\?([^#]*)$/i.exec(url);
    if (!stream) {
      if (DOWNLOAD_TAG.test(decode(url.split('/').pop()))) noCacheForThisFile();
      return;
    }
    if (!PART_PATH.test(stream[2])) return;
    const query = parseQuery(stream[3]);
    const local = (query.plexLocal && existingCopy(query.plexLocal, query.plexRatingKey))
      || downloadedCopy(stream[1], query.plexRatingKey);
    if (local) {
      localCopies.set(url, local);
      playingDownloads.set(query.plexRatingKey, local);
      mpv.set('stream-open-filename', local);
      noCacheForThisFile();
      console.log(`Playing /library/metadata/${query.plexRatingKey} from its download`);
    } else if (query.plexLocal) {
      // Gone, for example moved to the Trash once watched: stream, without the local path.
      mpv.set('stream-open-filename', url.replace(/([?&])plexLocal=[^&#]*&?/, '$1').replace(/[?&]$/, ''));
    }
  });

  // A download of this item in ~/Downloads/Plex to IINA (or one folder down), found by its
  // tag; null if there's none. The tag needs the server's ID, known once you've streamed
  // from it (rememberServer).
  function downloadedCopy(origin, ratingKey) {
    if (!/^\d+$/.test(ratingKey || '')) return null;
    const servers = loadPref(SERVERS_KEY);
    const server = Object.keys(servers).find((id) => servers[id].origin === origin);
    if (!server) return null;
    const tag = `{plex-${server}-${ratingKey}}`;
    try {
      const root = iina.utils.resolvePath('~/Downloads/Plex to IINA');
      const folders = [root];
      for (const entry of iina.file.list(root, {}) || []) {
        if (entry.isDir && !entry.filename.startsWith('.')) folders.push(`${root}/${entry.filename}`);
      }
      for (const folder of folders) {
        const hit = (iina.file.list(folder, {}) || []).find((entry) => !entry.isDir
          && DOWNLOAD_TAG.test(entry.filename) && entry.filename.includes(tag));
        if (hit) return `${folder}/${hit.filename}`;
      }
    } catch {
      // No such folder: nothing downloaded.
    }
    return null;
  }

  // The absolute path of a downloaded file of this item that's still there, or null. Only
  // tagged files of the same item, so a link can't make IINA open anything else.
  function existingCopy(path, ratingKey) {
    const tag = DOWNLOAD_TAG.exec(path.split('/').pop());
    if (!tag || tag[2] !== ratingKey) return null;
    try {
      const absolute = iina.utils.resolvePath(path);
      return absolute && iina.file.exists(absolute) ? absolute : null;
    } catch {
      return null;
    }
  }

  event.on('iina.file-loaded', (url) => {
    endDownload();
    const path = mpv.getString('path') || url || '';
    const stream = /^(https?:\/\/[^/?#]+)(\/[^?#]*)(?:\?([^#]*))?/i.exec(path);
    if (stream) {
      if (PART_PATH.test(stream[2])) rememberServer(stream[1], parseQuery(stream[3] || '')['X-Plex-Token'] || '');
      const local = localCopies.get(path);
      localCopies.delete(path);
      // Playing a download instead of the stream: the stream code reports progress; this
      // section only moves the file to the Trash once watched.
      if (local) trackDownload(local, true);
      return;
    }
    trackDownload(path, false);
  });

  function trackDownload(path, viaStream) {
    const match = DOWNLOAD_TAG.exec(decode(path.split('/').pop()));
    if (!match) return;
    download = {
      path: localPath(path),
      server: match[1],
      ratingKey: match[2],
      viaStream,
      position: 0,
      duration: 0,
      started: false,
      watched: false,
      lastSave: Date.now(),
      sampler: null,
    };
    const current = download;
    current.sampler = setInterval(() => sampleDownload(current), SAMPLE_MS);
    if (viaStream) return;
    console.log(`Downloaded file of /library/metadata/${current.ratingKey}; progress syncs with Plex when the server answers`);
    syncDownloads(current.server);
  }

  event.on('mpv.playback-restart', () => {
    if (download) download.started = true;
  });
  event.on('mpv.pause.changed', () => {
    if (download && download.started && mpv.getFlag('pause')) saveDownload(download);
  });
  event.on('iina.window-will-close', endDownload);
  event.on('mpv.end-file', endDownload);

  function sampleDownload(it) {
    if (download !== it || !it.started) return;
    // Once IINA moves on to the next file (Up Next), positions are that file's: keep the last.
    if (ratingKeyOf(mpv.getString('path')) !== it.ratingKey) return;
    // Watched at the end credits, as Plex counts it for streams, so Up Next from the credits
    // still counts it as watched.
    if (item && item.ratingKey === it.ratingKey && item.endCredits && core.status.position >= item.endCredits.start) it.watched = true;
    const position = core.status.position;
    const duration = core.status.duration;
    if (typeof position === 'number' && position >= 0) it.position = position;
    if (typeof duration === 'number' && duration > 0) it.duration = duration;
    if (Date.now() - it.lastSave >= SAVE_EVERY_MS) saveDownload(it);
  }

  function endDownload() {
    if (!download) return;
    const done = download;
    download = null;
    clearInterval(done.sampler);
    // The last sample is at most a second old; the player may already be closing.
    saveDownload(done);
    if (done.watched && trashWatched()) trashDownload(done);
  }

  // The progress is already saved, so Plex still learns it was watched.
  function trashDownload(it) {
    if (!it.path) return;
    try {
      iina.file.trash(it.path);
      console.log(`Moved the watched download of /library/metadata/${it.ratingKey} to the Trash`);
      core.osd('Watched: moved the download to the Trash');
    } catch (err) {
      console.warn(`Couldn't move the watched download to the Trash: ${err}`);
    }
  }

  // An absolute path, from a path or a file:// URL; null for anything else.
  function localPath(path) {
    if (path.startsWith('file://')) return decode(path.slice('file://'.length).replace(/^localhost/, ''));
    return path.startsWith('/') ? path : null;
  }

  function trashWatched() {
    return preferences.get(TRASH_KEY) !== false;
  }

  // Plugin menu: a checkbox for moving watched downloads to the Trash.
  const trashItem = menu.item('Move Watched Downloads to Trash', () => {
    const on = !trashWatched();
    preferences.set(TRASH_KEY, on);
    preferences.sync();
    trashItem.selected = on;
    menu.forceUpdate();
  }, { selected: trashWatched() });
  menu.addItem(trashItem);
  // Each window has its own menu item; catch up with a change made in another window.
  event.on('iina.window-main.changed', () => {
    trashItem.selected = trashWatched();
  });

  // Store this file's progress, then try to send everything waiting for its server.
  function saveDownload(it) {
    it.lastSave = Date.now();
    if (!it.started) return;
    if (it.duration && it.position / it.duration >= WATCHED_AT) it.watched = true;
    if (it.viaStream) return; // reported to Plex as a stream
    const pending = loadPref(PENDING_KEY);
    const id = `${it.server}-${it.ratingKey}`;
    const before = pending[id];
    pending[id] = {
      server: it.server,
      ratingKey: it.ratingKey,
      time: Math.round(it.position * 1000),
      duration: Math.round(it.duration * 1000),
      // Once watched, stay watched until Plex knows, even if you rewind afterwards.
      watched: it.watched || Boolean(before && before.watched),
      at: Date.now(),
    };
    savePref(PENDING_KEY, pending);
    syncDownloads(it.server);
  }

  function rememberServer(origin, token) {
    plexCall(origin, token, '/identity', {}).then((res) => {
      const id = String(jsonOf(res)?.MediaContainer?.machineIdentifier || '').toLowerCase();
      if (!/^[0-9a-f]{8}/.test(id)) return;
      const servers = loadPref(SERVERS_KEY);
      const server = id.slice(0, 8);
      const known = servers[server];
      if (!known || known.origin !== origin || known.token !== token) {
        servers[server] = { origin, token };
        savePref(SERVERS_KEY, servers);
      }
      syncDownloads(server);
    });
  }

  // Send the waiting progress of one server's downloads: watched ones are marked watched,
  // the others get their resume point. Entries are removed once Plex has them.
  function syncDownloads(server) {
    const target = loadPref(SERVERS_KEY)[server];
    if (!target || syncing.has(server)) return;
    const pending = loadPref(PENDING_KEY);
    const waiting = Object.keys(pending).filter((id) => pending[id].server === server);
    if (!waiting.length) return;
    syncing.add(server);
    const sent = waiting.map((id) => {
      const entry = pending[id];
      const params = { key: entry.ratingKey, identifier: LIBRARY };
      const request = entry.watched
        ? plexCall(target.origin, target.token, '/:/scrobble', params)
        : plexCall(target.origin, target.token, '/:/progress', { ...params, time: String(entry.time), state: 'stopped' });
      return request.then((res) => (res ? { id, at: entry.at } : null));
    });
    Promise.all(sent).then((results) => {
      syncing.delete(server);
      const done = results.filter(Boolean);
      if (!done.length) {
        console.log(`Plex server ${server} didn't answer; keeping progress of ${waiting.length} downloaded file(s) for later`);
        return;
      }
      const now = loadPref(PENDING_KEY);
      for (const { id, at } of done) {
        if (now[id] && now[id].at === at) delete now[id]; // unless it changed meanwhile
      }
      for (const id of Object.keys(now)) {
        if (Date.now() - now[id].at > KEEP_MS) delete now[id];
      }
      savePref(PENDING_KEY, now);
      console.log(`Sent progress of ${done.length} downloaded file(s) to Plex server ${server}`);
      if (download && download.server === server && !download.announced) {
        download.announced = true;
        core.osd('Syncing progress with Plex');
      }
    });
  }

  // Resolves to the response, or null. Never logs the URL: it would include the token.
  function plexCall(origin, token, path, params) {
    if (token) params['X-Plex-Token'] = token;
    let request;
    try {
      request = http.get(origin + path, { params, headers: plexHeaders() });
    } catch (err) {
      console.error(`${path}: ${err}`);
      return Promise.resolve(null);
    }
    if (!request) return Promise.resolve(null);
    return request.then((res) => res, () => null);
  }

  function jsonOf(res) {
    if (!res) return null;
    if (res.data && typeof res.data === 'object') return res.data;
    try {
      return JSON.parse(res.text);
    } catch {
      return null;
    }
  }

  function loadPref(key) {
    try {
      const value = JSON.parse(preferences.get(key) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }

  function savePref(key, value) {
    preferences.set(key, JSON.stringify(value));
    preferences.sync();
  }
})();
