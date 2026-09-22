/**
 * background.js — central message router and fetch orchestration.
 * Decides cache-fresh vs needs-fetch per channel, runs bounded-concurrency
 * fetches, writes results via storage.js, and replies to requesting pages
 * (ARCHITECTURE.md §2-3).
 */

const FEED_PAGE_PATH = "feed/feed.html";
const OPTIONS_PAGE_PATH = "options/options.html";

// Export *file* schema version — distinct from Storage.CURRENT_SCHEMA_VERSION
// (the internal browser.storage.local shape, which is unchanged). Exported
// files now carry a compact per-channel "identifier" instead of the full
// channelId/name/avatarUrl/sourceUrl/addedAt record (ROADMAP.md §A);
// internal storage stays verbose for fast, offline rendering.
const CURRENT_EXPORT_SCHEMA_VERSION = 2;

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

async function runWithConcurrency(items, limit, worker) {
  let cursor = 0;
  async function runNext() {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, runNext));
}

// ---------------------------------------------------------------------------
// Category → channel resolution
// ---------------------------------------------------------------------------

// What a Load calls itself in the console. The Built-in views have no record
// in the config, and a Category the user renamed mid-Load may have none either.
function categoryLabel(config, categoryId) {
  if (categoryId === "all") return "All";
  if (categoryId === "uncategorized") return "Uncategorized";
  const category = config.categories.find((c) => c.id === categoryId);
  return category ? category.name : categoryId;
}

function channelsForCategory(config, categoryId) {
  if (categoryId === "all") {
    return config.channels;
  }
  if (categoryId === "uncategorized") {
    return config.channels.filter((c) => !c.categoryIds || c.categoryIds.length === 0);
  }
  return config.channels.filter((c) => c.categoryIds && c.categoryIds.includes(categoryId));
}

// ---------------------------------------------------------------------------
// Compact channel identifier (ROADMAP.md §A.1)
// ---------------------------------------------------------------------------

// Reduces a channel to the shortest string that round-trips through
// resolve.js's normalizeInputUrl fallback branch (which already prepends
// "https://www.youtube.com/" to any bare path). Prefers the channel-shaped
// path from sourceUrl (e.g. "@handle", "channel/UC...", "c/Name",
// "user/Name") since that's what a human recognizes when sharing a list;
// falls back to "channel/{channelId}" — always resolvable, immune to handle
// changes — when sourceUrl isn't channel-shaped (e.g. the channel was added
// via a video/share link, so sourceUrl points at a /watch or youtu.be URL).
function channelIdentifier(channel) {
  try {
    const url = new URL(channel.sourceUrl);
    const isYoutubeHost = /(^|\.)youtube\.com$/i.test(url.hostname);
    const path = url.pathname.replace(/^\/+/, "");
    if (isYoutubeHost && /^(@|channel\/|c\/|user\/)/i.test(path)) {
      return path;
    }
  } catch (e) {
    // Malformed/missing sourceUrl — fall through to the channelId form.
  }
  return `channel/${channel.channelId}`;
}

function mergeAndSort(videosByChannel, channels, limit, watched) {
  const channelById = new Map(channels.map((c) => [c.channelId, c]));
  const merged = [];
  for (const [channelId, videos] of videosByChannel.entries()) {
    const channel = channelById.get(channelId);
    if (!channel) continue;
    for (const video of videos) {
      const progressEntry = watched[video.videoId];
      merged.push({
        ...video,
        channelId,
        channelName: channel.name,
        channelAvatarUrl: channel.avatarUrl,
        watchProgress: progressEntry ? progressEntry.progress : 0,
      });
    }
  }
  merged.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  return merged.slice(0, limit);
}

// ---------------------------------------------------------------------------
// GET_CATEGORY_FEED orchestration (streamed over a Port)
// ---------------------------------------------------------------------------

// A Load fetches every stale channel of a Category at once, and YouTube answers
// some of that burst with a 404, a 5xx or an HTML error page even though the
// channels are fine — for a large Category that is routinely dozens of them at
// a time, reported as "N channels failed to update" over last good lists that
// were never actually out of date. As in resolveIdentifiers below, those are
// tried once more afterwards, one at a time and a little apart, so the retry
// does not re-create the burst that provoked the failure.
//
// The budget bounds how long a Load can go on recovering: when YouTube is
// failing wholesale rather than glitching, spacing out hundreds of retries
// would only keep the page's spinner going for minutes. Channels the budget
// does not reach keep the failure they already had, which is what a Load
// without any retry pass would have left them with anyway.
// 400 ms was too soon to be worth much: on a real 99-channel Load it recovered
// 10 of 45, well under the ~46% that the same channels answer at when asked
// once. Channels that were measured recovering did so seconds later, not
// milliseconds, so the spacing is now long enough to be a genuinely separate
// attempt, and the budget long enough to reach a whole category's worth of
// failures rather than stopping a third of the way through.
const FEED_RETRY_SPACING_MS = 900;
const FEED_RETRY_BUDGET_MS = 40000;

