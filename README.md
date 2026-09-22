# YT Channels

A Firefox extension — with a Chromium build for Chrome and Edge made from the same source — that groups the YouTube channels you follow into your own categories, and opens a dedicated tab showing a clean, YouTube-style video grid for just the category you want to watch right now — no algorithm, no Shorts, no giant undifferentiated feed.

## Why

YouTube subscriptions give you one giant undifferentiated feed, and playlists don't auto-update with new uploads. This extension organizes your channels into custom categories (Programming, Physics, True Crime, whatever makes sense to you) instead.

## Features

- Organize channels into as many categories as you want; a channel can belong to more than one.
- One click opens (or refocuses) a single feed tab with category tabs across the top and a responsive video grid below.
- Shorts are excluded automatically — you only see regular uploads, and a failed update never brings Shorts back or replaces your last good list.
- Feeds are fetched only for the category you actually open, not all your channels at once, and are cached locally so switching back is instant.
- A progress bar on each video shows how far you've watched it (tracked while you watch on youtube.com in this browser), and a corner button marks a video as watched or resets it.
- Open a category in the Manage page to see and edit its channels, or share just that category with someone else as a small file.
- Fully local: no account, no cloud sync, no telemetry. Your categories and channel list can be exported to a plain text/JSON file and re-imported on another machine whenever you want; imports show a preview before anything is saved.

No API key, no setup beyond installing and adding channels.

## Install

- **From Mozilla Add-ons**: [YT Channels add-on](https://addons.mozilla.org/en-US/firefox/addon/yt-channels/)
- **Temporary/dev install (Firefox)**: clone this repo, open `about:debugging#/runtime/this-firefox` in Firefox, click **Load Temporary Add-on**, and select `manifest.json` from this folder.
- **Chrome and Edge (148 or newer)**: not in a store yet. Build the Chromium package with `node tools/package.mjs chromium --dev` (see [Packaging](#packaging)), open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, click **Load unpacked**, and select the `dist/chromium` folder. Chrome hides new extensions in the puzzle-piece menu next to the address bar: pin YT Channels there to get its toolbar button.

## Known limitations

- YouTube's RSS feeds cap at the 15 most recent uploads per channel — a channel that posts more than 15 times between visits will show gaps, not a full history.
- Live streams/premieres don't show up for channels that also have regular uploads, as a side effect of the feed used to filter Shorts out. Channels with no regular uploads at all show their streams instead, and channels that only post Shorts show nothing.
- YouTube's feed service is unreliable for some channels, more often smaller ones: it answers a request with an error and the same request with the video list moments later. A category tries a failed channel again before reporting it, and keeps showing that channel's previous videos meanwhile, but some updates still fail. Pressing Refresh again usually clears them.
- Watch progress is only recorded for videos you watch in this browser. There is no cloud sync or automatic background notifications in this version.
- Requires Firefox 140 or newer, or Chrome/Edge 148 or newer for the Chromium build (checked automatically on Chrome and Edge 153; not yet in a store). Firefox for Android, Safari and Opera are not supported.

## Privacy

Everything stays on your device: your categories, channel list, settings, cached video lists and watch progress live in the browser's extension storage, and are never sent anywhere. The extension only talks to youtube.com — to read its public upload feeds, to look up a channel from a link you paste, and (through a small script on youtube.com pages) to note how far you have watched a video — and it loads thumbnails and channel pictures from YouTube's image servers. There are no accounts, no analytics and no telemetry.

The full policy — what is stored, what is contacted, how cookies are handled — is in [PRIVACY.md](PRIVACY.md).

## Packaging

For contributors and releases. Needs Node 22 or newer and Git 2.32 or newer, and nothing else — there is no `package.json` and no dependencies.

```
node tools/package.mjs firefox           # release zip for Mozilla Add-ons
node tools/package.mjs chromium          # release zip for the Chrome Web Store and Edge Add-ons
node tools/package.mjs <target> --dev    # unpacked folder from the working tree, not for release
node --test tools/package.test.mjs       # the tool's own tests
```

The output goes to `dist/`. A release zip is made from the last commit (the tool refuses uncommitted changes) and holds exactly what was committed. The Firefox zip is the repository's runtime files, byte for byte, as `git archive` produces them; the Chromium zip is the same files plus a generated manifest and a one-line service-worker entry. The version number is read from `manifest.json`.

## Reporting bugs

Please open an issue: [issues](https://github.com/Project0B/YT-Channels/issues)

If a category says some channels failed to update, the feed page's console explains which ones and what YouTube answered. Press F12 on the YT Channels tab, open the Console, press Refresh, and copy the lines beginning with `[YT Channels]` into the issue. Nothing is logged when everything loads normally, and nothing is ever sent anywhere — see [PRIVACY.md](PRIVACY.md).

## Suggesting features

Suggestions are welcome via this form: [YT Channels - Feature Suggestion](https://forms.gle/ikP5KUtdFz3VWreX7)

## License

This project is licensed under the GNU General Public License v3.0.
See the [LICENSE](https://github.com/Project0B/YT-Channels/blob/main/LICENSE.txt) file for the full license text.
