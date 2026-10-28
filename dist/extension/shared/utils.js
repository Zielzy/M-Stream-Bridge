// ==M-Stream Bridge==
// @name        M-Stream Bridge
// @version     3.1.0
// @author      Zielzy
// @description Local bridge for non-DRM browser streams and Migaku Player.
// @homepage    https://github.com/Zielzy/M-Stream-Bridge
// ==/M-Stream Bridge==


globalThis.BridgeUtils = {
    romanToInt: function(token) {
        return {
            i: 1,
            ii: 2,
            iii: 3,
            iv: 4,
            v: 5,
            vi: 6,
            vii: 7,
            viii: 8,
            ix: 9,
            x: 10
        }[String(token || "").toLowerCase()] || null;
    },
    parseEpisodeFromText: function(text) {
        const value = String(text || ""), patterns = [ /[?#&](?:ep|episode|e)=(\d{1,4})\b/i, /\/(?:ep|episode)[-_/ ]?(\d{1,4})(?:\b|\/)/i, /\/e(\d{1,4})(?:\b|\/)/i, /\bseason[-_/ ]?\d{1,2}[-_/ ](\d{1,4})(?:\b|\/)/i, /(?:^|[-_\/ ])s\d{1,2}e(\d{1,4})(?:\b|\/)/i, /\b(?:episode|ep)[\s.:_-]*(\d{1,4})\b/i, /第(\d{1,4})話/, /-(\d{1,4})(?:\/?$)/ ];
        for (const pattern of patterns) {
            const match = value.match(pattern);
            if (match) return parseInt(match[1], 10);
        }
        return null;
    },
    parseSeasonFromText: function(text) {
        const value = String(text || "");
        let match = value.match(/\bS(\d{1,2})E\d{1,4}\b/i);
        if (match) return parseInt(match[1], 10);
        if (match = value.match(/\bSeason[ .:_-]*(\d{1,2}|[ivxlcdm]{1,6})\b/i), match) {
            const token = match[1];
            return /^\d+$/.test(token) ? parseInt(token, 10) : globalThis.BridgeUtils.romanToInt(token);
        }
        return null;
    },
    extractEpisodeFromUrl: function(url) {
        if (!url || "string" != typeof url) return null;
        try {
            const filename = new URL(url).pathname.split("/").pop() || "", dot = filename.lastIndexOf("."), stem = (dot >= 0 ? filename.slice(0, dot) : filename).toLowerCase();
            if ([ "stream", "index", "chunk", "segment", "seg", "video", "audio", "track", "part", "master", "playlist", "manifest", "rendition", "media", "frag", "init" ].some(p => stem.startsWith(p))) return null;
        } catch (_) {}
        const patterns = [ /[\/\-_](?:episode|ep)[\/\-_]?(\d{1,4})(?:[\/\-_.?#]|$)/i, /[\/\-_]e(\d{1,4})(?:[\/\-_.?#]|$)/i, /[?&]ep(?:isode)?=(\d{1,4})(?:&|$)/i, /\/(\d{1,4})\/(?:index|master|playlist)\.m3u8/i, /\/(\d{1,4})\/[^\/?#]+\.m3u8(?:\?|$)/i, /[\/\-_](\d{1,4})(?:\.m3u8|\.mp4|\.ts)(?:\?|$)/i, /S\d{1,2}E(\d{1,4})/i ];
        for (const re of patterns) {
            const m = url.match(re);
            if (m) {
                const n = parseInt(m[1], 10);
                if (n >= 1 && n <= 2e3) return n;
            }
        }
        return null;
    }
};
