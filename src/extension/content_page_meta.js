// ==M-Stream Bridge==
// @name        M-Stream Bridge
// @version     __VERSION__
// @author      Zielzy
// @description Local bridge for non-DRM browser streams and Migaku Player.
// @homepage    https://github.com/Zielzy/M-Stream-Bridge
// ==/M-Stream Bridge==

/**
 * M-Stream Bridge - Content Script (content_page_meta.js)
 *
 * Injected into web page tabs to collect metadata (media title, episode, season,
 * and video tag presence) from the active DOM. Relays data to the extension
 * Service Worker (`service_worker.js`) and manages the IDM-style floating capture badge.
 */
(function () {
  "use strict";

  // ==========================================================================
  // 1. Imports & Configuration
  // ==========================================================================

  const { parseEpisodeFromText, parseSeasonFromText } = globalThis.BridgeUtils;
  const ALLOWED_JSON_LD_TYPES = new Set(["Movie", "TVSeries", "VideoObject", "Episode", "CreativeWork", "AnimeSeries", "AnimeEpisode"]);

  let lastSentKey = "";
  let mutationSyncTimer = null;
  let spaFollowupTimers = [];

  /**
   * Schedules metadata transmission after DOM mutations settle.
   * Debounces scans to prevent performance overhead on rapid DOM updates.
   * @param {boolean} force - Force delivery flag.
   * @param {number} delayMs - Debounce delay in milliseconds.
   */
  function scheduleMeta(force, delayMs = 220) {
    if (mutationSyncTimer) clearTimeout(mutationSyncTimer);
    mutationSyncTimer = setTimeout(() => {
      mutationSyncTimer = null;
      sendMeta(force);
    }, delayMs);
  }

  /**
   * Cancels old SPA followup timers to prevent stale async work from abandoned pages.
   */
  function clearSpaFollowups() {
    spaFollowupTimers.forEach((timer) => clearTimeout(timer));
    spaFollowupTimers = [];
  }

  /**
   * Normalizes title candidate strings by collapsing whitespace.
   * @param {string} text - Raw title string.
   * @returns {string} Cleaned title string.
   */
  function cleanTitleCandidate(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ==========================================================================
  // 2. DOM Scrapers & Title Candidate Extractor
  // ==========================================================================

  /**
   * Collects title candidates from document title, meta tags, headings, JSON-LD, and URL slugs.
   * @returns {Array<{value: string, source: string}>} Array of scored candidate objects.
   */
  function collectTitleCandidates() {
    const out = [];
    const seen = new Set();

    function add(value, source = "unknown") {
      const cleaned = cleanTitleCandidate(value);
      if (!cleaned || cleaned.length < 2 || cleaned.length > 180) return;
      const key = `${cleaned.toLowerCase()}::${source}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ value: cleaned, source: source });
    }

    // 1. Document title
    add(document.title || "", "title_tag");

    // 2. Open Graph, Twitter, and Schema meta tags
    [
      { selector: "meta[property='og:title']", source: "og_title" },
      { selector: "meta[name='twitter:title']", source: "twitter_title" },
      { selector: "meta[name='title']", source: "title_tag" },
      { selector: "meta[itemprop='name']", source: "heading" },
    ].forEach(({ selector, source }) => {
      document.querySelectorAll(selector).forEach((el) => {
        add(el.getAttribute("content"), source);
      });
    });

    // 3. Headings
    document.querySelectorAll("h1, h2, [itemprop='name']").forEach((el) => {
      add(el.textContent, "heading");
    });

    // 4. JSON-LD structured data
    document.querySelectorAll("script[type='application/ld+json']").forEach((el) => {
      try {
        const data = JSON.parse(el.textContent || "null");
        const stack = Array.isArray(data) ? [...data] : [data];
        const collectionTypes = new Set(["ItemList", "CollectionPage", "SearchResultsPage"]);

        while (stack.length) {
          const item = stack.shift();
          if (!item || typeof item !== "object") continue;

          const type = typeof item["@type"] === "string" ? item["@type"] : (Array.isArray(item["@type"]) ? item["@type"][0] : "");

          // Skip collection children to prevent scanning entire listing grids
          if (type && collectionTypes.has(type)) {
            continue;
          }

          if (!type || ALLOWED_JSON_LD_TYPES.has(type)) {
            if (ALLOWED_JSON_LD_TYPES.has(type)) {
              if (item.name) add(item.name, "json_ld");
              if (item.alternateName) add(item.alternateName, "json_ld");
              if (item.headline) add(item.headline, "json_ld");
            }
          }

          for (const value of Object.values(item)) {
            if (Array.isArray(value)) {
              stack.push(...value);
            } else if (value && typeof value === "object") {
              stack.push(value);
            }
          }
        }
      } catch (_err) { }
    });

    // 5. Synonyms, Japanese, and alternative titles
    document.querySelectorAll("li, p, [class*='alias'], [class*='synonym'], [class*='alternative'], [class*='info'], [class*='detail']").forEach((el) => {
      if (out.length >= 30) return;
      const text = cleanTitleCandidate(el.textContent || "");
      const match = text.match(/^(?:alternative|synonyms?|japanese|english|romaji|native|other name)s?\s*[:：]\s*(.+)$/i);
      if (!match) return;
      match[1].split(/[,/;|]/).forEach((v) => add(v, "unknown"));
    });

    // 6. URL path slug
    try {
      const urlPath = location.pathname || "";
      const segments = urlPath.split("/").filter(Boolean);
      for (const segment of segments) {
        if (/^\d+$/.test(segment)) continue;
        if (segment.length < 3) continue;
        if (/^(watch|anime|episode|ep|series|tv|movie|play|video|embed|stream|season|sub|dub|page|category|genre|search|browse|home|index|api|v\d+)$/i.test(segment)) continue;
        const titleFromSlug = segment
          .replace(/[-_]+/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase())
          .trim();
        if (titleFromSlug && titleFromSlug.length >= 3) {
          add(titleFromSlug, "url_slug");
        }
      }
    } catch (_err) { }

    return out.slice(0, 30);
  }

  // ==========================================================================
  // 3. Episode & Season DOM Heuristics
  // ==========================================================================

  /**
   * Scans active buttons, lists, and URL anchors in the DOM to identify the active episode.
   * @returns {number|null} Best scored episode number or null.
   */
  function detectEpisodeFromDom() {
    const candidates = [];

    function addCandidate(ep, score, source) {
      if (!ep || ep < 1) return;
      candidates.push({ ep, score, source });
    }

    const strongSelectors = [
      ".ssl-item.ep-item.active",
      ".ep-item.active",
      "[class*='episode'][class*='active']",
      "[class*='ep-'][class*='active']",
      "[aria-current='page']",
      "[data-episode].active",
      "[data-ep].active",
    ];

    for (const selector of strongSelectors) {
      const list = document.querySelectorAll(selector);
      list.forEach((el) => {
        const text = String(el.textContent || "");
        const href = String(el.getAttribute("href") || "");
        const dataEpisode = String(el.getAttribute("data-episode") || el.getAttribute("data-ep") || "");
        addCandidate(parseEpisodeFromText(dataEpisode), 120, `${selector}:data`);
        addCandidate(parseEpisodeFromText(text), 110, `${selector}:text`);
        addCandidate(parseEpisodeFromText(href), 105, `${selector}:href`);
      });
    }

    const links = document.querySelectorAll("a[href]");
    links.forEach((a) => {
      const href = String(a.getAttribute("href") || "");
      const text = String(a.textContent || "");
      const absHref = (() => {
        try {
          return new URL(href, location.href).href;
        } catch (_err) {
          return "";
        }
      })();

      if (absHref && (absHref === location.href || absHref.replace(/\/$/, "") === location.href.replace(/\/$/, ""))) {
        addCandidate(parseEpisodeFromText(text), 95, "anchor-current:text");
        addCandidate(parseEpisodeFromText(absHref), 90, "anchor-current:href");
      }

      if (/episode|ep|watch/i.test(href)) {
        addCandidate(parseEpisodeFromText(href), 70, "anchor-href");
      }
    });

    if (!candidates.length) return null;

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.ep - a.ep;
    });

    return candidates[0].ep;
  }

  // ==========================================================================
  // 4. Page Kind Classifier & Metadata Payload Builder
  // ==========================================================================

  /**
   * Determines page type (entity vs listing) based on URL, Open Graph, and JSON-LD signals.
   * @returns {{kind: string, reason: string}} Page classification result.
   */
  function detectPageKind() {
    const pathname = location.pathname || "";

    // Level 1: URL Pattern
    if (/watch|anime|episode|title|series|movie|play/i.test(pathname)) {
      return { kind: "entity", reason: "url_match" };
    }

    // Level 2: Open Graph Metadata
    const ogType = document.querySelector("meta[property='og:type']")?.getAttribute("content") || "";
    if (ogType.includes("video") || ogType.includes("movie") || ogType.includes("tv_show")) {
      return { kind: "entity", reason: "og_video" };
    }

    // Level 3: JSON-LD Valid Entity
    let hasEntityLd = false;
    document.querySelectorAll("script[type='application/ld+json']").forEach((el) => {
      if (hasEntityLd) return;
      try {
        const data = JSON.parse(el.textContent || "null");
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (!item || typeof item !== "object") continue;
          const type = typeof item["@type"] === "string" ? item["@type"] : (Array.isArray(item["@type"]) ? item["@type"][0] : "");
          if (ALLOWED_JSON_LD_TYPES.has(type)) {
            hasEntityLd = true;
          }
        }
      } catch (_err) { }
    });

    if (hasEntityLd) {
      return { kind: "entity", reason: "jsonld_entity" };
    }

    return { kind: "listing", reason: "default" };
  }

  /**
   * Assembles all metadata extracted from the active page into a structured payload.
   * @returns {Object} Structured metadata message payload.
   */
  function buildMeta() {
    const pageUrl = location.href || "";
    const title = document.title || "";
    const { kind: pageKind, reason: pageReason } = detectPageKind();

    if (pageKind === "listing") {
      return {
        type: "bridge_ext_page_meta",
        page_url: pageUrl,
        title: title,
        title_candidates: [],
        episode: null,
        season: null,
        has_video: false,
        video_count: document.querySelectorAll("video").length,
        is_top_frame: window === window.top,
        frame_url: location.href,
        perf_now: performance.now(),
        page_kind: pageKind,
        page_reason: pageReason,
      };
    }

    const titleCandidates = collectTitleCandidates();
    const episode = parseEpisodeFromText(pageUrl) || detectEpisodeFromDom() || parseEpisodeFromText(title) || null;
    const season = parseSeasonFromText(pageUrl) || parseSeasonFromText(title) || null;
    const videoCount = document.querySelectorAll("video").length;

    return {
      type: "bridge_ext_page_meta",
      page_url: pageUrl,
      title,
      title_candidates: titleCandidates,
      episode,
      season,
      has_video: videoCount > 0,
      video_count: videoCount,
      is_top_frame: window === window.top,
      frame_url: location.href,
      perf_now: performance.now(),
      page_kind: pageKind,
      page_reason: pageReason,
    };
  }

  // ==========================================================================
  // 5. Metadata Dispatcher & SPA Navigation Observers
  // ==========================================================================

  /**
   * Extracts latest metadata and sends it to the extension Service Worker.
   * @param {boolean} force - Force delivery flag.
   */
  function sendMeta(force) {
    const meta = buildMeta();
    const key = JSON.stringify([
      meta.page_url,
      meta.episode,
      meta.season,
      meta.title,
      meta.title_candidates,
      meta.has_video,
      meta.video_count,
    ]);

    if (!force && key === lastSentKey) return;
    lastSentKey = key;

    console.debug(`[Bridge] sending page meta (t=${Math.round(meta.perf_now)}ms)`, {
      href: location.href,
      title: document.title,
      top: window === window.top,
      episode: meta.episode,
    });

    try {
      chrome.runtime.sendMessage(meta, function () {
        void chrome.runtime.lastError;
      });
    } catch (_err) { }
  }

  sendMeta(true);
  setTimeout(() => sendMeta(false), 1200);

  setInterval(() => {
    if (!document.hidden) sendMeta(false);
  }, 5000);

  let lastHref = location.href;
  const obs = new MutationObserver(function () {
    if (location.href !== lastHref) {
      lastHref = location.href;
      clearSpaFollowups();

      // On SPAs, metadata tags update after route change.
      // Stage polling intervals (50ms, 300ms, 800ms, 2000ms) prevent race conditions.
      spaFollowupTimers = [50, 300, 800, 2000].map((delay) => (
        setTimeout(() => sendMeta(true), delay)
      ));
      return;
    }
    scheduleMeta(false);
  });
  obs.observe(document.documentElement || document, { childList: true, subtree: true });

  window.addEventListener("popstate", () => scheduleMeta(true, 0), true);
  window.addEventListener("hashchange", () => scheduleMeta(true, 0), true);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) scheduleMeta(false, 0);
  });

  // ==========================================================================
  // 6. M-Stream Hook Receiver & Stream Candidate Scorer
  // ==========================================================================

  window.__MSTREAM_CAPTURED = [];
  let streamSendTimer = null;
  const STREAM_DEBOUNCE_MS = 1500;

  window.addEventListener("message", function (event) {
    if (event.source !== window || !event.data || event.data.source !== "__MSTREAM__") return;
    if (event.data.version !== 1) return;

    if (event.data.type === "NAV") {
      window.__MSTREAM_CAPTURED = [];
      return;
    }

    if ((event.data.type === "FETCH" || event.data.type === "XHR") && event.data.payload) {
      const url = event.data.payload.url;
      if (url.includes(".ts") || url.includes(".m4s")) return;

      if (!window.__MSTREAM_CAPTURED.find((c) => c.url === url)) {
        window.__MSTREAM_CAPTURED.push(event.data.payload);

        if (event.data.payload.isMaster) {
          if (streamSendTimer) clearTimeout(streamSendTimer);
          sendBestStreamCandidate();
          return;
        }

        if (streamSendTimer) clearTimeout(streamSendTimer);
        streamSendTimer = setTimeout(() => {
          sendBestStreamCandidate();
        }, STREAM_DEBOUNCE_MS * 2);
      }
    }
  });

  /**
   * Evaluates buffered stream candidate URLs and sends the highest-scoring candidate.
   */
  function sendBestStreamCandidate() {
    if (!window.__MSTREAM_CAPTURED.length) return;

    let best = window.__MSTREAM_CAPTURED[0];
    let bestScore = -100;

    for (const candidate of window.__MSTREAM_CAPTURED) {
      let score = 10;

      if (candidate.isMaster) score += 1000;

      const u = candidate.url.toLowerCase();

      if (u.match(/4k|2160p?/)) score += 100;
      if (u.includes("1080p")) score += 90;
      if (u.includes("720p")) score += 80;
      if (u.includes("master")) score += 40;
      if (u.includes("resolution")) score += 30;
      if (u.includes("index.m3u8")) score += 20;
      if (u.includes(".m3u8")) score += 20;
      if (u.includes("/playlist/")) score += 20;
      if (u.includes("/manifest/")) score += 20;
      if (u.includes(".mp4") || u.includes(".webm")) score += 20;

      if (u.includes("/api/")) score -= 100;
      if (u.includes("transcript")) score -= 100;
      if (u.includes("json") || u.includes("graphql")) score -= 100;

      if (u.match(/[/_-]?(init|segment|frag|part|chunk)\d*\.(mp4|m4s|m4a|m4v|webm)(\?|$)/)) continue;
      if (u.endsWith("init.mp4") || u.includes("init.mp4?")) continue;
      if (u.includes("initialization") || u.includes("init-stream")) continue;
      if (u.match(/\/(video|audio)_init/)) continue;

      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    if (bestScore < 0) return;

    try {
      chrome.runtime.sendMessage({
        type: "bridge_ext_page_hook",
        url: best.url,
        method: best.method || "GET",
        isMaster: !!best.isMaster,
        pageUrl: location.href,
      }, function () {
        void chrome.runtime.lastError;
      });

      if (typeof showHookButton === "function") {
        showHookButton();
      }
    } catch (e) { }
  }

  document.addEventListener("play", function (event) {
    if (event.target && event.target.tagName === "VIDEO") {
      if (streamSendTimer) clearTimeout(streamSendTimer);
      streamSendTimer = setTimeout(() => {
        sendBestStreamCandidate();
      }, STREAM_DEBOUNCE_MS);
    }
  }, true);

  // ==========================================================================
  // 7. IDM-Style Floating Video Action Button Manager
  // ==========================================================================

  let mstreamBtnState = "IDLE";
  let mstreamBtnRoot = null;
  let resizeObs = null;
  let intObs = null;
  let rafPending = false;
  let lastClickAt = 0;
  let trackingVideo = null;

  /**
   * Finds the currently active, visible video player element.
   * @returns {HTMLVideoElement|null} Video element or null.
   */
  function findActiveVideo() {
    const videos = [...document.querySelectorAll("video")];
    const playing = videos.filter((v) => {
      const r = v.getBoundingClientRect();
      return !v.paused && v.readyState >= 2 && r.width > 50 && r.height > 50 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
    });

    const pool = playing.length ? playing : videos.filter((v) => {
      const r = v.getBoundingClientRect();
      return v.readyState >= 2 && r.width > 50 && r.height > 50 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
    });

    return pool.sort((a, b) => {
      const rA = a.getBoundingClientRect();
      const rB = b.getBoundingClientRect();
      return (rB.width * rB.height) - (rA.width * rA.height);
    })[0] || null;
  }

  /**
   * Positions the floating button above or within the video player bounding rect.
   */
  function updatePosition() {
    if (mstreamBtnState !== "VISIBLE" || !mstreamBtnRoot) return;
    const video = findActiveVideo();
    if (!video) return;
    const rect = video.getBoundingClientRect();

    let topPos = rect.top - 28;
    let leftPos = rect.left;

    if (topPos < 0) {
      topPos = rect.top + 16;
      leftPos = rect.left + 16;
    }

    mstreamBtnRoot.style.top = `${topPos}px`;
    mstreamBtnRoot.style.left = `${leftPos}px`;
  }

  /**
   * Sets visible/hidden transition state for floating button.
   * @param {string} state - State key ("VISIBLE" | "HIDDEN").
   */
  function setButtonState(state) {
    if (!mstreamBtnRoot) return;
    mstreamBtnState = state;
    if (state === "VISIBLE") {
      mstreamBtnRoot.style.opacity = "1";
      mstreamBtnRoot.style.pointerEvents = "auto";
      mstreamBtnRoot.style.transform = "scale(1) translateY(0)";
      updatePosition();
    } else if (state === "HIDDEN") {
      mstreamBtnRoot.style.opacity = "0";
      mstreamBtnRoot.style.pointerEvents = "none";
      mstreamBtnRoot.style.transform = "scale(0.95) translateY(-4px)";
    }
  }

  function detachObservers() {
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    if (intObs) { intObs.disconnect(); intObs = null; }
  }

  /**
   * Observes video resizing and viewport intersection to automatically position button.
   * @param {HTMLVideoElement|null} video - Target video element.
   */
  function attachObservers(video) {
    detachObservers();
    trackingVideo = video;
    if (!video) return;

    resizeObs = new ResizeObserver(() => {
      if (mstreamBtnState === "VISIBLE") updatePosition();
    });
    resizeObs.observe(video);

    intObs = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          if (mstreamBtnState === "HIDDEN") setButtonState("VISIBLE");
        } else {
          if (mstreamBtnState === "VISIBLE") setButtonState("HIDDEN");
        }
      });
    }, { threshold: 0.1 });
    intObs.observe(video);
  }

  /**
   * Initializes floating capture button DOM elements and event handlers.
   * @returns {boolean} True if initialized.
   */
  function initUI() {
    if (window.__mstreamFloatingButton) return true;
    window.__mstreamFloatingButton = true;

    mstreamBtnRoot = document.createElement("div");
    mstreamBtnRoot.id = "mstream-floating-root";
    Object.assign(mstreamBtnRoot.style, {
      position: "fixed",
      zIndex: "2147483647",
      pointerEvents: "none",
      top: "-999px",
      left: "-999px",
      opacity: "0",
      transform: "scale(0.9) translateY(-4px)",
      transition: "opacity 200ms ease-out, transform 200ms ease-out",
      display: "flex",
    });

    const btn = document.createElement("button");
    btn.id = "mstream-hook-btn";
    Object.assign(btn.style, {
      pointerEvents: "auto",
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      padding: "2px 8px",
      background: "#f5f3fa",
      color: "#4B00B2",
      border: "1px solid rgba(75, 0, 178, 0.15)",
      borderRadius: "3px",
      boxShadow: "1px 1px 3px rgba(0,0,0,0.15)",
      cursor: "pointer",
      fontFamily: "'Segoe UI', 'Outfit', Arial, sans-serif",
      fontSize: "12px",
      fontWeight: "500",
      lineHeight: "1.2",
      transition: "all 0.1s ease",
      userSelect: "none",
      height: "24px",
      boxSizing: "border-box",
    });

    const iconUrl = chrome.runtime.getURL("icons/mstream.png");
    btn.innerHTML = `
      <img src="${iconUrl}" alt="logo" style="width: 14px; height: 14px; border-radius: 1px;" />
      <span>M-Stream Bridge</span>
    `;

    btn.addEventListener("mouseenter", () => {
      Object.assign(btn.style, {
        background: "#6D28D9",
        color: "#ffffff",
        boxShadow: "2px 2px 6px rgba(0,0,0,0.3)",
      });
    });
    btn.addEventListener("mouseleave", () => {
      Object.assign(btn.style, {
        background: "#f5f3fa",
        color: "#4B00B2",
        boxShadow: "1px 1px 3px rgba(0,0,0,0.15)",
      });
    });

    btn.addEventListener("click", () => {
      const now = Date.now();
      if (now - lastClickAt < 500) return;
      lastClickAt = now;
      try {
        if (!chrome.runtime?.id) return;
        chrome.runtime.sendMessage({ type: "bridge_open_popup" }, () => {
          void chrome.runtime.lastError;
        });
      } catch (err) {
        console.debug("[M-Stream] Runtime context invalidated.", err);
      }
    });

    mstreamBtnRoot.appendChild(btn);
    (document.documentElement || document.body).appendChild(mstreamBtnRoot);

    window.addEventListener("scroll", () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        if (mstreamBtnState === "VISIBLE") updatePosition();
        rafPending = false;
      });
    }, { passive: true, capture: true });

    const mutObs = new MutationObserver(() => {
      if (mstreamBtnState !== "IDLE") {
        const currentVideo = findActiveVideo();
        if (currentVideo && currentVideo !== trackingVideo) {
          attachObservers(currentVideo);
          setButtonState("VISIBLE");
        }
      }
    });
    mutObs.observe(document.body || document.documentElement, { childList: true, subtree: true });

    return true;
  }

  /**
   * Displays the floating capture button on active video player.
   */
  function showHookButton() {
    initUI();
    const video = findActiveVideo();
    if (video) {
      attachObservers(video);
      setButtonState("VISIBLE");
    }
  }

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === "bridge_force_meta_update") {
        sendMeta(true);
      }
    });
  }
})();

