# YT Channels

A Firefox extension that groups the YouTube channels you follow into your own categories, and opens a dedicated tab showing a clean, YouTube-style video grid for just the category you want to watch right now — no algorithm, no Shorts, no giant undifferentiated feed.

## Why

YouTube subscriptions give you one giant undifferentiated feed, and playlists don't auto-update with new uploads. This extension organizes your channels into custom categories (Programming, Physics, True Crime, whatever makes sense to you) instead.

## Features

- Organize channels into as many categories as you want; a channel can belong to more than one.
- One click opens (or refocuses) a single feed tab with category tabs across the top and a responsive video grid below.
- Shorts are excluded automatically — you only see regular uploads.
- Feeds are fetched only for the category you actually open, not all your channels at once, and are cached locally so switching back is instant.
- Fully local: no account, no cloud sync, no telemetry. Your categories and channel list can be exported to a plain text/JSON file and re-imported on another machine whenever you want.

No API key, no setup beyond installing and adding channels.

## Install

- **From Mozilla Add-ons**: [YT Channels add-on](https://addons.mozilla.org/en-US/firefox/addon/yt-channels/)
- **Temporary/dev install**: clone this repo, open `about:debugging#/runtime/this-firefox` in Firefox, click **Load Temporary Add-on**, and select `manifest.json` from this folder.

## Known limitations

- YouTube's RSS feeds cap at the 15 most recent uploads per channel — a channel that posts more than 15 times between visits will show gaps, not a full history.
- Live streams/premieres are currently excluded alongside Shorts, as a side effect of the feed used to filter Shorts out.
- Firefox for Android and Chrome/Edge are not supported or tested.
- No watched/read-state tracking, cloud sync, or automatic background notifications in this version.

## Reporting bugs

Please open an issue: [issues](https://github.com/Project0B/YT-Channels/issues)

## Suggesting features

Suggestions are welcome via this form: [YT Channels - Feature Suggestion](https://forms.gle/ikP5KUtdFz3VWreX7)

## License

This project is licensed under the GNU General Public License v3.0.
See the [LICENSE](https://github.com/Project0B/YT-Channels/blob/main/LICENSE.txt) file for the full license text.
