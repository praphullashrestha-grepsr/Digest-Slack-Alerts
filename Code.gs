/**
 * Grepsr daily digest monitor for Gmail and Slack.
 *
 * Once a day, at or after 10:30 (see CONFIG.alertHour / alertMinute, in
 * CONFIG.reportTimezone), the script reads every digest received in the last
 * 24 hours (from yesterday's alert time until now) and posts a single Slack
 * alert. A digest is included when it contains an
 * explicit flag: an alert section above zero, a comment such as COUNT_ALERT or
 * FILL_RATE_ALERT, or a report still running. The optional seven day trend
 * check (CONFIG.trendCheckEnabled) is off by default.
 *
 * Alerts are posted through the Slack Web API (chat.postMessage) with a bot
 * token, so each run produces ONE main message (a board grouped by urgency,
 * one line per project), with each project's details posted as a short,
 * plain-language reply in its thread. Slack incoming webhooks cannot thread,
 * so they are not used for this path.
 */

const CONFIG = Object.freeze({
  // Daily, weekly and monthly digests. The subject can read "Alerts for X this day",
  // "1 Failed, 2 Data Alerts for X this day", "1 Failed for X this week" and so on, so
  // only the "for <project> this <period>" part is relied on. The exact filtering
  // is done again in code. newer_than is wide on purpose, see windowHours.
  currentGmailQuery: 'from:noreply@grepsr.com (subject:"this day" OR subject:"this week" OR subject:"this month") newer_than:2d',
  reportTimezone: 'Asia/Kathmandu',
  // The seven day trend check is switched off. The digest already flags
  // count and fill rate changes itself (its COUNT and FILL RATE comments), so
  // this only added alerts for smaller changes the digest treated as normal.
  // Set to true to bring it back for a tailored setup. The hourly sheet
  // refresh below only exists to feed it, so setupMonitoring creates that
  // trigger only when this is true.
  trendCheckEnabled: false,
  historyDays: 7,
  minimumHistoryPoints: 3,
  countDropPercent: 10,
  fillRateDropPoints: 5,
  maximumThreads: 500,
  maximumSlackCharacters: 35000,
  webhookProperty: 'SLACK_WEBHOOK_URL',
  botTokenProperty: 'SLACK_BOT_TOKEN',
  channelProperty: 'SLACK_CHANNEL_ID',
  slackReplyDelayMs: 1100,
  bigDropPercent: 30,
  minimumUsualForRed: 20,
  maximumReportLines: 6,
  maximumGroupNames: 8,
  maximumProjectLines: 25,
  maximumProcessingNames: 4,
  slackSectionLimit: 2900,
  lastAlertProperty: 'LAST_ALERT_STATE',
  // The earliest time the daily alert may post, in reportTimezone. Apps Script
  // daily triggers only promise a rough window and can fire early, so the
  // trigger runs every alertCheckEveryMinutes (1, 5, 10, 15 or 30) and the
  // script itself refuses to post before this time. The alert posts on the
  // first check at or after it, so between 10:30 and about 10:40 by default.
  alertHour: 10,
  alertMinute: 30,
  alertCheckEveryMinutes: 10,
  // How far back each run looks, counted back from today's alert time (not from
  // the moment the script happens to run), so consecutive days leave no gap.
  // With the alert at 10:30 the window runs from 10:30 yesterday until now.
  windowHours: 24,
  // Digest sections the script reads but deliberately ignores everywhere:
  // no alert, no thread line, no daily summary total. Remove a key from this
  // list to start reporting that section again.
  ignoredSections: ['crawlerAnomalies', 'profilerAnomalies', 'missedRuns'],
  // Report links longer than this are shown as plain names. The digest email
  // only contains click tracking links of about 500 characters each, which
  // would fill the message and get cut off. Short direct links still work.
  maximumLinkLength: 300,
  // Projects to skip completely for now, written exactly as the project name
  // appears in the alert (capitals do not matter). Their digests are left out
  // of the alert, the daily summary and the sheet. Remove a name to start
  // watching that project again.
  ignoredProjects: [],
  // When a project sent more than one digest today, alert on its latest one
  // only, so the same project does not appear twice. Set to false to include
  // every digest.
  onlyLatestDigestPerProject: true,
  dailySheetPrefix: 'Digest Summary - '
});

const SUMMARY_HEADERS = Object.freeze([
  'Email Received At',
  'Digest Project',
  'Project',
  'Report',
  'Report URL',
  'Current Count',
  'Email Average Count',
  'Count Diff %',
  'Current Fill Rate',
  'Email Average Fill Rate',
  'Fill Rate Diff %',
  'Critical Errors',
  'Last Updated',
  'Comment',
  'Processing',
  'Gmail Unread',
  'Digest Status',
  'Alert Summary',
  'Slack Alert Required',
  'Message ID'
]);

/**
 * Every section the digest email can contain. The parser needs the whole
 * list to find where each section starts and ends, even the ignored ones.
 */
const DIGEST_SECTIONS = Object.freeze([
  {
    key: 'dataAlerts',
    label: 'Data alerts',
    pattern: 'Data Alert(?:\\(s\\)|s)?',
    htmlPattern: 'Data(?:\\s|&nbsp;|<[^>]+>)+Alert'
  },
  {
    key: 'failedRuns',
    label: 'Failed runs',
    pattern: 'Failed Run(?:\\(s\\)|s)?',
    htmlPattern: 'Failed(?:\\s|&nbsp;|<[^>]+>)+Run',
    columns: ['project', 'report', 'runStarted', 'runEnded', 'status', 'recordCount']
  },
  {
    key: 'missedRuns',
    label: 'Missed runs',
    pattern: 'Missed Run(?:\\(s\\)|s)?',
    htmlPattern: 'Missed(?:\\s|&nbsp;|<[^>]+>)+Run',
    columns: ['project', 'report', 'scheduledTime', 'runStarted']
  },
  {
    key: 'longRunning',
    label: 'Long-running crawlers',
    pattern: 'Long Running Crawler(?:\\(s\\)|s)?',
    htmlPattern: 'Long(?:\\s|&nbsp;|<[^>]+>)+Running(?:\\s|&nbsp;|<[^>]+>)+Crawler',
    columns: ['project', 'report', 'runStarted', 'runEnded', 'threshold', 'runTimeDiff']
  },
  {
    key: 'dataValidation',
    label: 'Data validation',
    pattern: 'Data Validation',
    htmlPattern: 'Data(?:\\s|&nbsp;|<[^>]+>)+Validation',
    columns: ['project', 'report', 'runStarted', 'runEnded', 'status']
  },
  {
    key: 'failedTasks',
    label: 'Failed tasks',
    pattern: 'Failed Task(?:\\(s\\)|s)?',
    htmlPattern: 'Failed(?:\\s|&nbsp;|<[^>]+>)+Task',
    columns: ['project', 'report', 'runStarted', 'runEnded', 'failedChildTasks', 'completedChildTasks']
  },
  {
    key: 'crawlerAnomalies',
    label: 'Crawler anomalies',
    pattern: 'Crawler Anomal(?:y|ie)(?:\\(s\\)|s)?',
    htmlPattern: 'Crawler(?:\\s|&nbsp;|<[^>]+>)+Anomal(?:y|ie)',
    columns: ['project', 'report', 'runStarted', 'runEnded', 'contributors']
  },
  {
    key: 'profilerAnomalies',
    label: 'Profiler anomalies',
    pattern: 'Profiler Anomal(?:y|ie)(?:\\(s\\)|s)?',
    htmlPattern: 'Profiler(?:\\s|&nbsp;|<[^>]+>)+Anomal(?:y|ie)',
    columns: ['project', 'report', 'runStarted', 'runEnded', 'contributors']
  }
]);

/**
 * The sections the script actually reports on: everything in DIGEST_SECTIONS
 * except the keys listed in CONFIG.ignoredSections. All alert logic and the
 * daily summary use this list.
 */
const ALERT_SECTIONS = Object.freeze(DIGEST_SECTIONS.filter(function(section) {
  return CONFIG.ignoredSections.indexOf(section.key) === -1;
}));

/**
 * Severity per digest section. Only used when a section shows a count but its
 * detail rows could not be read. 3 = act now, 2 = worth a look.
 */
const ALERT_SECTION_SEVERITY = Object.freeze({
  dataAlerts: 2,
  failedRuns: 3,
  missedRuns: 3,
  dataValidation: 3,
  failedTasks: 3,
  longRunning: 2,
  crawlerAnomalies: 2,
  profilerAnomalies: 2
});

const ALERT_ICONS = Object.freeze({
  3: ':red_circle:',
  2: ':large_orange_circle:',
  1: ':hourglass_flowing_sand:'
});

/**
 * Plain-language problem types. The label finishes the sentence "N reports ...".
 * Severity 3 = act now, 2 = worth a look.
 *
 * The rules are deliberately simple:
 *   Act now: a report with 0 records, a failed run, failed QA rules (the
 *     digest's Data validation section) and a failed child process (the
 *     digest's Failed tasks section).
 *   Worth a look: every count alert and fill rate alert the digest raises,
 *     whatever the size of the change, plus long running crawlers.
 * The far below normal and slightly below normal kinds only change the
 * wording. Both are worth a look.
 */
const ISSUE_KINDS = Object.freeze({
  noData:      { severity: 3, label: 'returned 0 records' },
  runFailed:   { severity: 3, label: 'with a failed run' },
  validation:  { severity: 3, label: 'failed QA rules' },
  failedTasks: { severity: 3, label: 'with a failed child process' },
  missedRun:   { severity: 3, label: 'missed their schedule' },
  emptyFields: { severity: 2, label: 'with 0% fill rate' },
  bigDrop:     { severity: 2, label: 'far below normal' },
  smallDrop:   { severity: 2, label: 'slightly below normal' },
  rise:        { severity: 2, label: 'above normal' },
  lowFill:     { severity: 2, label: 'with low fill rate' },
  slowRun:     { severity: 2, label: 'running long' },
  anomaly:     { severity: 2, label: 'flagged as unusual' }
});

