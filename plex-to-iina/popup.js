// Safari (and Firefox) expose the promise-based `browser` namespace; Chrome has `chrome`.
const ext = globalThis.browser ?? globalThis.chrome;

// Keep in sync with DEFAULTS in content.js.
const DEFAULTS = { enabled: true, resume: true, fullScreen: false, bufferGB: 5, bestAudio: true };
// Keep in sync with DEFAULTS in download.js.
const DOWNLOAD_DEFAULTS = { downloadButton: true, downloadCount: 3 };

ext.storage.sync.get({ ...DEFAULTS, ...DOWNLOAD_DEFAULTS }).then((settings) => {
  for (const [key, value] of Object.entries(settings)) {
    const input = document.getElementById(key);
    if (!input) continue;
    if (input.type === 'checkbox') {
      input.checked = value;
      input.addEventListener('change', () => ext.storage.sync.set({ [key]: input.checked }));
    } else {
      input.value = String(value);
      input.addEventListener('change', () => ext.storage.sync.set({ [key]: Number(input.value) }));
    }
  }
});
