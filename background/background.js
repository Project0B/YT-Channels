/**
 * background.js — central message router and fetch orchestration.
 * Decides cache-fresh vs needs-fetch per channel, runs bounded-concurrency
 * fetches, writes results via storage.js, and replies to requesting pages
 * (ARCHITECTURE.md §2-3).
 */

const FEED_PAGE_PATH = "feed/feed.html";

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

function channelsForCategory(config, categoryId) {
  if (categoryId === "all") {
    return config.channels;
  }
  if (categoryId === "uncategorized") {
    return config.channels.filter((c) => !c.categoryIds || c.categoryIds.length === 0);
  }
  return config.channels.filter((c) => c.categoryIds && c.categoryIds.includes(categoryId));
}

function mergeAndSort(videosByChannel, channels, limit) {
  const channelById = new Map(channels.map((c) => [c.channelId, c]));
  const merged = [];
  for (const [channelId, videos] of videosByChannel.entries()) {
    const channel = channelById.get(channelId);
    if (!channel) continue;
    for (const video of videos) {
      merged.push({
        ...video,
        channelId,
        channelName: channel.name,
        channelAvatarUrl: channel.avatarUrl,
      });
    }
  }
  merged.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  return merged.slice(0, limit);
}

// ---------------------------------------------------------------------------
// GET_CATEGORY_FEED orchestration (streamed over a Port)
// ---------------------------------------------------------------------------

async function handleGetCategoryFeed(categoryId, forceRefresh, port) {
  const config = await Storage.getConfig();
  const settings = await Storage.getSettings();
  const cache = await Storage.getCache();

  const channels = channelsForCategory(config, categoryId);
  if (channels.length === 0) {
    port.postMessage({ type: "CATEGORY_FEED_DONE", categoryId, videos: [], errors: {}, emptyCategory: true });
    return;
  }

  const ttlMs = settings.cacheTtlMinutes * 60 * 1000;
  const now = Date.now();

  const videosByChannel = new Map();
  const errors = {};
  // Channels where the undocumented UULF (Shorts-excluding) feed failed
  // outright and we fell back to the plain channel feed (SPEC.md §7,
  // DECISIONS.md) — a real fetch condition, not a silent, ordinary success,
  // since Shorts may reappear for that channel until UULF works again.
  const fallbackWarnings = {};

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

  const postProgress = () => {
    const videos = mergeAndSort(videosByChannel, channels, settings.videosPerCategoryLimit);
    port.postMessage({
      type: "CATEGORY_FEED_PARTIAL",
      categoryId,
      videos,
      errors: { ...errors },
      fallbackWarnings: { ...fallbackWarnings },
    });
  };

  // Initial paint with whatever cache we already have.
  postProgress();

  if (toFetch.length > 0) {
    await runWithConcurrency(toFetch, settings.fetchConcurrency, async (channel) => {
      const result = await Rss.fetchChannelVideos(channel.channelId);
      const priorEntry = cache[channel.channelId];

      if (result.error) {
        errors[channel.channelId] = result.error;
        // Keep prior cached videos (even stale) as fallback; don't clear them.
        if (priorEntry) {
          videosByChannel.set(channel.channelId, priorEntry.videos);
          await Storage.setCacheEntry(channel.channelId, { ...priorEntry, lastError: result.error });
        } else {
          videosByChannel.set(channel.channelId, []);
          await Storage.setCacheEntry(channel.channelId, {
            fetchedAt: priorEntry ? priorEntry.fetchedAt : new Date(0).toISOString(),
            videos: [],
            lastError: result.error,
          });
        }
      } else {
        if (result.usedFallback) {
          fallbackWarnings[channel.channelId] = channel.name;
        }
        videosByChannel.set(channel.channelId, result.videos);
        await Storage.setCacheEntry(channel.channelId, {
          fetchedAt: new Date().toISOString(),
          videos: result.videos,
          lastError: null,
        });
      }
      postProgress();
    });
  }

  const finalVideos = mergeAndSort(videosByChannel, channels, settings.videosPerCategoryLimit);
  port.postMessage({
    type: "CATEGORY_FEED_DONE",
    categoryId,
    videos: finalVideos,
    errors: { ...errors },
    fallbackWarnings: { ...fallbackWarnings },
  });
}

// ---------------------------------------------------------------------------
// Port-based streaming connections (feed.js)
// ---------------------------------------------------------------------------

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "feed") return;
  port.onMessage.addListener((msg) => {
    if (msg?.type === "GET_CATEGORY_FEED") {
      handleGetCategoryFeed(msg.categoryId, Boolean(msg.forceRefresh), port).catch((err) => {
        port.postMessage({ type: "CATEGORY_FEED_DONE", categoryId: msg.categoryId, videos: [], errors: {}, fatalError: String(err) });
      });
    }
  });
});

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
        order: config.categories.length,
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
          schemaVersion: config.schemaVersion,
          exportedAt: new Date().toISOString(),
          categories: config.categories,
          channels: config.channels,
        },
      };
    }

    case "IMPORT_CONFIG": {
      return importConfig(message.data, message.mode);
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

browser.runtime.onMessage.addListener((message) => handleMessage(message));

// ---------------------------------------------------------------------------
// Toolbar button: open-or-focus feed.html
// ---------------------------------------------------------------------------

browser.action.onClicked.addListener(async () => {
  const feedUrl = browser.runtime.getURL(FEED_PAGE_PATH);
  const tabs = await browser.tabs.query({});
  const existing = tabs.find((t) => t.url && t.url.startsWith(feedUrl));
  if (existing) {
    await browser.tabs.update(existing.id, { active: true });
    await browser.windows.update(existing.windowId, { focused: true });
  } else {
    await browser.tabs.create({ url: feedUrl });
  }
});

// ---------------------------------------------------------------------------
// Context menu: "Manage Channels"
// ---------------------------------------------------------------------------

// Re-registered on every background script activation (not just install),
// since Firefox's event page can suspend and restart without onInstalled
// firing again — a create-only-on-install approach would silently lose the
// menu item after a suspend/wake cycle.
(async () => {
  try {
    await browser.menus.removeAll();
  } catch (e) {
    // No-op on first-ever run.
  }
  browser.menus.create({
    id: "manage-channels",
    title: "Manage Channels",
    contexts: ["action"],
  });
})();

browser.menus.onClicked.addListener((info) => {
  if (info.menuItemId === "manage-channels") {
    browser.runtime.openOptionsPage();
  }
});