/**
 * Optional. Tag the person responsible for a project in its thread reply.
 * Key is the digest project name exactly as it appears in the alert, value is
 * the Slack member ID (profile > three dots > Copy member ID).
 * Example: 'Defensoria Salud-Defensoria Salud': 'U0123ABCD'
 */
const PROJECT_OWNERS = Object.freeze({
});

/**
 * Creates the triggers this script needs:
 *   1. monitorDigestAlerts: runs every alertCheckEveryMinutes. Nearly every run
 *      exits at once, because the script only posts at or after alertHour:
 *      alertMinute (in reportTimezone) and at most once per day.
 *   2. refreshDigestSheet: a silent hourly refresh of today's sheet tab so
 *      digests that arrive after the alert are still recorded for trends.
 *      Created only when CONFIG.trendCheckEnabled is true.
 * Add SLACK_BOT_TOKEN and SLACK_CHANNEL_ID under Project Settings > Script
 * properties first. Setup posts nothing to Slack; run postAlertThreadNow to
 * test the message. Running setup again replaces any older triggers.
 */
function setupMonitoring() {
  // Throws with a clear message when the bot token or channel ID is missing.
  getSlackBotConfig_();

  // Remove only this script's older triggers (including the old hourly alert)
  // so nothing runs twice.
  ScriptApp.getProjectTriggers()
    .filter(function(trigger) {
      const handler = trigger.getHandlerFunction();

      return handler === 'monitorDigestAlerts' || handler === 'refreshDigestSheet';
    })
    .forEach(function(trigger) {
      ScriptApp.deleteTrigger(trigger);
    });

  ScriptApp.newTrigger('monitorDigestAlerts')
    .timeBased()
    .everyMinutes(CONFIG.alertCheckEveryMinutes)
    .create();

  // The hourly refresh only feeds the trend check, so skip it when that is off.
  if (CONFIG.trendCheckEnabled) {
    ScriptApp.newTrigger('refreshDigestSheet')
      .timeBased()
      .everyHours(1)
      .create();

    refreshDigestSheet();
  }
}

/**
 * Keeps one evaluation per project: the digest received last. A project can
 * send several digests in a day, and the latest shows its current state.
 */
function latestDigestPerProject_(evaluations) {
  if (!CONFIG.onlyLatestDigestPerProject) {
    return evaluations;
  }

  const latest = new Map();

  evaluations.forEach(function(item) {
    const key = normalizeText_(item.digest.projectName).toLowerCase();
    const existing = latest.get(key);

    if (!existing ||
        item.digest.receivedAt.getTime() > existing.digest.receivedAt.getTime()) {
      latest.set(key, item);
    }
  });

  return Array.from(latest.values());
}

/**
 * Reads every digest received today, evaluates it against the sheet history
 * and rebuilds today's sheet tab. Posts nothing.
 */
function buildTodaysEvaluations_(spreadsheet) {
  const digests = loadCurrentDigests_();
  const sheetName = dailySheetName_(new Date());
  const sheetHistory = CONFIG.trendCheckEnabled
    ? loadHistoryFromDailySheets_(spreadsheet, sheetName)
    : [];
  const evaluations = digests.map(function(digest) {
    const history = getPriorHistory_(digest, sheetHistory);

    return {
      digest: digest,
      history: history,
      result: evaluateDigest_(digest, history)
    };
  });

  writeDailySummarySheet_(spreadsheet, sheetName, evaluations);
  orderDailySummarySheets_(spreadsheet);

  return { sheetName: sheetName, evaluations: evaluations };
}

/**
 * Hourly and silent: keeps today's sheet tab current, including digests that
 * arrive after the daily alert. This tab is the history the trend checks use.
 */
function refreshDigestSheet() {
  const snapshot = buildTodaysEvaluations_(getBoundSpreadsheet_());

  console.log('Refreshed %s with %s digest(s).', snapshot.sheetName, snapshot.evaluations.length);
}

/**
 * Reads which channels already received today's alert. The state is stored as
 * {"date": "2026-09-28", "channels": ["C0123ABCD9"]} and starts fresh each day.
 */
function readAlertState_(properties, today) {
  let state = null;

  try {
    state = JSON.parse(properties.getProperty(CONFIG.lastAlertProperty) || 'null');
  } catch (error) {
    state = null;
  }

  if (!state || state.date !== today || !Array.isArray(state.channels)) {
    return { date: today, channels: [], done: false };
  }

  state.done = state.done === true;

  return state;
}

/**
 * True once the local time in reportTimezone is at or after the configured
 * alert time. The check is made by the script, not by the trigger schedule.
 */
function isAlertTimeReached_(now) {
  const hour = parseInt(Utilities.formatDate(now, CONFIG.reportTimezone, 'H'), 10);
  const minute = parseInt(Utilities.formatDate(now, CONFIG.reportTimezone, 'm'), 10);

  return hour * 60 + minute >= CONFIG.alertHour * 60 + CONFIG.alertMinute;
}

/**
 * Posts the alert to each channel: its own main message and its own threads.
 * A channel counts as posted once its main message is up. Failures are
 * collected, so one broken channel never stops the others.
 */
function postAlertToChannels_(slack, channels, models, sheetUrl) {
  const result = { posted: [], errors: [] };

  channels.forEach(function(channel) {
    try {
      const outcome = postAlertThread_(
        { token: slack.token, channel: channel },
        models,
        sheetUrl
      );

      result.posted.push(channel);
      outcome.errors.forEach(function(message) {
        result.errors.push(channel + ' thread reply: ' + message);
      });
    } catch (error) {
      result.errors.push(channel + ': ' + error.message);
    }
  });

  return result;
}

/**
 * The daily alert. Runs on a frequent trigger but does nothing before
 * alertHour:alertMinute. From then on it covers every digest received so far
 * today and posts to every channel in SLACK_CHANNEL_ID at most once per day.
 * A channel that failed is tried again on the next run without repeating the
 * ones that worked. If nothing needs attention it posts nothing and does not
 * look again that day. To post by hand at any time, run postAlertThreadNow.
 */
function monitorDigestAlerts() {
  const properties = PropertiesService.getScriptProperties();
  const now = new Date();

  if (!isAlertTimeReached_(now)) {
    console.log('Before %s:%s in %s. Nothing to do yet.',
      CONFIG.alertHour, ('0' + CONFIG.alertMinute).slice(-2), CONFIG.reportTimezone);
    return;
  }

  const slack = getSlackBotConfig_();
  const today = Utilities.formatDate(now, CONFIG.reportTimezone, 'yyyy-MM-dd');
  const state = readAlertState_(properties, today);
  const pendingChannels = slack.channels.filter(function(channel) {
    return state.channels.indexOf(channel) === -1;
  });

  if (state.done || pendingChannels.length === 0) {
    console.log('Already handled the alert for %s. Skipping.', today);
    return;
  }

  const spreadsheet = getBoundSpreadsheet_();
  const snapshot = buildTodaysEvaluations_(spreadsheet);
  const alertingEvaluations = latestDigestPerProject_(snapshot.evaluations)
    .filter(function(item) {
      return item.result.shouldAlert;
    });

  if (alertingEvaluations.length === 0) {
    state.done = true;
    properties.setProperty(CONFIG.lastAlertProperty, JSON.stringify(state));
    console.log('Checked %s digest(s). Nothing needs attention, so no alert was posted.',
      snapshot.evaluations.length);
    return;
  }

  const models = alertingEvaluations
    .map(function(item) {
      return buildProjectAlertModel_(item);
    })
    .sort(compareAlertModels_);

  const outcome = postAlertToChannels_(
    slack,
    pendingChannels,
    models,
    alertSheetUrl_(spreadsheet, snapshot.sheetName)
  );

  if (outcome.posted.length > 0) {
    outcome.posted.forEach(function(channel) {
      state.channels.push(channel);
    });

    properties.setProperty(CONFIG.lastAlertProperty, JSON.stringify(state));
  }

  console.log('Checked %s digest(s). Posted the alert for %s project(s) to %s channel(s); %s problem(s).',
    snapshot.evaluations.length,
    models.length,
    outcome.posted.length,
    outcome.errors.length
  );

  if (outcome.errors.length > 0) {
    throw new Error('Some alert posts failed: ' + outcome.errors.join(' | '));
  }
}

/**
 * True when the project is listed in CONFIG.ignoredProjects.
 */
function isIgnoredProject_(projectName) {
  const name = normalizeText_(projectName)
    .replace(/\s+\((?:weekly|monthly)\)$/i, '')
    .toLowerCase();

  return CONFIG.ignoredProjects.some(function(ignored) {
    return normalizeText_(ignored).toLowerCase() === name;
  });
}

/**
 * Loads only digest messages received within the exact rolling 24-hour window.
 */
function loadCurrentDigests_() {
  const runStartedAt = new Date();
  const windowStart = digestWindowStart_(runStartedAt);
  const now = runStartedAt.getTime();

  return getDigestMessages_(CONFIG.currentGmailQuery, windowStart, now)
    .map(parseDigestMessage_)
    .filter(function(digest) {
      return digest !== null && !isIgnoredProject_(digest.projectName);
    })
    .sort(function(a, b) {
      return a.receivedAt.getTime() - b.receivedAt.getTime();
    });
}

