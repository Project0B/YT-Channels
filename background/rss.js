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

// The feed is read as text, not through the browser's XML parser: the
// background script may run as a Chrome service worker, which has no DOM. The
// helpers below cover what the Uploads feeds use — elements, attributes,
// CDATA and character references. DTDs, processing instructions inside entries
// and namespace prefixes other than the ones YouTube writes are not supported;
// a change of format shows up as a parse error, never as wrong data.

const XML_ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

// Decodes the five predefined entities and numeric character references, in one
// pass so that "&amp;lt;" becomes "&lt;". Anything else, such as "&nbsp;" or a
// reference to a character XML forbids, is kept as written.
function decodeXmlText(raw) {
  return raw.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(lt|gt|amp|quot|apos));/g, (whole, hex, dec, name) => {
    if (name) return XML_ENTITIES[name];
    const codePoint = hex ? parseInt(hex, 16) : parseInt(dec, 10);
    const allowed =
      codePoint === 0x9 ||
      codePoint === 0xa ||
      codePoint === 0xd ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    return allowed ? String.fromCodePoint(codePoint) : whole;
  });
}

// The pieces of markup that are not character data, tried at one position: a
// CDATA section, a comment, a processing instruction, or a start, end or
// self-closing tag (attribute values may contain ">" but not "<").
const XML_MARKUP =
  /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=\/>"'<]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;

// Splits markup into those pieces, in order. A "<" that starts none of them (a
// cut-off tag, an unescaped "<" in text, a DOCTYPE) means the text is not
// well-formed. Tags have a name; CDATA sections have a cdata string; comments
// and processing instructions have neither and only mark where text ends.
function xmlTokens(text) {
  const tokens = [];
  let position = text.indexOf("<");
  while (position !== -1) {
    XML_MARKUP.lastIndex = position;
    const match = XML_MARKUP.exec(text);
    if (!match) throw new Error("Feed XML failed to parse");
    const [whole, cdata, slash, name, attributes, selfSlash] = match;
    if (slash && (selfSlash || attributes)) throw new Error("Feed XML failed to parse");
    tokens.push({
      start: position,
      end: position + whole.length,
      cdata,
      name,
      closing: slash === "/",
      selfClosing: selfSlash === "/",
      attributes,
    });
    position = text.indexOf("<", position + whole.length);
  }
  return tokens;
}

// What textContent would return for this markup: CDATA verbatim, other text
// with its references decoded, and no tags or comments.
function xmlTextContent(markup) {
  let text = "";
  let position = 0;
  for (const token of xmlTokens(markup)) {
    text += decodeXmlText(markup.slice(position, token.start)) + (token.cdata ?? "");
    position = token.end;
  }
  return text + decodeXmlText(markup.slice(position));
}

// The attributes of a start tag, with their references decoded.
function xmlAttributes(tag) {
  const attributes = {};
  for (const [, name, double, single] of tag.attributes.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[name] = decodeXmlText(double ?? single);
  }
  return attributes;
}

// The text of a start tag's element, up to its own end tag. `tokens` are the
// tags of `markup`, which is well-formed.
function elementText(markup, tokens, tag) {
  if (tag.selfClosing) return "";
  let depth = 0;
  for (const token of tokens.slice(tokens.indexOf(tag))) {
    if (token.closing) depth--;
    else if (!token.selfClosing) depth++;
    if (depth === 0) return xmlTextContent(markup.slice(tag.end, token.start));
  }
  throw new Error("Feed XML failed to parse");
}

/**
 * @param {string} markup what lies between an entry's start tag and end tag
 * @returns {Video|null}
 */
function parseEntry(markup) {
  const tags = xmlTokens(markup).filter((token) => token.name);
  const first = (name) => tags.find((tag) => tag.name === name && !tag.closing);
  const textOf = (name) => {
    const tag = first(name);
    return tag && elementText(markup, tags, tag).trim();
  };

  const link = tags
    .filter((tag) => tag.name === "link" && !tag.closing)
    .map(xmlAttributes)
    .find((attributes) => (attributes.rel || "alternate") === "alternate");
  if (isShortLink(link?.href)) return null;

  const idText = textOf("yt:videoId");
  const rawId = textOf("id") || "";
  const videoId = idText || rawId.replace(/^yt:video:/, "");
  if (!videoId) return null;

  const title = textOf("title");
  if (!title) return null;

  const publishedText = textOf("published");
  if (!publishedText) return null;
  const publishedDate = new Date(publishedText);
  if (Number.isNaN(publishedDate.getTime())) return null;

  const thumbnail = first("media:thumbnail");
  const thumbnailUrl =
    (thumbnail && xmlAttributes(thumbnail).url) || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  return {
    videoId,
    title,
    thumbnailUrl,
    publishedAt: publishedDate.toISOString(),
  };
}

