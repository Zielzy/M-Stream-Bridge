// ==M-Stream Bridge==
// @name        M-Stream Bridge
// @version     __VERSION__
// @author      Zielzy
// @description Local bridge for non-DRM browser streams and Migaku Player.
// @homepage    https://github.com/Zielzy/M-Stream-Bridge
// ==/M-Stream Bridge==

/**
 * Shared metadata extraction and parsing utilities for M-Stream Bridge extension.
 */
globalThis.BridgeUtils = {
  /**
   * Converts lowercase Roman numeral tokens (i..x) into integers.
   * @param {string} token - Roman numeral string.
   * @returns {number|null} Parsed integer value or null if unmapped.
   */
  romanToInt: function (token) {
    const map = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
    return map[String(token || "").toLowerCase()] || null;
  },

  /**
   * Extracts episode numbers from arbitrary text using regex patterns.
   * @param {string} text - Input text string to evaluate.
   * @returns {number|null} Extracted episode number or null.
   */
  parseEpisodeFromText: function (text) {
    const value = String(text || "");
    const patterns = [
      /[?#&](?:ep|episode|e)=(\d{1,4})\b/i,
      /\/(?:ep|episode)[-_/ ]?(\d{1,4})(?:\b|\/)/i,
      /\/e(\d{1,4})(?:\b|\/)/i,
      /\bseason[-_/ ]?\d{1,2}[-_/ ](\d{1,4})(?:\b|\/)/i,
      /(?:^|[-_\/ ])s\d{1,2}e(\d{1,4})(?:\b|\/)/i,
      /\b(?:episode|ep)[\s.:_-]*(\d{1,4})\b/i,
      /第(\d{1,4})話/,
      /-(\d{1,4})(?:\/?$)/,
    ];

    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (match) return parseInt(match[1], 10);
    }
    return null;
  },

  /**
   * Extracts season numbers from text or Roman numeral patterns.
   * @param {string} text - Input text string.
   * @returns {number|null} Extracted season number or null.
   */
  parseSeasonFromText: function (text) {
    const value = String(text || "");
    let match = value.match(/\bS(\d{1,2})E\d{1,4}\b/i);
    if (match) return parseInt(match[1], 10);

    match = value.match(/\bSeason[ .:_-]*(\d{1,2}|[ivxlcdm]{1,6})\b/i);
    if (match) {
      const token = match[1];
      if (/^\d+$/.test(token)) return parseInt(token, 10);
      return globalThis.BridgeUtils.romanToInt(token);
    }
    return null;
  },

  /**
   * Extracts episode numbers from stream or manifest URLs, ignoring technical prefixes.
   * @param {string} url - Target stream URL.
   * @returns {number|null} Validated episode number between 1 and 2000, or null.
   */
  extractEpisodeFromUrl: function (url) {
    if (!url || typeof url !== "string") return null;

    try {
      const path = new URL(url).pathname;
      const filename = path.split("/").pop() || "";
      const dot = filename.lastIndexOf(".");
      const stem = (dot >= 0 ? filename.slice(0, dot) : filename).toLowerCase();

      const TECHNICAL_PREFIXES = [
        "stream", "index", "chunk", "segment", "seg",
        "video", "audio", "track", "part", "master",
        "playlist", "manifest", "rendition", "media",
        "frag", "init"
      ];

      if (TECHNICAL_PREFIXES.some((p) => stem.startsWith(p))) {
        return null;
      }
    } catch (_) { }

    const patterns = [
      /[\/\-_](?:episode|ep)[\/\-_]?(\d{1,4})(?:[\/\-_.?#]|$)/i,
      /[\/\-_]e(\d{1,4})(?:[\/\-_.?#]|$)/i,
      /[?&]ep(?:isode)?=(\d{1,4})(?:&|$)/i,
      /\/(\d{1,4})\/(?:index|master|playlist)\.m3u8/i,
      /\/(\d{1,4})\/[^\/?#]+\.m3u8(?:\?|$)/i,
      /[\/\-_](\d{1,4})(?:\.m3u8|\.mp4|\.ts)(?:\?|$)/i,
      /S\d{1,2}E(\d{1,4})/i,
    ];

    for (const re of patterns) {
      const m = url.match(re);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 1 && n <= 2000) return n;
      }
    }
    return null;
  }
};