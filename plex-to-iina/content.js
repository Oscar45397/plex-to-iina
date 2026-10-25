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
  // Plex's own Resume Playback dialog ("Resume from 1:14:57" / "Start from the
  // beginning"), which it shows when it starts an item with a watch position itself.
  const DIALOG = '[class*="ModalContent-modalContent"]';
  const DIALOG_CLOSE = '[class*="ModalContent-closeButton"]';
  const DIALOG_ITEM = '[class*="ListModalItem-listModalItem"]';
  const MENU_OR_DIALOG = '[class*="Menu-menuPortal"], [role="menu"], [role="menuitem"], [class*="Modal-modalContainer"]';
  const VIDEO_TYPES = new Set(['movie', 'episode', 'clip']);
  const CLIENT_ID = 'plex-to-iina-extension';
  const SERVER_CACHE_MS = 10 * 60 * 1000;

  // Safari (and Firefox) expose the promise-based `browser` namespace; Chrome has `chrome`.
  const ext = globalThis.browser ?? globalThis.chrome;
  // languages.js, loaded before this script.
  const LANGUAGES = globalThis.PlexToIinaLanguages;

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
  const DEFAULTS = {
    enabled: true, resume: true, fullScreen: false, bufferGB: 5, bestAudio: true,
    // Subtitles when the audio isn't in one of your languages; empty list = browser's.
    autoSubtitles: true, myLanguages: '',
  };
  let settings = { ...DEFAULTS };
  ext.storage.sync.get(DEFAULTS).then((stored) => { settings = stored; });
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [key, { newValue }] of Object.entries(changes)) settings[key] = newValue;
  });

  // Set while we re-send a click to Plex, so our own listener lets it through.
  let replaying = false;
  // The item the last click was about, because Plex's Resume Playback dialog doesn't say.
  let lastItem = null;
  // Resume dialogs whose choice is already on its way to IINA.
  const handledDialogs = new WeakSet();

  // Capture phase on window runs before React's listeners on the app root.
  window.addEventListener('click', onClick, true);
  // The Resume dialog's buttons act on mouseup, so those are caught too.
  window.addEventListener('mousedown', onDialogMouse, true);
  window.addEventListener('mouseup', onDialogMouse, true);

  function onClick(event) {
    if (replaying || event.button !== 0 || !(event.target instanceof Element)) return;
    const choice = resumeDialogChoice(event.target);
    if (choice) {
      onResumeDialog(event, choice);
      return;
    }
    rememberItem(event.target, event.altKey);
    if (!settings.enabled || event.altKey) return;
    const button = event.target.closest(PLAY_BUTTONS);
    if (!button) return;
    const target = findTarget(button);
    // The route holds the server and item IDs, never the token.
    note('log', `Play clicked (${button.dataset.testid ?? 'grid card'}) on ${location.hash.slice(0, 160)}: ${target ? `item ${target.ratingKey}` : 'item not recognised, leaving it to Plex'}`);
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    playInIina(target, button);
  }

  // ---- Plex's Resume Playback dialog ---------------------------------------------

  // Plex shows this dialog when a Play we didn't catch reaches it for an item with a
  // watch position. It has two list items: the first holds the position
  // ("Resume from 1:14:57"), the second is "Start from the beginning". Matched by that
  // shape rather than by text, because Plex Web is translated.
  function resumeDialogChoice(el) {
    const item = el.closest(DIALOG_ITEM);
    const dialog = item?.closest(DIALOG);
    const items = dialog ? [...dialog.querySelectorAll(DIALOG_ITEM)] : [];
    if (items.length !== 2 || !/\d:\d\d/.test(items[0].textContent)) return null;
    return { dialog, item, resume: item === items[0] };
  }

  // Only when we know the item: a dialog after a click we can't place stays with Plex.
  function takesOver(choice, event) {
    return settings.enabled && !event.altKey && Boolean(lastItem || handledDialogs.has(choice.dialog));
  }

  // Plex's dialog buttons press on mouseup (or on click when focused). Hide all three
  // events from Plex and act on the click, which keyboard Enter and Space also send.
  function onDialogMouse(event) {
    if (replaying || event.button !== 0 || !(event.target instanceof Element)) return;
    const choice = resumeDialogChoice(event.target);
    if (!choice) return;
    if (takesOver(choice, event)) event.stopImmediatePropagation();
    else if (event.type === 'mousedown') noteLeftToPlex();
  }

  function onResumeDialog(event, choice) {
    if (!takesOver(choice, event)) {
      // Reached by keyboard; a mouse press has already gone to Plex on mouseup.
      noteLeftToPlex();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (handledDialogs.has(choice.dialog)) return; // a second click while the first is on its way
    handledDialogs.add(choice.dialog);
    note('log', `Resume dialog: ${choice.resume ? 'resume' : 'start from the beginning'}, item ${lastItem.ratingKey}`);
    playInIina(lastItem, choice.item, { resume: choice.resume }).then((opened) => {
      if (opened) press(choice.dialog.querySelector(DIALOG_CLOSE));
    });
  }

  function noteLeftToPlex() {
    note('log', `Resume dialog: ${lastItem ? 'Option-click or turned off' : 'item not known'}, leaving it to Plex`);
  }

  // Remember which item a click was about: a poster card's item, or the item whose page
  // this is. Clicks in a menu or dialog keep the item that opened it.
  function rememberItem(el, altKey) {
    if (el.closest(MENU_OR_DIALOG)) return;
    if (altKey) lastItem = null; // Option-click: Plex's player, dialog included
    else if (el.closest(POSTER)) lastItem = findTarget(el.closest('button, a') ?? el);
    else lastItem = parsePlexLink(location.href); // null unless on an item's page
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

  // Resolves to true once IINA was asked to play; otherwise the click went back to Plex.
  async function playInIina(target, button, { resume = settings.resume } = {}) {
    toast('Finding the original file…', { sticky: true });
    try {
      const server = await resolveServer(target.machineId);
      const video = await pickVideo(server, target.ratingKey);
      if (!video) {
        // Music, photos, etc.: let Plex handle them.
        note('log', 'Not a video, handing back to Plex');
        handBack(button, null);
        return false;
      }
      // Downloaded before (download.js)? Then IINA plays that copy from disk (see iinaUrl).
      video.localPath = (await globalThis.plexToIina.findDownload?.(target.machineId, video.ratingKey)) ?? null;
      const { autoSubtitle, betterAudio, audio } = video.tracks;
      const languageOf = (stream) => LANGUAGES.displayName(LANGUAGES.ofStream(stream) ?? 'und');
      const notes = [
        video.localPath && "From your download, if it's still there",
        autoSubtitle && `${languageOf(autoSubtitle)} subtitles on: the audio is ${languageOf(audio)}`,
        betterAudio && `Better audio in ${languageOf(betterAudio)}: ${audioLabel(betterAudio)}. Switch in IINA's Audio menu (it reloads the buffer).`,
        server.relay && !video.localPath && '⚠ Via Plex Relay: bandwidth is limited',
      ].filter(Boolean);
      note('log', `Found ${video.title} (${video.quality}) on ${new URL(server.uri).host}${notes.map((n) => `; ${n}`).join('')}`);
      await openExternal(iinaUrl(server, video, resume));
      // Keep a note about other audio up long enough to read.
      toast([`▶ ${video.title} in IINA`, video.quality, ...notes].join('\n'), { long: Boolean(betterAudio) });
      return true;
    } catch (err) {
      console.warn('[Plex → IINA]', err);
      note('log', `Failed: ${err.message}`);
      handBack(button, `Couldn't open in IINA (${err.message}). Playing in Plex instead.`);
      return false;
    }
  }

  function handBack(button, message) {
    // If Plex now asks where to resume, that's its player's question: leave it to Plex.
    lastItem = null;
    if (button.isConnected) {
      press(button);
      if (message) toast(message, { error: true });
      else hideToast();
    } else {
      toast(message ?? 'Option-click Play to use the Plex player for this item.', { error: Boolean(message) });
    }
  }

  // Press a Plex button the way a mouse does, past our own listeners. Plex's newer buttons
  // act on click, older ones (the Resume dialog's) on mouseup; this presses either once.
  function press(el) {
    if (!el?.isConnected) return;
    replaying = true;
    try {
      for (const type of ['mousedown', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
      }
    } finally {
      replaying = false;
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
  // Audio: the first of your languages that has an audio track (otherwise the language
  // Plex picked), and within it the best track: lossless first, then the most channels.
  // A commentary track Plex picked is kept. If a clearly better track exists in another
  // language, it's noted so you can switch. Subtitles: whatever Plex picked; if Plex
  // picked none and the audio isn't in one of your languages, the best subtitles in your
  // language. mpv numbers tracks of each type from 1 in file order, which is Plex's
  // `index` order.
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
        const main = audio.filter((s) => !isCommentary(s));
        const language = LANGUAGES.parse(settings.myLanguages)
          .find((code) => main.some((s) => LANGUAGES.ofStream(s) === code))
          ?? LANGUAGES.ofStream(plexAudio);
        const inLanguage = main.filter((s) => LANGUAGES.ofStream(s) === language);
        chosen = bestAudio(inLanguage.length ? inLanguage : [plexAudio], plexAudio);
        const overall = bestAudio(main, chosen);
        if (isClearlyBetter(overall, chosen)) tracks.betterAudio = overall;
      }
      tracks.aid = audio.indexOf(chosen) + 1;
      tracks.audio = chosen;
    }

    const plexSubtitle = streams.find((s) => s.streamType === 3 && s.selected);
    if (plexSubtitle) {
      // A separate subtitle file (no index) isn't inside the video; leave that to IINA.
      if (subtitles.includes(plexSubtitle)) tracks.sid = subtitles.indexOf(plexSubtitle) + 1;
    } else {
      const subtitle = settings.autoSubtitles ? subtitlesForForeignAudio(tracks.audio, subtitles) : null;
      tracks.sid = subtitle ? subtitles.indexOf(subtitle) + 1 : 'no';
      if (subtitle) tracks.autoSubtitle = subtitle;
    }
    return tracks;
  }

  // When the audio isn't in one of your languages: the best subtitles in the first of your
  // languages that has any. Full subtitles before forced-only ones (which translate just
  // signs and the odd line), regular before SDH, then the file's default.
  function subtitlesForForeignAudio(audio, subtitles) {
    const audioLanguage = LANGUAGES.ofStream(audio);
    const mine = LANGUAGES.parse(settings.myLanguages);
    if (!audioLanguage || mine.includes(audioLanguage)) return null;
    for (const language of mine) {
      const candidates = subtitles.filter((s) => LANGUAGES.ofStream(s) === language);
      if (candidates.length) {
        return candidates.reduce((best, s) => (subtitleScore(s) > subtitleScore(best) ? s : best));
      }
    }
    return null;
  }

  function subtitleScore(stream) {
    const label = `${stream.title ?? ''} ${stream.displayTitle ?? ''}`;
    const forced = stream.forced || /\bforced\b/i.test(label);
    const sdh = stream.hearingImpaired || /\b(sdh|cc)\b/i.test(label);
    return (forced ? 0 : 4) + (sdh ? 0 : 2) + (stream.default ? 1 : 0);
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

  // The highest-scoring track; on a tie, `preferred` (Plex's pick) if it's in the list.
  function bestAudio(candidates, preferred) {
    const start = candidates.includes(preferred) ? preferred : candidates[0];
    return candidates.reduce((best, s) => (audioScore(s) > audioScore(best) ? s : best), start);
  }

  // Worth a note: lossless over lossy, or more channels at the same kind. A slightly
  // higher bitrate alone isn't.
  function isClearlyBetter(a, b) {
    if (a === b) return false;
    if (isLossless(a) !== isLossless(b)) return isLossless(a);
    return (a.channels ?? 0) > (b.channels ?? 0);
  }

  async function nextEpisode(server, ratingKey) {
    const episodes = (await plexGet(server, `/library/metadata/${ratingKey}/allLeaves`)).Metadata ?? [];
    return episodes.find((ep) => ep.viewOffset) ?? episodes.find((ep) => !ep.viewCount) ?? episodes[0];
  }

  // ---- Handing off to IINA -------------------------------------------------------

  function iinaUrl(server, video, resume) {
    // The part URL is the original file, served with HTTP range requests (seeking works).
    const file = new URL(server.uri + video.partKey);
    if (server.token) file.searchParams.set('X-Plex-Token', server.token);
    // Plex ignores this; the IINA plugin (iina-plugin/) reads it to report watch progress.
    file.searchParams.set('plexRatingKey', video.ratingKey);
    // Where to start, in seconds, or 'none' for the beginning. IINA keeps mpv options per
    // player window, so always set it; otherwise the next file would inherit the previous
    // resume point. IINA sets mpv_start only after it has started opening the file, so its
    // saved position for this URL ("Resume last playback position") can load on top of it;
    // the IINA plugin reads plexStart from the URL and sets the start again after that.
    const start = resume && video.viewOffset > 0 ? String(video.viewOffset / 1000) : 'none';
    file.searchParams.set('plexStart', start);

    // A downloaded copy (download.js): the IINA plugin plays it from disk instead, if it's
    // still there; same file, no streaming, so no buffering. As ~/…, so the Mac's user
    // name never reaches the server; the plugin removes it before streaming anyway.
    if (video.localPath) file.searchParams.set('plexLocal', video.localPath.replace(/^\/Users\/[^/]+\//, '~/'));

    const params = { url: file.href };
    if (settings.fullScreen) params.full_screen = '1';
    params.mpv_start = start;
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
    const audio = audioStream
      ? audioLabel(audioStream)
      : [audioName(media), CHANNELS[media.audioChannels]].filter(Boolean).join(' ');
    const rate = media.bitrate ? `${Math.round(media.bitrate / 1000)} Mbps` : '';
    return [video, audio, rate].filter(Boolean).join(' · ');
  }

  const CHANNELS = { 8: '7.1', 7: '6.1', 6: '5.1', 2: '2.0', 1: 'mono' };

  // A Plex audio stream as "TrueHD 7.1".
  function audioLabel(stream) {
    const name = audioName({ audioCodec: stream.codec, audioProfile: stream.profile });
    return [name, CHANNELS[stream.channels]].filter(Boolean).join(' ');
  }

  function audioName({ audioCodec: codec, audioProfile: profile }) {
    if (codec === 'dca' || codec === 'dca-ma') return codec === 'dca-ma' || profile === 'ma' ? 'DTS-HD MA' : 'DTS';
    return { truehd: 'TrueHD', eac3: 'DD+', ac3: 'Dolby Digital', aac: 'AAC', flac: 'FLAC', opus: 'Opus', pcm: 'PCM' }[codec]
      ?? (codec ?? '').toUpperCase();
  }

  // ---- Toast ---------------------------------------------------------------------

  let toastEl = null;
  let toastTimer = 0;

  // The first line is the headline; any further lines show smaller, below it.
  function toast(text, { error = false, sticky = false, long = false } = {}) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.dataset.plexToIina = 'toast';
      toastEl.setAttribute('role', 'status');
      const root = toastEl.attachShadow({ mode: 'closed' });
      root.innerHTML = `
        <style>
          .toast {
            position: fixed; right: 24px; bottom: 24px; z-index: 2147483647;
            display: flex; gap: 10px; max-width: 420px; padding: 11px 15px 12px 12px;
            border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.08);
            background: rgba(28, 30, 33, 0.94); color: #f5f5f7;
            font: 13px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
            -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px);
            pointer-events: none; opacity: 0; transform: translateY(8px);
            transition: opacity 0.2s, transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);
          }
          .toast.on { opacity: 1; transform: none; }
          .toast.error { background: rgba(92, 26, 26, 0.95); }
          .mark { flex: none; width: 4px; border-radius: 2px; background: #e5a00d; }
          .error .mark { background: #ff6b5e; }
          .title { font-weight: 600; }
          .details { margin-top: 2px; color: #b4b4b9; white-space: pre-line; }
          .details:empty { display: none; }
          @media (prefers-reduced-motion: reduce) { .toast { transform: none; } }
        </style>
        <div class="toast"><span class="mark"></span><div><div class="title"></div><div class="details"></div></div></div>`;
      toastEl.parts = { box: root.querySelector('.toast'), title: root.querySelector('.title'), details: root.querySelector('.details') };
    }
    if (!toastEl.isConnected) document.documentElement.append(toastEl);
    const [title, ...details] = String(text).split('\n');
    const { box } = toastEl.parts;
    toastEl.parts.title.textContent = title;
    toastEl.parts.details.textContent = details.join('\n');
    box.classList.toggle('error', error);
    requestAnimationFrame(() => box.classList.add('on'));
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(hideToast, error ? 7000 : long ? 9000 : 4000);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastEl?.parts.box.classList.remove('on');
  }

  // For download.js, which runs after this file in the same content-script world.
  globalThis.plexToIina = { ext, note, toast, resolveServer, plexGet, parsePlexLink, titleOf };
})();