/**
 * Start of the digest window in milliseconds: today's alert time (alertHour:
 * alertMinute in reportTimezone) minus windowHours. Anchoring to the alert time
 * instead of "now" means a run at 10:34 today and one at 10:41 tomorrow still
 * join up with no gap between them.
 */
function digestWindowStart_(now) {
  const dayStart = startOfToday_(now, CONFIG.reportTimezone).getTime();
  const alertTime = dayStart + (CONFIG.alertHour * 60 + CONFIG.alertMinute) * 60 * 1000;

  return alertTime - CONFIG.windowHours * 60 * 60 * 1000;
}

/**
 * Calculates midnight for the configured timezone without relying on the
 * Apps Script project's timezone setting.
 */
function startOfToday_(now, timezone) {
  const localDate = Utilities.formatDate(now, timezone, 'yyyy-MM-dd');
  const utcMidnightGuess = Date.parse(localDate + 'T00:00:00Z');
  const firstOffset = timezoneOffsetMinutes_(
    Utilities.formatDate(new Date(utcMidnightGuess), timezone, 'Z')
  );
  let localMidnight = new Date(utcMidnightGuess - firstOffset * 60 * 1000);
  const correctedOffset = timezoneOffsetMinutes_(
    Utilities.formatDate(localMidnight, timezone, 'Z')
  );

  // Recalculate once when a daylight-saving transition changes the offset.
  if (correctedOffset !== firstOffset) {
    localMidnight = new Date(utcMidnightGuess - correctedOffset * 60 * 1000);
  }

  return localMidnight;
}

/**
 * Converts an RFC 822 timezone offset such as +0545 into signed minutes.
 */
function timezoneOffsetMinutes_(offsetText) {
  const match = String(offsetText).match(/^([+-])(\d{2})(\d{2})$/);

  if (!match) {
    throw new Error('Unable to calculate timezone offset for ' + CONFIG.reportTimezone + '.');
  }

  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

/**
 * Accepts only messages from local midnight through the current run time.
 */
function isWithinCurrentWindow_(receivedAt, windowStart, now) {
  const receivedTime = receivedAt.getTime();

  return receivedTime >= windowStart && receivedTime <= now;
}

/**
 * Loads matching Gmail messages in batches so multiple projects are supported.
 */
function getDigestMessages_(gmailQuery, windowStart, now) {
  const messages = [];
  const batchSize = 100;

  for (let start = 0; start < CONFIG.maximumThreads; start += batchSize) {
    const threads = GmailApp.search(gmailQuery, start, batchSize);

    threads.forEach(function(thread) {
      thread.getMessages().forEach(function(message) {
        // Check the timestamp before reading the subject or body of the email.
        if (!isWithinCurrentWindow_(message.getDate(), windowStart, now)) {
          return;
        }

        const isDigestSender = /noreply@grepsr\.com/i.test(message.getFrom());
        const isDigestSubject = parseDigestSubject_(message.getSubject()) !== null;

        // Gmail returns every message in a matching thread so filter each one.
        if (isDigestSender && isDigestSubject) {
          messages.push(message);
        }
      });
    });

    if (threads.length < batchSize) {
      break;
    }
  }

  return messages;
}

/**
 * True when records came back but the fill rate is 0% today and its usual
 * fill rate is also 0%. That pattern means the report holds JSON data, where
 * fill rate does not apply, so a 0% fill rate is normal for it.
 */
function isFillRateNotApplicable_(row) {
  return Number(row.currentCount) > 0 &&
    Number(row.currentFillRate) === 0 &&
    Number(row.displayedAverageFillRate) === 0;
}

/**
 * True when the digest flagged a report only for its fill rate and fill rate
 * does not apply to it. Such a flag is ignored everywhere.
 */
function isIgnorableFillFlag_(row) {
  const comment = String(row.comment || '').toUpperCase();

  return isFillRateNotApplicable_(row) &&
    comment.indexOf('FILL') !== -1 &&
    comment.indexOf('COUNT') === -1;
}

/**
 * The digest's "Data alerts" count includes the fill rate flags we ignore, so
 * take them off. Without this a digest whose only flag is an ignored JSON
 * report would still look like it has a data alert.
 */
function adjustSectionCountsForJsonReports_(sectionCounts, rows) {
  const ignored = rows.filter(function(row) {
    return !row.isProcessing && isIgnorableFillFlag_(row);
  }).length;
  const adjusted = Object.assign({}, sectionCounts);

  if (ignored > 0 && adjusted.dataAlerts !== undefined) {
    adjusted.dataAlerts = Math.max(0, adjusted.dataAlerts - ignored);
  }

  return adjusted;
}

/**
 * Converts a Gmail message into metrics and named alert-section counts.
 */
function parseDigestMessage_(message) {
  const plainText = normalizeText_(message.getPlainBody());
  const html = message.getBody();
  const rows = parseMetricRows_(html);
  const projectName = extractProjectName_(plainText, message.getSubject());
  const sectionCounts = adjustSectionCountsForJsonReports_(
    extractSectionCounts_(plainText),
    rows
  );

  if (!projectName || rows.length === 0) {
    console.log('Skipped unrecognized digest: %s', message.getSubject());
    return null;
  }

  return {
    messageId: message.getId(),
    threadId: message.getThread().getId(),
    subject: message.getSubject(),
    receivedAt: message.getDate(),
    isUnread: message.isUnread(),
    projectName: projectName,
    sectionCounts: sectionCounts,
    alertDetails: parseAlertDetails_(html, sectionCounts),
    rows: rows
  };
}

/**
 * Extracts report rows from the HTML table containing count and fill-rate data.
 */
function parseMetricRows_(html) {
  // Scan rows directly because email templates commonly contain nested tables.
  const rowHtmlList = html.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  const yellowClassNames = extractYellowClassNames_(html);

  return rowHtmlList.map(function(rowHtml) {
    const cells = extractCells_(rowHtml);

    if (cells.length < 10 || !/^\d+$/.test(cells[0].text)) {
      return null;
    }

    const countPair = parsePair_(cells[3].text);
    const fillRatePair = parsePair_(cells[5].text);

    if (!countPair || !fillRatePair) {
      return null;
    }

    return {
      project: cells[1].text,
      report: cells[2].text,
      reportUrl: cells[2].href,
      currentCount: countPair.current,
      displayedAverageCount: countPair.average,
      displayedCountDiff: parseNumber_(cells[4].text),
      currentFillRate: fillRatePair.current,
      displayedAverageFillRate: fillRatePair.average,
      displayedFillRateDiff: parseNumber_(cells[6].text),
      criticalErrors: parseNumber_(cells[7].text) || 0,
      lastUpdated: cells[8].text,
      comment: cells[9].text,
      isProcessing: isProcessingRow_(
        rowHtml,
        cells,
        countPair,
        fillRatePair,
        yellowClassNames
      )
    };
  }).filter(function(row) {
    return row !== null;
  });
}

/**
 * Extracts detailed rows from every active secondary alert section.
 */
function parseAlertDetails_(html, sectionCounts) {
  const sectionLocations = locateAlertSections_(html);

  return ALERT_SECTIONS.reduce(function(details, section) {
    if (section.key === 'dataAlerts' ||
        sectionCounts[section.key] === 0 ||
        !section.columns ||
        sectionLocations[section.key] === undefined) {
      details[section.key] = [];
      return details;
    }

    const start = sectionLocations[section.key];
    const laterStarts = Object.keys(sectionLocations)
      .map(function(key) {
        return sectionLocations[key];
      })
      .filter(function(location) {
        return location > start;
      });
    const end = laterStarts.length > 0 ? Math.min.apply(null, laterStarts) : html.length;
    const sectionHtml = html.slice(start, end);
    details[section.key] = parseSectionRows_(sectionHtml, section);
    return details;
  }, {});
}

/**
 * Finds the first HTML position of every named alert-section heading.
 */
function locateAlertSections_(html) {
  return DIGEST_SECTIONS.reduce(function(locations, section) {
    const match = new RegExp(section.htmlPattern, 'i').exec(html);

    if (match) {
      locations[section.key] = match.index;
    }

    return locations;
  }, {});
}

/**
 * Converts a secondary alert table into consistently named detail objects.
 */
function parseSectionRows_(sectionHtml, section) {
  const rowHtmlList = sectionHtml.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];

  return rowHtmlList.map(function(rowHtml) {
    const cells = extractCells_(rowHtml);

    if (cells.length < 3 || !/^\d+$/.test(cells[0].text)) {
      return null;
    }

    const detail = {
      sectionKey: section.key,
      reportUrl: ''
    };

    section.columns.forEach(function(column, index) {
      const cell = cells[index + 1];

      if (cell) {
        detail[column] = cell.text;

        if (column === 'report') {
          detail.reportUrl = cell.href;
        }
      }
    });

    return detail.report ? detail : null;
  }).filter(function(detail) {
    return detail !== null;
  });
}

/**
 * Detects an in-progress row from yellow styling or its blank zero-state fields.
 */
function isProcessingRow_(rowHtml, cells, countPair, fillRatePair, yellowClassNames) {
  const hasBlankZeroState = countPair.current === 0 &&
    countPair.average === 0 &&
    fillRatePair.current === 0 &&
    fillRatePair.average === 0 &&
    cells[8].text === '' &&
    cells[9].text === '';

  return hasYellowHighlight_(rowHtml) ||
    hasYellowCssClass_(rowHtml, yellowClassNames) ||
    hasBlankZeroState;
}

/**
 * Finds CSS classes whose stylesheet rule applies a yellow background.
 */