// Asking the long-form feed for a channel that has none costs a request on every
// Load only to be told what the previous Load already learned, and for a library
// where most channels have no long-form uploads that is nearly half the Load.
// A channel is therefore pinned to the feed that served it — but carefully,
// because a long-form 404 is not a reliable fact about a channel: YouTube serves
// them in passing, and channels measured 404ing in the morning answered 200 the
// same afternoon. One 404 is not evidence, so a channel is pinned only after two
// Loads in a row have had to fall back, and the pin is re-examined daily, which
// caps how long a wrongly pinned channel shows the live streams and premieres
// its long-form feed would have left out.
const LONG_FORM_RECHECK_MS = 24 * 60 * 60 * 1000;
const PLAIN_RUNS_BEFORE_PINNING = 2;

// Which channels were reached is recorded on the channels themselves, so there
// is nothing to report back: a channel the budget skipped simply never gets its
// `triedAgain` flag set.
async function retryFailedChannels(channels, fetchChannel, abandoned) {
  const deadline = Date.now() + FEED_RETRY_BUDGET_MS;
  for (const channel of channels) {
    if (abandoned() || Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, FEED_RETRY_SPACING_MS));
    if (abandoned()) return;
    await fetchChannel(channel);
  }
}

// How many Loads in a row have had to fall back to the plain feed. A Load that
// did not ask the long-form feed (a pinned channel) leaves the count alone: it
// learned nothing new about which feed the channel has.
function plainRunsAfter(entry, result) {
  const previous = (entry && entry.plainRuns) || 0;
  if (!result.checkedLongForm) return previous;
  return result.source === "plain" ? previous + 1 : 0;
}

