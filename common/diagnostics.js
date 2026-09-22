/*
 * diagnostics.js — turns what a Load observed into console lines.
 *
 * Loaded twice on purpose: as a background script, where a Load is run and
 * failures are logged as they happen, and by the Feed page, which logs the
 * finished report to its own console. The Feed page's console is a keypress
 * away (F12 on the extension's tab) while the background one needs
 * about:debugging → Inspect, so the whole story of the last Load is printed
 * where it is easiest to read, and copied from there into a bug report.
 *
 * Formatting lives here, in one place, so the two consoles can never drift
 * apart. Nothing here touches the DOM or any browser API: a Chrome service
 * worker has neither.
 */

const LOG_PREFIX = "[YT Channels]";

function formatSeconds(ms) {
  return ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}

// What YouTube did, in the words a person can act on. The `kind` comes from
// rss.js: "http" (it answered with a bad status), "parse" (it answered 200 with
// something that is not a feed — an error page or a cut-off download) or
// "network" (it did not answer at all), where the message separates a timeout
// from a dead connection and is worth keeping.
function describeFeedFailure({ kind, httpStatus, error }) {
  if (kind === "http") return `HTTP ${httpStatus}`;
  if (kind === "parse") return "not a readable feed";
  return `no answer (${error})`;
}

// "HTTP 500 ×38, not a readable feed ×3", commonest first: the one line that
// says whether a bad Load was YouTube glitching, the connection dropping or the
// feed format changing.
function summarizeFailures(failures) {
  const counts = new Map();
  for (const failure of failures) {
    const phrase = failure.kind === "network" ? "no answer" : describeFeedFailure(failure);
    counts.set(phrase, (counts.get(phrase) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([phrase, count]) => `${phrase} ×${count}`)
    .join(", ");
}

/**
 * The console lines for a finished Load. Returns nothing when every Channel
 * answered: a healthy Load leaves no trace in either console.
 * @param {LoadReport} report
 * @returns {string[]}
 */
function formatLoadReport(report) {
  const { failures = [] } = report;
  if (failures.length === 0) return [];

  const recovered = failures.filter((f) => f.recovered);
  const stillFailing = failures.filter((f) => !f.recovered && f.triedAgain);
  // Queued for a retry the budget never got to. Saying so matters: it is the
  // difference between "YouTube would not answer" and "this Load gave up".
  const neverReached = failures.filter((f) => !f.recovered && !f.triedAgain && f.retryable);

  const lines = [
    `${LOG_PREFIX} Load "${report.categoryLabel}" finished in ${formatSeconds(report.elapsedMs)} —` +
      ` ${report.channelCount} channels, ${report.fetchedCount} fetched, ${report.concurrency} at a time`,
    `${LOG_PREFIX}   ${failures.length} failed to update: ${summarizeFailures(failures)}`,
  ];

  // A channel with no long-form feed costs two requests every time, so the
  // burst YouTube sees is bigger than the channel count. Worth stating plainly
  // when a Load has gone badly, because it is the size of that burst that
  // decides how much of it comes back broken.
  if (report.requestCount > report.fetchedCount) {
    lines.push(
      `${LOG_PREFIX}   ${report.requestCount} requests for ${report.fetchedCount} channels` +
        ` — ${report.requestCount - report.fetchedCount} of them a second try on the plain feed`
    );
  }

  if (report.retried > 0) {
    const parts = [`${recovered.length} recovered`, `${stillFailing.length} failed again`];
    if (neverReached.length > 0) {
      const budget = report.retryBudgetMs ? `${Math.round(report.retryBudgetMs / 1000)} s ` : "";
      parts.push(`${neverReached.length} never reached before the ${budget}retry budget ran out`);
    }
    lines.push(`${LOG_PREFIX}   ${report.retried} queued for a retry, one at a time: ${parts.join(", ")}`);
  }

  // Why the rest were left alone. Both reasons are ordinary, and saying which
  // one applies is the difference between "YouTube is glitching" and "this
  // browser is offline".
  const notTried = failures.filter((f) => !f.recovered && !f.retryable);
  if (notTried.length > 0) {
    const stopgaps = notTried.filter((f) => f.servedStopgap).length;
    const noAnswer = notTried.length - stopgaps;
    const reasons = [];
    // The count is repeated per reason only when there is more than one, so a
    // single reason does not read "1 not tried again: 1 …".
    const count = (n) => (stopgaps > 0 && noAnswer > 0 ? `${n} ` : "");
    if (stopgaps > 0) reasons.push(`${count(stopgaps)}served a one-off list from the plain feed`);
    if (noAnswer > 0) reasons.push(`${count(noAnswer)}got no answer at all, so the connection is down`);
    lines.push(`${LOG_PREFIX}   ${notTried.length} not tried again: ${reasons.join(", ")}`);
  }

  for (const failure of failures) {
    lines.push(`${LOG_PREFIX}   ${formatFailureLine(failure)}`);
  }
  return lines;
}

/**
 * One Channel's failure: who, which feed, what happened, how long it took, and
 * what became of it, which is one of: recovered on retry, served a one-off list,
 * failed again on the retry, never retried because the budget ran out, or not
 * retried at all. The count of lines that are not "recovered on retry" is
 * exactly the number the Feed page's banner shows.
 * @param {ChannelFailure} failure
 * @returns {string}
 */
function formatFailureLine(failure) {
  const outcome = failure.recovered
    ? "recovered on retry"
    : failure.servedStopgap
      ? "served a one-off list from the plain feed, not cached"
      : failure.triedAgain
        ? "failed again on the retry"
        : failure.retryable
          ? "never retried, the budget ran out first"
          : "not retried";
  return (
    `${failure.name} (${failure.channelId}) — ${failure.feed} feed,` +
    ` ${describeFeedFailure(failure)} after ${formatSeconds(failure.ms)} — ${outcome}` +
    (failure.hadLastGood ? ", kept its last good list" : ", no cached videos to fall back on")
  );
}

const Diagnostics = {
  LOG_PREFIX,
  describeFeedFailure,
  formatFailureLine,
  formatLoadReport,
};
