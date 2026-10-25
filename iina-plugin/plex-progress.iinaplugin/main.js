// Plex Progress for IINA
// When IINA plays a file streamed from Plex Media Server (a /library/parts/… URL, as opened
// by the Plex → IINA extension), report the playback position back to the server, so
// Continue Watching and watched status stay in sync. For episodes, also line up the next
// one in IINA's playlist and show Up Next when the credits start.
//
// The extension adds plexRatingKey=<id> to the file URL; Plex ignores it, and we use it to
// know which library item is playing. The server address and token come from the same URL.
(() => {
  'use strict';

  const { core, console, event, http, mpv, overlay, playlist, preferences } = iina;

  const VERSION = '1.1.0';
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
  // Details looked up while an item was being opened, for its file-loaded handler.
  const prefetched = new Map();

  // Player events and network replies arrive on IINA's background threads, holding the
  // plugin's lock. Changing the playlist, playing an entry or seeking from there can
  // deadlock IINA, which finishes those on the main thread, where it may be waiting for
  // the same lock. IINA runs timers on the main thread, so those actions go through here.
  const onMain = (fn) => setTimeout(fn, 0);

  // ---- Player events -------------------------------------------------------------

  event.on('iina.file-loaded', (url) => {
    finish();
    item = parsePlexUrl(mpv.getString('path') || url);
    if (!item) return;
    console.log(`Reporting progress of /library/metadata/${item.ratingKey} to ${item.origin}`);
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
    if (!it.started) return;
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

  // Plex's credits markers, and for an episode the next one, which goes into
  // IINA's playlist right away: IINA plays it when this one ends (unless "Play next item
  // automatically" is off in its settings), and Next Media reaches it.
  async function lookUp(it) {
    let details = prefetched.get(it.ratingKey);
    prefetched.delete(it.ratingKey);
    if (!details) {
      details = (await plexJson(it, `/library/metadata/${it.ratingKey}`, { includeMarkers: '1' }))?.Metadata?.[0];
    }
    if (!details || item !== it) return;
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
    // Season lists leave out some details; the episode's own entry has them all.
    const full = (await plexJson(it, `/library/metadata/${next.ratingKey}`))?.Metadata?.[0] ?? next;
    const part = bestMedia(full)?.Part?.[0];
    if (!part?.key) return null;
    const ratingKey = String(full.ratingKey);
    return {
      ratingKey,
      url: `${it.origin}${part.key}?${it.token ? `X-Plex-Token=${encodeURIComponent(it.token)}&` : ''}plexRatingKey=${ratingKey}`,
      label: episodeLabel(full),
      title: full.title ?? '',
      show: full.grandparentTitle ?? '',
      thumb: full.thumb ? thumbUrl(it, full.thumb) : null,
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

  // Before IINA opens a file from the playlist (the next episode, or Next or Previous
  // Media), set where it starts and which tracks it plays. mpv would otherwise keep the
  // previous file's settings: its start time and its track numbers, which can mean another
  // language in this file. Files the extension opens replace the playlist, so they're
  // alone in it, and the extension has already chosen for them.
  mpv.addHook('on_load', 50, async (next) => {
    try {
      await prepareFromPlaylist();
    } catch (err) {
      console.error(`Preparing the next file: ${err}`);
    }
    next();
  });

  async function prepareFromPlaylist() {
    if (mpv.getNumber('playlist-count') < 2) return;
    const it = parsePlexUrl(mpv.getString('path'), { quiet: true });
    if (!it) return;
    const details = (await within(LOOKUP_MS, plexJson(it, `/library/metadata/${it.ratingKey}`, { includeMarkers: '1' })))?.Metadata?.[0];
    // Resume where Plex says, like the extension does by default.
    const offset = details?.viewOffset > 0 ? details.viewOffset / 1000 : 0;
    const tracks = details ? matchTracks(lastTracks, streamsOf(partOf(details, it.partId))) : { aid: 'auto', sid: 'auto' };
    mpv.set('start', offset ? String(offset) : 'none');
    mpv.set('aid', tracks.aid);
    mpv.set('sid', tracks.sid);
    if (details) prefetched.set(it.ratingKey, details);
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

  // ---- Up Next -------------------------------------------------------------------

  const NOTHING = { kind: 'none' };

  // The stretch of the file where Up Next shows: from the start of the end credits.
  // Without an end-credits marker, it shows for the last seconds and the episode plays out.
  function setMoments(it, details) {
    const markers = (details.Marker ?? [])
      .map((m) => ({ type: m.type, start: m.startTimeOffset / 1000, end: m.endTimeOffset / 1000, final: m.final }))
      .filter((m) => m.end > m.start);
    it.listedDuration = (details.duration ?? 0) / 1000;
    const credits = markers.filter((m) => m.type === 'credits');
    // Older servers don't mark the end credits: then it's credits that run to the end.
    const end = it.listedDuration || it.duration;
    it.endCredits = credits.find((m) => m.final) ?? credits.filter((m) => m.end >= end - 15).pop() ?? null;
    it.moments = [];
  }

  function addUpNext(it) {
    const duration = it.listedDuration || it.duration;
    if (!duration) return;
    const start = it.endCredits?.start ?? duration - Math.min(UP_NEXT_S, duration * (1 - WATCHED_AT));
    it.moments.push({ kind: 'up-next', start, end: Infinity, credits: Boolean(it.endCredits) });
  }

  // Called every second and after seeks, on the main thread (see onMain): decide what the
  // overlay shows, and act on the Up Next countdown.
  function refresh(it) {
    showOverlay(item === it ? decide(it) : NOTHING);
  }

  function decide(it) {
    if (!it.started || it.leaving) return NOTHING;
    const t = it.position;
    const inside = (m) => t >= m.start && t < m.end - 0.5;
    // A dismissed card comes back if you go back to before it.
    for (const m of it.dismissed) if (!inside(m)) it.dismissed.delete(m);
    const found = it.moments.find(inside);
    const moment = found && !it.dismissed.has(found) ? found : null;
    it.moment = moment;
    if (moment?.kind !== 'up-next') it.deadline = null;
    if (!moment) return NOTHING;

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

  // The overlay page (overlay.html) shows the card and sends back clicks. It loads once
  // per window; clicks only reach it while the card shows.
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
      deadline: null,
    };
  }

  function ratingKeyOf(url) {
    return /[?&]plexRatingKey=(\d+)/.exec(url || '')?.[1] ?? null;
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
})();
