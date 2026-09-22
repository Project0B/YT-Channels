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

// Version of `cache` entries. Older entries may hold Shorts and carry no request-start
// time, so getCache() ignores them and the next cache write drops them.
const CACHE_ENTRY_VERSION = 2;

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
  const raw = result[STORAGE_KEYS.CACHE] || {};
  const cache = {};
  for (const [channelId, entry] of Object.entries(raw)) {
    if (entry && entry.v === CACHE_ENTRY_VERSION) cache[channelId] = entry;
  }
  return cache;
}

async function setCache(cache) {
  await browser.storage.local.set({ [STORAGE_KEYS.CACHE]: cache });
}

async function getCacheEntry(channelId) {
  const cache = await getCache();
  return cache[channelId] || null;
}

// `cache` and `watched` are each one object in storage, rewritten whole to
// change a single key. Two overlapping writers therefore both read the same
// snapshot and the later write silently drops the earlier one's change.
// Chaining every write onto a single promise makes writes for *any* key run
// one at a time, so each one's read always sees the previous one's write
// having already landed. The chain continues past a failed job (via the
// second .then handler) so one rejected write cannot wedge every later one.
//
// Each storage key gets its own chain: they never share a read-modify-write,
// so making a slow cache write hold up a watch-progress write would only add
// latency.
function writeSerializer() {
  let chain = Promise.resolve();
  return (job) => {
    const task = chain.then(job, job);
    chain = task.catch(() => {});
    return task;
  };
}

// handleGetCategoryFeed() in background.js writes one cache entry per channel
// from parallel runWithConcurrency() workers.
const enqueueCacheWrite = writeSerializer();

async function writeCacheEntry(channelId, entry) {
  const cache = await getCache();
  const current = cache[channelId];
  // Entries are stamped with when their request started; a slower, older request
  // must not overwrite a newer result that finished first.
  if (current && Date.parse(current.fetchedAt) > Date.parse(entry.fetchedAt)) return;
  cache[channelId] = entry;
  await setCache(cache);
}

function setCacheEntry(channelId, entry) {
  return enqueueCacheWrite(() => writeCacheEntry(channelId, entry));
}

// Drops the cache entries of channels that are no longer in the config.
function retainCacheFor(channelIds) {
  const keep = new Set(channelIds);
  return enqueueCacheWrite(async () => {
    const cache = await getCache();
    const stale = Object.keys(cache).filter((id) => !keep.has(id));
    if (stale.length === 0) return;
    for (const id of stale) delete cache[id];
    await setCache(cache);
  });
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

// The watch page reports progress every few seconds from every playing tab,
// and the Feed page's toggle writes from another page entirely, so the
// `watched` map has more overlapping writers than the cache does, not fewer.
const enqueueWatchedWrite = writeSerializer();

// Watched entries are tiny but never expire, and the whole map is rewritten on every
// progress report. Once it is large, drop entries that are old and no longer in any
// cached feed — only a video still listed in a feed can show its progress bar.
const WATCHED_PRUNE_ABOVE = 1500;
const WATCHED_KEEP_MS = 180 * 24 * 60 * 60 * 1000;
const WATCHED_PRUNE_EVERY_MS = 60 * 60 * 1000;
let lastWatchedPrune = 0;

async function pruneWatched(map) {
  if (Object.keys(map).length <= WATCHED_PRUNE_ABOVE) return;
  if (Date.now() - lastWatchedPrune < WATCHED_PRUNE_EVERY_MS) return;
  lastWatchedPrune = Date.now();
  const listed = new Set();
  for (const entry of Object.values(await getCache())) {
    for (const video of entry.videos) listed.add(video.videoId);
  }
  const cutoff = Date.now() - WATCHED_KEEP_MS;
  for (const [videoId, entry] of Object.entries(map)) {
    if (!listed.has(videoId) && Date.parse(entry.updatedAt) < cutoff) delete map[videoId];
  }
}

// Organic progress report from the watch-page content script. Records the
// *maximum* progress reached per videoId — scrubbing backward, or reopening
// a mostly-watched video and bailing early, must never lower a video's
// recorded progress.
function updateWatchProgress(videoId, progress) {
  return enqueueWatchedWrite(async () => {
    const current = await getWatched();
    const clamped = Math.min(1, Math.max(0, progress));
    const existing = current[videoId];
    if (existing && existing.progress >= clamped) return existing;
    const entry = { progress: clamped, updatedAt: new Date().toISOString() };
    current[videoId] = entry;
    await pruneWatched(current);
    await setWatchedMap(current);
    return entry;
  });
}

// Manual override from the feed page's corner toggle — explicit user intent
// ("I watched this elsewhere" / "reset this"), not a progress observation,
// so unlike updateWatchProgress() above it isn't clamped against the
// existing value; it replaces it outright.
function setManualWatchedState(videoId, watched) {
  return enqueueWatchedWrite(async () => {
    const current = await getWatched();
    if (watched) {
      current[videoId] = { progress: 1, updatedAt: new Date().toISOString() };
    } else {
      delete current[videoId];
    }
    await setWatchedMap(current);
  });
}

const Storage = {
  CURRENT_SCHEMA_VERSION,
  CACHE_ENTRY_VERSION,
  DEFAULT_CONFIG,
  DEFAULT_SETTINGS,
  genId,
  getConfig,
  setConfig,
  getCache,
  setCache,
  getCacheEntry,
  setCacheEntry,
  retainCacheFor,
  getSettings,
  setSettings,
  updateSettings,
  getWatched,
  updateWatchProgress,
  setManualWatchedState,
};
