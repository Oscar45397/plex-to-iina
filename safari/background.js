// Safari only. content.js asks us to open an iina:// link; we pass it to the companion
// app (SafariWebExtensionHandler.swift), which opens it with NSWorkspace. That skips
// Safari's "Allow this page to open IINA?" question on every play.
//
// content.js also says hello when it starts on a page (we show an "on" badge for that
// tab) and sends short progress notes, which the app writes to the macOS log.
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