function extractYellowClassNames_(html) {
  const classNames = new Set();
  const rulePattern = /([^{}]+)\{([^{}]+)\}/g;
  let ruleMatch;

  while ((ruleMatch = rulePattern.exec(html)) !== null) {
    if (!hasYellowHighlight_(ruleMatch[2])) {
      continue;
    }

    const classPattern = /\.([a-z0-9_-]+)/gi;
    let classMatch;

    while ((classMatch = classPattern.exec(ruleMatch[1])) !== null) {
      classNames.add(classMatch[1].toLowerCase());
    }
  }

  return classNames;
}

/**
 * Checks row and cell class attributes against yellow stylesheet classes.
 */
function hasYellowCssClass_(rowHtml, yellowClassNames) {
  if (!yellowClassNames || yellowClassNames.size === 0) {
    return false;
  }

  const classPattern = /class\s*=\s*["']([^"']+)["']/gi;
  let classMatch;

  while ((classMatch = classPattern.exec(rowHtml)) !== null) {
    const rowClasses = classMatch[1].split(/\s+/);

    if (rowClasses.some(function(className) {
      return yellowClassNames.has(className.toLowerCase());
    })) {
      return true;
    }
  }

  return false;
}

/**
 * Recognizes common yellow inline CSS and bgcolor values used by HTML email.
 */
function hasYellowHighlight_(html) {
  const colorPattern = /(?:background(?:-color)?\s*:\s*|bgcolor\s*=\s*["']?)(#[0-9a-f]{3,8}|rgba?\([^)]*\)|[a-z]+)/gi;
  let match;

  while ((match = colorPattern.exec(html)) !== null) {
    if (isYellowColor_(match[1])) {
      return true;
    }
  }

  return false;
}

/**
 * Classifies named hex and RGB colors while excluding white and neutral gray.
 */
function isYellowColor_(color) {
  const value = String(color || '').toLowerCase().trim();

  if (/^(yellow|lightyellow|gold|khaki|lemonchiffon)$/.test(value)) {
    return true;
  }

  if (value.charAt(0) === '#') {
    let hex = value.slice(1);

    if (hex.length === 3 || hex.length === 4) {
      hex = hex.slice(0, 3).split('').map(function(character) {
        return character + character;
      }).join('');
    } else {
      hex = hex.slice(0, 6);
    }

    if (/^[0-9a-f]{6}$/.test(hex)) {
      return isYellowRgb_(
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16)
      );
    }
  }

  const rgbMatch = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  return rgbMatch ? isYellowRgb_(
    Number(rgbMatch[1]),
    Number(rgbMatch[2]),
    Number(rgbMatch[3])
  ) : false;
}

/**
 * Treats warm pale backgrounds as yellow only when blue is clearly lower.
 */
function isYellowRgb_(red, green, blue) {
  return red >= 220 &&
    green >= 185 &&
    blue <= 235 &&
    red - blue >= 20 &&
    green - blue >= 10;
}

/**
 * Extracts visible text and the first link from every table cell.
 */
function extractCells_(rowHtml) {
  const cellHtmlList = rowHtml.match(/<(?:td|th)\b[\s\S]*?<\/(?:td|th)>/gi) || [];

  return cellHtmlList.map(function(cellHtml) {
    const hrefMatch = cellHtml.match(/<a\b[^>]*href=["']([^"']+)["']/i);

    return {
      text: normalizeText_(htmlToText_(cellHtml)),
      href: hrefMatch ? decodeHtml_(hrefMatch[1]) : ''
    };
  });
}

/**
 * Reads every named section count from the digest's plain-text body.
 */
function extractSectionCounts_(plainText) {
  return ALERT_SECTIONS.reduce(function(counts, section) {
    const match = plainText.match(new RegExp('(\\d+)\\s+' + section.pattern, 'i'));
    counts[section.key] = match ? Number(match[1]) : 0;
    return counts;
  }, {});
}

/**
 * Labels added to the project name of weekly and monthly digests, so they stay
 * separate from the same project's daily digest in the sheet and in the alert.
 */
const PERIOD_LABELS = Object.freeze({ day: '', week: ' (weekly)', month: ' (monthly)' });

/**
 * Reads the project and the period from a digest subject. Handles
 * "Alerts for X this day", "1 Failed, 2 Data Alerts for X this day",
 * "1 Failed for X this week" and "... for X this month". Returns null when the
 * subject is not a digest subject.
 */
function parseDigestSubject_(subject) {
  const match = String(subject || '').match(/\bfor\s+(.+?)\s+this\s+(day|week|month)\b/i);

  return match ? { name: match[1].trim(), period: match[2].toLowerCase() } : null;
}

/**
 * Finds the customer or project name from the digest heading.
 */
function extractProjectName_(plainText, subject) {
  const parsed = parseDigestSubject_(subject);

  if (parsed) {
    return parsed.name + PERIOD_LABELS[parsed.period];
  }

  // Use the body heading only as a fallback for an unexpected subject format.
  const bodyMatch = plainText.match(/(Daily|Weekly|Monthly)\s+Summary Report for\s+(.+?)\s*\(\d+\)/i);

  if (!bodyMatch) {
    return '';
  }

  const period = { daily: 'day', weekly: 'week', monthly: 'month' }[bodyMatch[1].toLowerCase()];

  return bodyMatch[2].trim() + PERIOD_LABELS[period];
}

/**
 * Selects only earlier digests within seven days of the current email.
 */
function getPriorHistory_(currentDigest, allDigests) {
  const historyStart = currentDigest.receivedAt.getTime() -
    CONFIG.historyDays * 24 * 60 * 60 * 1000;

  return allDigests.filter(function(digest) {
    const receivedAt = digest.receivedAt.getTime();
    return digest.projectName === currentDigest.projectName &&
      receivedAt < currentDigest.receivedAt.getTime() &&
      receivedAt >= historyStart;
  });
}

/**
 * Returns the spreadsheet that owns this bound Apps Script project.
 */
function getBoundSpreadsheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

  if (!spreadsheet) {
    throw new Error('Attach this Apps Script project to the destination Google Sheet.');
  }

  return spreadsheet;
}

/**
 * Builds the daily tab name using the spreadsheet timezone.
 */
function dailySheetName_(date) {
  const dateKey = Utilities.formatDate(
    date,
    CONFIG.reportTimezone,
    'yyyy-MM-dd'
  );

  return CONFIG.dailySheetPrefix + dateKey;
}

/**
 * Reads prior dated summary tabs instead of accessing older Gmail messages.
 */
function loadHistoryFromDailySheets_(spreadsheet, currentSheetName) {
  const cutoffDate = new Date(
    Date.now() - (CONFIG.historyDays + 1) * 24 * 60 * 60 * 1000
  );
  const cutoffKey = Utilities.formatDate(
    cutoffDate,
    CONFIG.reportTimezone,
    'yyyy-MM-dd'
  );
  const digestsById = new Map();

  spreadsheet.getSheets().forEach(function(sheet) {
    const dateKey = dailySheetDateKey_(sheet.getName());

    if (!dateKey || dateKey < cutoffKey || sheet.getName() === currentSheetName) {
      return;
    }

    readHistoryDigestsFromSheet_(sheet).forEach(function(digest) {
      // The rolling window may place one message on two tabs so deduplicate it.
      digestsById.set(digest.messageId, digest);
    });
  });

  return Array.from(digestsById.values()).sort(function(a, b) {
    return a.receivedAt.getTime() - b.receivedAt.getTime();
  });
}

/**
 * Extracts the ISO date from a generated summary tab name.
 */
function dailySheetDateKey_(sheetName) {
  if (sheetName.indexOf(CONFIG.dailySheetPrefix) !== 0) {
    return '';
  }

  const dateKey = sheetName.slice(CONFIG.dailySheetPrefix.length);
  return /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? dateKey : '';
}

/**
 * Reconstructs the minimal digest objects required for seven-day comparisons.
 */
function readHistoryDigestsFromSheet_(sheet) {
  if (sheet.getLastRow() < 2 || sheet.getLastColumn() < SUMMARY_HEADERS.length) {
    return [];
  }

  const values = sheet.getDataRange().getValues();
  const headerIndexes = {};

  values[0].forEach(function(header, index) {
    headerIndexes[String(header).trim()] = index;
  });

  const requiredHeaders = [
    'Email Received At',
    'Digest Project',
    'Project',
    'Report',
    'Current Count',
    'Current Fill Rate',
    'Processing',
    'Message ID'
  ];
  const missingHeaders = requiredHeaders.filter(function(header) {
    return headerIndexes[header] === undefined;
  });

  if (missingHeaders.length > 0) {
    console.log('Skipped history sheet %s because columns are missing: %s',
      sheet.getName(),
      missingHeaders.join(', ')
    );
    return [];
  }

  const digestsById = new Map();

  values.slice(1).forEach(function(valuesRow) {
    const messageId = String(valuesRow[headerIndexes['Message ID']] || '').trim();
    const receivedValue = valuesRow[headerIndexes['Email Received At']];
    const receivedAt = receivedValue instanceof Date
      ? receivedValue
      : new Date(receivedValue);

    if (!messageId || isNaN(receivedAt.getTime())) {
      return;
    }

    if (!digestsById.has(messageId)) {
      digestsById.set(messageId, {
        messageId: messageId,
        projectName: String(valuesRow[headerIndexes['Digest Project']] || ''),
        receivedAt: receivedAt,
        rows: []
      });
    }

    digestsById.get(messageId).rows.push({
      project: String(valuesRow[headerIndexes.Project] || ''),
      report: String(valuesRow[headerIndexes.Report] || ''),
      reportUrl: headerIndexes['Report URL'] === undefined
        ? ''
        : String(valuesRow[headerIndexes['Report URL']] || ''),
      currentCount: Number(valuesRow[headerIndexes['Current Count']]) || 0,
      currentFillRate: Number(valuesRow[headerIndexes['Current Fill Rate']]) || 0,
      isProcessing: sheetBoolean_(valuesRow[headerIndexes.Processing])
    });
  });

  return Array.from(digestsById.values());
}

