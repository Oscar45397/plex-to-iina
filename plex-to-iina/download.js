// Plex → IINA: Download button
// Adds a Download button next to Play on Plex Web's details pages. It saves the original
// files of the next few episodes (or the film) to Downloads/Plex to IINA/, so you can watch
// them in IINA without the server, for example away from home. Chrome downloads them with
// its downloads API (service-worker.js); in Safari the companion app does (safari/).
//
// File names end in a tag, {plex-<server>-<ratingKey>}, where <server> is the first 8
// characters of the server's machine identifier. The IINA plugin reads it to send your
// progress to Plex once the server can be reached again.
(() => {
  'use strict';

  const shared = globalThis.plexToIina; // set by content.js, which runs first
  if (!shared) return;
  const { ext, note, toast, resolveServer, plexGet, parsePlexLink, titleOf } = shared;

  const DETAILS_PLAY = '[data-testid="preplay-play"]';
  const SEASON = 0; // "Season" in the picker: the rest of the season
  const COUNTS = [1, 2, 3, 5, 10, SEASON]; // offered next to the button and in the popup
  const DEFAULTS = { downloadButton: true, downloadCount: 3 };
  const DOWNLOADABLE = new Set(['movie', 'show', 'season', 'episode']);
  const FOLDER = 'Plex to IINA';

  let settings = { ...DEFAULTS };
  ext.storage.sync.get(DEFAULTS).then((stored) => {
    settings = stored;
    schedule();
  });
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in DEFAULTS) settings[key] = newValue;
    }
    if (countSelect) countSelect.value = String(count());
    schedule();
  });

  // ---- The button ----------------------------------------------------------------

  let host = null; // our element in Plex's button row; its contents live in a shadow root
  let button = null;
  let label = null;
  let countSelect = null;
  let shown = null; // { key, target, type } of the page the button is for
  const types = new Map(); // item type by key, so re-renders don't ask the server again

  // Plex Web re-renders often; check at most once per frame.
  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      update();
    });
  }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('hashchange', schedule);
  window.addEventListener('popstate', schedule);

  function update() {
    const play = settings.downloadButton ? document.querySelector(DETAILS_PLAY) : null;
    const target = play ? parsePlexLink(location.href) : null;
    if (!target) {
      host?.remove();
      shown = null;
      closePopover();
      return;
    }
    if (!host) build();
    // Right after Play, in the same row. Climb out of any wrapper that holds only Play.
    let anchor = play;
    while (anchor.parentElement && anchor.parentElement.childElementCount === 1 && anchor.parentElement !== document.body) {
      anchor = anchor.parentElement;
    }
    if (anchor.nextElementSibling !== host) anchor.after(host);

    const key = `${target.machineId}/${target.ratingKey}`;
    if (shown?.key === key) return;
    closePopover();
    const page = { key, target, type: types.get(key) ?? null };
    shown = page;
    showType(page);
    if (page.type) return;
    resolveServer(target.machineId)
      .then((server) => plexGet(server, `/library/metadata/${target.ratingKey}`))
      .then((container) => {
        page.type = container.Metadata?.[0]?.type ?? 'unknown';
        types.set(key, page.type);
        if (shown === page) showType(page);
      })
      .catch(() => {
        // Server not reachable from here: no button.
      });
  }

  // Hidden until we know it's a film or a show; films have no episode count.
  function showType(page) {
    host.hidden = !DOWNLOADABLE.has(page.type);
    countSelect.hidden = page.type === 'movie';
  }

  function build() {
    host = document.createElement('span');
    host.dataset.plexToIina = 'download';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        :host { display: inline-flex; vertical-align: middle; }
        :host([hidden]) { display: none; }
        .pill {
          display: inline-flex; align-items: stretch; height: 40px; border-radius: 20px;
          background: rgba(128, 128, 128, 0.22); color: inherit; font: inherit; overflow: hidden;
        }
        button, select {
          font: inherit; font-size: 15px; font-weight: 600; color: inherit; background: transparent;
          border: 0; margin: 0; cursor: pointer;
        }
        button { display: inline-flex; align-items: center; gap: 7px; padding: 0 14px 0 12px; }
        button:hover:not(:disabled), select:hover { background: rgba(128, 128, 128, 0.18); }
        button:disabled { cursor: progress; opacity: 0.7; }
        button:focus-visible, select:focus-visible { outline: 2px solid #e5a00d; outline-offset: -2px; }
        svg { width: 18px; height: 18px; flex: none; }
        select {
          appearance: none; -webkit-appearance: none; padding: 0 28px 0 12px;
          border-left: 1px solid rgba(128, 128, 128, 0.35);
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23999' stroke-width='1.6'/%3E%3C/svg%3E");
          background-repeat: no-repeat; background-position: right 11px center; background-size: 10px 6px;
        }
        select[hidden] { display: none; }
        option { color: #000; background: #fff; }
      </style>
      <span class="pill">
        <button type="button" title="Save to Downloads › ${FOLDER}, to watch in IINA without the server">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>
          </svg>
          <span class="label">Download</span>
        </button>
        <select title="How many episodes to download: a number, or the rest of the season" aria-label="Episodes to download">
          <optgroup label="Episodes to download">
            ${COUNTS.map((n) => `<option value="${n}">${n === SEASON ? 'Season' : n}</option>`).join('')}
          </optgroup>
        </select>
      </span>`;
    button = root.querySelector('button');
    label = root.querySelector('.label');
    countSelect = root.querySelector('select');
    countSelect.value = String(count());
    countSelect.addEventListener('change', () => {
      closePopover();
      ext.storage.sync.set({ downloadCount: Number(countSelect.value) });
    });
    button.addEventListener('click', onDownload);
    // Keep Plex's own shortcuts and click handlers out of our controls.
    for (const type of ['click', 'keydown', 'mousedown', 'pointerdown']) {
      host.addEventListener(type, (event) => event.stopPropagation());
    }
  }

  function count() {
    return COUNTS.includes(settings.downloadCount) ? settings.downloadCount : DEFAULTS.downloadCount;
  }

  // ---- Choosing what to download -------------------------------------------------

  async function onDownload() {
    if (!shown || button.disabled) return;
    if (popover) return closePopover();
    const { target } = shown;
    button.disabled = true;
    label.textContent = 'Finding…';
    try {
      const plan = await makePlan(target, shown.type === 'movie' ? 1 : count());
      if (shown?.target === target) showPopover(plan);
    } catch (err) {
      console.warn('[Plex → IINA]', err);
      note('log', `Download failed: ${err.message}`);
      toast(`Couldn't prepare the download (${err.message}).`, { error: true });
    } finally {
      button.disabled = false;
      label.textContent = 'Download';
    }
  }

  async function makePlan(target, howMany) {
    const server = await resolveServer(target.machineId);
    const item = (await plexGet(server, `/library/metadata/${target.ratingKey}?includeOnDeck=1`)).Metadata?.[0];
    if (!item) throw new Error('item not found');
    const items = await pickItems(server, item, howMany);
    if (!items.length) throw new Error('no episodes found');
    const files = [];
    for (let it of items) {
      // Lists usually include the files; fetch the item itself when they don't.
      if (!it.Media?.length) it = (await plexGet(server, `/library/metadata/${it.ratingKey}`)).Metadata?.[0] ?? it;
      const file = fileFor(server, target.machineId, it);
      if (file) files.push(file);
    }
    if (!files.length) throw new Error('no media files for this item');

    const check = await send({ type: 'download-check', tags: files.map((f) => f.tag) });
    const existing = new Set(check.existing ?? []);
    return {
      server,
      folder: item.type === 'movie' ? FOLDER : `${FOLDER} › ${cleanName(files[0].show)}`,
      files: files.filter((f) => !existing.has(f.tag)),
      skipped: files.filter((f) => existing.has(f.tag)),
      freeBytes: typeof check.freeBytes === 'number' ? check.freeBytes : null,
    };
  }

  // Film: itself. Episode page: that episode and the ones after it. Show or season: from
  // the episode Plex has On Deck (else the first one in progress or unwatched), the next
  // unwatched ones. Everything watched: from the first episode, for a rewatch. With
  // SEASON, everything from there to the end of that episode's season.
  async function pickItems(server, item, howMany) {
    if (item.type === 'movie') return [item];
    if (item.type === 'episode') {
      const all = await episodes(server, item.grandparentRatingKey, 'allLeaves');
      const here = all.findIndex((ep) => sameItem(ep, item));
      return here < 0 ? [item] : take(all.slice(here), howMany);
    }
    if (item.type !== 'show' && item.type !== 'season') return [];
    const all = await episodes(server, item.ratingKey, item.type === 'show' ? 'allLeaves' : 'children');
    // Specials (season 0) come first in a show; don't start there.
    const regular = all.filter((ep) => item.type === 'season' || ep.parentIndex !== 0);
    const onDeck = [item.OnDeck?.Metadata].flat()[0];
    let start = onDeck ? all.findIndex((ep) => sameItem(ep, onDeck)) : -1;
    if (start < 0) {
      const next = regular.find((ep) => ep.viewOffset) ?? regular.find((ep) => !ep.viewCount);
      start = next ? all.indexOf(next) : -1;
    }
    if (start < 0) return take(regular, howMany);
    return take(all.slice(start).filter((ep, i) => i === 0 || !ep.viewCount), howMany);
  }

  // The first howMany episodes, or with SEASON, those in the first one's season.
  function take(list, howMany) {
    if (howMany !== SEASON) return list.slice(0, howMany);
    return list.filter((ep) => ep.parentIndex === list[0]?.parentIndex);
  }

  async function episodes(server, ratingKey, list) {
    if (!ratingKey) return [];
    const items = (await plexGet(server, `/library/metadata/${ratingKey}/${list}`)).Metadata ?? [];
    return items.filter((m) => m.type === 'episode');
  }

  function sameItem(a, b) {
    return String(a.ratingKey) === String(b.ratingKey);
  }

  // Where one item goes: Plex to IINA/<Show>/S01E02 - Title {plex-…}.mkv for an episode,
  // Plex to IINA/Title (Year) {plex-…}.mkv for a film. Same version as Play: the one with
  // the most pixels, then the highest bitrate. Multi-part items: only the first part.
  function fileFor(server, machineId, item) {
    const media = [...(item.Media ?? [])].sort(
      (a, b) => (b.width ?? 0) - (a.width ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0),
    )[0];
    const part = media?.Part?.[0];
    if (!part?.key) return null;
    const extension = (/\.([a-z0-9]{2,5})$/i.exec(part.file ?? '')?.[1] ?? part.container ?? media.container ?? 'mkv')
      .toLowerCase();
    const tag = tagFor(machineId, item.ratingKey);
    let path;
    if (item.type === 'episode') {
      const show = cleanName(item.grandparentTitle) || 'TV';
      const title = cleanName(item.title);
      path = `${FOLDER}/${show}/${episodeCode(item)}${title ? ` - ${title}` : ''} ${tag}.${extension}`;
    } else {
      path = `${FOLDER}/${cleanName(item.year ? `${item.title} (${item.year})` : item.title) || 'Film'} ${tag}.${extension}`;
    }
    // The token goes in a header, so it doesn't end up in the browser's download list.
    const url = new URL(server.uri + part.key);
    url.searchParams.set('download', '1');
    return {
      tag,
      path,
      url: url.href,
      token: server.token ?? '',
      size: part.size ?? 0,
      label: item.type === 'episode' ? `${episodeCode(item)}${item.title ? ` · ${item.title}` : ''}` : titleOf(item),
      show: item.grandparentTitle ?? '',
    };
  }

  function tagFor(machineId, ratingKey) {
    return `{plex-${machineId.slice(0, 8).toLowerCase()}-${ratingKey}}`;
  }

  // For the Play button (content.js): the path of a finished download of this item, so
  // IINA can play it from disk instead of streaming; null if there's none. Play never
  // waits long for this.
  shared.findDownload = async (machineId, ratingKey) => {
    try {
      const reply = await Promise.race([
        ext.runtime.sendMessage({ type: 'download-find', tag: tagFor(machineId, ratingKey) }),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      return typeof reply?.path === 'string' && reply.path.startsWith('/') ? reply.path : null;
    } catch {
      return null;
    }
  };

  function episodeCode(item) {
    const pad = (n) => String(n ?? 0).padStart(2, '0');
    return `S${pad(item.parentIndex)}E${pad(item.index)}`;
  }

  // Safe on macOS and accepted by Chrome's downloads API: no slashes, colons or other
  // characters Finder or Chrome reject, no leading dots, not too long.
  function cleanName(text) {
    return String(text ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s*:\s*/g, ' - ')
      .replace(/[\\/]/g, '-')
      .replace(/[*?"<>|~]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.-]+|[\s.]+$/g, '')
      .slice(0, 100)
      .trim();
  }

  // ---- Confirming and starting ---------------------------------------------------

  let popover = null;

  function showPopover(plan) {
    closePopover();
    const total = plan.files.reduce((sum, f) => sum + f.size, 0);
    const noun = shown?.type === 'movie' ? 'film' : `episode${plan.files.length === 1 ? '' : 's'}`;
    const tooBig = plan.freeBytes !== null && total > plan.freeBytes;

    popover = document.createElement('div');
    popover.dataset.plexToIina = 'download-popover';
    const root = popover.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .box {
          position: fixed; z-index: 2147483646; width: 360px; max-width: calc(100vw - 32px);
          box-sizing: border-box; padding: 14px 16px; border-radius: 10px; background: #1f2326;
          color: #eceef0; font: 13px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5); border: 1px solid #34383c;
        }
        h2 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
        ul { list-style: none; margin: 0 0 8px; padding: 0; max-height: 220px; overflow: auto; }
        li { display: flex; gap: 12px; padding: 3px 0; border-top: 1px solid #2c3034; }
        li:first-child { border-top: 0; }
        .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .size { color: #9aa0a6; font-variant-numeric: tabular-nums; }
        p { margin: 4px 0; color: #9aa0a6; }
        .warn { color: #f2b35b; }
        .error { color: #ff8a80; }
        .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
        button {
          font: inherit; font-weight: 600; border-radius: 6px; padding: 6px 14px; cursor: pointer;
          border: 1px solid #44494e; background: transparent; color: inherit;
        }
        button.primary { background: #e5a00d; border-color: #e5a00d; color: #1f2326; }
        button:disabled { opacity: 0.5; cursor: default; }
        button:focus-visible { outline: 2px solid #e5a00d; outline-offset: 2px; }
      </style>
      <div class="box" role="dialog" aria-label="Download">
        <h2></h2>
        <ul></ul>
        <p class="skipped" hidden></p>
        <p class="where"></p>
        <p class="after">Once you've watched one in IINA, it moves to the Trash. To keep them, turn
          off Move Watched Downloads to Trash in IINA's Plugin menu.</p>
        <p class="space" hidden></p>
        <p class="relay warn" hidden>⚠ Via Plex Relay: downloads will be very slow.</p>
        <div class="actions">
          <button type="button" class="cancel">Cancel</button>
          <button type="button" class="primary start">Download</button>
        </div>
      </div>`;
    const $ = (selector) => root.querySelector(selector);

    if (plan.files.length) {
      $('h2').textContent = `Download ${plan.files.length} ${noun} · ${formatBytes(total)}`;
      for (const file of plan.files) {
        const li = document.createElement('li');
        li.innerHTML = '<span class="name"></span><span class="size"></span>';
        li.querySelector('.name').textContent = file.label;
        li.querySelector('.name').title = file.label;
        li.querySelector('.size').textContent = formatBytes(file.size);
        $('ul').append(li);
      }
    } else {
      $('h2').textContent = plan.skipped.length === 1 ? 'Already downloaded' : `All ${plan.skipped.length} already downloaded`;
      $('ul').remove();
      $('.start').hidden = true;
      $('.after').hidden = true;
      $('.cancel').textContent = 'OK';
    }
    if (plan.skipped.length && plan.files.length) {
      $('.skipped').hidden = false;
      $('.skipped').textContent = `Already downloaded: ${plan.skipped.map((f) => f.label.split(' · ')[0]).join(', ')}`;
    }
    $('.where').textContent = `To Downloads › ${plan.folder}`;
    if (plan.freeBytes !== null && plan.files.length) {
      $('.space').hidden = false;
      $('.space').textContent = tooBig
        ? `Not enough space: ${formatBytes(plan.freeBytes)} free on this Mac.`
        : `${formatBytes(plan.freeBytes)} free on this Mac.`;
      $('.space').classList.toggle('error', tooBig);
    }
    $('.relay').hidden = !plan.server.relay;
    $('.start').disabled = tooBig;
    $('.cancel').addEventListener('click', closePopover);
    $('.start').addEventListener('click', () => start(plan, total));
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closePopover();
      event.stopPropagation(); // keep Plex's keyboard shortcuts out
    });

    document.documentElement.append(popover);
    const box = $('.box');
    const anchor = host.getBoundingClientRect();
    const left = Math.max(16, Math.min(anchor.left, window.innerWidth - box.offsetWidth - 16));
    const below = anchor.bottom + 8;
    box.style.left = `${left}px`;
    box.style.top = `${below + box.offsetHeight > window.innerHeight - 16 ? Math.max(16, anchor.top - 8 - box.offsetHeight) : below}px`;
    (plan.files.length && !tooBig ? $('.start') : $('.cancel')).focus();
    setTimeout(() => {
      document.addEventListener('pointerdown', onOutside, true);
      window.addEventListener('scroll', closePopover, true);
      window.addEventListener('hashchange', closePopover);
    });
  }

  function onOutside(event) {
    if (popover && !event.composedPath().includes(popover) && !event.composedPath().includes(host)) closePopover();
  }

  function closePopover() {
    if (!popover) return;
    popover.remove();
    popover = null;
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('scroll', closePopover, true);
    window.removeEventListener('hashchange', closePopover);
  }

  async function start(plan, total) {
    closePopover();
    const jobs = plan.files.map(({ tag, path, url, token, size, label }) => ({ tag, path, url, token, size, label }));
    try {
      const reply = await send({ type: 'download', jobs });
      if (reply.error) throw new Error(reply.error);
      const what = jobs.length === 1 ? jobs[0].label : `${jobs.length} ${shown?.type === 'movie' ? 'films' : 'episodes'}, one at a time`;
      const progress = reply.where === 'app' ? 'Progress is in the Plex to IINA app.' : "Progress is in Chrome's downloads.";
      note('log', `Download started: ${jobs.length} file(s)`);
      toast(`⬇ Downloading ${what} (${formatBytes(total)})\nTo Downloads › ${plan.folder}\n${progress}`);
    } catch (err) {
      note('log', `Download failed: ${err.message}`);
      toast(`Couldn't start the download (${err.message}).`, { error: true });
    }
  }

  // Chrome: service-worker.js answers. Safari: background.js asks the companion app.
  async function send(message) {
    let reply;
    try {
      reply = await Promise.race([
        ext.runtime.sendMessage(message),
        new Promise((_, reject) => setTimeout(() => reject(new Error('no answer')), 10000)),
      ]);
    } catch (err) {
      throw new Error(`the extension didn't answer: reload it and this page (${err.message})`);
    }
    if (!reply) throw new Error('the extension didn\'t answer: reload it and this page');
    if (reply.error) throw new Error(reply.error);
    return reply;
  }

  function formatBytes(bytes) {
    if (!bytes) return '? GB';
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e11 ? 0 : 1)} GB`;
    return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
  }
})();
