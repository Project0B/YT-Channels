/**
 * resolve.js — given a pasted YouTube URL (channel URL, /@handle, /c/Name,
 * /channel/UC..., or a video URL), fetch the relevant youtube.com page(s)
 * and extract {channelId, name, avatarUrl} (SPEC.md §4).
 */

const CHANNEL_ID_RE = /UC[a-zA-Z0-9_-]{22}/;

function normalizeInputUrl(input) {
  let s = (input || "").trim();
  if (!s) {
    throw new Error("Paste a YouTube channel or video URL");
  }
  if (!/^https?:\/\//i.test(s)) {
    if (s.startsWith("@")) {
      s = `https://www.youtube.com/${s}`;
    } else if (/^(www\.)?(youtube\.com|youtu\.be)/i.test(s)) {
      s = `https://${s}`;
    } else {
      s = `https://www.youtube.com/${s.replace(/^\/+/, "")}`;
    }
  }
  let url;
  try {
    url = new URL(s);
  } catch (e) {
    throw new Error("That doesn't look like a valid URL");
  }
  if (!/(^|\.)youtube\.com$/i.test(url.hostname) && !/(^|\.)youtu\.be$/i.test(url.hostname)) {
    throw new Error("Only youtube.com URLs are supported");
  }
  return url.toString();
}

function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}

function extractChannelId(html) {
  const canonical = html.match(/<link rel="canonical" href="[^"]*\/channel\/(UC[a-zA-Z0-9_-]{22})"/);
  if (canonical) return canonical[1];

  const ogUrl = html.match(/<meta property="og:url" content="[^"]*\/channel\/(UC[a-zA-Z0-9_-]{22})"/);
  if (ogUrl) return ogUrl[1];

  const channelIdJson = html.match(/"channelId":"(UC[a-zA-Z0-9_-]{22})"/);
  if (channelIdJson) return channelIdJson[1];

  const externalIdJson = html.match(/"externalId":"(UC[a-zA-Z0-9_-]{22})"/);
  if (externalIdJson) return externalIdJson[1];

  const anyMatch = html.match(CHANNEL_ID_RE);
  if (anyMatch) return anyMatch[0];

  return null;
}

function extractMetaContent(html, property) {
  if (!html) return null;
  const re = new RegExp(`<meta property="${property}" content="([^"]*)"`, "i");
  const match = html.match(re);
  return match ? decodeHtmlEntities(match[1]) : null;
}

function isConsentWallPage(html) {
  return html.includes("consent.youtube.com") || html.includes("Before you continue to YouTube");
}

const PAGE_FETCH_TIMEOUT_MS = 15000;

// See the matching helper in rss.js: plain fetch() never times out on its
// own, so a stalled request would otherwise hang the Manage page's
// "Resolve" button (and its await chain) indefinitely.
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error("Request timed out");
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchPage(url) {
  // credentials: "include" — without it, cross-origin fetches from the
  // background script never carry youtube.com's cookies, and YouTube's
  // channel pages (unlike video pages) reliably respond with a
  // cookie-consent interstitial instead of real content for cookie-less
  // requests. Including credentials lets the user's normal youtube.com
  // session (e.g. an already-accepted CONSENT cookie) through, which is
  // what makes channel-page resolution work at all.
  const response = await fetchWithTimeout(url, { credentials: "include" }, PAGE_FETCH_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error("Couldn't find a channel at that URL");
  }
  const html = await response.text();
  if (isConsentWallPage(html)) {
    throw new Error(
      "YouTube is asking for cookie consent before showing this page. Visit youtube.com in a regular tab, accept the cookie prompt, then try again."
    );
  }
  return html;
}

/**
 * @param {string} inputUrl
 * @returns {Promise<{channelId: string, name: string, avatarUrl: string, sourceUrl: string}>}
 */
const VIDEO_URL_RE = /\/watch\?|youtu\.be\//i;

async function resolveChannelUrl(inputUrl) {
  const normalized = normalizeInputUrl(inputUrl);

  let html;
  try {
    html = await fetchPage(normalized);
  } catch (e) {
    throw new Error(e.message || "Couldn't find a channel at that URL");
  }

  const channelId = extractChannelId(html);
  if (!channelId) {
    throw new Error("Couldn't determine the channel for that URL");
  }

  // The originally fetched page is only a valid source of *channel* name/
  // avatar metadata if it was itself a channel-shaped page. For a video
  // URL, its og:title/og:image are the video's, not the channel's — using
  // them as a fallback would silently mislabel the channel (this was the
  // actual bug: a video link would save the video's own thumbnail/title as
  // the channel's).
  const isChannelShapedPage = !VIDEO_URL_RE.test(normalized);

  let channelPageHtml = null;
  try {
    channelPageHtml = await fetchPage(`https://www.youtube.com/channel/${channelId}`);
  } catch (e) {
    // Fall back below to metadata from the originally fetched page, if
    // that page is actually usable for channel-level metadata.
  }

  const fallbackHtml = isChannelShapedPage ? html : null;

  const name =
    extractMetaContent(channelPageHtml, "og:title") ||
    extractMetaContent(fallbackHtml, "og:title") ||
    "Unknown Channel";
  const avatarUrl =
    extractMetaContent(channelPageHtml, "og:image") || extractMetaContent(fallbackHtml, "og:image") || "";

  return { channelId, name, avatarUrl, sourceUrl: normalized };
}

const Resolve = {
  normalizeInputUrl,
  resolveChannelUrl,
};