/**
 * Normalizes checkbox values and text booleans read from Google Sheets.
 */
function sheetBoolean_(value) {
  if (value === true) {
    return true;
  }

  return /^(true|yes|1)$/i.test(String(value).trim());
}

/**
 * Creates or rebuilds today's report tab with one row per parsed report.
 */
function writeDailySummarySheet_(spreadsheet, sheetName, evaluations) {
  let sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  if (sheet.getFilter()) {
    sheet.getFilter().remove();
  }

  sheet.clear();

  const rows = buildSummaryRows_(evaluations);
  const output = [SUMMARY_HEADERS.slice()].concat(rows);
  const outputRange = sheet.getRange(1, 1, output.length, SUMMARY_HEADERS.length);

  // Add checkbox validation before writing values so true states are preserved.
  if (rows.length > 0) {
    sheet.getRange(2, 15, rows.length, 1).insertCheckboxes();
    sheet.getRange(2, 16, rows.length, 1).insertCheckboxes();
    sheet.getRange(2, 19, rows.length, 1).insertCheckboxes();
  }

  outputRange.setValues(output);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, SUMMARY_HEADERS.length)
    .setFontWeight('bold')
    .setFontColor('#ffffff')
    .setBackground('#1f4e78');

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sheet.getRange(2, 6, rows.length, 2).setNumberFormat('#,##0.00');
    sheet.getRange(2, 8, rows.length, 1).setNumberFormat('0.00"%"');
    sheet.getRange(2, 9, rows.length, 2).setNumberFormat('0.00');
    sheet.getRange(2, 11, rows.length, 1).setNumberFormat('0.00"%"');
    sheet.getRange(2, 12, rows.length, 1).setNumberFormat('#,##0');
  }

  if (rows.length > 0) {
    outputRange.createFilter();
  }
  sheet.autoResizeColumns(1, SUMMARY_HEADERS.length);
  sheet.setColumnWidth(4, 220);
  sheet.setColumnWidth(5, 260);
  sheet.setColumnWidth(18, 420);
  sheet.setTabColor('#1f4e78');
}

/**
 * Converts evaluated digests into rows sorted by newest received time first.
 */
function buildSummaryRows_(evaluations) {
  const rows = [];

  evaluations.forEach(function(item) {
    item.digest.rows.forEach(function(reportRow) {
      rows.push({
        receivedAt: item.digest.receivedAt,
        values: [
          item.digest.receivedAt,
          item.digest.projectName,
          reportRow.project,
          reportRow.report,
          reportRow.reportUrl,
          reportRow.currentCount,
          reportRow.displayedAverageCount,
          reportRow.displayedCountDiff,
          reportRow.currentFillRate,
          reportRow.displayedAverageFillRate,
          reportRow.displayedFillRateDiff,
          reportRow.criticalErrors,
          reportRow.lastUpdated,
          reportRow.comment,
          reportRow.isProcessing,
          item.digest.isUnread,
          digestStatus_(item.result),
          buildSheetAlertSummary_(item.digest, reportRow, item.result),
          item.result.shouldAlert,
          item.digest.messageId
        ]
      });
    });
  });

  return rows.sort(function(a, b) {
    const dateDifference = b.receivedAt.getTime() - a.receivedAt.getTime();

    if (dateDifference !== 0) {
      return dateDifference;
    }

    return String(a.values[3]).localeCompare(String(b.values[3]));
  }).map(function(item) {
    return item.values;
  });
}

/**
 * Returns a short sheet-friendly status for the evaluated digest.
 */
function digestStatus_(result) {
  if (!result.shouldAlert) {
    return 'Healthy';
  }

  return result.reason === 'trend' ? '7-day trend alert' : 'Current alert';
}

/**
 * Summarizes digest-level and report-level findings in one readable cell.
 */
function buildSheetAlertSummary_(digest, reportRow, result) {
  const parts = [];

  result.activeSections.forEach(function(section) {
    parts.push(section.label + ': ' + digest.sectionCounts[section.key]);
  });

  if (reportRow.isProcessing) {
    parts.push('Still processing');
  }

  if (result.flaggedRows.some(function(row) {
    return reportKey_(row) === reportKey_(reportRow);
  })) {
    parts.push('Comment: ' + reportRow.comment);
  }

  const trendAlert = result.trendAlerts.find(function(alert) {
    return reportKey_(alert.row) === reportKey_(reportRow);
  });

  if (trendAlert) {
    if (trendAlert.countDrop > CONFIG.countDropPercent) {
      parts.push('Count down ' + trendAlert.countDrop.toFixed(2) + '%');
    }

    if (trendAlert.fillRateDrop > CONFIG.fillRateDropPoints) {
      parts.push('Fill rate down ' + trendAlert.fillRateDrop.toFixed(2) + ' points');
    }
  }

  if (result.shouldAlert && parts.length === 0) {
    parts.push('Digest-level alert detected');
  }

  return parts.join(' | ');
}

/**
 * Places generated daily tabs at the front in descending creation-date order.
 */
function orderDailySummarySheets_(spreadsheet) {
  const previouslyActiveSheet = spreadsheet.getActiveSheet();
  const dailySheets = spreadsheet.getSheets()
    .filter(function(sheet) {
      return dailySheetDateKey_(sheet.getName()) !== '';
    })
    .sort(function(a, b) {
      return dailySheetDateKey_(b.getName())
        .localeCompare(dailySheetDateKey_(a.getName()));
    });

  dailySheets.forEach(function(sheet, index) {
    spreadsheet.setActiveSheet(sheet);
    spreadsheet.moveActiveSheet(index + 1);
  });

  if (previouslyActiveSheet) {
    spreadsheet.setActiveSheet(previouslyActiveSheet);
  }
}

/**
 * Prioritizes explicit digest flags and uses seven-day trends only when clean.
 */
function evaluateDigest_(currentDigest, history) {
  const activeSections = ALERT_SECTIONS.filter(function(section) {
    return currentDigest.sectionCounts[section.key] > 0;
  });
  const processingRows = currentDigest.rows.filter(function(row) {
    return row.isProcessing;
  });
  const flaggedRows = currentDigest.rows.filter(function(row) {
    const comment = row.comment.trim().toUpperCase();
    return !row.isProcessing && comment !== '' && comment !== 'OK' && comment !== '-' &&
      !isIgnorableFillFlag_(row);
  });

  if (activeSections.length > 0 || flaggedRows.length > 0 || processingRows.length > 0) {
    return {
      shouldAlert: true,
      reason: 'explicit',
      activeSections: activeSections,
      flaggedRows: flaggedRows,
      processingRows: processingRows,
      alertDetails: currentDigest.alertDetails,
      trendAlerts: []
    };
  }

  const trendAlerts = CONFIG.trendCheckEnabled
    ? compareWithSevenDayHistory_(currentDigest, history)
    : [];

  return {
    shouldAlert: trendAlerts.length > 0,
    reason: 'trend',
    activeSections: [],
    flaggedRows: [],
    processingRows: [],
    alertDetails: {},
    trendAlerts: trendAlerts
  };
}

/**
 * Compares current metrics with one latest observation from each prior day.
 */
function compareWithSevenDayHistory_(currentDigest, history) {
  return currentDigest.rows.reduce(function(alerts, currentRow) {
    // A running row has incomplete values and must not generate a trend alert.
    if (currentRow.isProcessing) {
      return alerts;
    }

    const historicalRows = latestDailyRowsForReport_(currentRow, history);

    if (historicalRows.length < CONFIG.minimumHistoryPoints) {
      return alerts;
    }

    const averageCount = average_(historicalRows.map(function(row) {
      return row.currentCount;
    }));
    const averageFillRate = average_(historicalRows.map(function(row) {
      return row.currentFillRate;
    }));
    const countDrop = averageCount > 0
      ? ((averageCount - currentRow.currentCount) / averageCount) * 100
      : 0;
    const fillRateDrop = averageFillRate - currentRow.currentFillRate;

    if (countDrop > CONFIG.countDropPercent ||
        fillRateDrop > CONFIG.fillRateDropPoints) {
      alerts.push({
        row: currentRow,
        historyPoints: historicalRows.length,
        averageCount: averageCount,
        countDrop: countDrop,
        averageFillRate: averageFillRate,
        fillRateDrop: fillRateDrop
      });
    }

    return alerts;
  }, []);
}

/**
 * Keeps the latest matching report row for each historical calendar day.
 */
function latestDailyRowsForReport_(currentRow, history) {
  const rowsByDay = {};

  history.forEach(function(digest) {
    const matchingRow = digest.rows.find(function(row) {
      return !row.isProcessing && reportKey_(row) === reportKey_(currentRow);
    });

    if (!matchingRow) {
      return;
    }

    const dayKey = Utilities.formatDate(
      digest.receivedAt,
      CONFIG.reportTimezone,
      'yyyy-MM-dd'
    );
    const existing = rowsByDay[dayKey];

    if (!existing || digest.receivedAt.getTime() > existing.receivedAt) {
      rowsByDay[dayKey] = {
        receivedAt: digest.receivedAt.getTime(),
        row: matchingRow
      };
    }
  });

  return Object.keys(rowsByDay).map(function(dayKey) {
    return rowsByDay[dayKey].row;
  });
}

/**
 * Sorts alert models: act now first, then worth a look, then still running.
 */
function compareAlertModels_(a, b) {
  return b.severity - a.severity ||
    String(a.projectName).localeCompare(String(b.projectName));
}

/**
 * Turns one alerting digest into a plain-language model: a merged list of
 * affected reports (one line per report) plus a one-line project summary.
 */
