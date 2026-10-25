// Plex → IINA
// Catches Plex Web's Play buttons, looks up the item's original media file on your
// Plex Media Server, and hands that file's direct URL to IINA. Nothing is transcoded:
// IINA gets the same bytes that are on disk (4K remux video, TrueHD / DTS-HD MA audio).
// Option-click Play to use Plex's own player instead.
(() => {
  'use strict';

  // Markers taken from Plex Web's bundle: the big Play button on a details page, the round
  // play button on hub posters, and the play button (or whole-poster play cover) on
  // library-grid cards, which has no data-testid, only this class.
  const DETAILS_PLAY = '[data-testid="preplay-play"]';
  const PLAY_BUTTONS = `${DETAILS_PLAY}, [data-testid="metadataPosterPlayButton"], [class*="MetadataPosterCardActions-playButton"]`;
  // One per poster card, and the class Plex gives each card's root (poster plus title).
  const POSTER = '[data-testid^="metadataPosterCard--"]';
  const CARD_ROOT = /\bMetadataPoster(?:Cell|ListItem)-/;
  const VIDEO_TYPES = new Set(['movie', 'episode', 'clip']);
  const CLIENT_ID = 'plex-to-iina-extension';
  const SERVER_CACHE_MS = 10 * 60 * 1000;

  // Safari (and Firefox) expose the promise-based `browser` namespace; Chrome has `chrome`.
  const ext = globalThis.browser ?? globalThis.chrome;

  // Safari: background.js shows an "on" badge for this tab and forwards these notes to
  // the companion app's log (Console.app, subsystem local.plex-to-iina.app.Extension).
  // Chrome's service worker ignores them. Never include the token.
  function note(type, text = '') {
    Promise.resolve()
      .then(() => ext.runtime.sendMessage({ type, text }))
      .catch(() => {});
  }
  note('hello', location.host);

  const BUFFER_SIZES = [1, 2, 5]; // GB, offered in the popup
  const DEFAULTS = { enabled: true, resume: true, fullScreen: false, bufferGB: 5, bestAudio: true };
  let settings = { ...DEFAULTS };
  ext.storage.sync.get(DEFAULTS).then((stored) => { settings = stored; });
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [key, { newValue }] of Object.entries(changes)) settings[key] = newValue;
  });

  // Set while we re-send a click to Plex, so our own listener lets it through.
  let replaying = false;

  // Capture phase on window runs before React's listeners on the app root.
  window.addEventListener('click', onClick, true);

  function onClick(event) {
    if (replaying || !settings.enabled || event.altKey || event.button !== 0) return;
    const button = event.target instanceof Element ? event.target.closest(PLAY_BUTTONS) : null;
    if (!button) return;
    const target = findTarget(button);
    // The route holds the server and item IDs, never the token.
    note('log', `Play clicked (${button.dataset.testid ?? 'grid card'}) on ${location.hash.slice(0, 160)}: ${target ? `item ${target.ratingKey}` : 'item not recognised, leaving it to Plex'}`);
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    playInIina(target, button);
  }

  // ---- Which item was clicked ----------------------------------------------------

  function findTarget(button) {
    if (button.matches(DETAILS_PLAY)) return parsePlexLink(location.href);
    // Poster card: on some pages the hover overlay links to the item right next to the
    // play button; in library grids the only link is the title under the poster. Climb
    // from the button and take the nearest link, but never past this card.
    for (let el = button, depth = 0; el && el !== document.body && depth < 12; el = el.parentElement, depth++) {
      if (depth > 0 && el.querySelectorAll(POSTER).length > 1) return null; // a second card
      for (const link of [el, ...el.querySelectorAll('a[href]')]) {
        const target = parsePlexLink(link.getAttribute('href'));
        if (target) return target;
      }
      // The card's root holds its title; nothing above it belongs to this card.
      if (typeof el.className === 'string' && CARD_ROOT.test(el.className)) return null;
    }
    return null;
  }

  // Plex Web routes look like #!/server/<machineId>/details?key=%2Flibrary%2Fmetadata%2F123;
  // newer builds also use #!/media/<machineId>/….
  function parsePlexLink(href) {
    if (!href) return null;
    const route = href.includes('#!') ? href.slice(href.indexOf('#!') + 2) : href;
    const machineId = /\/(?:server|media)\/([^/?#]+)/.exec(route)?.[1];
    if (!machineId || route.includes('/provider/')) return null;
    const query = route.includes('?') ? route.slice(route.indexOf('?') + 1) : '';
    const key = new URLSearchParams(query).get('key') ?? '';
    const ratingKey = /^\/library\/metadata\/(\d+)$/.exec(key)?.[1];
    return ratingKey ? { machineId: decodeURIComponent(machineId), ratingKey } : null;
  }

  // ---- Main flow -----------------------------------------------------------------

  async function playInIina(target, button) {
    toast('Finding the original file…', { sticky: true });
    try {
      const server = await resolveServer(target.machineId);
      const video = await pickVideo(server, target.ratingKey);
      if (!video) {
        // Music, photos, etc.: let Plex handle them.
        note('log', 'Not a video, handing back to Plex');
        handBack(button, null);
        return;
      }
      // Downloaded before (download.js)? Then IINA plays that copy from disk (see iinaUrl).
      video.localPath = (await globalThis.plexToIina.findDownload?.(target.machineId, video.ratingKey)) ?? null;
      note('log', `Found ${video.title} (${video.quality}) on ${new URL(server.uri).host}${server.relay ? ' via relay' : ''}${video.localPath ? ', playing the download' : ''}`);
      await openExternal(iinaUrl(server, video));
      toast(`▶ ${video.title} in IINA\n${video.quality}${video.localPath ? "\nFrom your download, if it's still there" : server.relay ? '\n⚠ Via Plex Relay: bandwidth is limited' : ''}`);
    } catch (err) {
      console.warn('[Plex → IINA]', err);
      note('log', `Failed: ${err.message}`);
      handBack(button, `Couldn't open in IINA (${err.message}). Playing in Plex instead.`);
    }
  }

  function handBack(button, message) {
    if (button.isConnected) {
      replaying = true;
      try { button.click(); } finally { replaying = false; }
      if (message) toast(message, { error: true });
      else hideToast();
    } else {
      toast(message ?? 'Option-click Play to use the Plex player for this item.', { error: Boolean(message) });
    }
  }

  // ---- Server discovery ----------------------------------------------------------

  const serverCache = new Map();

  function resolveServer(machineId) {
    const hit = serverCache.get(machineId);
    if (hit && Date.now() - hit.at < SERVER_CACHE_MS) return hit.promise;
    const promise = findServer(machineId);
    serverCache.set(machineId, { at: Date.now(), promise });
    promise.catch(() => serverCache.delete(machineId));
    return promise;
  }

  async function findServer(machineId) {
    const token = accountToken();

    // Plex Web served by the server itself (http://<server>:32400/web): use this origin.
    if (location.hostname !== 'app.plex.tv' && await probe(location.origin, machineId)) {
      return { uri: location.origin, token, relay: false };
    }
    if (!token) throw new Error('not signed in to Plex');

    const res = await fetch(
      'https://clients.plex.tv/api/v2/resources?includeHttps=1&includeRelay=1' +
        `&X-Plex-Token=${encodeURIComponent(token)}&X-Plex-Client-Identifier=${CLIENT_ID}&X-Plex-Product=Plex%20to%20IINA`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) throw new Error(`plex.tv returned ${res.status}`);
    const device = (await res.json()).find((d) => d.clientIdentifier === machineId);
    if (!device) throw new Error('server not found on your Plex account');

    // An https page can't fetch plain-http connections, so only probe https ones there.
    const usable = (device.connections ?? []).filter((c) => location.protocol !== 'https:' || c.protocol === 'https');
    const tiers = [
      usable.filter((c) => c.local && !c.relay),
      usable.filter((c) => !c.local && !c.relay),
      usable.filter((c) => c.relay),
    ];
    for (const tier of tiers) {
      if (!tier.length) continue;
      try {
        const winner = await Promise.any(
          tier.map((c) => probe(c.uri, machineId).then((ok) => (ok ? c : Promise.reject()))),
        );
        return { uri: winner.uri, token: device.accessToken || token, relay: Boolean(winner.relay) };
      } catch {
        // Nothing in this tier answered; try the next one.
      }
    }
    throw new Error(`couldn't reach ${device.name}`);
  }

  async function probe(uri, machineId) {
    try {
      const res = await fetch(`${uri}/identity`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(3000),
      });
      return res.ok && (await res.json()).MediaContainer?.machineIdentifier === machineId;
    } catch {
      return false;
    }
  }

  function accountToken() {
    try {
      const direct = localStorage.getItem('myPlexAccessToken');
      if (direct) return direct.replace(/^"|"$/g, '');
      const users = JSON.parse(localStorage.getItem('users') ?? 'null');
      return users?.users?.[0]?.authToken ?? null;
    } catch {
      return null;
    }
  }

  // ---- Library lookups -----------------------------------------------------------

  async function plexGet(server, path) {
    const url = new URL(server.uri + path);
    if (server.token) url.searchParams.set('X-Plex-Token', server.token);
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    return (await res.json()).MediaContainer ?? {};
  }

  async function pickVideo(server, ratingKey) {
    let item = (await plexGet(server, `/library/metadata/${ratingKey}?includeOnDeck=1`)).Metadata?.[0];
    if (!item) throw new Error('item not found');

    // Shows and seasons: play what Plex would, i.e. the On Deck / next unwatched episode.
    if (item.type === 'show' || item.type === 'season') {
      const onDeck = item.OnDeck?.Metadata;
      item = (Array.isArray(onDeck) ? onDeck[0] : onDeck) ?? (await nextEpisode(server, ratingKey));
    }
    if (!item || !VIDEO_TYPES.has(item.type)) return null;
    if (!item.Media?.length) {
      item = (await plexGet(server, `/library/metadata/${item.ratingKey}`)).Metadata?.[0];
    }

    // Several versions (e.g. 4K remux + 1080p copy): take the biggest, highest-bitrate one.
    const media = [...(item?.Media ?? [])].sort(
      (a, b) => (b.width ?? 0) - (a.width ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0),
    )[0];
    const part = media?.Part?.[0];
    if (!part?.key) throw new Error('no media file for this item');

    let streams = part.Stream;
    if (!streams) {
      // Episodes from a show's episode list come without stream details.
      const full = (await plexGet(server, `/library/metadata/${item.ratingKey}`)).Metadata?.[0];
      streams = full?.Media?.find((m) => m.id === media.id)?.Part?.[0]?.Stream ?? [];
    }
    const tracks = pickTracks(streams);

    return {
      ratingKey: item.ratingKey,
      partKey: part.key,
      viewOffset: item.viewOffset ?? 0,
      title: titleOf(item),
      quality: describe(media, tracks.audio),
      tracks,
    };
  }

  // Choose the audio and subtitle tracks before IINA starts, because switching tracks
  // during playback makes mpv throw away its whole buffer and download it again.
  // Audio: the best track in the language Plex picked (lossless first, then the most
  // channels), unless Plex picked a commentary track. Subtitles: whatever Plex picked.
  // mpv numbers tracks of each type from 1 in file order, which is Plex's `index` order.
  function pickTracks(streams) {
    if (!streams.length) return {}; // nothing known: let IINA choose
    const byIndex = (a, b) => a.index - b.index;
    const audio = streams.filter((s) => s.streamType === 2 && s.index != null).sort(byIndex);
    const subtitles = streams.filter((s) => s.streamType === 3 && s.index != null).sort(byIndex);
    const tracks = {};

    const plexAudio = audio.find((s) => s.selected) ?? audio.find((s) => s.default) ?? audio[0];
    if (plexAudio) {
      let chosen = plexAudio;
      if (settings.bestAudio && !isCommentary(plexAudio)) {
        chosen = audio
          .filter((s) => s.languageCode === plexAudio.languageCode && !isCommentary(s))
          .reduce((best, s) => (audioScore(s) > audioScore(best) ? s : best), plexAudio);
      }
      tracks.aid = audio.indexOf(chosen) + 1;
      tracks.audio = chosen;
    }

    const plexSubtitle = streams.find((s) => s.streamType === 3 && s.selected);
    if (!plexSubtitle) tracks.sid = 'no';
    else if (subtitles.includes(plexSubtitle)) tracks.sid = subtitles.indexOf(plexSubtitle) + 1;
    // A separate subtitle file (no index) isn't inside the video; leave that to IINA.
    return tracks;
  }

  function isCommentary(stream) {
    return /commentary/i.test(`${stream.title ?? ''} ${stream.displayTitle ?? ''}`);
  }

  function isLossless(stream) {
    return ['truehd', 'flac', 'alac', 'dca-ma'].includes(stream.codec)
      || stream.codec?.startsWith('pcm')
      || (stream.codec === 'dca' && stream.profile === 'ma');
  }

  function audioScore(stream) {
    return (isLossless(stream) ? 1e6 : 0) + (stream.channels ?? 0) * 1e4 + (stream.bitrate ?? 0) / 100;
  }

  async function nextEpisode(server, ratingKey) {
    const episodes = (await plexGet(server, `/library/metadata/${ratingKey}/allLeaves`)).Metadata ?? [];
    return episodes.find((ep) => ep.viewOffset) ?? episodes.find((ep) => !ep.viewCount) ?? episodes[0];
  }

  // ---- Handing off to IINA -------------------------------------------------------

  function iinaUrl(server, video) {
    // The part URL is the original file, served with HTTP range requests (seeking works).
    const file = new URL(server.uri + video.partKey);
    if (server.token) file.searchParams.set('X-Plex-Token', server.token);
    // Plex ignores this; the IINA plugin (iina-plugin/) reads it to report watch progress.
    file.searchParams.set('plexRatingKey', video.ratingKey);

    // A downloaded copy (download.js): the IINA plugin plays it from disk instead, if it's
    // still there; same file, no streaming, so no buffering. As ~/…, so the Mac's user
    // name never reaches the server; the plugin removes it before streaming anyway.
    if (video.localPath) file.searchParams.set('plexLocal', video.localPath.replace(/^\/Users\/[^/]+\//, '~/'));

    const params = { url: file.href };
    if (settings.fullScreen) params.full_screen = '1';
    // IINA keeps mpv options per player window, so always set start explicitly;
    // otherwise the next file would inherit the previous resume point.
    params.mpv_start = settings.resume && video.viewOffset > 0 ? String(video.viewOffset / 1000) : 'none';
    // Read ahead until the buffer holds bufferGB of the file, kept in RAM. cache-secs is set
    // far beyond any film's length so size is the only limit: 5 GB is ~7 min of a 91 Mbps
    // remux, ~12 min at 55 Mbps, or a whole TV episode. Always sent, because IINA keeps
    // these options per player window.
    const gb = BUFFER_SIZES.includes(settings.bufferGB) ? settings.bufferGB : DEFAULTS.bufferGB;
    params.mpv_cache = 'yes';
    params['mpv_cache-secs'] = '86400';
    params['mpv_demuxer-max-bytes'] = `${gb}GiB`;
    // Also keep what was just played, so seeking back doesn't re-download: mpv's default
    // 50 MiB is only ~4.5 s of a 91 Mbps remux. A fifth of the buffer on top: 1 GB at the
    // 5 GB setting, ~90 s of that remux.
    params['mpv_demuxer-max-back-bytes'] = `${Math.round((gb * 1024) / 5)}MiB`;
    // After a seek outside the buffer, resume once 2 s are buffered and keep filling in the
    // background, rather than waiting for IINA's "cache pause wait" (up to 10 s if raised).
    params['mpv_cache-pause-wait'] = '2';
    // Tracks chosen up front (see pickTracks); 'auto' when unknown, so a reused IINA window
    // doesn't keep the previous file's choice.
    params.mpv_aid = video.tracks.aid ? String(video.tracks.aid) : 'auto';
    params.mpv_sid = video.tracks.sid ? String(video.tracks.sid) : 'auto';
    const query = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    return `iina://open?${query}`;
  }

  // In Safari, the extension's companion app opens IINA directly, which avoids Safari's
  // "Allow this page to open IINA?" question on every play. In Chrome nothing answers
  // this message, so we fall back to a link click.
  async function openExternal(url) {
    try {
      // The app normally answers within a second. If Safari couldn't start it (this happens
      // right after the app is reinstalled), don't wait forever: fall back to the link.
      const reply = await Promise.race([
        ext.runtime.sendMessage({ type: 'open-iina', url }),
        new Promise((resolve) => setTimeout(resolve, 4000)),
      ]);
      if (reply?.opened) return;
      note('log', 'Companion app did not open IINA, trying a link');
    } catch {
      // No answer (Chrome): use the link below.
    }
    // A detached link click opens the external app without Plex's router seeing it.
    const link = document.createElement('a');
    link.href = url;
    link.click();
  }

  // ---- Labels --------------------------------------------------------------------

  function titleOf(item) {
    if (item.type === 'episode') {
      const pad = (n) => String(n ?? '?').padStart(2, '0');
      return `${item.grandparentTitle} S${pad(item.parentIndex)}E${pad(item.index)}`;
    }
    return item.year ? `${item.title} (${item.year})` : item.title;
  }

  // audioStream: the track chosen by pickTracks, if known; otherwise Plex's summary.
  function describe(media, audioStream) {
    const resolution = { '4k': '4K', 1080: '1080p', 720: '720p', 480: '480p', sd: 'SD' }[media.videoResolution]
      ?? media.videoResolution ?? '';
    const video = [resolution, (media.videoCodec ?? '').toUpperCase()].filter(Boolean).join(' ');
    const track = audioStream
      ? { audioCodec: audioStream.codec, audioProfile: audioStream.profile, audioChannels: audioStream.channels }
      : media;
    const channels = { 8: '7.1', 7: '6.1', 6: '5.1', 2: '2.0', 1: 'mono' }[track.audioChannels] ?? '';
    const audio = [audioName(track), channels].filter(Boolean).join(' ');
    const rate = media.bitrate ? `${Math.round(media.bitrate / 1000)} Mbps` : '';
    return [video, audio, rate].filter(Boolean).join(' · ');
  }

  function audioName({ audioCodec: codec, audioProfile: profile }) {
    if (codec === 'dca' || codec === 'dca-ma') return codec === 'dca-ma' || profile === 'ma' ? 'DTS-HD MA' : 'DTS';
    return { truehd: 'TrueHD', eac3: 'DD+', ac3: 'Dolby Digital', aac: 'AAC', flac: 'FLAC', opus: 'Opus', pcm: 'PCM' }[codec]
      ?? (codec ?? '').toUpperCase();
  }

  // ---- Toast ---------------------------------------------------------------------

  let toastEl = null;
  let toastTimer = 0;

  function toast(text, { error = false, sticky = false } = {}) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.setAttribute('role', 'status');
      Object.assign(toastEl.style, {
        position: 'fixed',
        right: '24px',
        bottom: '24px',
        zIndex: '2147483647',
        maxWidth: '420px',
        padding: '10px 14px',
        borderRadius: '8px',
        borderLeft: '3px solid #e5a00d',
        color: '#fff',
        font: '13px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
        whiteSpace: 'pre-line',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
        pointerEvents: 'none',
        transition: 'opacity 0.2s',
      });
    }
    if (!toastEl.isConnected) document.documentElement.append(toastEl);
    toastEl.textContent = text;
    toastEl.style.background = error ? '#5c1a1a' : '#1f2326';
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(hideToast, error ? 7000 : 4000);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    if (toastEl) toastEl.style.opacity = '0';
  }

  // For download.js, which runs after this file in the same content-script world.
  globalThis.plexToIina = { ext, note, toast, resolveServer, plexGet, parsePlexLink, titleOf };
})();
