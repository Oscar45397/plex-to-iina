// Plex Progress for IINA
// When IINA plays a file streamed from Plex Media Server (a /library/parts/… URL, as opened
// by the Plex → IINA extension), report the playback position back to the server, so
// Continue Watching and watched status stay in sync.
//
// The extension adds plexRatingKey=<id> to the file URL; Plex ignores it, and we use it to
// know which library item is playing. The server address and token come from the same URL.
(() => {
  'use strict';

  const { core, console, event, http, mpv, preferences } = iina;

  const VERSION = '1.0.0';
  const PART_PATH = /^\/library\/parts\/\d+\//;
  const LIBRARY = 'com.plexapp.plugins.library';
  const SAMPLE_MS = 1000; // read the position this often, so a stop reports a fresh one
  const REPORT_MS = 10000; // tell Plex this often while playing
  const SETTLE_MS = 1000; // fold a burst of seeks or pause toggles into one report
  const WATCHED_AT = 0.9; // Plex's default "video played threshold"

  // The Plex item playing in this window, or null.
  let item = null;

  // ---- Player events -------------------------------------------------------------

  event.on('iina.file-loaded', (url) => {
    finish();
    item = parsePlexUrl(mpv.getString('path') || url);
    if (!item) return;
    console.log(`Reporting progress of /library/metadata/${item.ratingKey} to ${item.origin}`);
    sample(item);
    item.sampler = setInterval(tick, SAMPLE_MS);
  });

  // Fires when playback starts (after the resume seek) and again after every seek.
  event.on('mpv.playback-restart', () => {
    if (!item) return;
    item.started = true;
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
    // While a settle timer is pending, a report is already on its way. While paused the
    // position doesn't move, and pausing already reported it, so stay quiet until resumed.
    if (item.settle === null && !item.paused && Date.now() - item.lastReport >= REPORT_MS) report(item);
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
    // No fresh sample here: the player may already be tearing down. The last one is at
    // most a second old, and at the end of the file it equals the duration.
    report(done, 'stopped');
  }

  // core.status keeps the last known position after the player stops, unlike mpv's
  // time-pos, which becomes unavailable.
  function sample(it) {
    const position = core.status.position;
    const duration = core.status.duration;
    if (typeof position === 'number' && position >= 0) it.position = position;
    if (typeof duration === 'number' && duration > 0) it.duration = duration;
    it.paused = mpv.getFlag('pause');
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

  // Once per file, the first time playback passes the threshold.
  function markWatchedIfDone(it) {
    if (it.scrobbled || !it.duration || it.position / it.duration < WATCHED_AT) return;
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
    if (it.token) params['X-Plex-Token'] = it.token;
    let request;
    try {
      request = http.get(it.origin + path, { params, headers: plexHeaders() });
    } catch (err) {
      console.error(`${path}: ${err}`);
      return Promise.resolve(false);
    }
    // http.get returns nothing when the host isn't in allowedDomains.
    if (!request) return Promise.resolve(false);
    return request.then(
      () => true,
      (res) => {
        const status = res && res.statusCode ? `HTTP ${res.statusCode} ${res.reason || ''}` : 'no response';
        console.warn(`${path} failed: ${status.trim()}`);
        return false;
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

  // ---- Recognising Plex files ----------------------------------------------------

  // http(s)://<server>/library/parts/<id>/<ts>/file.mkv?X-Plex-Token=…&plexRatingKey=…
  // (No URL class here: IINA plugins run in plain JavaScriptCore, not a browser.)
  function parsePlexUrl(url) {
    const match = /^(https?:\/\/[^/?#]+)(\/[^?#]*)(?:\?([^#]*))?/i.exec(url || '');
    if (!match || !PART_PATH.test(match[2])) return null;
    const query = parseQuery(match[3] || '');
    const ratingKey = query.plexRatingKey;
    if (!/^\d+$/.test(ratingKey || '')) {
      console.log('Plex file without plexRatingKey; update the Plex → IINA extension to report progress');
      return null;
    }
    return {
      origin: match[1],
      token: query['X-Plex-Token'] || '',
      ratingKey,
      position: 0,
      duration: 0,
      paused: false,
      started: false,
      lastReport: 0,
      sampler: null,
      settle: null,
      announced: false,
      scrobbled: false,
    };
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
})();
