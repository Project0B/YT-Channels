/**
 * feed.js — Feed page controller: category tabs, video grid, progressive
 * rendering driven by a streaming Port to background.js (ARCHITECTURE.md §3,
 * INTERFACE_SPEC.md §2).
 */

// A video counts as "done" once real playback progress reaches this
// fraction — the progress bar caps out at full width here rather than
// requiring a literal 100.0%, since outros/credits/autoplay-next often mean
// a video never reports exactly 1.0 even when the viewer is functionally
// finished. Open assumption, flagged in DECISIONS.md.
const WATCH_COMPLETE_THRESHOLD = 0.9;

let state = {
  config: { categories: [], channels: [] },
  settings: {},
  activeCategoryId: "all",
  fetchInFlight: false,
};

// A single Port opened once at page load and held forever is fragile: MV3
// event pages in Firefox can be suspended after a period of inactivity,
// which invalidates any Ports it was holding. Reusing a stale port makes
// postMessage() throw (silently, since nothing awaits it), so the spinner
// never turns off and the grid hangs — matching a "loading forever" bug
// that only clears on a full page reload. Opening a fresh port per request
// instead means every request wakes a suspended background script cleanly
// via its own onConnect event.
let activePort = null;

function send(type, extra) {
  return browser.runtime.sendMessage({ type, ...extra });
}

