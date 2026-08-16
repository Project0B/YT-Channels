/**
 * watch-progress.js — content script injected on every youtube.com page
 * (manifest.json's content_scripts, matching the existing host_permissions
 * so no new permission prompt is triggered), not just /watch pages.
 *
 * Why all of youtube.com rather than just "/watch" pages: browsers only
 * auto-inject a content script on a real page navigation matching its
 * `matches` pattern. Clicking a video from within YouTube's own UI (search
 * results, the homepage, a channel's videos tab) doesn't trigger one — it's
 * a client-side history.pushState navigation, not a fresh page load — so a
 * script scoped to just /watch* would never get injected at all when a
 * video is opened that way (only when a /watch URL is loaded directly, e.g.
 * via this extension's feed links). Injecting everywhere and gating actual
 * tracking on the current URL internally (getVideoIdFromUrl below) means
 * the SPA-navigation listener has already been set up by the time any watch
 * page is reached, regardless of where the tab started.
 *
 * Tracks real playback progress from the page's own <video> element rather
 * than reverse-engineering YouTube's ytInitialData/innertube JSON — same
 * instinct as youtube-watchmarker (https://github.com/sniklaus/youtube-watchmarker)
 * observing the live rendered DOM instead of a hidden data field. Reports
 * the maximum progress reached per videoId to background.js via the same
 * browser.runtime message-passing pattern used elsewhere in this codebase
 * (feed.js's send()). See DECISIONS.md for the full rationale and trade-offs.
 */

(function () {
  const REPORT_INTERVAL_MS = 5000;
  const PLAYER_SELECTOR = "#movie_player, .html5-video-player";
  const VIDEO_SELECTOR = "video.html5-main-video";
  const URL_POLL_MS = 2000;

  let currentVideoId = null;
  let lastReportedProgress = -1;
  let lastReportTime = 0;
  let adActive = false;
  let adObserver = null;

  function getVideoIdFromUrl(href) {
    try {
      const url = new URL(href);
      if (url.pathname !== "/watch") return null;
      return url.searchParams.get("v");
    } catch (e) {
      return null;
    }
  }

  function send(type, extra) {
    try {
      const result = browser.runtime.sendMessage({ type, ...extra });
      // Manifest V3 event page may be suspended/restarting; a rejected
      // promise here just means this particular report is lost, not a bug
      // worth surfacing — the next throttled report will retry.
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (e) {
      // Extension context invalidated (e.g. the extension was reloaded) —
      // nothing this page can do about it.
    }
  }

  function getVideoEl() {
    return document.querySelector(VIDEO_SELECTOR);
  }

  function getPlayerEl() {
    return document.querySelector(PLAYER_SELECTOR);
  }

  function reportProgress(force) {
    if (!currentVideoId || adActive) return;
    const video = getVideoEl();
    if (!video || !video.duration || Number.isNaN(video.duration)) return;

    const now = Date.now();
    if (!force && now - lastReportTime < REPORT_INTERVAL_MS) return;

    const progress = Math.min(1, Math.max(0, video.currentTime / video.duration));
    if (!force && progress <= lastReportedProgress) return;

    lastReportTime = now;
    lastReportedProgress = progress;
    send("UPDATE_WATCH_PROGRESS", { videoId: currentVideoId, progress });
  }

  // YouTube reuses the same <video> element for pre-roll/mid-roll ads, which
  // would otherwise inflate a video's recorded progress with ad watch time.
  // Verified against a live watch page (2026-08-12): the player container
  // (#movie_player / .html5-video-player) gets an "ad-showing" class for the
  // duration of an ad and loses it when the ad ends — confirmed both in the
  // live class list and across YouTube's own shipped CSS (e.g.
  // ".html5-video-player.ad-showing", ".ad-showing .ad-video"). A
  // MutationObserver on that class attribute lets tracking pause/resume
  // without polling every tick.
  function startAdWatcher() {
    if (adObserver) adObserver.disconnect();
    const player = getPlayerEl();
    if (!player) {
      adActive = false;
      return;
    }
    adActive = player.classList.contains("ad-showing");
    adObserver = new MutationObserver(() => {
      const showing = player.classList.contains("ad-showing");
      if (showing !== adActive) {
        adActive = showing;
        if (!adActive) {
          // Ad just ended — resync against real position immediately rather
          // than waiting out the throttle window.
          lastReportTime = 0;
          reportProgress(true);
        }
      }
    });
    adObserver.observe(player, { attributes: true, attributeFilter: ["class"] });
  }

  function attachVideoListeners(video) {
    if (video.dataset.ytChannelsBound) return;
    video.dataset.ytChannelsBound = "1";
    video.addEventListener("timeupdate", () => reportProgress(false));
    video.addEventListener("pause", () => reportProgress(true));
  }

  function startTracking() {
    const nextVideoId = getVideoIdFromUrl(location.href);
    if (nextVideoId === currentVideoId) return;

    currentVideoId = nextVideoId;
    lastReportedProgress = -1;
    lastReportTime = 0;
    startAdWatcher();

    const video = getVideoEl();
    if (video) attachVideoListeners(video);
  }

  // YouTube is a single-page app: autoplay-next or clicking a suggested
  // video swaps the <video> element's source and the URL via
  // history.pushState, without a full page load. `yt-navigate-finish` is
  // YouTube's own event marking "a client-side navigation just completed"
  // (dispatched on document); the URL-polling fallback below covers the
  // case where that event is renamed, delayed, or removed in a future
  // YouTube build.
  document.addEventListener("yt-navigate-finish", () => {
    startTracking();
    const video = getVideoEl();
    if (video) attachVideoListeners(video);
  });

  // Also doubles as a retry for attachVideoListeners(): at document_idle the
  // player may not have inserted its <video> element yet, so each tick
  // re-checks and attaches (idempotently, via the dataset flag) once it
  // exists rather than only on a URL change.
  let lastPolledUrl = location.href;
  setInterval(() => {
    if (location.href !== lastPolledUrl) {
      lastPolledUrl = location.href;
      startTracking();
    }
    const video = getVideoEl();
    if (video) attachVideoListeners(video);
    if (!adObserver && getPlayerEl()) startAdWatcher();
  }, URL_POLL_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) reportProgress(true);
  });
  window.addEventListener("pagehide", () => reportProgress(true));
  window.addEventListener("beforeunload", () => reportProgress(true));

  startTracking();
})();