// The markup inside each top-level <entry> of a feed. Text that is not a
// complete feed throws instead of giving an empty list: an HTML page returned
// with status 200, an empty body or a cut-off download must not read as "a
// feed with no videos", because that would be cached over the last good list.
// So the text must open with <feed> (after an optional XML declaration), end
// with </feed>, and close every tag it opens, in order.
function feedEntries(text) {
  const notAFeed = () => new Error("Feed XML failed to parse");
  const tags = xmlTokens(text).filter((token) => token.name);
  const root = tags[0];
  const last = tags[tags.length - 1];
  if (!root || root.closing || root.name !== "feed" || !last.closing || last.name !== "feed") throw notAFeed();
  if (!/^\s*(?:<\?xml[^>]*\?>\s*)?$/.test(text.slice(0, root.start)) || text.slice(last.end).trim()) {
    throw notAFeed();
  }

  const entries = [];
  const open = [];
  let entryStart = null;
  tags.forEach((tag, index) => {
    if (!tag.closing) {
      if (tag.name === "entry" && open.length === 1 && !tag.selfClosing) entryStart = tag;
      if (!tag.selfClosing) open.push(tag.name);
      return;
    }
    if (open.pop() !== tag.name) throw notAFeed();
    // The root closes only at the very end.
    if (open.length === 0 && index < tags.length - 1) throw notAFeed();
    if (tag.name === "entry" && open.length === 1) entries.push(text.slice(entryStart.end, tag.start));
  });
  if (open.length > 0) throw notAFeed();
  return entries;
}

/**
 * @param {string} xmlText
 * @returns {Video[]}
 */
function parseFeedXml(xmlText) {
  // A byte-order mark is not content, and XML reads every line ending as "\n".
  const text = xmlText.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const videos = [];
  for (const markup of feedEntries(text)) {
    try {
      const video = parseEntry(markup);
      if (video) videos.push(video);
    } catch (e) {
      // Skip an entry that cannot be read rather than failing the whole
      // channel.
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

// Whether a failure is more likely a passing glitch than an answer about the
// channel. YouTube's feed endpoint intermittently serves 404s, 5xx errors and
// HTML error pages for channels that answered normally a second earlier, and it
// does so to many channels at once, so a whole Load can come back "failed" for
// no lasting reason. A "network" failure is the one that is not worth another
// go: nothing answered at all, so the connection is down and an immediate
// second request would only fail the same way.
function isTransientFeedError(err) {
  return err.kind === "http" || err.kind === "parse";
}

// A failed result: the message the Feed page shows, whether a later retry is
// worth making, and the pieces a Load needs to say in the console what YouTube
// actually did (see common/diagnostics.js). `alsoFailed` is the other feed's
// error when both were tried — the retry is worth making only if neither
// failure was the connection being down.
function failedResult(err, feed, alsoFailed) {
  return {
    status: "failed",
    error: err.message || "Fetch failed",
    retryable: isTransientFeedError(err) && (!alsoFailed || isTransientFeedError(alsoFailed)),
    kind: err.kind,
    httpStatus: err.status,
    feed,
    // The plain feed is only ever read after the long-form feed has been tried,
    // so a result that names it cost two requests.
    requests: feed === "plain" || alsoFailed ? 2 : 1,
  };
}

/**
 * Fetch a channel's videos. The long-form feed is preferred; a 404 there, or a feed with
 * no videos left once Shorts are dropped, means the channel has no long-form uploads and
 * is answered from the plain feed. Any other failure never yields cacheable data:
 * "failed" tells the caller to keep its last good list, and "stopgap" is a one-off list
 * for a channel that has none. Every result says how many requests it cost, because a
 * channel with no long-form feed silently costs two on every Load and that is invisible
 * otherwise — a long-form 404 is the answer "no long-form uploads", never a failure.
 * A failure also says whether it is worth another try later
 * (see isTransientFeedError); the caller decides when, so that a retry does not join the
 * burst of requests that provoked the failure.
 * @param {string} channelId
 * @param {{hasLastGood?: boolean}} [options]
 * @returns {Promise<
 *   {status: "ok", videos: Video[], source: "long-form"|"plain", requests: number} |
 *   {status: "stopgap", videos: Video[], error: string, kind: string, httpStatus: number|undefined, feed: "long-form", requests: number} |
 *   {status: "failed", error: string, retryable: boolean, kind: string, httpStatus: number|undefined, feed: "long-form"|"plain", requests: number}>}
 */
async function fetchChannelVideos(channelId, { hasLastGood = false } = {}) {
  let longFormError = null;
  try {
    const videos = await fetchFeed(longFormFeedUrl(channelId));
    if (videos.length > 0) return { status: "ok", videos, source: "long-form", requests: 1 };
  } catch (e) {
    longFormError = e;
  }

  const noLongForm = !longFormError || (longFormError.kind === "http" && longFormError.status === 404);
  if (!noLongForm) {
    // No answer at all means the network is down; a second request would only double the wait.
    if (longFormError.kind === "network" || hasLastGood) {
      return failedResult(longFormError, "long-form");
    }
  }

  try {
    const videos = await fetchFeed(plainChannelFeedUrl(channelId));
    return noLongForm
      ? { status: "ok", videos, source: "plain", requests: 2 }
      : {
          status: "stopgap",
          videos,
          requests: 2,
          error: longFormError.message,
          // The Feed page counts a stopgap among the channels that failed to
          // update, so it carries what the console needs to explain it too.
          kind: longFormError.kind,
          httpStatus: longFormError.status,
          feed: "long-form",
        };
  } catch (plainError) {
    // Both feeds have now failed. The one that is reported is the one that says
    // something about the Channel: the plain feed's when the long-form feed is
    // simply missing, otherwise the long-form feed's.
    return noLongForm
      ? failedResult(plainError, "plain")
      : failedResult(longFormError, "long-form", plainError);
  }
}

const Rss = {
  longFormFeedUrl,
  plainChannelFeedUrl,
  fetchChannelVideos,
};
