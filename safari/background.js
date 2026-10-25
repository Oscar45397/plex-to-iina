// Safari only. content.js asks us to open an iina:// link; we pass it to the companion
// app (SafariWebExtensionHandler.swift), which opens it with NSWorkspace. That skips
// Safari's "Allow this page to open IINA?" question on every play.
//
// content.js also says hello when it starts on a page (we show an "on" badge for that
// tab) and sends short progress notes, which the app writes to the macOS log. And
// download.js asks for downloads, which the app does (see below).
browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'hello') {
    if (sender.tab?.id != null) {
      browser.action.setBadgeText({ tabId: sender.tab.id, text: 'on' }).catch(() => {});
    }
    log(`Active on ${message.text}`);
    return undefined;
  }
  if (message?.type === 'log') {
    log(String(message.text));
    return undefined;
  }
  // The Download button (download.js). Safari has no downloads API for extensions, so the
  // companion app checks the Downloads folder and does the downloading.
  if (['download-check', 'download-find', 'download'].includes(message?.type)) {
    const request = {
      'download-check': { downloadCheck: { tags: message.tags } },
      'download-find': { downloadFind: { tag: message.tag } },
      download: { download: { jobs: message.jobs } },
    }[message.type];
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('no answer within 8 s')), 8000));
    return Promise.race([browser.runtime.sendNativeMessage('application.id', request), timeout])
      .then((reply) => reply ?? { error: 'the Plex to IINA app did not answer' })
      .catch((err) => {
        log(`Companion app unreachable for downloads: ${err?.message ?? err}`);
        return { error: 'the Plex to IINA app did not answer; open it once, then try again' };
      });
  }
  if (message?.type !== 'open-iina' || typeof message.url !== 'string' || !message.url.startsWith('iina://open?')) {
    return undefined;
  }
  // Safari can fail to start the app (right after it's reinstalled) without ever
  // answering, so give up after 3 seconds and let content.js use a link instead.
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('no answer within 3 s')), 3000));
  return Promise.race([browser.runtime.sendNativeMessage('application.id', { openURL: message.url }), timeout])
    .then((reply) => ({ opened: reply?.opened === true }))
    .catch((err) => {
      log(`Companion app unreachable: ${err?.message ?? err}`);
      return { opened: false };
    });
});

function log(text) {
  browser.runtime.sendNativeMessage('application.id', { log: text.slice(0, 400) }).catch(() => {});
}
