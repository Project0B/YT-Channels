/**
 * types.js — JSDoc type definitions mirroring DATA_SPEC.md. No runtime code;
 * loaded first purely so editors can resolve these typedefs across modules.
 *
 * @typedef {Object} Category
 * @property {string} id
 * @property {string} name
 * @property {number} order
 *
 * @typedef {Object} Channel
 * @property {string} channelId
 * @property {string} name
 * @property {string} avatarUrl
 * @property {string} sourceUrl
 * @property {string[]} categoryIds
 * @property {string} addedAt
 *
 * @typedef {Object} Config
 * @property {number} schemaVersion
 * @property {Category[]} categories
 * @property {Channel[]} channels
 *
 * @typedef {Object} Video
 * @property {string} videoId
 * @property {string} title
 * @property {string} thumbnailUrl
 * @property {string} publishedAt
 *
 * @typedef {Object} CacheEntry
 * @property {string} fetchedAt
 * @property {Video[]} videos
 * @property {string|null} lastError
 *
 * @typedef {Object.<string, CacheEntry>} Cache
 *
 * @typedef {Object} Settings
 * @property {number} cacheTtlMinutes
 * @property {number} videosPerCategoryLimit
 * @property {string|null} lastViewedCategoryId
 * @property {number} fetchConcurrency
 *
 * @typedef {Object} WatchProgress
 * @property {number} progress - 0-1, maximum playback position reached (or 1 for a manual override).
 * @property {string} updatedAt - ISO timestamp of the last update.
 *
 * @typedef {Object.<string, WatchProgress>} WatchedMap
 */
