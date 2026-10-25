// Safari (and Firefox) expose the promise-based `browser` namespace; Chrome has `chrome`.
const ext = globalThis.browser ?? globalThis.chrome;
// languages.js, loaded before this script.
const LANGUAGES = globalThis.PlexToIinaLanguages;

// Keep in sync with DEFAULTS in content.js.
const DEFAULTS = {
  enabled: true, resume: true, fullScreen: false, bufferGB: 5, bestAudio: true,
  autoSubtitles: true, myLanguages: '',
};

// The browser's languages, shown when the field is empty.
const languageNames = (codes) => codes.map(LANGUAGES.displayName).join(', ');
document.getElementById('myLanguages').placeholder = languageNames(LANGUAGES.parse('')) || 'English';
// Keep in sync with DEFAULTS in download.js.
const DOWNLOAD_DEFAULTS = { downloadButton: true, downloadCount: 3 };

ext.storage.sync.get({ ...DEFAULTS, ...DOWNLOAD_DEFAULTS }).then((settings) => {
  for (const [key, value] of Object.entries(settings)) {
    const input = document.getElementById(key);
    if (!input) continue;
    if (input.type === 'checkbox') {
      input.checked = value;
      input.addEventListener('change', () => ext.storage.sync.set({ [key]: input.checked }));
    } else if (input.type === 'text') {
      input.value = value;
      // Show what was understood ("en, ES" → "English, Spanish"); unknown names drop out.
      input.addEventListener('change', () => {
        input.value = input.value.trim() ? languageNames(LANGUAGES.parse(input.value, [])) : '';
        ext.storage.sync.set({ [key]: input.value });
      });
    } else {
      input.value = String(value);
      input.addEventListener('change', () => ext.storage.sync.set({ [key]: Number(input.value) }));
    }
  }
});