async function handleGetCategoryFeed(categoryId, forceRefresh, port) {
  // feed.js disconnects the previous port whenever a new category is
  // requested (e.g. rapid tab switching), but nothing here used to notice —
  // this request just kept running and its next port.postMessage() would
  // throw ("Attempt to postMessage on disconnected port"). safePost() below
  // makes every reply a no-op once the port is known gone, and the worker
  // skips starting fetches for channels it hasn't reached yet once
  // abandoned, instead of only discovering the disconnect via a thrown
  // exception after the work was already done.
  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
  });
  const safePost = (msg) => {
    if (disconnected) return;
    try {
      port.postMessage(msg);
    } catch (e) {
      disconnected = true;
    }
  };

  const config = await Storage.getConfig();
  const settings = await Storage.getSettings();
  const cache = await Storage.getCache();
  const watched = await Storage.getWatched();

  const channels = channelsForCategory(config, categoryId);
  if (channels.length === 0) {
    safePost({ type: "CATEGORY_FEED_DONE", categoryId, videos: [], errors: {}, emptyCategory: true });
    return;
  }

  const ttlMs = settings.cacheTtlMinutes * 60 * 1000;
  const now = Date.now();

  const videosByChannel = new Map();
  const errors = {};
  // Every Channel that failed at least once this Load, in the order it failed.
  const failures = new Map();
  const loadStart = Date.now();
  // Requests, not channels: a channel with no long-form feed costs two of them
  // on every Load, which is what makes a big Category's burst bigger than its
  // channel count suggests.
  let requestCount = 0;
  let servedFromPlain = 0;
  let skippedLongForm = 0;

  const toFetch = [];
  for (const channel of channels) {
    const entry = cache[channel.channelId];
    const isFresh = !forceRefresh && entry && now - new Date(entry.fetchedAt).getTime() < ttlMs;
    if (isFresh) {
      videosByChannel.set(channel.channelId, entry.videos);
    } else {
      if (entry) videosByChannel.set(channel.channelId, entry.videos);
      toFetch.push(channel);
    }
  }

  const postProgress = (extra) => {
    if (disconnected) return;
    const videos = mergeAndSort(videosByChannel, channels, settings.videosPerCategoryLimit, watched);
    safePost({
      type: "CATEGORY_FEED_PARTIAL",
      categoryId,
      videos,
      errors: { ...errors },
      ...extra,
    });
  };

  // Initial paint with whatever cache we already have.
  postProgress();

  const fetchChannel = async (channel) => {
    // Stamped at request start so a slow, older request can't overwrite a newer result.
    const startedAt = new Date().toISOString();
    const entry = cache[channel.channelId];
    const hadLastGood = Boolean(entry);
    // A channel the last Load served from the plain feed is asked for that feed
    // alone, until its long-form feed is due to be looked at again.
    const preferPlain = Boolean(
      entry &&
        entry.source === "plain" &&
        (entry.plainRuns || 0) >= PLAIN_RUNS_BEFORE_PINNING &&
        entry.longFormCheckedAt &&
        now - Date.parse(entry.longFormCheckedAt) < LONG_FORM_RECHECK_MS
    );
    if (preferPlain) skippedLongForm++;

    const clockStart = Date.now();
    const result = await Rss.fetchChannelVideos(channel.channelId, {
      hasLastGood: hadLastGood,
      preferPlain,
    });
    const ms = Date.now() - clockStart;
    requestCount += result.requests || 1;
    if (result.status === "ok" && result.source === "plain") servedFromPlain++;

    if (result.status === "ok") {
      videosByChannel.set(channel.channelId, result.videos);
      delete errors[channel.channelId];
      await Storage.setCacheEntry(channel.channelId, {
        v: Storage.CACHE_ENTRY_VERSION,
        fetchedAt: startedAt,
        source: result.source,
        videos: result.videos,
        // Only a Load that actually asked the long-form feed may move the
        // re-check date on, or a channel pinned to the plain feed would renew
        // its own pin for ever and never be looked at again.
        longFormCheckedAt: result.checkedLongForm ? startedAt : entry.longFormCheckedAt,
        // Consecutive Loads that asked for the long-form feed and still ended up
        // on the plain one. The long-form feed serving the channel clears it, so
        // a single passing 404 can never reach the pinning threshold.
        plainRuns: plainRunsAfter(entry, result),
      });
    } else {
      // Failures never touch the cache: keep the last good list (already in
      // videosByChannel) or show a one-off stopgap list for this run only.
      errors[channel.channelId] = result.error;
      if (result.status === "stopgap") videosByChannel.set(channel.channelId, result.videos);
    }

    if (result.status === "ok") {
      const earlier = failures.get(channel.channelId);
      if (earlier) earlier.recovered = true;
    } else {
      // "failed" and "stopgap" both leave the channel in `errors`, so the
      // banner counts both and the console has to account for both — a stopgap
      // is a one-off list, not a channel that updated. The latest attempt
      // replaces an earlier one: it is the outcome the banner reflects.
      const failure = {
        channelId: channel.channelId,
        name: channel.name,
        kind: result.kind,
        httpStatus: result.httpStatus,
        feed: result.feed,
        error: result.error,
        retryable: result.status === "failed" && result.retryable,
        servedStopgap: result.status === "stopgap",
        hadLastGood,
        ms,
        recovered: false,
        triedAgain: false,
      };
      failures.set(channel.channelId, failure);
      // Printed as it happens as well as in the report at the end, so a Load
      // that is still running — or one whose page was closed — is not silent.
      console.warn(`${Diagnostics.LOG_PREFIX} ${Diagnostics.formatFailureLine(failure)}`);
    }
    postProgress();
    return result;
  };

  let retried = 0;
  if (toFetch.length > 0) {
    const toRetry = [];
    await runWithConcurrency(toFetch, settings.fetchConcurrency, async (channel) => {
      // Abandoned mid-flight (port disconnected) — don't start fetches for
      // channels this run hasn't reached yet.
      if (disconnected) return;
      const result = await fetchChannel(channel);
      if (result.status === "failed" && result.retryable) toRetry.push(channel);
    });

    // Every channel has now been asked once, which is as much as the page needs
    // before it is usable. The retry pass can take most of a minute on a large
    // category, and holding Refresh disabled for all of it would make a bad Load
    // feel worse than the failures it is busy repairing — so the page is handed
    // back here, and each channel the retry recovers arrives as an ordinary
    // progress update that ticks the failure count down.
    postProgress({ firstPassDone: true });
    // Marked after the fetch, because a fetch that fails again replaces the
    // channel's entry: without this, a channel the budget never reached would
    // be reported as "still failing after a retry" that never happened.
    const retryOne = async (channel) => {
      const result = await fetchChannel(channel);
      const failure = failures.get(channel.channelId);
      if (failure) failure.triedAgain = true;
      return result;
    };
    await retryFailedChannels(toRetry, retryOne, () => disconnected);
    retried = toRetry.length;
  }

  const finalVideos = mergeAndSort(videosByChannel, channels, settings.videosPerCategoryLimit, watched);
  /** @type {LoadReport} */
  const diagnostics = {
    categoryLabel: categoryLabel(config, categoryId),
    channelCount: channels.length,
    fetchedCount: toFetch.length,
    concurrency: settings.fetchConcurrency,
    elapsedMs: Date.now() - loadStart,
    requestCount,
    servedFromPlain,
    skippedLongForm,
    retried,
    retryBudgetMs: FEED_RETRY_BUDGET_MS,
    failures: [...failures.values()],
  };
  for (const line of Diagnostics.formatLoadReport(diagnostics)) console.warn(line);

  safePost({
    type: "CATEGORY_FEED_DONE",
    categoryId,
    videos: finalVideos,
    errors: { ...errors },
    diagnostics,
  });
}

