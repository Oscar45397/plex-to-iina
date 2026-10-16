// Language helpers shared by content.js and the popup. Languages are handled as
// two-letter codes ("en", "es"): from a typed list like "English, Spanish" or "en, es",
// from the browser's languages, or from a Plex stream's languageTag / languageCode.
globalThis.PlexToIinaLanguages = (() => {
  'use strict';

  // Languages recognised by name (in English or in the language itself).
  const NAMED = ['en', 'de', 'fr', 'es', 'it', 'pt', 'ja', 'ko', 'zh', 'sv', 'da', 'no', 'fi', 'nl',
    'pl', 'ru', 'tr', 'ar', 'he', 'hi', 'cs', 'hu', 'el', 'ro', 'uk', 'th', 'id', 'vi', 'ms'];
  // Three-letter codes Plex and video files use (ISO 639-2, both B and T forms).
  const THREE = {
    eng: 'en', ger: 'de', deu: 'de', fre: 'fr', fra: 'fr', spa: 'es', dut: 'nl', nld: 'nl',
    ita: 'it', por: 'pt', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', swe: 'sv', dan: 'da',
    nor: 'no', nob: 'no', nno: 'no', fin: 'fi', pol: 'pl', rus: 'ru', tur: 'tr', ara: 'ar',
    heb: 'he', hin: 'hi', cze: 'cs', ces: 'cs', hun: 'hu', gre: 'el', ell: 'el', rum: 'ro',
    ron: 'ro', ukr: 'uk', tha: 'th', ind: 'id', vie: 'vi', may: 'ms', msa: 'ms',
  };
  const ALIASES = { nb: 'no', nn: 'no', iw: 'he', in: 'id' };

  let byName = null;
  function nameMap() {
    if (byName) return byName;
    byName = new Map();
    for (const code of NAMED) {
      for (const locale of ['en', code]) {
        try {
          const name = new Intl.DisplayNames([locale], { type: 'language' }).of(code);
          if (name) byName.set(name.toLowerCase(), code);
        } catch {
          // This browser doesn't know the locale; the English name still works.
        }
      }
    }
    return byName;
  }

  // "en-US", "eng", "English", "Español" → "en" / "es"; anything else → null.
  function normalize(token) {
    const text = String(token ?? '').trim().toLowerCase();
    if (!text) return null;
    const primary = text.split(/[-_]/)[0];
    if (/^[a-z]{2}$/.test(primary)) return ALIASES[primary] ?? primary;
    if (/^[a-z]{3}$/.test(primary) && THREE[primary]) return THREE[primary];
    return nameMap().get(text) ?? null;
  }

  // A comma-separated list in order of preference, or the browser's languages if empty.
  function parse(text, fallback = globalThis.navigator?.languages ?? []) {
    const tokens = text && String(text).trim() ? String(text).split(/[,;]/) : fallback;
    return [...new Set(tokens.map(normalize).filter(Boolean))];
  }

  function displayName(code) {
    try {
      return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
    } catch {
      return code;
    }
  }

  // The language of a Plex audio or subtitle stream, or null when the file doesn't say.
  function ofStream(stream) {
    if (!stream) return null;
    return normalize(stream.languageTag) ?? normalize(stream.languageCode);
  }

  return { parse, normalize, displayName, ofStream };
})();