function $(id) {
  return document.getElementById(id);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  const [{ config }, { settings }] = await Promise.all([send("GET_CONFIG"), send("GET_SETTINGS")]);
  state.config = config;
  state.settings = settings;
  document.documentElement.style.setProperty("--max-columns", settings.maxVideosPerRow);

  const tabs = buildTabs();
  const restored = settings.lastViewedCategoryId;
  state.activeCategoryId = tabs.some((t) => t.id === restored) ? restored : "all";

  renderTabs(tabs);
  loadCategory(state.activeCategoryId, false);

  $("refresh-button").addEventListener("click", () => loadCategory(state.activeCategoryId, true));
  $("status-banner-dismiss").addEventListener("click", () => hideBanner());

  // A real <a href> (see the video-card links below for the same reasoning)
  // so middle-click/ctrl-click/right-click "Open in New Tab" still work as
  // an explicit "yes, a second tab" escape hatch. A plain left click instead
  // asks background.js to focus an already-open Manage tab rather than
  // piling up duplicates.
  $("manage-link").addEventListener("click", (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    send("OPEN_OR_FOCUS_MANAGE");
  });
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function channelsForCategoryClient(categoryId) {
  if (categoryId === "all") return state.config.channels;
  if (categoryId === "uncategorized") {
    return state.config.channels.filter((c) => !c.categoryIds || c.categoryIds.length === 0);
  }
  return state.config.channels.filter((c) => c.categoryIds && c.categoryIds.includes(categoryId));
}

function buildTabs() {
  const tabs = [{ id: "all", label: "All" }];
  const uncategorized = channelsForCategoryClient("uncategorized");
  if (uncategorized.length > 0) {
    tabs.push({ id: "uncategorized", label: "Uncategorized" });
  }
  const sorted = [...state.config.categories].sort((a, b) => a.order - b.order);
  for (const cat of sorted) {
    tabs.push({ id: cat.id, label: cat.name });
  }
  return tabs;
}

function renderTabs(tabs) {
  const nav = $("category-tabs");
  nav.replaceChildren();
  for (const tab of tabs) {
    const btn = document.createElement("button");
    btn.className = "category-tab" + (tab.id === state.activeCategoryId ? " active" : "");
    btn.textContent = tab.label;
    btn.addEventListener("click", () => {
      if (state.activeCategoryId === tab.id) return;
      state.activeCategoryId = tab.id;
      send("UPDATE_SETTINGS", { partial: { lastViewedCategoryId: tab.id } });
      [...nav.children].forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      loadCategory(tab.id, false);
    });
    nav.appendChild(btn);
  }
}

// ---------------------------------------------------------------------------
// Loading a category
// ---------------------------------------------------------------------------

function setRefreshSpinning(spinning) {
  state.fetchInFlight = spinning;
  $("refresh-button").querySelector(".refresh-icon").classList.toggle("spinning", spinning);
  $("refresh-button").disabled = spinning;
}

function loadCategory(categoryId, forceRefresh) {
  hideBanner();
  const channelCount = channelsForCategoryClient(categoryId).length;

  if (channelCount === 0) {
    clearGrid();
    setEmptyState({
      message: "No channels in this category yet",
      action: { type: "link", href: "../options/options.html", label: "Add channels in Manage" },
    });
    return;
  }

  clearEmptyState();
  setRefreshSpinning(true);

  if (!forceRefresh) {
    renderSkeleton(Math.min(channelCount * 2, 12));
  }

  requestCategoryFeed(categoryId, forceRefresh);
}

function requestCategoryFeed(categoryId, forceRefresh) {
  // Cancel any still-open port from a previous request (e.g. rapid tab
  // switching) rather than leaving it dangling.
  if (activePort) {
    try {
      activePort.disconnect();
    } catch (e) {
      // Already disconnected — fine.
    }
  }

  const requestPort = browser.runtime.connect({ name: "feed" });
  activePort = requestPort;
  let settled = false;

  requestPort.onMessage.addListener((msg) => {
    if (!msg || msg.categoryId !== state.activeCategoryId) return;

    if (msg.type === "CATEGORY_FEED_PARTIAL") {
      if (msg.videos.length > 0) {
        renderVideoGrid(msg.videos);
      }
    } else if (msg.type === "CATEGORY_FEED_DONE") {
      settled = true;
      setRefreshSpinning(false);
      finalizeCategory(msg);
      requestPort.disconnect();
    }
  });

  requestPort.onDisconnect.addListener(() => {
    if (activePort === requestPort) activePort = null;
    if (settled) return; // Normal disconnect after CATEGORY_FEED_DONE.
    // The background script died mid-request (suspended, crashed, or the
    // request was superseded) before ever replying. Don't leave the UI
    // spinning forever — surface it as a retryable failure instead.
    if (categoryId !== state.activeCategoryId) return;
    setRefreshSpinning(false);
    clearGrid();
    setEmptyState({
      message: "Couldn't load videos — check your connection",
      action: { type: "button", label: "Retry", onClick: () => loadCategory(categoryId, true) },
    });
  });

  requestPort.postMessage({ type: "GET_CATEGORY_FEED", categoryId, forceRefresh });
}

function finalizeCategory(msg) {
  const channelCount = channelsForCategoryClient(msg.categoryId).length;
  const errorCount = Object.keys(msg.errors || {}).length;
  const fallbackNames = Object.values(msg.fallbackWarnings || {});

  if (msg.videos.length === 0) {
    if (errorCount > 0 && errorCount === channelCount) {
      clearGrid();
      setEmptyState({
        message: "Couldn't load videos — check your connection",
        action: { type: "button", label: "Retry", onClick: () => loadCategory(msg.categoryId, true) },
      });
      return;
    }
    clearGrid();
    setEmptyState({ message: "No videos found for this category" });
    return;
  }

  clearEmptyState();
  renderVideoGrid(msg.videos);

  const bannerParts = [];
  if (errorCount > 0) {
    const failedWithCache = Object.keys(msg.errors).filter((channelId) =>
      msg.videos.some((v) => v.channelId === channelId)
    ).length;
    const base = `${errorCount} channel${errorCount > 1 ? "s" : ""} failed to update`;
    if (failedWithCache === 0) bannerParts.push(`${base} — no cached data`);
    else if (failedWithCache === errorCount) bannerParts.push(`${base} — showing cached results`);
    else bannerParts.push(`${base} — showing cached results where available`);
  }
  if (fallbackNames.length > 0) {
    bannerParts.push(
      `${fallbackNames.join(", ")} used a fallback feed this update — Shorts may briefly reappear for ${
        fallbackNames.length > 1 ? "them" : "it"
      }`
    );
  }
  if (bannerParts.length > 0) {
    showBanner(bannerParts.join(" · "));
  }
}

// ---------------------------------------------------------------------------
// Rendering: grid, cards, skeleton, empty states, banner
// ---------------------------------------------------------------------------

function clearGrid() {
  $("video-grid").replaceChildren();
}

/**
 * @param {{message: string, action?: {type: "link", href: string, label: string} | {type: "button", label: string, onClick: () => void}}} config
 */
function setEmptyState({ message, action }) {
  clearGrid();
  const el = $("empty-state");

  const p = document.createElement("p");
  p.textContent = message;

  const children = [p];
  if (action?.type === "link") {
    const a = document.createElement("a");
    a.href = action.href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = action.label;
    children.push(a);
  } else if (action?.type === "button") {
    const btn = document.createElement("button");
    btn.textContent = action.label;
    btn.addEventListener("click", action.onClick);
    children.push(btn);
  }

  el.replaceChildren(...children);
  el.classList.remove("hidden");
}

function clearEmptyState() {
  $("empty-state").classList.add("hidden");
  $("empty-state").replaceChildren();
}

function showBanner(text) {
  if (!text) return;
  $("status-banner-text").textContent = text;
  $("status-banner").classList.remove("hidden");
}

function hideBanner() {
  $("status-banner").classList.add("hidden");
}

function renderSkeleton(count) {
  const grid = $("video-grid");
  grid.replaceChildren();
  for (let i = 0; i < count; i++) {
    const card = document.createElement("div");
    card.className = "video-card skeleton-card";

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "video-thumb-wrap";

    const line = document.createElement("div");
    line.className = "skeleton-line";

    const shortLine = document.createElement("div");
    shortLine.className = "skeleton-line short";

    card.append(thumbWrap, line, shortLine);
    grid.appendChild(card);
  }
}

function relativeTime(iso) {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 14) return `${diffDay}d ago`;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function renderVideoGrid(videos) {
  const grid = $("video-grid");
  grid.replaceChildren();
  for (const video of videos) {
    const card = document.createElement("div");
    const isComplete = () => (video.watchProgress || 0) >= WATCH_COMPLETE_THRESHOLD;
    card.className = "video-card" + (isComplete() ? " completed" : "");

    // A real <a href> rather than a div+click-handler — that's what makes
    // native middle-click/right-click-menu/ctrl-or-cmd+click work at all;
    // window.open() only ever responds to a plain left click. The watched
    // toggle button below is a *sibling*, not nested inside this anchor
    // (nesting interactive elements inside <a> is invalid HTML and behaves
    // inconsistently), positioned over its corner via CSS instead.
    //
    // Opening a video no longer marks it watched by itself — that was the
    // whole problem being fixed (SPEC.md §3.5): a click is "I opened this
    // tab," not "I watched this." Real progress is now tracked by a content
    // script on the youtube.com/watch page itself and picked up here the
    // next time this category's feed is loaded.
    const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
    const link = document.createElement("a");
    link.className = "video-card-link";
    link.href = videoUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.title = video.title;
    link.setAttribute("aria-label", `Open ${video.title}`);

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "video-thumb-wrap";
    const thumb = document.createElement("img");
    thumb.src = video.thumbnailUrl;
    thumb.alt = "";
    thumb.loading = "lazy";
    thumbWrap.appendChild(thumb);

    const progressBar = document.createElement("div");
    progressBar.className = "watch-progress-bar";
    const displayProgress = isComplete() ? 1 : Math.max(0, Math.min(1, video.watchProgress || 0));
    progressBar.style.width = `${displayProgress * 100}%`;
    thumbWrap.appendChild(progressBar);

    // Manual override, not the primary source of truth: "I watched this
    // elsewhere" (marks fully done) / "reset this" (clears tracked
    // progress) — actual progress otherwise comes from real playback.
    const watchedToggle = document.createElement("button");
    watchedToggle.type = "button";
    watchedToggle.className = "watched-toggle";
    const toggleLabel = () => (isComplete() ? "Reset watch progress" : "Mark as watched");
    watchedToggle.title = toggleLabel();
    watchedToggle.setAttribute("aria-label", watchedToggle.title);
    watchedToggle.textContent = "✓";
    watchedToggle.addEventListener("click", () => {
      const next = !isComplete();
      video.watchProgress = next ? 1 : 0;
      card.classList.toggle("completed", next);
      progressBar.style.width = `${next ? 100 : 0}%`;
      watchedToggle.title = toggleLabel();
      watchedToggle.setAttribute("aria-label", watchedToggle.title);
      send("TOGGLE_WATCHED", { videoId: video.videoId, watched: next });
    });

    const meta = document.createElement("div");
    meta.className = "video-meta";
    const avatar = document.createElement("img");
    avatar.className = "avatar";
    avatar.src = video.channelAvatarUrl || "";
    avatar.alt = "";
    avatar.loading = "lazy";

    const text = document.createElement("div");
    text.className = "video-text";
    const title = document.createElement("div");
    title.className = "video-title";
    title.textContent = video.title;
    const channelLine = document.createElement("div");
    channelLine.className = "video-channel";
    channelLine.textContent = `${video.channelName} · ${relativeTime(video.publishedAt)}`;
    text.append(title, channelLine);

    meta.append(avatar, text);
    link.append(thumbWrap, meta);
    card.append(link, watchedToggle);
    grid.appendChild(card);
  }
}

init();