// ---------------------------------------------------------------------------
// Port-based streaming connections (feed.js)
// ---------------------------------------------------------------------------

browser.runtime.onConnect.addListener((port) => {
  if (port.name === "feed") {
    port.onMessage.addListener((msg) => {
      if (msg?.type === "GET_CATEGORY_FEED") {
        handleGetCategoryFeed(msg.categoryId, Boolean(msg.forceRefresh), port).catch((err) => {
          // A Load only lands here when something outside the per-channel
          // handling broke (storage, a bad config), which the page can show
          // only as "check your connection" — so the real error is logged.
          console.error(`${Diagnostics.LOG_PREFIX} Load "${msg.categoryId}" failed outright`, err);
          // The port may already be disconnected (see handleGetCategoryFeed's
          // safePost) — posting to a dead port throws, so guard this too.
          try {
            port.postMessage({ type: "CATEGORY_FEED_DONE", categoryId: msg.categoryId, videos: [], errors: {}, fatalError: String(err) });
          } catch (e) {
            // Nothing left to notify.
          }
        });
      }
    });
  } else if (port.name === "import") {
    port.onMessage.addListener((msg) => {
      if (msg?.type === "RESOLVE_CATEGORY_IMPORT") {
        handleResolveCategoryImport(msg.data, port).catch((err) => {
          port.postMessage({ type: "IMPORT_RESOLVE_ERROR", error: String(err) });
        });
      } else if (msg?.type === "RESOLVE_CONFIG_IMPORT_V2") {
        handleResolveConfigImportV2(msg.data, port).catch((err) => {
          port.postMessage({ type: "IMPORT_RESOLVE_ERROR", error: String(err) });
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Import resolution (ROADMAP.md §A.4) — streamed over the "import" Port so
// the UI can show progress across what's now a multi-second, per-channel
// network operation instead of an instant local file read.
// ---------------------------------------------------------------------------

// A page that comes back without its channel's details is usually a passing
// glitch when many pages are fetched at once, so those are tried once more,
// one at a time and a little apart, after the concurrent pass.
const IMPORT_RETRY_SPACING_MS = 400;

async function resolveIdentifiers(identifiers, settings, port) {
  const results = new Array(identifiers.length).fill(null);
  const failed = [];
  let resolvedCount = 0;

  await runWithConcurrency(identifiers, settings.fetchConcurrency, async (identifier, index) => {
    try {
      results[index] = await Resolve.resolveChannelUrl(identifier);
    } catch (err) {
      failed.push({ identifier, index, err });
    }
    resolvedCount++;
    port.postMessage({ type: "IMPORT_PROGRESS", resolved: resolvedCount, total: identifiers.length });
  });

  const errors = [];
  for (const { identifier, index, err } of failed) {
    let last = err;
    if (err.retryable) {
      await new Promise((resolve) => setTimeout(resolve, IMPORT_RETRY_SPACING_MS));
      try {
        results[index] = await Resolve.resolveChannelUrl(identifier);
        last = null;
      } catch (retryErr) {
        last = retryErr;
      }
      // Also keeps a service worker awake through a long retry pass.
      port.postMessage({ type: "IMPORT_PROGRESS", resolved: resolvedCount, total: identifiers.length });
    }
    if (last) {
      errors.push({ identifier, error: last.message || "Couldn't resolve" });
      console.warn(`${Diagnostics.LOG_PREFIX} Could not resolve "${identifier}" —`, last.message || last);
    }
  }

  return { results, errors };
}

async function handleResolveCategoryImport(data, port) {
  const error = validateCategoryShareShape(data);
  if (error) {
    port.postMessage({ type: "IMPORT_RESOLVE_ERROR", error });
    return;
  }
  const settings = await Storage.getSettings();
  const { results, errors } = await resolveIdentifiers(data.channels, settings, port);
  // Dedupe by resolved channelId, not by input identifier string — two
  // different identifiers (e.g. an @handle and a channel/UC... form) can
  // resolve to the same channel.
  const seen = new Set();
  const channels = [];
  for (const resolved of results) {
    if (resolved && !seen.has(resolved.channelId)) {
      seen.add(resolved.channelId);
      channels.push(resolved);
    }
  }
  port.postMessage({
    type: "IMPORT_PREVIEW_CATEGORY",
    categoryName: data.category.name,
    channels,
    errors,
  });
}

async function handleResolveConfigImportV2(data, port) {
  const error = validateConfigV2Shape(data);
  if (error) {
    port.postMessage({ type: "IMPORT_RESOLVE_ERROR", error });
    return;
  }
  const settings = await Storage.getSettings();
  const identifiers = data.channels.map((c) => c.identifier);
  const { results, errors } = await resolveIdentifiers(identifiers, settings, port);

  // Dedupe by resolved channelId (see handleResolveCategoryImport), merging
  // categoryIds if the same channel appears under two different identifiers.
  const byChannelId = new Map();
  data.channels.forEach((entry, index) => {
    const resolved = results[index];
    if (!resolved) return;
    const existing = byChannelId.get(resolved.channelId);
    if (existing) {
      existing.categoryIds = Array.from(new Set([...existing.categoryIds, ...entry.categoryIds]));
    } else {
      byChannelId.set(resolved.channelId, {
        ...resolved,
        categoryIds: [...entry.categoryIds],
        addedAt: new Date().toISOString(),
      });
    }
  });
  const channels = Array.from(byChannelId.values());

  port.postMessage({
    type: "IMPORT_PREVIEW_CONFIG_V2",
    categories: data.categories,
    channels,
    errors,
  });
}

function validateCategoryShareShape(data) {
  if (!data || typeof data !== "object") return "File is not valid JSON";
  if (typeof data.schemaVersion !== "number") return "Missing schemaVersion";
  if (data.schemaVersion > CURRENT_EXPORT_SCHEMA_VERSION) return "Unsupported config version";
  if (!data.category || typeof data.category.name !== "string" || !data.category.name.trim()) {
    return "Missing category name";
  }
  if (!Array.isArray(data.channels) || !data.channels.every((c) => typeof c === "string" && c.trim())) {
    return "Malformed channel list";
  }
  return null;
}

function validateConfigV2Shape(data) {
  if (!data || typeof data !== "object") return "File is not valid JSON";
  if (typeof data.schemaVersion !== "number") return "Missing schemaVersion";
  if (data.schemaVersion > CURRENT_EXPORT_SCHEMA_VERSION) return "Unsupported config version";
  if (!Array.isArray(data.categories)) return "Missing categories array";
  if (!Array.isArray(data.channels)) return "Missing channels array";

  const catIds = new Set();
  for (const c of data.categories) {
    if (!c || typeof c.id !== "string" || typeof c.name !== "string" || typeof c.order !== "number") {
      return "Malformed category entry";
    }
    catIds.add(c.id);
  }
  for (const ch of data.channels) {
    if (!ch || typeof ch.identifier !== "string" || !ch.identifier.trim() || !Array.isArray(ch.categoryIds)) {
      return "Malformed channel entry";
    }
    for (const cid of ch.categoryIds) {
      if (!catIds.has(cid)) return "Channel references an unknown category";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Request/response messages (options.js, feed.js)
// ---------------------------------------------------------------------------

async function handleMessage(message) {
  switch (message.type) {
    case "GET_CONFIG":
      return { config: await Storage.getConfig() };

    case "GET_SETTINGS":
      return { settings: await Storage.getSettings() };

    case "UPDATE_SETTINGS":
      return { settings: await Storage.updateSettings(message.partial) };

    // Channels whose Long-form feed doesn't exist and whose Plain feed holds only Shorts.
    case "GET_EMPTY_CHANNELS": {
      const cache = await Storage.getCache();
      const channelIds = Object.entries(cache)
        .filter(([, entry]) => entry.source === "plain" && entry.videos.length === 0)
        .map(([channelId]) => channelId);
      return { channelIds };
    }

    case "TOGGLE_WATCHED":
      await Storage.setManualWatchedState(message.videoId, Boolean(message.watched));
      return { ok: true };

    case "UPDATE_WATCH_PROGRESS": {
      const entry = await Storage.updateWatchProgress(message.videoId, Number(message.progress) || 0);
      return { ok: true, watchProgress: entry.progress };
    }

    case "OPEN_OR_FOCUS_FEED":
      await openOrFocusPage(FEED_PAGE_PATH, { reloadIfExisting: Boolean(message.reloadIfExisting) });
      return { ok: true };

    case "OPEN_OR_FOCUS_MANAGE":
      await openOrFocusPage(OPTIONS_PAGE_PATH);
      return { ok: true };

    case "RESOLVE_CHANNEL": {
      try {
        const resolved = await Resolve.resolveChannelUrl(message.url);
        return resolved;
      } catch (err) {
        return { error: err.message || "Couldn't resolve that URL" };
      }
    }

    case "SAVE_CHANNEL": {
      const config = await Storage.getConfig();
      const { channelId, name, avatarUrl, sourceUrl, categoryIds } = message.channel;
      const existingIndex = config.channels.findIndex((c) => c.channelId === channelId);
      const record = {
        channelId,
        name,
        avatarUrl,
        sourceUrl,
        categoryIds: categoryIds || [],
        addedAt: existingIndex >= 0 ? config.channels[existingIndex].addedAt : new Date().toISOString(),
      };
      if (existingIndex >= 0) {
        config.channels[existingIndex] = record;
      } else {
        config.channels.push(record);
      }
      await Storage.setConfig(config);
      return { config };
    }

    case "UPDATE_CHANNEL_CATEGORIES": {
      const config = await Storage.getConfig();
      const channel = config.channels.find((c) => c.channelId === message.channelId);
      if (!channel) return { error: "Channel not found" };
      channel.categoryIds = message.categoryIds || [];
      await Storage.setConfig(config);
      return { config };
    }

    case "REMOVE_CHANNEL": {
      const config = await Storage.getConfig();
      config.channels = config.channels.filter((c) => c.channelId !== message.channelId);
      await Storage.setConfig(config);
      await Storage.retainCacheFor(config.channels.map((c) => c.channelId));
      return { config };
    }

    case "CREATE_CATEGORY": {
      const config = await Storage.getConfig();
      const name = (message.name || "").trim();
      if (!name) return { error: "Category name can't be empty" };
      const dup = config.categories.some((c) => c.name.toLowerCase() === name.toLowerCase());
      if (dup) return { error: "A category with that name already exists" };
      const category = {
        id: Storage.genId("cat"),
        name,
        // One past the highest order in use, not the number of categories:
        // deleting a category used to leave a gap, so `length` could equal an
        // order already taken and the new category would sort into the middle
        // of the tab bar instead of onto the end.
        order: config.categories.reduce((max, c) => Math.max(max, Number(c.order) || 0), -1) + 1,
      };
      config.categories.push(category);
      await Storage.setConfig(config);
      return { config, category };
    }

    case "RENAME_CATEGORY": {
      const config = await Storage.getConfig();
      const name = (message.name || "").trim();
      if (!name) return { error: "Category name can't be empty" };
      const dup = config.categories.some(
        (c) => c.id !== message.categoryId && c.name.toLowerCase() === name.toLowerCase()
      );
      if (dup) return { error: "A category with that name already exists" };
      const category = config.categories.find((c) => c.id === message.categoryId);
      if (!category) return { error: "Category not found" };
      category.name = name;
      await Storage.setConfig(config);
      return { config };
    }

    case "DELETE_CATEGORY": {
      const config = await Storage.getConfig();
      config.categories = config.categories.filter((c) => c.id !== message.categoryId);
      // Close the gap the removed category leaves, so the sequence stays dense
      // and orders that are already duplicated heal on the next delete.
      config.categories.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
      config.categories.forEach((c, index) => {
        c.order = index;
      });
      for (const channel of config.channels) {
        channel.categoryIds = channel.categoryIds.filter((id) => id !== message.categoryId);
      }
      await Storage.setConfig(config);
      const settings = await Storage.getSettings();
      if (settings.lastViewedCategoryId === message.categoryId) {
        await Storage.updateSettings({ lastViewedCategoryId: null });
      }
      return { config };
    }

    case "REORDER_CATEGORIES": {
      const config = await Storage.getConfig();
      const orderIndex = new Map(message.orderedIds.map((id, idx) => [id, idx]));
      config.categories.forEach((c) => {
        if (orderIndex.has(c.id)) c.order = orderIndex.get(c.id);
      });
      config.categories.sort((a, b) => a.order - b.order);
      await Storage.setConfig(config);
      return { config };
    }

    case "EXPORT_CONFIG": {
      const config = await Storage.getConfig();
      return {
        exportData: {
          schemaVersion: CURRENT_EXPORT_SCHEMA_VERSION,
          exportedAt: new Date().toISOString(),
          categories: config.categories,
          channels: config.channels.map((ch) => ({
            identifier: channelIdentifier(ch),
            categoryIds: ch.categoryIds,
          })),
        },
      };
    }

    case "EXPORT_CATEGORY": {
      const config = await Storage.getConfig();
      const category = config.categories.find((c) => c.id === message.categoryId);
      if (!category) return { error: "Category not found" };
      const channels = config.channels.filter((c) => c.categoryIds.includes(category.id));
      return {
        exportData: {
          schemaVersion: CURRENT_EXPORT_SCHEMA_VERSION,
          exportedAt: new Date().toISOString(),
          shareType: "category",
          category: { name: category.name },
          channels: channels.map((ch) => channelIdentifier(ch)),
        },
      };
    }

    case "IMPORT_CONFIG": {
      return importConfig(message.data, message.mode);
    }

    case "COMMIT_CATEGORY_IMPORT": {
      return commitCategoryImport(message.categoryName, message.channels, message.collisionMode);
    }

    case "COMMIT_CONFIG_IMPORT_V2": {
      return importConfig(
        {
          schemaVersion: Storage.CURRENT_SCHEMA_VERSION,
          categories: message.categories,
          channels: message.channels,
        },
        message.mode
      );
    }

    default:
      return { error: `Unknown message type: ${message.type}` };
  }
}

function validateImportShape(data) {
  if (!data || typeof data !== "object") return "File is not valid JSON";
  if (typeof data.schemaVersion !== "number") return "Missing schemaVersion";
  if (data.schemaVersion > Storage.CURRENT_SCHEMA_VERSION) return "Unsupported config version";
  if (!Array.isArray(data.categories)) return "Missing categories array";
  if (!Array.isArray(data.channels)) return "Missing channels array";

  const catIds = new Set();
  const catNames = new Set();
  for (const c of data.categories) {
    if (!c || typeof c.id !== "string" || typeof c.name !== "string" || typeof c.order !== "number") {
      return "Malformed category entry";
    }
    if (catIds.has(c.id)) return "Duplicate category id in file";
    catIds.add(c.id);
    const lower = c.name.toLowerCase();
    if (catNames.has(lower)) return "Duplicate category name in file";
    catNames.add(lower);
  }

  const chanIds = new Set();
  for (const ch of data.channels) {
    if (
      !ch ||
      typeof ch.channelId !== "string" ||
      typeof ch.name !== "string" ||
      typeof ch.avatarUrl !== "string" ||
      typeof ch.sourceUrl !== "string" ||
      !Array.isArray(ch.categoryIds) ||
      typeof ch.addedAt !== "string"
    ) {
      return "Malformed channel entry";
    }
    if (chanIds.has(ch.channelId)) return "Duplicate channelId in file";
    chanIds.add(ch.channelId);
    for (const cid of ch.categoryIds) {
      if (!catIds.has(cid)) return "Channel references an unknown category";
    }
  }

  return null;
}

async function importConfig(data, mode) {
  const error = validateImportShape(data);
  if (error) return { error };

  if (mode === "replace") {
    const config = {
      schemaVersion: Storage.CURRENT_SCHEMA_VERSION,
      categories: data.categories,
      channels: data.channels,
    };
    await Storage.setConfig(config);
    await Storage.retainCacheFor(config.channels.map((c) => c.channelId));
    return { config };
  }

  // Merge: categories matched by name (case-insensitive) reuse local id;
  // channels matched by channelId are left untouched if already present.
  const config = await Storage.getConfig();
  const nameToLocalId = new Map(config.categories.map((c) => [c.name.toLowerCase(), c.id]));
  const importIdToLocalId = new Map();

  for (const importedCat of data.categories) {
    const lower = importedCat.name.toLowerCase();
    if (nameToLocalId.has(lower)) {
      importIdToLocalId.set(importedCat.id, nameToLocalId.get(lower));
    } else {
      const newCat = { id: Storage.genId("cat"), name: importedCat.name, order: config.categories.length };
      config.categories.push(newCat);
      nameToLocalId.set(lower, newCat.id);
      importIdToLocalId.set(importedCat.id, newCat.id);
    }
  }

  const existingChannelIds = new Set(config.channels.map((c) => c.channelId));
  for (const importedChannel of data.channels) {
    if (existingChannelIds.has(importedChannel.channelId)) continue;
    config.channels.push({
      ...importedChannel,
      categoryIds: importedChannel.categoryIds.map((cid) => importIdToLocalId.get(cid)).filter(Boolean),
    });
  }

  await Storage.setConfig(config);
  return { config };
}

// Commits an already-resolved, already-previewed category import
// (ROADMAP.md §A.2). `channels` are full resolved records
// ({channelId, name, avatarUrl, sourceUrl}), not identifiers — resolution
// already happened during the RESOLVE_CATEGORY_IMPORT preview step.
async function commitCategoryImport(categoryName, channels, collisionMode) {
  const config = await Storage.getConfig();
  const lowerName = categoryName.trim().toLowerCase();
  let targetCategory = config.categories.find((c) => c.name.toLowerCase() === lowerName);

  if (targetCategory && collisionMode === "new") {
    let suffix = 2;
    let candidateName = `${categoryName} (${suffix})`;
    while (config.categories.some((c) => c.name.toLowerCase() === candidateName.toLowerCase())) {
      suffix++;
      candidateName = `${categoryName} (${suffix})`;
    }
    targetCategory = { id: Storage.genId("cat"), name: candidateName, order: config.categories.length };
    config.categories.push(targetCategory);
  } else if (!targetCategory) {
    targetCategory = { id: Storage.genId("cat"), name: categoryName, order: config.categories.length };
    config.categories.push(targetCategory);
  }
  // else: targetCategory already exists and collisionMode === "merge" — reuse it as-is.

  // Deliberate divergence from importConfig()'s merge semantics above: that
  // merge never touches an existing channel's categoryIds. Importing a
  // category means "put these channels in this category", so an existing
  // channel gets the category added to it rather than being left alone
  // (ROADMAP.md §A.2's "deliberate divergence" note).
  for (const ch of channels) {
    const existing = config.channels.find((c) => c.channelId === ch.channelId);
    if (existing) {
      if (!existing.categoryIds.includes(targetCategory.id)) {
        existing.categoryIds.push(targetCategory.id);
      }
    } else {
      config.channels.push({
        channelId: ch.channelId,
        name: ch.name,
        avatarUrl: ch.avatarUrl,
        sourceUrl: ch.sourceUrl,
        categoryIds: [targetCategory.id],
        addedAt: new Date().toISOString(),
      });
    }
  }

  await Storage.setConfig(config);
  return { config };
}

browser.runtime.onMessage.addListener((message) => handleMessage(message));

// ---------------------------------------------------------------------------
// Open-or-focus: toolbar button, feed page's "Manage" link, Manage page's
// "Open Feed" link all share this — a page-scoped tab should never
// accumulate duplicates just because its own link was clicked again.
// ---------------------------------------------------------------------------

async function openOrFocusPage(pagePath, { reloadIfExisting = false } = {}) {
  const url = browser.runtime.getURL(pagePath);
  const tabs = await browser.tabs.query({});
  const existing = tabs.find((t) => t.url && t.url.startsWith(url));
  if (existing) {
    // Reload before focusing, not after — a reload briefly shows the page's
    // loading state, which reads oddly if it happens right after the tab
    // already looks focused/settled.
    if (reloadIfExisting) await browser.tabs.reload(existing.id);
    await browser.tabs.update(existing.id, { active: true });
    await browser.windows.update(existing.windowId, { focused: true });
  } else {
    await browser.tabs.create({ url });
  }
}

browser.action.onClicked.addListener(() => openOrFocusPage(FEED_PAGE_PATH));

// ---------------------------------------------------------------------------
// Context menu: "Manage Channels"
// ---------------------------------------------------------------------------

// Re-registered on every background script activation (not just install),
// since the background can be suspended and restarted (Firefox's event page,
// Chrome's service worker) without onInstalled firing again — a
// create-only-on-install approach would silently lose the menu item after a
// suspend/wake cycle.
(async () => {
  try {
    await browser.contextMenus.removeAll();
  } catch (e) {
    // No-op on first-ever run.
  }
  browser.contextMenus.create({
    id: "manage-channels",
    title: "Manage Channels",
    contexts: ["action"],
  });
})();

browser.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "manage-channels") {
    browser.runtime.openOptionsPage();
  }
});
