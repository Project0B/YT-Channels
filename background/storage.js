/**
 * Storage.js — single source of truth for reading/writing the three
 * browser.storage.local keys defined in DATA_SPEC.md: config, cache, settings.
 * Other modules never touch browser.storage directly.
 */

const STORAGE_KEYS = {
  CONFIG: "config",
  CACHE: "cache",
  SETTINGS: "settings",
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
    await setConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
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

async function setCacheEntry(channelId, entry) {
  const cache = await getCache();
  cache[channelId] = entry;
  await setCache(cache);
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
};
