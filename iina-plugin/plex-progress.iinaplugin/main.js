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

  const VERSION = '1.1.0';
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
  // Play in Plex Web adds plexLocal=<path> to the stream URL when you've downloaded the
  // item (content.js). Just before mpv opens the stream, play that file from disk instead,
  // if it's still there. Progress then goes to Plex as for any stream.

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

  mpv.addHook('on_load', 40, () => {
    const url = mpv.getString('stream-open-filename') || '';
    const stream = /^(https?:\/\/[^/?#]+)(\/[^?#]*)\?([^#]*)$/i.exec(url);
    if (!stream || !PART_PATH.test(stream[2])) return;
    const query = parseQuery(stream[3]);
    if (!query.plexLocal) return;
    const local = existingCopy(query.plexLocal, query.plexRatingKey);
    if (local) {
      localCopies.set(url, local);
      mpv.set('stream-open-filename', local);
      mpv.set('cache', 'auto'); // mpv's default: no read-ahead into memory for a file on disk
      console.log(`Playing /library/metadata/${query.plexRatingKey} from its download`);
    } else {
      // Gone, for example moved to the Trash once watched: stream, without the local path.
      mpv.set('stream-open-filename', url.replace(/([?&])plexLocal=[^&#]*&?/, '$1').replace(/[?&]$/, ''));
    }
  });

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
  const trashItem = iina.menu.item('Move Watched Downloads to Trash', () => {
    const on = !trashWatched();
    preferences.set(TRASH_KEY, on);
    preferences.sync();
    trashItem.selected = on;
    iina.menu.forceUpdate();
  }, { selected: trashWatched() });
  iina.menu.addItem(trashItem);
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
