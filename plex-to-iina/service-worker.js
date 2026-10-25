// Plex → IINA, Chrome only: saves the files for the Download button (download.js) with
// Chrome's downloads API. Safari has no such API; there safari/background.js hands the
// files to the companion app instead.
//
// Files download one at a time, so the first episodes are complete first, for example if
// you leave before the rest are done. The queue is kept in storage.session, which outlasts
// Chrome stopping this worker between downloads (but not a browser restart).
'use strict';

const QUEUE_KEY = 'downloadQueue';
// Stop the queue too: there's no room for the rest, or the user cancelled in Chrome.
const STOP_REASONS = new Set(['FILE_NO_SPACE', 'FILE_TOO_LARGE', 'USER_CANCELED']);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = { 'download-check': check, 'download-find': find, download: enqueue }[message?.type];
  if (!handler) return false; // the Play button's messages: nothing to do in Chrome
  handler(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err?.message ?? String(err) }));
  return true; // answering asynchronously
});

chrome.downloads.onChanged.addListener((delta) => {
  const finished = delta.state?.current === 'complete' || delta.state?.current === 'interrupted';
  if (!finished) return;
  locked(async () => {
    const queue = await load();
    if (queue.current?.id !== delta.id) return; // one of the user's own downloads
    const reason = delta.error?.current;
    if (reason) console.warn(`Download of ${queue.current.job.label} stopped: ${reason}`);
    queue.current = null;
    if (STOP_REASONS.has(reason)) queue.jobs = [];
    await startNext(queue);
  });
});

// Which of these files are already on disk or on their way. Chrome only notices deleted
// files when asked, so ask once, give it a moment to check, then ask again.
async function check({ tags }) {
  const queue = await load();
  const waiting = new Set([queue.current?.job, ...queue.jobs].filter(Boolean).map((job) => job.tag));
  await Promise.all(tags.map((tag) => chrome.downloads.search({ filenameRegex: pattern(tag) })));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const existing = [];
  for (const tag of tags) {
    if (waiting.has(tag)) {
      existing.push(tag);
      continue;
    }
    const found = await chrome.downloads.search({ filenameRegex: pattern(tag), exists: true });
    if (found.some((d) => d.state === 'complete' || d.state === 'in_progress')) existing.push(tag);
  }
  // Chrome can't tell how much disk space is free.
  return { existing, freeBytes: null };
}

// For the Play button: the path of a finished download that's still on disk, or null.
async function find({ tag }) {
  const known = await chrome.downloads.search({ filenameRegex: pattern(tag), state: 'complete' });
  if (!known.length) return { path: null };
  await new Promise((resolve) => setTimeout(resolve, 300)); // let Chrome notice deleted files
  const found = await chrome.downloads.search({
    filenameRegex: pattern(tag), state: 'complete', exists: true, orderBy: ['-startTime'],
  });
  return { path: found[0]?.filename ?? null };
}

// Matches a file name ending in this tag and an extension.
function pattern(tag) {
  return `${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[^/]+$`;
}

async function enqueue({ jobs }) {
  if (!Array.isArray(jobs) || !jobs.length) throw new Error('nothing to download');
  return locked(async () => {
    const queue = await load();
    const known = new Set([queue.current?.job, ...queue.jobs].filter(Boolean).map((job) => job.tag));
    for (const job of jobs) {
      if (!known.has(job.tag)) queue.jobs.push(job);
    }
    await startNext(queue);
    return { queued: jobs.length, where: 'chrome' };
  });
}

async function startNext(queue) {
  while (!queue.current && queue.jobs.length) {
    const job = queue.jobs.shift();
    try {
      const id = await chrome.downloads.download({
        url: job.url,
        filename: job.path,
        conflictAction: 'uniquify',
        saveAs: false,
        headers: job.token ? [{ name: 'X-Plex-Token', value: job.token }] : [],
      });
      queue.current = { id, job };
    } catch (err) {
      console.warn(`Couldn't start the download of ${job.label}: ${err?.message ?? err}`);
    }
  }
  await chrome.storage.session.set({ [QUEUE_KEY]: queue });
  const left = queue.jobs.length + (queue.current ? 1 : 0);
  await chrome.action.setBadgeText({ text: left ? String(left) : '' });
  if (left) await chrome.action.setBadgeBackgroundColor({ color: '#e5a00d' });
}

async function load() {
  const stored = (await chrome.storage.session.get(QUEUE_KEY))[QUEUE_KEY];
  return { current: stored?.current ?? null, jobs: stored?.jobs ?? [] };
}

// Messages and download events can arrive together; handle one at a time.
let lock = Promise.resolve();
function locked(fn) {
  const run = lock.then(fn);
  lock = run.catch(() => {});
  return run;
}