function buildProjectAlertModel_(evaluation) {
  const digest = evaluation.digest;
  const result = evaluation.result;
  const items = buildAlertItems_(digest, result);
  const processing = result.processingRows.map(function(row) {
    return { report: row.report, reportUrl: row.reportUrl };
  });
  // Safety net: the digest shows a section count but no detail could be read.
  const unexplained = items.length === 0 ? result.activeSections : [];
  let severity = items.reduce(function(highest, item) {
    return Math.max(highest, item.severity);
  }, 0);

  unexplained.forEach(function(section) {
    severity = Math.max(severity, ALERT_SECTION_SEVERITY[section.key] || 2);
  });

  if (severity === 0) {
    severity = processing.length > 0 ? 1 : 2;
  }

  let summary = 'flagged in the digest, see the sheet';

  if (items.length > 0) {
    summary = summarizeIssueKinds_(items);
  } else if (unexplained.length > 0) {
    summary = unexplained.map(function(section) {
      return section.label + ' (' + digest.sectionCounts[section.key] + ')';
    }).join(', ') + ', details could not be read, see the sheet';
  } else if (processing.length > 0) {
    summary = processing.slice(0, 3).map(slackReportLink_).join(', ') +
      (processing.length > 3 ? ', +' + (processing.length - 3) + ' more' : '') +
      ' still running';
  }

  return {
    digest: digest,
    projectName: digest.projectName,
    severity: severity,
    items: items,
    processing: processing,
    unexplained: unexplained,
    summary: summary,
    // Projects that are only "still running" get a line in the main message
    // but no thread reply, because there is nothing to explain.
    hasThread: items.length > 0 || unexplained.length > 0 ||
      (processing.length === 0)
  };
}

/**
 * Merges every finding for a digest into one item per report.
 */
function buildAlertItems_(digest, result) {
  const byReport = new Map();

  const add = function(row, description) {
    const report = normalizeText_(row.report);

    if (!report) {
      return;
    }

    const key = report.toLowerCase();
    const existing = byReport.get(key);
    const severity = ISSUE_KINDS[description.kind].severity;

    if (!existing) {
      byReport.set(key, {
        report: report,
        reportUrl: row.reportUrl || '',
        severity: severity,
        kind: description.kind,
        texts: description.text ? [description.text] : []
      });
      return;
    }

    // Already explained by the flagged row, so do not say it twice.
    if (description.redundantIfFlagged) {
      return;
    }

    if (severity > existing.severity) {
      existing.severity = severity;
      existing.kind = description.kind;
    }

    if (!existing.reportUrl && row.reportUrl) {
      existing.reportUrl = row.reportUrl;
    }

    if (description.text && existing.texts.indexOf(description.text) === -1) {
      existing.texts.push(description.text);
    }
  };

  result.flaggedRows.forEach(function(row) {
    add(row, describeFlaggedRow_(row));
  });

  result.trendAlerts.forEach(function(alert) {
    add(alert.row, describeTrendAlert_(alert));
  });

  ALERT_SECTIONS.forEach(function(section) {
    (result.alertDetails[section.key] || []).forEach(function(detail) {
      add(detail, describeSectionDetail_(section.key, detail));
    });
  });

  return Array.from(byReport.values()).sort(function(a, b) {
    return b.severity - a.severity || a.report.localeCompare(b.report);
  });
}

/**
 * Explains a flagged report row in everyday words.
 */
function describeFlaggedRow_(row) {
  const comment = String(row.comment || '').toUpperCase();
  const fillNotApplicable = isFillRateNotApplicable_(row);
  const flagsFill = comment.indexOf('FILL') !== -1 && !fillNotApplicable;
  const flagsCount = comment.indexOf('COUNT') !== -1 || !flagsFill;
  const count = Number(row.currentCount) || 0;
  const usual = Math.round(Number(row.displayedAverageCount) || 0);
  const diff = row.displayedCountDiff;
  const fill = Number(row.currentFillRate) || 0;
  let kind = 'lowFill';

  if (count === 0) {
    kind = 'noData';
  } else if (fill === 0 && !fillNotApplicable) {
    kind = 'emptyFields';
  } else if (flagsCount && diff !== null && diff < 0) {
    // Tiny reports swing a lot in percentage terms, so they stay orange.
    kind = diff <= -CONFIG.bigDropPercent && usual >= CONFIG.minimumUsualForRed
      ? 'bigDrop'
      : 'smallDrop';
  } else if (flagsCount && diff !== null && diff > 0) {
    kind = 'rise';
  }

  const parts = [];

  if (flagsCount || count === 0) {
    let countText = formatNumber_(count) + (count === 1 ? ' record' : ' records') + ' today';

    if (usual > 0) {
      countText += ' vs ~' + formatNumber_(usual) + ' usual';
    }

    if (count > 0 && diff !== null && diff !== 0) {
      countText += ' (' + (diff < 0 ? 'down ' : 'up ') + Math.abs(diff).toFixed(0) + '%)';
    }

    parts.push(countText);
  }

  if (count > 0 && fill === 0 && !fillNotApplicable) {
    parts.push('fill rate 0%');
  } else if (count > 0 && flagsFill && fill < 100) {
    parts.push('fill rate ' + fill.toFixed(0) + '%');
  }

  if (parts.length === 0) {
    parts.push('flagged by the digest');
  }

  return { kind: kind, text: parts.join(', ') };
}

/**
 * Explains a seven-day trend drop in everyday words.
 */
function describeTrendAlert_(alert) {
  const parts = [];
  let kind = 'lowFill';

  if (alert.countDrop > CONFIG.countDropPercent) {
    const usual = Math.round(alert.averageCount);

    parts.push(
      formatNumber_(alert.row.currentCount) + ' records today vs ~' +
      formatNumber_(usual) + ' usual over ' + alert.historyPoints +
      ' days (down ' + alert.countDrop.toFixed(0) + '%)'
    );
    kind = alert.countDrop >= CONFIG.bigDropPercent && usual >= CONFIG.minimumUsualForRed
      ? 'bigDrop'
      : 'smallDrop';
  }

  if (alert.fillRateDrop > CONFIG.fillRateDropPoints) {
    parts.push(
      'fill rate ' + alert.row.currentFillRate.toFixed(0) + '% vs ~' +
      alert.averageFillRate.toFixed(0) + '% usual'
    );
  }

  return { kind: kind, text: parts.join(', ') };
}

/**
 * Explains a row from a secondary alert table (failed runs, validation, ...).
 */
function describeSectionDetail_(sectionKey, detail) {
  const status = normalizeText_(detail.status);
  const isSuccess = /^success/i.test(status);

  if (sectionKey === 'failedRuns') {
    const records = detail.recordCount === undefined ? '' : String(detail.recordCount).trim();
    const recordsText = records === '' ? '' : escapeSlack_(records) + ' records';

    if (isSuccess) {
      return {
        kind: 'runFailed',
        text: 'last run finished but returned ' + (recordsText || 'no records'),
        // A finished run with 0 records is already covered by "0 records today".
        redundantIfFlagged: /^0+(\.0+)?$/.test(records || '0')
      };
    }

    return {
      kind: 'runFailed',
      text: 'last run ended as ' + escapeSlack_(status || 'failed') +
        (recordsText ? ' with ' + recordsText : '')
    };
  }

  if (sectionKey === 'missedRuns') {
    return {
      kind: 'missedRun',
      text: 'did not start on time' +
        (detail.scheduledTime ? ' (was due ' + escapeSlack_(detail.scheduledTime) + ')' : '')
    };
  }

  if (sectionKey === 'longRunning') {
    return {
      kind: 'slowRun',
      text: 'taking longer than usual' +
        (detail.runTimeDiff ? ' (over by ' + escapeSlack_(detail.runTimeDiff) + ')' : '')
    };
  }

  if (sectionKey === 'dataValidation') {
    return {
      kind: 'validation',
      text: /fail/i.test(status) || status === ''
        ? 'QA rules failed'
        : 'QA rules status: ' + escapeSlack_(status)
    };
  }

  if (sectionKey === 'failedTasks') {
    const failedCount = Number(detail.failedChildTasks);

    return {
      kind: 'failedTasks',
      text: Number.isFinite(failedCount) && failedCount > 0
        ? failedCount + (failedCount === 1 ? ' child process' : ' child processes') + ' failed'
        : 'a child process failed'
    };
  }

  if (sectionKey === 'crawlerAnomalies') {
    return { kind: 'anomaly', text: 'crawler output looks unusual' };
  }

  return { kind: 'anomaly', text: 'some fields look unusual compared to normal' };
}

/**
 * One phrase for the main message, such as
 * "6 reports returned 0 records, 1 far below normal".
 */
function summarizeIssueKinds_(items) {
  const counts = {};

  items.forEach(function(item) {
    counts[item.kind] = (counts[item.kind] || 0) + 1;
  });

  const kinds = Object.keys(counts).sort(function(a, b) {
    return ISSUE_KINDS[b].severity - ISSUE_KINDS[a].severity || counts[b] - counts[a];
  });
  const parts = kinds.slice(0, 3).map(function(kind, index) {
    const noun = index === 0 ? alertPlural_(counts[kind], 'report') : String(counts[kind]);
    return noun + ' ' + ISSUE_KINDS[kind].label;
  });
  const hidden = kinds.slice(3).reduce(function(total, kind) {
    return total + counts[kind];
  }, 0);

  if (hidden > 0) {
    parts.push(hidden + ' other');
  }

  return parts.join(', ');
}

/**
 * "1 report", "3 reports".
 */
function alertPlural_(count, word) {
  return count + ' ' + word + (count === 1 ? '' : 's');
}

/**
 * Shortens text to a hard character limit.
 */
