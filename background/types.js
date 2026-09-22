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
 * @property {number} v - Storage.CACHE_ENTRY_VERSION; entries without it are ignored.
 * @property {string} fetchedAt - ISO time the request started (not finished).
 * @property {"long-form"|"plain"} source - Which Uploads feed the videos came from.
 * @property {number} [plainRuns] - Consecutive Loads that asked for the Long-form feed and
 *   still fell back to the Plain one. Two of them pin the Channel to the Plain feed.
 * @property {string} [longFormCheckedAt] - ISO time the Long-form feed was last actually
 *   asked. Absent on entries written before this was recorded, which simply means the next
 *   Load asks for both feeds and fills it in.
 * @property {Video[]} videos
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

/**
 * What one Load observed, formatted for the console by common/diagnostics.js.
 * @typedef {Object} LoadReport
 * @property {string} categoryLabel
 * @property {number} channelCount every Channel of the Category
 * @property {number} fetchedCount those a Load actually fetched (the rest were cache-fresh)
 * @property {number} concurrency
 * @property {number} elapsedMs
 * @property {number} requestCount feed requests made, which exceeds fetchedCount
 * @property {number} servedFromPlain Channels answered from the Plain feed
 * @property {number} skippedLongForm Channels asked only for the Plain feed that last served them
 * @property {number} retried how many Channels the retry pass was given
 * @property {number} retryBudgetMs how long the retry pass was allowed to take
 * @property {ChannelFailure[]} failures every Channel that failed at least once, in order
 */

/**
 * One Channel's failed fetch within a Load.
 * @typedef {Object} ChannelFailure
 * @property {string} channelId
 * @property {string} name
 * @property {"network"|"http"|"parse"} kind
 * @property {number|undefined} httpStatus set when kind is "http"
 * @property {"long-form"|"plain"} feed which feed the reported failure came from
 * @property {string} error
 * @property {boolean} retryable
 * @property {boolean} hadLastGood there were cached videos to keep showing
 * @property {number} ms
 * @property {boolean} recovered a later try in the same Load succeeded
 * @property {boolean} triedAgain the retry pass actually reached this Channel
 */
