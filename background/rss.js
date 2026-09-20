/**
 * rss.js — derives a channel's Uploads feed URLs, fetches + parses them into
 * Video[] (dropping Shorts, tolerating partial/malformed entries), and picks
 * which feed a channel is served from.
 */

function longFormFeedUrl(channelId) {
  const suffix = channelId.replace(/^UC/, "");
  return `https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${suffix}`;
}

function plainChannelFeedUrl(channelId) {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

// YouTube marks a Short only by its entry link: /shorts/<id> instead of /watch?v=<id>.
function isShortLink(href) {
  return /^https?:\/\/[^/]+\/shorts\//i.test(href || "");
}

/**
 * @param {Element} entry
 * @returns {Video|null}
 */
function parseEntry(entry) {
  const link = Array.from(entry.getElementsByTagName("link")).find(
    (el) => (el.getAttribute("rel") || "alternate") === "alternate"
  );
  if (isShortLink(link?.getAttribute("href"))) return null;

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

// Feed failures carry a `kind` so callers can tell "no answer at all" from "answered
// with something unusable": "network" (offline, timeout, reset), "http" (bad status,
// see `status`) or "parse" (200 but not a readable feed).
function feedError(message, kind, status) {
  const err = new Error(message);
  err.kind = kind;
  err.status = status;
  return err;
}

// Plain fetch() has no timeout of its own. A single stalled connection
// (flaky network, YouTube not responding) would otherwise hang forever —
// and since handleGetCategoryFeed in background.js awaits every channel's
// fetch via Promise.all across bounded-concurrency lanes, one stuck request
// blocks the entire category from ever finishing (no CATEGORY_FEED_DONE,
// spinner stuck, only fixable by reloading the page). Aborting after a
// bounded timeout turns that into an ordinary, already-handled fetch error.
//
// fetch() itself only resolves once response *headers* arrive — a
// connection that sends 200 OK promptly but then stalls mid-body would hang
// response.text() forever if the timer were cleared as soon as fetch()
// resolved. The timer is instead kept alive (via the returned clearTimer)
// until the caller has finished reading the body, so a stalled body read
// gets aborted too, not just a stalled header read.
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return { response, clearTimer: () => clearTimeout(timeoutId) };
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") {
      throw feedError("Feed request timed out", "network");
    }
    e.kind = "network";
    throw e;
  }
}

async function fetchFeed(url) {
  const { response, clearTimer } = await fetchWithTimeout(
    url,
    // no-store: our own cache decides freshness; the browser's HTTP cache would answer for up to 15 minutes.
    { credentials: "omit", cache: "no-store" },
    FEED_FETCH_TIMEOUT_MS
  );
  try {
    if (!response.ok) {
      throw feedError(`Feed request failed with status ${response.status}`, "http", response.status);
    }
    const text = await response.text();
    try {
      return parseFeedXml(text);
    } catch (e) {
      throw feedError(e.message, "parse");
    }
  } catch (e) {
    if (e.name === "AbortError") {
      throw feedError("Feed request timed out", "network");
    }
    if (!e.kind) e.kind = "network";
    throw e;
  } finally {
    clearTimer();
  }
}

/**
 * Fetch a channel's videos. The long-form feed is preferred; a 404 there means the
 * channel has no long-form uploads and is answered from the plain feed. Any other
 * failure never yields cacheable data: "failed" tells the caller to keep its last good
 * list, and "stopgap" is a one-off list for a channel that has none.
 * @param {string} channelId
 * @param {{hasLastGood?: boolean}} [options]
 * @returns {Promise<
 *   {status: "ok", videos: Video[], source: "long-form"|"plain"} |
 *   {status: "stopgap", videos: Video[], error: string} |
 *   {status: "failed", error: string}>}
 */
async function fetchChannelVideos(channelId, { hasLastGood = false } = {}) {
  let longFormError;
  try {
    const videos = await fetchFeed(longFormFeedUrl(channelId));
    return { status: "ok", videos, source: "long-form" };
  } catch (e) {
    longFormError = e;
  }

  const noLongForm = longFormError.kind === "http" && longFormError.status === 404;
  // No answer at all means the network is down; a second request would only double the wait.
  if (longFormError.kind === "network") return { status: "failed", error: longFormError.message };
  if (!noLongForm && hasLastGood) return { status: "failed", error: longFormError.message };

  try {
    const videos = await fetchFeed(plainChannelFeedUrl(channelId));
    return noLongForm
      ? { status: "ok", videos, source: "plain" }
      : { status: "stopgap", videos, error: longFormError.message };
  } catch (plainError) {
    return { status: "failed", error: (noLongForm ? plainError : longFormError).message || "Fetch failed" };
  }
}

const Rss = {
  longFormFeedUrl,
  plainChannelFeedUrl,
  fetchChannelVideos,
};