function alertTrim_(text, limit) {
  if (text.length <= limit) {
    return text;
  }

  let cut = text.slice(0, limit - 1);

  // Never leave half of a Slack link behind, it renders as broken text.
  if (cut.lastIndexOf('<') > cut.lastIndexOf('>')) {
    cut = cut.slice(0, cut.lastIndexOf('<'));
  }

  return cut.replace(/[,\s]+$/, '') + '…';
}

/**
 * Link to today's tab in the tracking sheet.
 */
function alertSheetUrl_(spreadsheet, sheetName) {
  const sheet = spreadsheet.getSheetByName(sheetName);

  return sheet
    ? spreadsheet.getUrl() + '#gid=' + sheet.getSheetId()
    : spreadsheet.getUrl();
}

/**
 * Groups reports that share the exact same problem text so a project with six
 * identical failures reads as one line instead of six.
 */
function groupAlertItems_(items) {
  const groups = new Map();

  items.forEach(function(item) {
    const text = item.texts.length > 0 ? item.texts.join(', ') : 'needs a look';
    const key = item.severity + '|' + text;

    if (!groups.has(key)) {
      groups.set(key, { severity: item.severity, text: text, items: [] });
    }

    groups.get(key).items.push(item);
  });

  return Array.from(groups.values()).sort(function(a, b) {
    return b.severity - a.severity ||
      b.items.length - a.items.length ||
      a.items[0].report.localeCompare(b.items[0].report);
  });
}

/**
 * One line for a group. A single report leads with its name, a shared problem
 * leads with the problem and lists the report names after it.
 */
function alertGroupLine_(group) {
  const icon = ALERT_ICONS[group.severity];

  if (group.items.length === 1) {
    return icon + ' *' + slackReportLink_(group.items[0]) + '*: ' + group.text;
  }

  const shown = group.items.slice(0, CONFIG.maximumGroupNames);
  let names = shown.map(slackReportLink_).join(', ');

  if (group.items.length > shown.length) {
    names += ', +' + (group.items.length - shown.length) + ' more';
  }

  return icon + ' *' + group.text.charAt(0).toUpperCase() + group.text.slice(1) +
    '* (' + group.items.length + ' reports): ' + names;
}

/**
 * Splits mrkdwn lines across section blocks under Slack's text limit.
 */
function alertSectionBlocks_(blocks, lines) {
  let buffer = [];

  const flush = function() {
    if (buffer.length > 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: buffer.join('\n') }
      });
      buffer = [];
    }
  };

  lines.forEach(function(line) {
    const safeLine = alertTrim_(line, 700);

    if (buffer.length > 0 &&
        buffer.concat([safeLine]).join('\n').length > CONFIG.slackSectionLimit) {
      flush();
    }

    buffer.push(safeLine);
  });

  flush();
}

/**
 * The main message: a scannable board grouped by urgency, one line per project.
 */
function buildThreadParentBlocks_(models, sheetUrl) {
  const groups = { 3: [], 2: [], 1: [] };
  const groupTitles = { 3: 'Act now', 2: 'Worth a look', 1: 'Still running' };

  models.forEach(function(model) {
    groups[model.severity].push(model);
  });

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: 'Crawler digest: ' + alertPlural_(models.length, 'project') + ' flagged',
        emoji: true
      }
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: Utilities.formatDate(new Date(), CONFIG.reportTimezone, 'EEE d MMM, HH:mm') +
          ' ' + CONFIG.reportTimezone +
          '  ·  "usual" is the average shown in the digest'
      }]
    }
  ];

  [3, 2, 1].forEach(function(severity) {
    const list = groups[severity];

    if (list.length === 0) {
      return;
    }

    const lines = [
      ALERT_ICONS[severity] + ' *' + groupTitles[severity] + ' (' + list.length + ')*'
    ];

    list.slice(0, CONFIG.maximumProjectLines).forEach(function(model) {
      lines.push('• *' + escapeSlack_(model.projectName) + '*: ' + model.summary);
    });

    if (list.length > CONFIG.maximumProjectLines) {
      lines.push('_+' + (list.length - CONFIG.maximumProjectLines) +
        ' more, see the sheet._');
    }

    alertSectionBlocks_(blocks, lines);
  });

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: 'Each project has its details in the thread below. ' +
        'React with :eyes: when you pick one up and :white_check_mark: when it is fixed.'
    }]
  });

  if (sheetUrl) {
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Open full sheet', emoji: true },
        url: sheetUrl,
        action_id: 'open_sheet'
      }]
    });
  }

  return blocks;
}

/**
 * Notification text for the main message.
 */
function buildThreadParentFallback_(models) {
  const actNow = models.filter(function(model) {
    return model.severity === 3;
  }).length;

  return 'Crawler digest: ' + alertPlural_(models.length, 'project') +
    ' flagged, ' + actNow + ' need action now.';
}

/**
 * One project's thread reply: the worst reports first, in plain words, with
 * the report name linking straight to the report.
 */
function buildProjectThreadBlocks_(model) {
  const digest = model.digest;
  const owner = PROJECT_OWNERS[digest.projectName];
  const received = Utilities.formatDate(digest.receivedAt, CONFIG.reportTimezone, 'HH:mm');
  const headLines = [
    ALERT_ICONS[model.severity] + ' *' + escapeSlack_(digest.projectName) + '*' +
      (owner ? '  <@' + owner + '>' : '')
  ];

  if (model.items.length > 0) {
    const total = Math.max(digest.rows.length, model.items.length);

    headLines.push('_' + model.items.length + ' of ' + alertPlural_(total, 'report') +
      ' affected, digest received ' + received + '_');
  }

  const blocks = [{
    type: 'section',
    text: { type: 'mrkdwn', text: headLines.join('\n') }
  }];
  const lines = [];
  const groups = groupAlertItems_(model.items);

  groups.slice(0, CONFIG.maximumReportLines).forEach(function(group) {
    lines.push(alertGroupLine_(group));
  });

  const hiddenReports = groups.slice(CONFIG.maximumReportLines).reduce(function(total, group) {
    return total + group.items.length;
  }, 0);

  if (hiddenReports > 0) {
    lines.push('_+' + hiddenReports + ' more reports, open the sheet for the full list._');
  }

  model.unexplained.forEach(function(section) {
    lines.push(ALERT_ICONS[3] + ' The digest lists *' + section.label + ' (' +
      digest.sectionCounts[section.key] + ')* but the details could not be read. ' +
      'Please check the sheet.');
  });

  if (lines.length > 0) {
    alertSectionBlocks_(blocks, lines);
  }

  if (model.processing.length > 0) {
    const shown = model.processing.slice(0, CONFIG.maximumProcessingNames);
    let text = ALERT_ICONS[1] + ' Still running: ' + shown.map(slackReportLink_).join(', ');

    if (model.processing.length > shown.length) {
      text += ', +' + (model.processing.length - shown.length) + ' more';
    }

    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: alertTrim_(text, 2900) }]
    });
  }

  return blocks;
}

/**
 * Posts one project's threaded reply under the main message.
 */
function postThreadReply_(slack, parent, model) {
  slackApi_(slack.token, 'chat.postMessage', {
    channel: parent.channel,
    thread_ts: parent.ts,
    text: model.projectName + ': ' + model.summary,
    blocks: buildProjectThreadBlocks_(model),
    unfurl_links: false,
    unfurl_media: false
  });
}

/**
 * Posts the main message, then one threaded reply per project that has
 * something to explain. Throws if the main message fails. A reply that fails
 * is tried once more, because the alert only runs once a day. Anything still
 * failing is returned in the outcome.
 */
function postAlertThread_(slack, models, sheetUrl) {
  const parent = slackApi_(slack.token, 'chat.postMessage', {
    channel: slack.channel,
    text: buildThreadParentFallback_(models),
    blocks: buildThreadParentBlocks_(models, sheetUrl),
    unfurl_links: false,
    unfurl_media: false
  });
  const outcome = { failedMessageIds: [], errors: [] };
  const failed = [];
  const threaded = models.filter(function(model) {
    return model.hasThread;
  });

  threaded.forEach(function(model, index) {
    // Slack allows roughly one message per second per channel.
    if (index > 0) {
      Utilities.sleep(CONFIG.slackReplyDelayMs);
    }

    try {
      postThreadReply_(slack, parent, model);
    } catch (error) {
      failed.push(model);
    }
  });

  failed.forEach(function(model, index) {
    Utilities.sleep(index === 0 ? 3000 : CONFIG.slackReplyDelayMs);

    try {
      postThreadReply_(slack, parent, model);
    } catch (error) {
      outcome.failedMessageIds.push(model.digest.messageId);
      outcome.errors.push(model.projectName + ': ' + error.message);
    }
  });

  return outcome;
}

/**
 * Reads the bot token and the channel IDs used for alerts. SLACK_CHANNEL_ID
 * can hold one ID or several separated by commas, for example
 * C0123ABCD9,C0456EFGH1. Every channel gets the alert.
 */
function getSlackBotConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const token = (properties.getProperty(CONFIG.botTokenProperty) || '').trim();
  const channels = (properties.getProperty(CONFIG.channelProperty) || '')
    .split(/[\s,;]+/)
    .filter(function(id, index, all) {
      return id !== '' && all.indexOf(id) === index;
    });

  if (!token || channels.length === 0) {
    throw new Error('Add SLACK_BOT_TOKEN and SLACK_CHANNEL_ID in Project Settings > Script properties.');
  }

  return { token: token, channels: channels };
}

/**
 * Calls a Slack Web API method. Slack answers HTTP 200 with ok:false for most
 * errors, so both the status code and the ok flag are checked. Retries once
 * when Slack rate limits the request.
 */
