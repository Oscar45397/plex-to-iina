// Safari (and Firefox) expose the promise-based `browser` namespace; Chrome has `chrome`.
const ext = globalThis.browser ?? globalThis.chrome;
// languages.js, loaded before this script.
const LANGUAGES = globalThis.PlexToIinaLanguages;

// Keep in sync with DEFAULTS in content.js.
const DEFAULTS = {
  enabled: true, resume: true, fullScreen: false, bufferGB: 5, bestAudio: true,
  autoSubtitles: true, myLanguages: '',
};
// Keep in sync with DEFAULTS in download.js.
const DOWNLOAD_DEFAULTS = { downloadButton: true, downloadCount: 3 };

const $ = (id) => document.getElementById(id);

// The browser's languages, shown when the field is empty.
const languageNames = (codes) => codes.map(LANGUAGES.displayName).join(', ');
$('myLanguages').placeholder = languageNames(LANGUAGES.parse('')) || 'English';
$('version').textContent = `v${ext.runtime.getManifest().version}`;

// Dim what doesn't apply right now: with Play going to Plex, the playback and track
// settings; without the Download button, its episode count.
function showState() {
  const on = $('enabled').checked;
  $('status').textContent = on ? 'Play opens in IINA' : "Play uses Plex's player";
  for (const id of ['playback', 'tracks']) $(id).classList.toggle('off', !on);
  $('downloadCountRow').classList.toggle('off', !$('downloadButton').checked);
}

ext.storage.sync.get({ ...DEFAULTS, ...DOWNLOAD_DEFAULTS }).then((settings) => {
  for (const [key, value] of Object.entries(settings)) {
    const radios = document.querySelectorAll(`input[type="radio"][name="${key}"]`);
    if (radios.length) {
      for (const radio of radios) {
        radio.checked = radio.value === String(value);
        radio.addEventListener('change', () => ext.storage.sync.set({ [key]: Number(radio.value) }));
      }
      continue;
    }
    const input = $(key);
    if (!input) continue;
    if (input.type === 'checkbox') {
      input.checked = value;
      input.addEventListener('change', () => {
        ext.storage.sync.set({ [key]: input.checked });
        showState();
      });
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
  showState();
});
