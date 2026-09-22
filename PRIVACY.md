# Privacy policy — YT Channels

Last updated: 2026-09-22 (applies to version 1.2.1 and later, until a newer date is shown here).

YT Channels keeps everything on your device. It has no server of its own, no accounts, no analytics and no telemetry, and it sends nothing to its developer or to anyone else.

## What it stores on your device

The extension keeps the following in your browser's extension storage, and nowhere else:

- **Your setup:** your categories, and the channels you added to them (each channel's name, avatar link, YouTube link and the categories it belongs to), and your settings.
- **Saved video lists:** for each channel, the latest videos last fetched from YouTube — titles, thumbnail links and publish dates — so that switching back to a category is instant.
- **Watch progress:** for each YouTube video you watch in this browser while the extension is installed, the video's ID, how far you got, and when you last watched it.

When a category cannot be updated, the extension writes a few lines to your browser's own developer console naming the channels it could not reach and what YouTube answered, so that you can see what went wrong and include it in a bug report if you choose to. Those lines stay in your browser, are not stored, and disappear when you close the console.

Removing a channel deletes its saved videos. Old watch-progress entries are tidied automatically. Removing the extension deletes everything it stored. Exporting your setup creates a file on your own device with your categories and channel identifiers only; watch progress is never exported, and nothing is shared unless you send the file to someone yourself.

## What it connects to

The extension contacts only:

- **youtube.com and youtu.be**, to read YouTube's public upload feeds for the category you open, to look up a channel from a link you paste or import, and — through a small script that runs on youtube.com pages — to read which video is playing and how far along it is, so that watch progress can be saved on your device;
- **YouTube's image servers**, to show video thumbnails and channel pictures.

These requests reach YouTube as any visit to its site would, and YouTube's own privacy policy applies to them. No other server is contacted, and the extension downloads and runs no remote code.

## Cookies

When the extension looks up a channel page, your browser attaches youtube.com's own cookies to that request, exactly as if you had opened the page yourself. That is what lets a browser that has accepted YouTube's cookie prompt get the page. The extension never reads, stores or passes on the cookie values, and it does not use the browser's cookie permission. Feed requests are sent without cookies.

## Sharing and selling data

The extension does not sell, transfer or share any data with third parties, does not use data for anything other than its single purpose (grouping your YouTube channels and showing their latest videos), and does not use data for advertising, profiling, creditworthiness or lending.

## Your control

You can edit or remove categories and channels on the Manage page at any time, export your setup to a file, and delete everything by removing the extension.

## Contact and changes

Questions or concerns: open an issue at <https://github.com/Project0B/YT-Channels/issues>. If this policy changes, the new version and its date will appear here.