function slackApi_(token, method, payload) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = UrlFetchApp.fetch('https://slack.com/api/' + method, {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    const responseCode = response.getResponseCode();

    if (responseCode === 429 && attempt === 0) {
      const headers = response.getHeaders();
      const waitSeconds = Number(headers['Retry-After'] || headers['retry-after']) || 2;
      Utilities.sleep(Math.min(waitSeconds, 20) * 1000);
      continue;
    }

    let body = {};

    try {
      body = JSON.parse(response.getContentText());
    } catch (error) {
      body = {};
    }

    if (responseCode < 200 || responseCode >= 300 || !body.ok) {
      throw new Error(
        'Slack ' + method + ' failed (HTTP ' + responseCode + '): ' +
        (body.error || response.getContentText())
      );
    }

    return body;
  }
}

/**
 * Posts a plain Slack message and fails loudly when Slack rejects it.
 */
function postToSlack_(webhookUrl, text) {
  const safeText = truncateSlackMessage_(text);
  const response = UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: safeText }),
    muteHttpExceptions: true
  });
  const responseCode = response.getResponseCode();

  if (responseCode < 200 || responseCode >= 300) {
    throw new Error(
      'Slack webhook failed with HTTP ' + responseCode + ': ' + response.getContentText()
    );
  }
}

/**
 * Keeps unusually large alert digests within Slack's practical message limit.
 */
function truncateSlackMessage_(text) {
  if (text.length <= CONFIG.maximumSlackCharacters) {
    return text;
  }

  return text.slice(0, CONFIG.maximumSlackCharacters - 80) +
    '\n\n_Message shortened because the digest contained too many alert rows._';
}

/**
 * Parses a displayed value such as "477 | 488" into current and average.
 */
function parsePair_(value) {
  const match = value.match(/(-?[\d,.]+)\s*\|\s*(-?[\d,.]+)/);

  return match ? {
    current: parseNumber_(match[1]),
    average: parseNumber_(match[2])
  } : null;
}

/**
 * Converts formatted numeric text including percentages into a number.
 */
function parseNumber_(value) {
  const cleaned = String(value || '').replace(/,/g, '').replace(/%/g, '').trim();
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

/**
 * Produces a stable report key shared across daily digest emails.
 */
function reportKey_(row) {
  return normalizeText_(row.project).toLowerCase() + '|' +
    normalizeText_(row.report).toLowerCase();
}

/**
 * Calculates the arithmetic mean of numeric observations.
 */
function average_(values) {
  return values.reduce(function(total, value) {
    return total + value;
  }, 0) / values.length;
}

/**
 * Converts HTML table content into readable text for parsing.
 */
function htmlToText_(html) {
  return decodeHtml_(String(html || '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' '));
}

/**
 * Decodes common and numeric HTML entities found in Gmail message bodies.
 */
function decodeHtml_(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, function(match, code) {
      return String.fromCodePoint(parseInt(code, 16));
    })
    .replace(/&#(\d+);/g, function(match, code) {
      return String.fromCodePoint(Number(code));
    });
}

/**
 * Collapses whitespace while keeping extracted values readable and comparable.
 */
function normalizeText_(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Escapes characters that Slack treats as message markup.
 */
function escapeSlack_(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Returns a clickable report name when the digest contains a report URL.
 */
function slackReportLink_(row) {
  const name = escapeSlack_(row.report);
  const url = row.reportUrl || '';

  return url && url.length <= CONFIG.maximumLinkLength
    ? '<' + url + '|' + name + '>'
    : name;
}

/**
 * Formats large record counts with grouping separators.
 */
function formatNumber_(value) {
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * Formats positive and negative values consistently for Slack.
 */
function formatSigned_(value, suffix) {
  if (value === null) {
    return 'n/a';
  }

  const sign = value > 0 ? '+' : '';
  return sign + value.toFixed(2) + suffix;
}

/**
 * Debug helper: parses the newest digest and logs its evaluation without Slack.
 */
function testLatestDigest() {
  const spreadsheet = getBoundSpreadsheet_();
  const currentDigests = loadCurrentDigests_();

  if (currentDigests.length === 0) {
    throw new Error('No digest was found within the last 24 hours.');
  }

  const latest = currentDigests[currentDigests.length - 1];
  const currentSheetName = dailySheetName_(new Date());
  const sheetHistory = loadHistoryFromDailySheets_(spreadsheet, currentSheetName);
  const history = getPriorHistory_(latest, sheetHistory);
  const evaluation = evaluateDigest_(latest, history);
  console.log(JSON.stringify({
    projectName: latest.projectName,
    receivedAt: latest.receivedAt,
    parsedRows: latest.rows.length,
    processingReports: latest.rows.filter(function(row) {
      return row.isProcessing;
    }).map(function(row) {
      return row.report;
    }),
    sectionCounts: latest.sectionCounts,
    alertDetails: latest.alertDetails,
    evaluation: evaluation,
    slackPreview: evaluation.shouldAlert
      ? buildProjectThreadBlocks_(buildProjectAlertModel_({ digest: latest, result: evaluation }))
      : 'No Slack alert.'
  }, null, 2));
}

/**
 * Debug helper: rebuilds today's sheet without posting anything to Slack.
 */
function testDailySummarySheet() {
  const spreadsheet = getBoundSpreadsheet_();
  const digests = loadCurrentDigests_();
  const sheetName = dailySheetName_(new Date());
  const sheetHistory = loadHistoryFromDailySheets_(spreadsheet, sheetName);
  const evaluations = digests.map(function(digest) {
    const history = getPriorHistory_(digest, sheetHistory);

    return {
      digest: digest,
      history: history,
      result: evaluateDigest_(digest, history)
    };
  });

  writeDailySummarySheet_(spreadsheet, sheetName, evaluations);
  orderDailySummarySheets_(spreadsheet);
  console.log('Created %s with %s digest(s) and %s report row(s).',
    sheetName,
    evaluations.length,
    buildSummaryRows_(evaluations).length
  );
}

/**
 * Debug helper: verifies the configured webhook with a harmless test message.
 */
function testSlackWebhook() {
  const webhookUrl = PropertiesService.getScriptProperties()
    .getProperty(CONFIG.webhookProperty);

  if (!webhookUrl) {
    throw new Error('SLACK_WEBHOOK_URL is missing from Script properties.');
  }

  postToSlack_(webhookUrl, ':white_check_mark: Grepsr digest monitor test succeeded.');
}

/**
 * Debug helper: posts a test parent message and one threaded reply to verify
 * the bot token, channel ID and channel membership.
 */
function testSlackBot() {
  const slack = getSlackBotConfig_();
  const errors = [];

  slack.channels.forEach(function(channel) {
    try {
      const parent = slackApi_(slack.token, 'chat.postMessage', {
        channel: channel,
        text: ':white_check_mark: Grepsr digest monitor bot test. Check the thread for a reply.'
      });

      slackApi_(slack.token, 'chat.postMessage', {
        channel: parent.channel,
        thread_ts: parent.ts,
        text: 'Threaded reply worked.'
      });
    } catch (error) {
      errors.push(channel + ': ' + error.message);
    }
  });

  if (errors.length > 0) {
    throw new Error('Test failed for: ' + errors.join(' | '));
  }
}

/**
 * Manual helper: posts today's alerting digests to the REAL channel in the new
 * format, ignoring the processed list, so the layout can be checked without
 * waiting for a fresh digest. It does not mark anything as processed.
 */
function postAlertThreadNow() {
  const slack = getSlackBotConfig_();
  const spreadsheet = getBoundSpreadsheet_();
  const sheetName = dailySheetName_(new Date());
  const sheetHistory = loadHistoryFromDailySheets_(spreadsheet, sheetName);
  const evaluations = loadCurrentDigests_().map(function(digest) {
    return {
      digest: digest,
      result: evaluateDigest_(digest, getPriorHistory_(digest, sheetHistory))
    };
  });
  const models = latestDigestPerProject_(evaluations)
    .filter(function(item) {
      return item.result.shouldAlert;
    })
    .map(function(item) {
      return buildProjectAlertModel_(item);
    })
    .sort(compareAlertModels_);

  if (models.length === 0) {
    throw new Error('No alerting digests found today to post.');
  }

  const outcome = postAlertToChannels_(
    slack,
    slack.channels,
    models,
    alertSheetUrl_(spreadsheet, sheetName)
  );

  if (outcome.errors.length > 0) {
    throw new Error('Some posts failed: ' + outcome.errors.join(' | '));
  }
}

/**
 * Read only check. Lists the weekly and monthly digests of the last 35 days and
 * says whether each one can be read, so a missing project can be traced. It
 * posts nothing and writes nothing. Read the result in the execution log.
 */
function checkWeeklyAndMonthlyDigests() {
  const days = 35;
  const query = 'from:noreply@grepsr.com (subject:"this week" OR subject:"this month") newer_than:' + days + 'd';
  const now = Date.now();
  const messages = getDigestMessages_(query, now - days * 24 * 60 * 60 * 1000, now)
    .sort(function(a, b) {
      return a.getDate().getTime() - b.getDate().getTime();
    });
  let unreadable = 0;

  messages.forEach(function(message) {
    const digest = parseDigestMessage_(message);
    const received = Utilities.formatDate(message.getDate(), CONFIG.reportTimezone, 'yyyy-MM-dd HH:mm');

    if (!digest) {
      unreadable++;
    }

    console.log('%s | %s | %s', received, message.getSubject(), digest
      ? 'READ as "' + digest.projectName + '" with ' + digest.rows.length + ' report row(s)'
      : 'NOT READ (no project name or no report rows)');
  });

  console.log('%s weekly or monthly digest(s) found in the last %s days, %s could not be read.',
    messages.length, days, unreadable);
}
