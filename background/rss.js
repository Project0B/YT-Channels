/**
 * rss.js — derives a channel's long-form uploads feed URL (SPEC.md §5.1),
 * fetches + parses it into Video[], tolerating partial/malformed entries,
 * and falls back to the plain channel feed if the long-form feed fails
 * outright (SPEC.md §7).
 */

function longFormFeedUrl(channelId) {
  const suffix = channelId.replace(/^UC/, "");
  return `https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${suffix}`;
}

function plainChannelFeedUrl(channelId) {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

/**
 * @param {Element} entry
 * @returns {Video|null}
 */
function parseEntry(entry) {
  const idText = entry.getElementsByTagName("yt:videoId")[0]?.textContent?.trim();
  const rawId = entry.getElementsByTagName("id")[0]?.textContent?.trim() || "";
  const videoId = idText || rawId.replace(/^yt:video:/, "");
  if (!videoId) return null;

  const title = entry.getElementsByTagName("title")[0]?.textContent?.trim();
  if (!title) return null;

  const publishedText = entry.getElementsByTagName("published")[0]?.textContent?.trim();
  if (!publishedText) return null;
  const publishedDate = new Date(publishedText);
  if (Number.isNaN(publishedDate.getTime())) return null;

  const thumbEl = entry.getElementsByTagName("media:thumbnail")[0];
  const thumbnailUrl =
    thumbEl?.getAttribute("url") || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  return {
    videoId,
    title,
    thumbnailUrl,
    publishedAt: publishedDate.toISOString(),
  };
}

/**
 * @param {string} xmlText
 * @returns {Video[]}
 */
function parseFeedXml(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const parserError = doc.getElementsByTagName("parsererror")[0];
  if (parserError) {
    throw new Error("Feed XML failed to parse");
  }
  const entries = Array.from(doc.getElementsByTagName("entry"));
  const videos = [];
  for (const entry of entries) {
    try {
      const video = parseEntry(entry);
      if (video) videos.push(video);
    } catch (e) {
      // Skip unparseable entries within a feed (SPEC.md §7) rather than
      // failing the whole channel.
    }
  }
  return videos;
}

const FEED_FETCH_TIMEOUT_MS = 15000;

// Plain fetch() has no timeout of its own. A single stalled connection
// (flaky network, YouTube not responding) would otherwise hang forever —
// and since handleGetCategoryFeed in background.js awaits every channel's
// fetch via Promise.all across bounded-concurrency lanes, one stuck request
// blocks the entire category from ever finishing (no CATEGORY_FEED_DONE,
// spinner stuck, only fixable by reloading the page). Aborting after a
// bounded timeout turns that into an ordinary, already-handled fetch error.
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error("Feed request timed out");
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchFeed(url) {
  const response = await fetchWithTimeout(url, { credentials: "omit" }, FEED_FETCH_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`Feed request failed with status ${response.status}`);
  }
  const text = await response.text();
  return parseFeedXml(text);
}

/**
 * Fetch a channel's uploads, preferring the long-form (Shorts-excluding)
 * playlist feed and falling back to the plain channel feed on outright
 * failure. The fallback is intentionally not silent (SPEC.md §7): callers
 * get `usedFallback: true` so it can be surfaced as a fetch condition
 * rather than reported as an ordinary clean success.
 * @param {string} channelId
 * @returns {Promise<{videos: Video[], error: string|null, usedFallback: boolean}>}
 */
async function fetchChannelVideos(channelId) {
  try {
    const videos = await fetchFeed(longFormFeedUrl(channelId));
    return { videos, error: null, usedFallback: false };
  } catch (longFormError) {
    try {
      const videos = await fetchFeed(plainChannelFeedUrl(channelId));
      return { videos, error: null, usedFallback: true };
    } catch (plainError) {
      return { videos: [], error: plainError.message || "Fetch failed", usedFallback: false };
    }
  }
}

const Rss = {
  longFormFeedUrl,
  plainChannelFeedUrl,
  fetchChannelVideos,
};
