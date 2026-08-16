/**
 * Storage.js — single source of truth for reading/writing the three
 * browser.storage.local keys defined in DATA_SPEC.md: config, cache, settings.
 * Other modules never touch browser.storage directly.
 */

const STORAGE_KEYS = {
  CONFIG: "config",
  CACHE: "cache",
  SETTINGS: "settings",
  WATCHED: "watched",
};

const CURRENT_SCHEMA_VERSION = 1;

const DEFAULT_CONFIG = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  categories: [],
  channels: [],
};

const DEFAULT_SETTINGS = {
  cacheTtlMinutes: 30,
  videosPerCategoryLimit: 60,
  lastViewedCategoryId: null,
  fetchConcurrency: 6,
  maxVideosPerRow: 4,
};

function genId(prefix) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}_${out}`;
}

async function getConfig() {
  const result = await browser.storage.local.get(STORAGE_KEYS.CONFIG);
  const config = result[STORAGE_KEYS.CONFIG];
  if (!config) {
    // Deep-clone rather than shallow-spread: a shallow `{ ...DEFAULT_CONFIG }`
    // still shares the same `.categories`/`.channels` array instances as the
    // module-level DEFAULT_CONFIG, so the first config-mutating handler to
    // `.push()` onto them (CREATE_CATEGORY, SAVE_CHANNEL, etc.) would mutate
    // the shared default in place.
    const fresh = structuredClone(DEFAULT_CONFIG);
    await setConfig(fresh);
    return fresh;
  }
  return config;
}

async function setConfig(config) {
  await browser.storage.local.set({ [STORAGE_KEYS.CONFIG]: config });
}

async function getCache() {
  const result = await browser.storage.local.get(STORAGE_KEYS.CACHE);
  return result[STORAGE_KEYS.CACHE] || {};
}

async function setCache(cache) {
  await browser.storage.local.set({ [STORAGE_KEYS.CACHE]: cache });
}

async function getCacheEntry(channelId) {
  const cache = await getCache();
  return cache[channelId] || null;
}

// setCacheEntry() is a read-modify-write over the single shared `cache`
// storage key. handleGetCategoryFeed() in background.js calls this once per
// channel from parallel runWithConcurrency() workers, so without
// serialization two calls can both read the cache before either writes back
// — the later write then silently clobbers the earlier channel's entry.
// Chaining every call onto a single promise forces writes for *any* channel
// to run one at a time, so each one's getCache() always sees the previous
// one's setCache() having already landed. The chain continues past a
// failed write (via the second .then handler) so one rejected write doesn't
// wedge every subsequent call.
let cacheWriteChain = Promise.resolve();

async function writeCacheEntry(channelId, entry) {
  const cache = await getCache();
  cache[channelId] = entry;
  await setCache(cache);
}

function setCacheEntry(channelId, entry) {
  const task = cacheWriteChain.then(
    () => writeCacheEntry(channelId, entry),
    () => writeCacheEntry(channelId, entry)
  );
  cacheWriteChain = task.catch(() => {});
  return task;
}

async function getSettings() {
  const result = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
  const settings = result[STORAGE_KEYS.SETTINGS];
  if (!settings) {
    await setSettings(DEFAULT_SETTINGS);
    return { ...DEFAULT_SETTINGS };
  }
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function setSettings(settings) {
  await browser.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
}

async function updateSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await setSettings(next);
  return next;
}

// Watched state: per-video maximum playback progress reached, keyed by
// videoId — {videoId: {progress: 0-1, updatedAt: isoString}}. Not part of
// `config` (never exported/imported/shared — it's purely local viewing
// history) and not part of `cache` (survives independently of cache entries
// expiring or a channel's videos rotating out of the RSS window).
//
// Legacy shape (pre-progress-tracking installs): {videoId: watchedAtIsoString}.
// getWatched() normalizes a raw string entry to {progress: 1, updatedAt: entry}
// at read time so existing viewing history survives the upgrade instead of
// being silently discarded; storage itself isn't rewritten until that video's
// entry is next updated.
async function getWatched() {
  const result = await browser.storage.local.get(STORAGE_KEYS.WATCHED);
  const raw = result[STORAGE_KEYS.WATCHED] || {};
  const normalized = {};
  for (const [videoId, entry] of Object.entries(raw)) {
    normalized[videoId] = typeof entry === "string" ? { progress: 1, updatedAt: entry } : entry;
  }
  return normalized;
}

async function setWatchedMap(map) {
  await browser.storage.local.set({ [STORAGE_KEYS.WATCHED]: map });
}

// Organic progress report from the watch-page content script. Records the
// *maximum* progress reached per videoId — scrubbing backward, or reopening
// a mostly-watched video and bailing early, must never lower a video's
// recorded progress.
async function updateWatchProgress(videoId, progress) {
  const current = await getWatched();
  const clamped = Math.min(1, Math.max(0, progress));
  const existing = current[videoId];
  if (existing && existing.progress >= clamped) return existing;
  const entry = { progress: clamped, updatedAt: new Date().toISOString() };
  current[videoId] = entry;
  await setWatchedMap(current);
  return entry;
}

// Manual override from the feed page's corner toggle — explicit user intent
// ("I watched this elsewhere" / "reset this"), not a progress observation,
// so unlike updateWatchProgress() above it isn't clamped against the
// existing value; it replaces it outright.
async function setManualWatchedState(videoId, watched) {
  const current = await getWatched();
  if (watched) {
    current[videoId] = { progress: 1, updatedAt: new Date().toISOString() };
  } else {
    delete current[videoId];
  }
  await setWatchedMap(current);
}

const Storage = {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_CONFIG,
  DEFAULT_SETTINGS,
  genId,
  getConfig,
  setConfig,
  getCache,
  setCache,
  getCacheEntry,
  setCacheEntry,
  getSettings,
  setSettings,
  updateSettings,
  getWatched,
  updateWatchProgress,
  setManualWatchedState,
};
