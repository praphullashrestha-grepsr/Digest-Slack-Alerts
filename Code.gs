/**
 * Grepsr digest monitor for Gmail and Slack.
 *
 * Runs at the times each team chooses, without anyone editing the code.
 * The simple way: add ALERT_TIMES in Script properties (for example
 * 10:00, 13:00, 16:00) and run setupMonitoring once. The script then books a
 * one-time trigger for each time and, after each run, books the next day's,
 * so the alert lands within a few minutes of each time, every day.
 * (Teams can instead add their own Day timer triggers on monitorDigestAlerts
 * in the Triggers page; those fire somewhere inside the chosen hour.)
 *
 * Each run reads every digest received since the previous run and posts one
 * Slack message when something is flagged. With 10:00, 13:00 and 16:00, the
 * 13:00 run covers 10 to 1, the 16:00 run covers 1 to 4, and the next day's
 * 10:00 run covers 4pm to 10am.
 *
 * The window is stored in the LAST_ALERT_STATE script property, with one
 * start time per Slack channel. After a run, a channel's start moves to the
 * end of that run's window once the channel received the alert (or when
 * nothing needed attention). A channel whose post failed keeps its old start,
 * so it gets those digests on the next run. Consecutive runs join up with no
 * gap and no overlap.
 *
 * A digest is included when it contains an explicit flag: an alert section
 * above zero, a comment such as COUNT_ALERT or FILL_RATE_ALERT, or a report
 * still running. The optional seven day trend check
 * (CONFIG.trendCheckEnabled) is off by default.
 *
 * The alert is ONE Slack message (chat.postMessage with a bot token): a table
 * with one row per report and three columns, Project, Report (linked to the
 * report) and Status (a colored dot). There are no thread
 * replies. A very long alert continues in a second message, because Slack
 * limits the size of one table.
 */

const CONFIG = Object.freeze({
  // Daily, weekly and monthly digests. The subject can read "Alerts for X this day",
  // "1 Failed, 2 Data Alerts for X this day", "1 Failed for X this week" and so on, so
  // only the "for <project> this <period>" part is relied on. The exact filtering
  // is done again in code. No newer_than here: loadCurrentDigests_ adds an
  // "after:" filter based on the saved window start.
  currentGmailQuery: 'from:noreply@grepsr.com (subject:"this day" OR subject:"this week" OR subject:"this month")',
  reportTimezone: 'Asia/Kathmandu',
  // Run times are NOT set here, so the code stays the same for every team.
  // Each team adds ALERT_TIMES in Script properties (for example
  // 10:00, 13:00, 16:00, read in reportTimezone) and runs setupMonitoring.
  // These are the names of the properties the schedule uses.
  alertTimesProperty: 'ALERT_TIMES',
  scheduleProperty: 'ALERT_SCHEDULE',
  // Google allows about 20 triggers per script; one is booked per time.
  maximumAlertTimes: 15,
  //
  // Only for the very first run, before any window start is saved.
  firstRunLookbackHours: 24,
  // Longest window one run may cover (catch-up after an outage).
  maximumWindowHours: 168,
  // Each window ends this many minutes before the run starts. A digest that
  // arrives in those last minutes is picked up by the next run instead, so a
  // message Gmail has not finished indexing is never skipped.
  digestSettleMinutes: 5,
  // Only used once, when upgrading from the old once-a-day version: its last
  // alert covered digests up to this time on the day it saved.
  legacyAlertHour: 10,
  legacyAlertMinute: 30,
  // The seven day trend check is switched off. The digest already flags
  // count and fill rate changes itself (its COUNT and FILL RATE comments), so
  // this only added alerts for smaller changes the digest treated as normal.
  // Set to true to bring it back for a tailored setup.
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
  // Pause between messages when a long alert needs a second message.
  slackReplyDelayMs: 1100,
  slackSectionLimit: 2900,
  // Slack allows one table per message, at most 100 rows (header included)
  // and 10,000 characters across its cells. A longer alert continues in the
  // next message.
  maximumTableRows: 100,
  maximumTableCharacters: 9000,
  maximumCellCharacters: 150,
  lastAlertProperty: 'LAST_ALERT_STATE',
  // Digest sections the script reads but deliberately ignores everywhere:
  // no alert, no table row, no daily summary total. Remove a key from this
  // list to start reporting that section again.
  ignoredSections: ['crawlerAnomalies', 'profilerAnomalies', 'missedRuns'],
  // Projects to skip completely for now, written exactly as the project name
  // appears in the alert (capitals do not matter). Their digests are left out
  // of the alert, the daily summary and the sheet. Remove a name to start
  // watching that project again.
  ignoredProjects: ['US Food Import-US Food Imports'],
  // When a project sent more than one digest in the window, alert on its
  // latest one only, so the same project does not appear twice. Set to false
  // to include every digest.
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

/**
 * The colored dot shown in the Status column, by severity:
 * 3 = act now (red), 2 = worth a look (yellow), 1 = still running.
 */
const ALERT_EMOJI = Object.freeze({
  3: 'red_circle',
  2: 'large_yellow_circle',
  1: 'hourglass_flowing_sand'
});

/**
 * Problem types behind each report's status. Severity 3 = act now (red),
 * 2 = worth a look (yellow). Rank only orders problems of the same severity,
 * lower first.
 *
 * The rules are deliberately simple:
 *   Act now: a report with 0 records, a failed run, failed QA rules (the
 *     digest's Data validation section) and a failed child process (the
 *     digest's Failed tasks section).
 *   Worth a look: every count alert and fill rate alert the digest raises,
 *     whatever the size of the change, plus long running crawlers.
 */
const ISSUE_KINDS = Object.freeze({
  runFailed:   { severity: 3, rank: 1 },
  noData:      { severity: 3, rank: 2 },
  validation:  { severity: 3, rank: 3 },
  failedTasks: { severity: 3, rank: 4 },
  missedRun:   { severity: 3, rank: 5 },
  emptyFields: { severity: 2, rank: 6 },
  drop:        { severity: 2, rank: 7 },
  lowFill:     { severity: 2, rank: 8 },
  rise:        { severity: 2, rank: 9 },
  countChange: { severity: 2, rank: 10 },
  slowRun:     { severity: 2, rank: 11 },
  anomaly:     { severity: 2, rank: 12 },
  flagged:     { severity: 2, rank: 13 }
});

/**
 * Optional. Tag the person responsible for a project next to its name in the
 * Project column. Key is the digest project name exactly as it appears in the
 * digest subject, value is the Slack member ID (profile > three dots > Copy
 * member ID).
 * Example: 'Defensoria Salud-Defensoria Salud': 'U0123ABCD'
 */
const PROJECT_OWNERS = Object.freeze({
});

/**
 * Name of the function the script books for each time in ALERT_TIMES. Only
 * the script creates triggers on it; teams never add it by hand.
 */
const SCHEDULED_HANDLER = 'runScheduledAlert';

/**
 * Sets up the schedule. Run it once after pasting the code, and again after
 * changing ALERT_TIMES. It posts nothing to Slack; read the execution log.
 *
 * With ALERT_TIMES in Script properties (for example 10:00, 13:00, 16:00):
 * removes the triggers it booked before and books one one-time trigger per
 * time, at the next occurrence of that time in reportTimezone. Each of those
 * runs books the next day's trigger for its time, so the schedule keeps
 * going on its own.
 *
 * Without ALERT_TIMES: books nothing. The team can then add its own Day
 * timer triggers on monitorDigestAlerts in the Triggers page instead (each
 * fires at some minute inside the chosen hour).
 */
function setupMonitoring() {
  const slack = getSlackBotConfig_();
  const times = readAlertTimes_();
  const properties = PropertiesService.getScriptProperties();
  const triggers = ScriptApp.getProjectTriggers();
  const manualTriggers = triggers.filter(function(trigger) {
    return trigger.getHandlerFunction() === 'monitorDigestAlerts';
  });
  const refreshTriggers = triggers.filter(function(trigger) {
    return trigger.getHandlerFunction() === 'refreshDigestSheet';
  });

  // Start the schedule fresh: remove every trigger this script booked before.
  triggers.filter(function(trigger) {
    return trigger.getHandlerFunction() === SCHEDULED_HANDLER;
  }).forEach(function(trigger) {
    ScriptApp.deleteTrigger(trigger);
  });
  properties.deleteProperty(CONFIG.scheduleProperty);

  console.log('Slack: bot token found, %s channel(s): %s.',
    slack.channels.length, slack.channels.join(', '));

  if (times.length > 0) {
    const booked = syncAlertSchedule_(null);
    const next = Object.keys(booked).map(function(id) {
      return booked[id];
    }).sort(function(a, b) {
      return a.at - b.at;
    }).map(function(booking) {
      return formatWindowTime_(booking.at);
    });

    console.log('Alert times (%s): %s. Booked the next runs: %s.',
      CONFIG.reportTimezone,
      times.map(function(time) {
        return time.text;
      }).join(', '),
      next.join(', '));

    if (manualTriggers.length > 0) {
      console.log('WARNING: %s trigger(s) in the Triggers page also run monitorDigestAlerts. ' +
        'With ALERT_TIMES set they are not needed and would post extra alerts. ' +
        'Delete them in the Triggers page.', manualTriggers.length);
    }
  } else {
    console.log('ALERT_TIMES is not set, so no run times were booked. Either add ALERT_TIMES ' +
      'in Script properties (for example 10:00, 13:00, 16:00) and run setupMonitoring again, ' +
      'or add Day timer triggers on monitorDigestAlerts in the Triggers page.');
    console.log('%s trigger(s) in the Triggers page run monitorDigestAlerts. They use the ' +
      'project time zone (%s).', manualTriggers.length, Session.getScriptTimeZone());
  }

  if (refreshTriggers.length > 0) {
    console.log('%s old trigger(s) run refreshDigestSheet. They are no longer needed ' +
      'and can be deleted in the Triggers page.', refreshTriggers.length);
  }

  console.log('The next run will cover digests received after %s.',
    formatWindowTime_(resolveAlertWindow_(new Date()).start));
}

/**
 * Reads ALERT_TIMES from Script properties: times separated by commas, such
 * as "10:00, 13:00, 16:00" or "10am, 1pm, 4:30pm", in reportTimezone.
 * Returns them sorted, without duplicates. Throws with a clear message when
 * a time cannot be read.
 */
function readAlertTimes_() {
  const raw = String(
    PropertiesService.getScriptProperties().getProperty(CONFIG.alertTimesProperty) || ''
  ).trim();
  const seen = new Set();
  const times = [];

  raw.split(/[,;\n]+/).map(function(part) {
    return part.trim();
  }).filter(function(part) {
    return part !== '';
  }).forEach(function(part) {
    const match = part.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/i);
    let hour = match ? Number(match[1]) : NaN;
    const minute = match && match[2] ? Number(match[2]) : 0;
    const suffix = match && match[3] ? match[3].toLowerCase() : '';

    if (match && suffix && hour >= 1 && hour <= 12) {
      hour = hour % 12 + (suffix === 'pm' ? 12 : 0);
    } else if (match && suffix) {
      hour = NaN;
    }

    if (!match || !(hour >= 0 && hour <= 23) || minute > 59 || (!suffix && !match[2])) {
      throw new Error('ALERT_TIMES has "' + part + '". Write times like 10:00, 13:00, 16:00 ' +
        '(or 10am, 1pm, 4pm), separated by commas.');
    }

    const text = ('0' + hour).slice(-2) + ':' + ('0' + minute).slice(-2);

    if (!seen.has(text)) {
      seen.add(text);
      times.push({ text: text, hour: hour, minute: minute });
    }
  });

  if (times.length > CONFIG.maximumAlertTimes) {
    throw new Error('ALERT_TIMES has ' + times.length + ' times. Google allows about 20 ' +
      'triggers per script, so use at most ' + CONFIG.maximumAlertTimes + '.');
  }

  return times.sort(function(a, b) {
    return a.text.localeCompare(b.text);
  });
}

/**
 * The next moment a time happens, in reportTimezone, after fromMs (with a
 * one minute margin so a run never books its own time again).
 */
function nextOccurrence_(time, fromMs) {
  const todayKey = Utilities.formatDate(new Date(fromMs), CONFIG.reportTimezone, 'yyyy-MM-dd');
  let at = localTimeToMilliseconds_(todayKey, time.hour, time.minute);

  if (at <= fromMs + 60 * 1000) {
    const tomorrowKey = Utilities.formatDate(
      new Date(localTimeToMilliseconds_(todayKey, 12, 0) + 24 * 60 * 60 * 1000),
      CONFIG.reportTimezone,
      'yyyy-MM-dd'
    );

    at = localTimeToMilliseconds_(tomorrowKey, time.hour, time.minute);
  }

  return at;
}

/**
 * Makes sure every time in ALERT_TIMES has exactly one upcoming one-time
 * trigger, and nothing else is booked. firedTriggerId is the trigger that
 * started this run (or null): it is removed, and the next day's trigger for
 * its time is booked. Missing triggers are booked again, so one run repairs
 * the whole schedule. Bookings are kept in the ALERT_SCHEDULE property as
 * {"<trigger id>": {"time": "13:00", "at": 1759910000000}}.
 */
function syncAlertSchedule_(firedTriggerId) {
  const properties = PropertiesService.getScriptProperties();
  const times = readAlertTimes_();
  const now = Date.now();
  const wanted = new Set(times.map(function(time) {
    return time.text;
  }));
  let bookings = {};

  try {
    bookings = JSON.parse(properties.getProperty(CONFIG.scheduleProperty) || '{}') || {};
  } catch (error) {
    bookings = {};
  }

  const fired = firedTriggerId ? bookings[firedTriggerId] : null;
  const kept = {};
  const covered = {};

  ScriptApp.getProjectTriggers().filter(function(trigger) {
    return trigger.getHandlerFunction() === SCHEDULED_HANDLER;
  }).forEach(function(trigger) {
    const id = trigger.getUniqueId();
    const booking = bookings[id];
    // A booking more than 10 minutes in the past never fired; replace it.
    const keep = id !== firedTriggerId &&
      booking && wanted.has(booking.time) && !covered[booking.time] &&
      booking.at > now - 10 * 60 * 1000;

    if (keep) {
      kept[id] = booking;
      covered[booking.time] = true;
    } else {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  times.forEach(function(time) {
    if (covered[time.text]) {
      return;
    }

    // The time that just fired books its next day, even if it fired early.
    const from = fired && fired.time === time.text ? Math.max(now, fired.at) : now;
    const at = nextOccurrence_(time, from);
    const trigger = ScriptApp.newTrigger(SCHEDULED_HANDLER)
      .timeBased()
      .at(new Date(at))
      .create();

    kept[trigger.getUniqueId()] = { time: time.text, at: at };
  });

  properties.setProperty(CONFIG.scheduleProperty, JSON.stringify(kept));

  return kept;
}

/**
 * Started by the one-time triggers booked from ALERT_TIMES. It books the
 * next trigger FIRST, so the schedule continues even if posting fails, then
 * runs the alert. Never add this function in the Triggers page by hand.
 */
function runScheduledAlert(event) {
  const firedTriggerId = event && event.triggerUid ? String(event.triggerUid) : null;
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    // Another run is busy. Keep the schedule going; the next run's window
    // includes everything this one would have posted.
    syncAlertSchedule_(firedTriggerId);
    console.log('Another run is still in progress. Skipping this one.');
    return;
  }

  let scheduleError = null;

  try {
    try {
      syncAlertSchedule_(firedTriggerId);
    } catch (error) {
      scheduleError = error;
      console.log('Could not book the next run: %s', error.message);
    }

    runDigestAlert_();
  } finally {
    lock.releaseLock();
  }

  if (scheduleError) {
    throw new Error('The alert was posted but the next run could not be booked: ' +
      scheduleError.message + ' Fix ALERT_TIMES and run setupMonitoring again.');
  }
}

/**
 * Keeps one evaluation per project: the digest received last. A project can
 * send several digests in a window, and the latest shows its current state.
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
 * Reads every digest in the alert window, evaluates it against the sheet
 * history and adds the new digests to today's sheet tab. Posts nothing. When
 * no window is passed, the current window (saved start to now) is used.
 */
function buildTodaysEvaluations_(spreadsheet, alertWindow) {
  const digests = loadCurrentDigests_(alertWindow);
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
 * Manual and silent: adds the digests of the current window to today's sheet
 * tab without posting to Slack and without moving the saved window.
 */
function refreshDigestSheet() {
  const snapshot = buildTodaysEvaluations_(getBoundSpreadsheet_());

  console.log('Refreshed %s with %s digest(s).', snapshot.sheetName, snapshot.evaluations.length);
}

/**
 * Reads LAST_ALERT_STATE, which holds where the next window starts:
 *   {"windowStart": 1759900000000,
 *    "channels": {"C0123ABCD9": 1759900000000},
 *    "windowStartText": "2026-10-08 16:00", "time": "2026-10-08 16:05:12"}
 * "channels" has one start per Slack channel, so a channel whose post failed
 * keeps its older start. "windowStart" is used for a channel with no entry,
 * such as one just added to SLACK_CHANNEL_ID. The two text fields are only
 * for reading in Script properties.
 *
 * A state saved by the old once-a-day version ({"date": "2026-10-08",
 * "channels": [...]}) is read as "start at that day's legacyAlertHour:
 * legacyAlertMinute", so the first run after upgrading does not post again
 * what the old version already posted.
 */
function readAlertState_() {
  let state = null;

  try {
    state = JSON.parse(
      PropertiesService.getScriptProperties().getProperty(CONFIG.lastAlertProperty) || 'null'
    );
  } catch (error) {
    state = null;
  }

  if (!state || typeof state !== 'object') {
    return { windowStart: null, channels: {} };
  }

  if (Number.isFinite(state.windowStart)) {
    const channels = {};

    if (state.channels && typeof state.channels === 'object' && !Array.isArray(state.channels)) {
      Object.keys(state.channels).forEach(function(channel) {
        if (Number.isFinite(state.channels[channel])) {
          channels[channel] = state.channels[channel];
        }
      });
    }

    return { windowStart: state.windowStart, channels: channels };
  }

  if (typeof state.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(state.date)) {
    return {
      windowStart: localTimeToMilliseconds_(state.date, CONFIG.legacyAlertHour, CONFIG.legacyAlertMinute),
      channels: {}
    };
  }

  return { windowStart: null, channels: {} };
}

/**
 * Saves where the next window starts: one start per channel, plus the start
 * for channels that have none yet.
 */
function saveAlertState_(properties, windowStart, channelStarts, now) {
  properties.setProperty(CONFIG.lastAlertProperty, JSON.stringify({
    windowStart: windowStart,
    channels: channelStarts,
    windowStartText: formatWindowTime_(windowStart),
    time: Utilities.formatDate(now, CONFIG.reportTimezone, 'yyyy-MM-dd HH:mm:ss')
  }));
}

/**
 * End of the window for a run starting now: a few minutes before now
 * (digestSettleMinutes), so very recent digests wait for the next run.
 */
function windowEndFor_(now) {
  return now.getTime() - CONFIG.digestSettleMinutes * 60 * 1000;
}

/**
 * Where a channel's window starts: its own saved start, else the shared one,
 * else firstRunLookbackHours before the end. Never older than
 * maximumWindowHours and never after the end.
 */
function channelWindowStart_(state, channel, end) {
  let start = state.channels[channel];

  if (!Number.isFinite(start)) {
    start = state.windowStart;
  }

  if (!Number.isFinite(start)) {
    start = end - CONFIG.firstRunLookbackHours * 60 * 60 * 1000;
  }

  start = Math.max(start, end - CONFIG.maximumWindowHours * 60 * 60 * 1000);

  return Math.min(start, end);
}

/**
 * The current window, read only, for helpers: from the earliest channel
 * start to the end. Changes nothing.
 */
function resolveAlertWindow_(now) {
  const end = windowEndFor_(now);
  const state = readAlertState_();
  let channels = [];

  try {
    channels = getSlackBotConfig_().channels;
  } catch (error) {
    channels = [];
  }

  const starts = (channels.length > 0 ? channels : ['']).map(function(channel) {
    return channelWindowStart_(state, channel, end);
  });

  return { start: Math.min.apply(null, starts), end: end };
}

/**
 * Formats an epoch ms value as a local date and time for logs.
 */
function formatWindowTime_(milliseconds) {
  return Utilities.formatDate(new Date(milliseconds), CONFIG.reportTimezone, 'yyyy-MM-dd HH:mm');
}

/**
 * Epoch ms of a local date ("2026-10-07") and time in reportTimezone.
 */
function localTimeToMilliseconds_(dateKey, hour, minute) {
  const dayStart = startOfToday_(
    new Date(Date.parse(dateKey + 'T12:00:00Z')),
    CONFIG.reportTimezone
  ).getTime();

  return dayStart + (Number(hour) * 60 + Number(minute)) * 60 * 1000;
}

/**
 * Posts the alert to each channel. A channel counts as posted once the first
 * message is up. Failures are collected, so one broken channel never stops
 * the others.
 */
function postAlertToChannels_(slack, channels, models) {
  const result = { posted: [], errors: [] };

  channels.forEach(function(channel) {
    try {
      const outcome = postAlertMessage_({ token: slack.token, channel: channel }, models);

      result.posted.push(channel);
      outcome.errors.forEach(function(message) {
        result.errors.push(channel + ': ' + message);
      });
    } catch (error) {
      result.errors.push(channel + ': ' + error.message);
    }
  });

  return result;
}

/**
 * The function for Day timer triggers added by hand in the Triggers page
 * (only needed when ALERT_TIMES is not used). Every run posts. A script lock
 * stops two runs from overlapping, which would read the same window twice.
 * To post by hand at any time, run postAlertThreadNow.
 */
function monitorDigestAlerts() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    console.log('Another run is still in progress. Skipping this one.');
    return;
  }

  try {
    runDigestAlert_();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Today's alert models from a list of evaluations: the latest digest per
 * project, only those that need attention, worst first.
 */
function buildAlertModels_(evaluations) {
  return latestDigestPerProject_(evaluations)
    .filter(function(item) {
      return item.result.shouldAlert;
    })
    .map(function(item) {
      return buildProjectAlertModel_(item);
    })
    .sort(compareAlertModels_);
}

/**
 * One run: reads the digests since the earliest channel start, adds them to
 * today's sheet and posts to each channel the flagged digests of its own
 * window. A channel's start moves to this window's end when it received the
 * alert or when nothing needed attention. A channel whose post failed keeps
 * its start, so the next run covers those digests again for it.
 */
function runDigestAlert_() {
  const properties = PropertiesService.getScriptProperties();
  const now = new Date();
  const slack = getSlackBotConfig_();
  const end = windowEndFor_(now);
  const state = readAlertState_();
  const starts = {};

  slack.channels.forEach(function(channel) {
    starts[channel] = channelWindowStart_(state, channel, end);
  });

  const earliest = Math.min.apply(null, slack.channels.map(function(channel) {
    return starts[channel];
  }));
  const spreadsheet = getBoundSpreadsheet_();
  const snapshot = buildTodaysEvaluations_(spreadsheet, { start: earliest, end: end });

  // Channels with the same start get the same alert, posted once per channel.
  const groups = new Map();

  slack.channels.forEach(function(channel) {
    if (!groups.has(starts[channel])) {
      groups.set(starts[channel], []);
    }

    groups.get(starts[channel]).push(channel);
  });

  const nextStarts = {};
  const errors = [];
  const summaries = [];

  groups.forEach(function(channels, start) {
    const windowText = formatWindowTime_(start) + ' to ' + formatWindowTime_(end);
    const models = buildAlertModels_(snapshot.evaluations.filter(function(item) {
      return item.digest.receivedAt.getTime() > start;
    }));

    if (models.length === 0) {
      channels.forEach(function(channel) {
        nextStarts[channel] = end;
      });
      summaries.push(windowText + ': nothing needs attention.');
      return;
    }

    const outcome = postAlertToChannels_(slack, channels, models);

    channels.forEach(function(channel) {
      nextStarts[channel] = outcome.posted.indexOf(channel) !== -1 ? end : start;
    });
    outcome.errors.forEach(function(message) {
      errors.push(message);
    });
    summaries.push(windowText + ': ' + models.length + ' project(s) posted to ' +
      outcome.posted.length + ' of ' + channels.length + ' channel(s).');
  });

  saveAlertState_(properties, end, nextStarts, now);
  console.log('Checked %s digest(s). %s', snapshot.evaluations.length, summaries.join(' '));

  if (errors.length > 0) {
    throw new Error('Some alert posts failed: ' + errors.join(' | ') +
      '. A channel that got nothing will get these digests on the next run.');
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
 * Loads only digest messages received inside the alert window. When no
 * window is passed, the current one (saved start to now) is used without
 * changing anything.
 */
function loadCurrentDigests_(alertWindow) {
  const range = alertWindow || resolveAlertWindow_(new Date());
  // Gmail's after: is only a rough pre-filter (1 hour margin). The exact
  // cut is made per message in isWithinCurrentWindow_.
  const afterSeconds = Math.floor((range.start - 60 * 60 * 1000) / 1000);
  const query = CONFIG.currentGmailQuery + ' after:' + afterSeconds;

  return getDigestMessages_(query, range.start, range.end)
    .map(parseDigestMessage_)
    .filter(function(digest) {
      return digest !== null && !isIgnoredProject_(digest.projectName);
    })
    .sort(function(a, b) {
      return a.receivedAt.getTime() - b.receivedAt.getTime();
    });
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
 * Accepts only messages after the window start (exclusive) up to and
 * including the window end, so a digest on the boundary belongs to exactly
 * one window.
 */
function isWithinCurrentWindow_(receivedAt, windowStart, windowEnd) {
  const receivedTime = receivedAt.getTime();

  return receivedTime > windowStart && receivedTime <= windowEnd;
}

/**
 * Loads matching Gmail messages in batches so multiple projects are supported.
 */
function getDigestMessages_(gmailQuery, windowStart, windowEnd) {
  const messages = [];
  const batchSize = 100;

  for (let start = 0; start < CONFIG.maximumThreads; start += batchSize) {
    const threads = GmailApp.search(gmailQuery, start, batchSize);

    threads.forEach(function(thread) {
      thread.getMessages().forEach(function(message) {
        // Check the timestamp before reading the subject or body of the email.
        if (!isWithinCurrentWindow_(message.getDate(), windowStart, windowEnd)) {
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
      reportUrl: cells[2].href || rowLink_(cells, [1]),
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

    if (!detail.reportUrl) {
      detail.reportUrl = rowLink_(cells, [section.columns.indexOf('project') + 1]);
    }

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
 * The first web link anywhere in a row, skipping the given cell positions
 * (the project column), for rows whose report cell has no link of its own.
 */
function rowLink_(cells, skipIndexes) {
  const cell = cells.find(function(item, index) {
    return skipIndexes.indexOf(index) === -1 && /^https?:\/\//i.test(item.href);
  });

  return cell ? cell.href : '';
}

/**
 * Extracts visible text and the first link from every table cell.
 */
function extractCells_(rowHtml) {
  const cellHtmlList = rowHtml.match(/<(?:td|th)\b[\s\S]*?<\/(?:td|th)>/gi) || [];

  return cellHtmlList.map(function(cellHtml) {
    // Quoted or unquoted href, in any position inside the <a> tag.
    const hrefMatch = cellHtml.match(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const href = hrefMatch ? (hrefMatch[1] || hrefMatch[2] || hrefMatch[3] || '') : '';

    return {
      text: normalizeText_(htmlToText_(cellHtml)),
      href: decodeHtml_(href).trim()
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
 * Builds the daily tab name using the report timezone.
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
      // A message may appear on two tabs so deduplicate it.
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
 * Creates today's report tab if needed and APPENDS one row per parsed report.
 * Digests already on the tab (matched by Message ID) are skipped, so several
 * runs in one day add to the tab instead of wiping each other.
 */
function writeDailySummarySheet_(spreadsheet, sheetName, evaluations) {
  let sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  if (sheet.getFilter()) {
    sheet.getFilter().remove();
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, SUMMARY_HEADERS.length).setValues([SUMMARY_HEADERS.slice()]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, SUMMARY_HEADERS.length)
      .setFontWeight('bold')
      .setFontColor('#ffffff')
      .setBackground('#1f4e78');
  }

  // Skip digests already written by an earlier run today.
  const idIndex = SUMMARY_HEADERS.indexOf('Message ID');
  const knownIds = new Set();

  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, idIndex + 1, sheet.getLastRow() - 1, 1).getValues()
      .forEach(function(row) {
        knownIds.add(String(row[0]));
      });
  }

  const rows = buildSummaryRows_(evaluations).filter(function(row) {
    return !knownIds.has(String(row[idIndex]));
  });

  if (rows.length > 0) {
    const first = sheet.getLastRow() + 1;

    // Add checkbox validation before writing values so true states are preserved.
    sheet.getRange(first, 15, rows.length, 1).insertCheckboxes();
    sheet.getRange(first, 16, rows.length, 1).insertCheckboxes();
    sheet.getRange(first, 19, rows.length, 1).insertCheckboxes();
    sheet.getRange(first, 1, rows.length, SUMMARY_HEADERS.length).setValues(rows);
    sheet.getRange(first, 1, rows.length, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sheet.getRange(first, 6, rows.length, 2).setNumberFormat('#,##0.00');
    sheet.getRange(first, 8, rows.length, 1).setNumberFormat('0.00"%"');
    sheet.getRange(first, 9, rows.length, 2).setNumberFormat('0.00');
    sheet.getRange(first, 11, rows.length, 1).setNumberFormat('0.00"%"');
    sheet.getRange(first, 12, rows.length, 1).setNumberFormat('#,##0');
  }

  if (sheet.getLastRow() > 1) {
    sheet.getRange(1, 1, sheet.getLastRow(), SUMMARY_HEADERS.length).createFilter();
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
 * Inside each group the project with the most red reports comes first, then
 * the most yellow, then the most still running, then by name.
 */
function compareAlertModels_(a, b) {
  return b.severity - a.severity ||
    b.counts[3] - a.counts[3] ||
    b.counts[2] - a.counts[2] ||
    b.counts[1] - a.counts[1] ||
    String(a.projectName).localeCompare(String(b.projectName));
}

/**
 * Turns one alerting digest into the model behind its table rows: one item
 * per affected report, the reports still running that have no other
 * problem, and how many reports are red, yellow and still running. Each
 * report is counted once, under its worst color.
 */
function buildProjectAlertModel_(evaluation) {
  const digest = evaluation.digest;
  const result = evaluation.result;
  const items = buildAlertItems_(digest, result);
  const itemsByKey = new Map(items.map(function(item) {
    return [item.key, item];
  }));
  const processing = [];
  const seenProcessing = new Set();

  result.processingRows.forEach(function(row) {
    const report = normalizeText_(row.report);
    const key = report.toLowerCase();

    if (itemsByKey.has(key)) {
      // The report has a problem from an earlier run and a new run had started.
      itemsByKey.get(key).running = true;
    } else if (report && !seenProcessing.has(key)) {
      seenProcessing.add(key);
      processing.push({ report: report, reportUrl: row.reportUrl || '' });
    }
  });

  // A report can appear in several tables of the digest and only some of them
  // link it, so take its link from whichever table has one.
  const links = reportLinksByName_(digest);

  items.forEach(function(item) {
    if (!/^https?:\/\//i.test(item.reportUrl)) {
      item.reportUrl = links.get(item.key) || item.reportUrl;
    }
  });

  processing.forEach(function(row) {
    if (!/^https?:\/\//i.test(row.reportUrl)) {
      row.reportUrl = links.get(normalizeText_(row.report).toLowerCase()) || row.reportUrl;
    }
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

  const counts = { 3: 0, 2: 0, 1: processing.length };

  items.forEach(function(item) {
    counts[item.severity]++;
  });

  unexplained.forEach(function(section) {
    counts[ALERT_SECTION_SEVERITY[section.key] || 2] += digest.sectionCounts[section.key] || 1;
  });

  if (counts[3] + counts[2] + counts[1] === 0) {
    counts[severity] = 1;
  }

  return {
    digest: digest,
    projectName: digest.projectName,
    severity: severity,
    items: items,
    processing: processing,
    unexplained: unexplained,
    counts: counts
  };
}

/**
 * Every report link found in a digest, by lowercase report name: the main
 * table first, then the other tables (failed runs, data validation, ...).
 */
function reportLinksByName_(digest) {
  const links = new Map();
  const add = function(row) {
    const key = normalizeText_(row.report).toLowerCase();
    const url = String(row.reportUrl || '').trim();

    if (key && /^https?:\/\//i.test(url) && !links.has(key)) {
      links.set(key, url);
    }
  };

  digest.rows.forEach(add);
  Object.keys(digest.alertDetails || {}).forEach(function(key) {
    (digest.alertDetails[key] || []).forEach(add);
  });

  return links;
}

/**
 * Collects every finding for a digest into one item per report.
 */
function buildAlertItems_(digest, result) {
  const byReport = new Map();

  const add = function(row, findings, redundantIfFlagged) {
    const report = normalizeText_(row.report);

    if (!report || findings.length === 0) {
      return;
    }

    const key = report.toLowerCase();
    const existing = byReport.get(key);
    const severity = findings.reduce(function(highest, finding) {
      return Math.max(highest, ISSUE_KINDS[finding.kind].severity);
    }, 0);

    if (!existing) {
      byReport.set(key, {
        report: report,
        key: key,
        reportUrl: row.reportUrl || '',
        severity: severity,
        findings: findings.slice(),
        running: false
      });
      return;
    }

    // Already explained by the flagged row, so do not say it twice.
    if (redundantIfFlagged) {
      return;
    }

    existing.severity = Math.max(existing.severity, severity);

    if (!existing.reportUrl && row.reportUrl) {
      existing.reportUrl = row.reportUrl;
    }

    findings.forEach(function(finding) {
      existing.findings.push(finding);
    });
  };

  result.flaggedRows.forEach(function(row) {
    add(row, describeFlaggedRow_(row), false);
  });

  result.trendAlerts.forEach(function(alert) {
    add(alert.row, describeTrendAlert_(alert), false);
  });

  ALERT_SECTIONS.forEach(function(section) {
    (result.alertDetails[section.key] || []).forEach(function(detail) {
      const finding = describeSectionDetail_(section.key, detail);

      add(detail, [{ kind: finding.kind, text: finding.text }], finding.redundantIfFlagged === true);
    });
  });

  return Array.from(byReport.values()).sort(function(a, b) {
    return b.severity - a.severity ||
      itemTopRank_(a) - itemTopRank_(b) ||
      a.report.localeCompare(b.report);
  });
}

/**
 * The findings shown for a report: only those of its worst color. A report
 * that is red shows its red problems only, so "up 2%" never sits next to a
 * failed run. Everything else is still in the sheet.
 */
function itemShownFindings_(item) {
  return item.findings
    .filter(function(finding) {
      return ISSUE_KINDS[finding.kind].severity === item.severity;
    })
    .sort(function(a, b) {
      return ISSUE_KINDS[a.kind].rank - ISSUE_KINDS[b.kind].rank;
    });
}

/**
 * Rank of the first problem shown for a report, used to keep reports with the
 * same problem next to each other in the table.
 */
function itemTopRank_(item) {
  const shown = itemShownFindings_(item);

  return shown.length > 0 ? ISSUE_KINDS[shown[0].kind].rank : 99;
}

/**
 * The problem in a few words, such as "Run failed, QA failed" or
 * "0 records, new run started". Not shown in the table for now (the Status
 * column shows only the color); kept for previews and a later layout.
 */
function itemIssueText_(item) {
  const texts = [];

  itemShownFindings_(item).forEach(function(finding) {
    if (texts.indexOf(finding.text) === -1) {
      texts.push(finding.text);
    }
  });

  if (texts.length === 0) {
    texts.push('Needs a look');
  }

  if (item.running) {
    texts.push('new run started');
  }

  return texts.join(', ');
}

/**
 * "2,108 records, usually 2,124". The usual number is the average shown in
 * the digest.
 */
function countVersusUsualText_(count, average) {
  const usual = Math.round(Number(average) || 0);
  let text = formatNumber_(count) + (Number(count) === 1 ? ' record' : ' records');

  if (usual > 0) {
    text += ', usually ' + formatNumber_(usual);
  }

  return text;
}

/**
 * "Fill rate 19%, usually 80%".
 */
function fillVersusUsualText_(fill, average) {
  const usual = Math.round(Number(average) || 0);
  let text = 'Fill rate ' + Math.round(Number(fill) || 0) + '%';

  if (usual > 0) {
    text += ', usually ' + usual + '%';
  }

  return text;
}

/**
 * Splits a flagged report row into separate findings, one fact each: its
 * record count and its fill rate. A row with 0 records is red; every other
 * flagged row is yellow, exactly as before.
 */
function describeFlaggedRow_(row) {
  const comment = String(row.comment || '').toUpperCase();
  const fillNotApplicable = isFillRateNotApplicable_(row);
  const flagsFill = comment.indexOf('FILL') !== -1 && !fillNotApplicable;
  const flagsCount = comment.indexOf('COUNT') !== -1 || !flagsFill;
  const count = Number(row.currentCount) || 0;
  const diff = row.displayedCountDiff;
  const fill = Number(row.currentFillRate) || 0;
  const findings = [];

  if (count === 0) {
    findings.push({ kind: 'noData', text: '0 records' });
  } else if (flagsCount) {
    let kind = 'countChange';

    if (diff !== null && diff < 0) {
      kind = 'drop';
    } else if (diff !== null && diff > 0) {
      kind = 'rise';
    }

    findings.push({
      kind: kind,
      text: countVersusUsualText_(count, row.displayedAverageCount)
    });
  }

  if (count > 0 && fill === 0 && !fillNotApplicable) {
    findings.push({ kind: 'emptyFields', text: 'Fill rate 0%' });
  } else if (count > 0 && flagsFill && fill < 100) {
    findings.push({
      kind: 'lowFill',
      text: fillVersusUsualText_(fill, row.displayedAverageFillRate)
    });
  }

  if (findings.length === 0) {
    findings.push({ kind: 'flagged', text: 'Flagged by the digest' });
  }

  return findings;
}

/**
 * Explains a seven-day trend drop. Only used when trendCheckEnabled is true.
 */
function describeTrendAlert_(alert) {
  const findings = [];

  if (alert.countDrop > CONFIG.countDropPercent) {
    findings.push({
      kind: 'drop',
      text: countVersusUsualText_(alert.row.currentCount, alert.averageCount)
    });
  }

  if (alert.fillRateDrop > CONFIG.fillRateDropPoints) {
    findings.push({
      kind: 'lowFill',
      text: fillVersusUsualText_(alert.row.currentFillRate, alert.averageFillRate)
    });
  }

  return findings;
}

/**
 * Explains a row from a secondary alert table (failed runs, validation, ...).
 */
function describeSectionDetail_(sectionKey, detail) {
  const status = normalizeText_(detail.status);
  const isSuccess = /^success/i.test(status);

  if (sectionKey === 'failedRuns') {
    const records = detail.recordCount === undefined ? '' : String(detail.recordCount).trim();

    if (isSuccess) {
      // The run finished but brought nothing back, which is the same problem
      // as "0 records", so it is called that everywhere.
      if (/^0+(\.0+)?$/.test(records || '0')) {
        return { kind: 'noData', text: '0 records', redundantIfFlagged: true };
      }

      return { kind: 'runFailed', text: 'Run flagged as failed' };
    }

    return {
      kind: 'runFailed',
      text: status === '' || /fail/i.test(status)
        ? 'Run failed'
        : 'Run ended as ' + status.toLowerCase()
    };
  }

  if (sectionKey === 'missedRuns') {
    return { kind: 'missedRun', text: 'Missed its schedule' };
  }

  if (sectionKey === 'longRunning') {
    return { kind: 'slowRun', text: 'Running long' };
  }

  if (sectionKey === 'dataValidation') {
    return {
      kind: 'validation',
      text: /fail/i.test(status) || status === ''
        ? 'QA failed'
        : 'QA status: ' + status.toLowerCase()
    };
  }

  if (sectionKey === 'failedTasks') {
    const failedCount = Number(detail.failedChildTasks);

    return {
      kind: 'failedTasks',
      text: Number.isFinite(failedCount) && failedCount > 1
        ? failedCount + ' child processes failed'
        : 'Child process failed'
    };
  }

  if (sectionKey === 'crawlerAnomalies') {
    return { kind: 'anomaly', text: 'Crawler output looks unusual' };
  }

  return { kind: 'anomaly', text: 'Fields look unusual' };
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
 * The project name without its client part: "Averon Group-Averon_Group
 * (monthly)" becomes "Averon Group (monthly)". It cuts at the last hyphen and
 * keeps the weekly or monthly label.
 */
function shortProjectName_(projectName) {
  const full = normalizeText_(projectName);
  const match = full.match(/^(.*?)((?:\s+\((?:weekly|monthly)\))?)$/i);
  const base = match ? match[1] : full;
  const period = match ? match[2] : '';
  const cut = base.lastIndexOf('-');
  const short = cut > 0 ? base.slice(0, cut).trim() : base;

  return (short || base) + period;
}

/**
 * Short names for every project in the alert. When two different projects
 * would end up with the same short name, both keep their full names so they
 * can still be told apart.
 */
function shortProjectNames_(models) {
  const fullNamesByShort = new Map();

  models.forEach(function(model) {
    const key = shortProjectName_(model.projectName).toLowerCase();

    if (!fullNamesByShort.has(key)) {
      fullNamesByShort.set(key, new Set());
    }

    fullNamesByShort.get(key).add(model.projectName);
  });

  const names = new Map();

  models.forEach(function(model) {
    const short = shortProjectName_(model.projectName);

    names.set(
      model.projectName,
      fullNamesByShort.get(short.toLowerCase()).size > 1 ? model.projectName : short
    );
  });

  return names;
}

/**
 * Splits mrkdwn lines across section blocks under Slack's text limit. Used
 * when Slack refuses a table and the same rows are posted as plain lines.
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
 * A plain text table cell.
 */
function rawCell_(text) {
  const value = alertTrim_(normalizeText_(text), CONFIG.maximumCellCharacters);

  return { type: 'raw_text', text: value || '-' };
}

/**
 * A formatted table cell made of rich text elements (text, emoji, links).
 */
function richCell_(elements) {
  return {
    type: 'rich_text',
    elements: [{ type: 'rich_text_section', elements: elements }]
  };
}

/**
 * The Project cell: the short project name, plus the owner's Slack tag when
 * PROJECT_OWNERS lists one.
 */
function projectCell_(name, projectName) {
  const owner = PROJECT_OWNERS[projectName];
  const text = alertTrim_(normalizeText_(name), CONFIG.maximumCellCharacters) || '-';

  if (!owner) {
    return rawCell_(text);
  }

  return richCell_([
    { type: 'text', text: text + ' ' },
    { type: 'user', user_id: owner }
  ]);
}

/**
 * The Report cell: the report name, linked to the report page when the
 * digest has a link for it.
 */
function reportCell_(row) {
  const name = alertTrim_(normalizeText_(row.report), CONFIG.maximumCellCharacters) || '-';
  const url = String(row.reportUrl || '').trim();

  if (/^https?:\/\//i.test(url)) {
    return richCell_([{ type: 'link', url: url, text: name }]);
  }

  return rawCell_(name);
}

/**
 * The Status cell: only the colored dot (red, yellow or hourglass).
 */
function statusCell_(severity) {
  return richCell_([{ type: 'emoji', name: ALERT_EMOJI[severity] }]);
}

/**
 * Notification text for the message: "Crawler digest: 5 projects need
 * action · 8 worth a look · 3 still running". Slack shows it in
 * notifications; the message itself is only the table.
 */
function alertHeadline_(models) {
  const totals = { 3: 0, 2: 0, 1: 0 };

  models.forEach(function(model) {
    totals[model.severity]++;
  });

  const parts = [
    totals[3] === 0
      ? 'nothing needs action'
      : alertPlural_(totals[3], 'project') + (totals[3] === 1 ? ' needs' : ' need') + ' action'
  ];

  if (totals[2] > 0) {
    parts.push(totals[2] + ' worth a look');
  }

  if (totals[1] > 0) {
    parts.push(totals[1] + ' still running');
  }

  return 'Crawler digest: ' + parts.join(' · ');
}

/**
 * Every table row of the alert, worst project first and worst report first
 * inside each project: [Project, Report, Status].
 */
function buildAlertTableRows_(models) {
  const names = shortProjectNames_(models);
  const rows = [];

  models.forEach(function(model) {
    const project = function() {
      return projectCell_(names.get(model.projectName), model.projectName);
    };
    const before = rows.length;

    model.items.forEach(function(item) {
      rows.push([project(), reportCell_(item), statusCell_(item.severity)]);
    });

    model.unexplained.forEach(function(section) {
      rows.push([
        project(),
        rawCell_(section.label + ' (' + model.digest.sectionCounts[section.key] + ')'),
        statusCell_(ALERT_SECTION_SEVERITY[section.key] || 2)
      ]);
    });

    model.processing.forEach(function(row) {
      rows.push([project(), reportCell_(row), statusCell_(1)]);
    });

    // A flag with no report name still gets a row, so no project disappears.
    if (rows.length === before) {
      rows.push([project(), rawCell_('-'), statusCell_(model.severity)]);
    }
  });

  return rows;
}

/**
 * Characters a row adds to a table. With countLinks, link addresses count
 * too, which is the safe reading of Slack's limit.
 */
function tableRowCharacters_(row, countLinks) {
  return row.reduce(function(total, cell) {
    if (cell.type !== 'rich_text') {
      return total + String(cell.text).length;
    }

    return total + cell.elements[0].elements.reduce(function(sum, element) {
      return sum + String(element.text || element.name || element.user_id || '').length +
        (countLinks && element.url ? element.url.length : 0);
    }, 0);
  }, 0);
}

/**
 * Splits rows into tables that fit Slack's limits: maximumTableRows rows per
 * table including the header, and maximumTableCharacters per table.
 */
function packTableRows_(rows, countLinks) {
  const header = [rawCell_('Project'), rawCell_('Report'), rawCell_('Status')];
  const headerCharacters = tableRowCharacters_(header, countLinks);
  const tables = [];
  let current = [];
  let characters = headerCharacters;

  rows.forEach(function(row) {
    const size = tableRowCharacters_(row, countLinks);

    if (current.length > 0 &&
        (current.length + 1 >= CONFIG.maximumTableRows ||
         characters + size > CONFIG.maximumTableCharacters)) {
      tables.push(current);
      current = [];
      characters = headerCharacters;
    }

    current.push(row);
    characters += size;
  });

  if (current.length > 0) {
    tables.push(current);
  }

  return tables.map(function(tableRows) {
    return [{
      type: 'table',
      column_settings: [{ is_wrapped: true }, { is_wrapped: true }, { is_wrapped: true }],
      rows: [header].concat(tableRows)
    }];
  });
}

/**
 * The messages of one alert, as Slack would get them on a normal day: one
 * message with the table, or more when the table is too long for one.
 */
function buildAlertMessages_(models) {
  const headline = alertHeadline_(models);
  const tables = packTableRows_(buildAlertTableRows_(models), false);

  return tables.map(function(blocks, index) {
    return {
      text: index === 0 ? headline : headline + ' (continued ' + (index + 1) + '/' + tables.length + ')',
      blocks: blocks
    };
  });
}

/**
 * True for Slack errors caused by the size or shape of the blocks, where
 * posting smaller tables or plain lines can still succeed.
 */
function isLayoutError_(error) {
  return /invalid_blocks|invalid_attachments|msg_too_long|too_many_attachments|only_one_table|invalid_arguments/i
    .test(String(error && error.message));
}

/**
 * Posts one message. If Slack refuses the layout, the same table is split
 * with link addresses counted, and any part still refused is posted as plain
 * lines. Errors that are not about the layout (no access to the channel,
 * bad token and so on) are thrown.
 */
function postTableMessage_(slack, message) {
  const post = function(text, blocks) {
    return slackApi_(slack.token, 'chat.postMessage', {
      channel: slack.channel,
      text: text,
      blocks: blocks,
      unfurl_links: false,
      unfurl_media: false
    });
  };

  try {
    return post(message.text, message.blocks);
  } catch (error) {
    if (!isLayoutError_(error)) {
      throw error;
    }

    console.log('Slack refused the table (%s). Posting it in smaller parts.', error.message);
  }

  const parts = packTableRows_(message.blocks[0].rows.slice(1), true);
  let first = null;

  parts.forEach(function(blocks, index) {
    if (index > 0) {
      Utilities.sleep(CONFIG.slackReplyDelayMs);
    }

    let response;

    try {
      response = post(message.text, blocks);
    } catch (error) {
      if (!isLayoutError_(error)) {
        throw error;
      }

      console.log('Slack refused a table part (%s). Posting it as plain lines.', error.message);
      response = post(message.text, tablesToSectionBlocks_(blocks));
    }

    first = first || response;
  });

  return first;
}

/**
 * Posts the alert to one channel. Throws if the first message fails, so the
 * channel keeps its window and gets these digests on the next run. A later
 * part that fails is tried once more; anything still failing is returned.
 */
function postAlertMessage_(slack, models) {
  const messages = buildAlertMessages_(models);
  const outcome = { errors: [] };

  postTableMessage_(slack, messages[0]);

  messages.slice(1).forEach(function(message) {
    Utilities.sleep(CONFIG.slackReplyDelayMs);

    try {
      postTableMessage_(slack, message);
    } catch (error) {
      Utilities.sleep(3000);

      try {
        postTableMessage_(slack, message);
      } catch (retryError) {
        outcome.errors.push('continued message: ' + retryError.message);
      }
    }
  });

  return outcome;
}

/**
 * Replaces every table block with plain mrkdwn lines, one line per row.
 */
function tablesToSectionBlocks_(blocks) {
  const output = [];

  blocks.forEach(function(block) {
    if (block.type !== 'table') {
      output.push(block);
      return;
    }

    const lines = block.rows.slice(1).map(function(row) {
      const cells = row.map(tableCellToMrkdwn_);

      return '• ' + cells[0] + '  ·  ' + cells[1] + ': ' + cells[2];
    });

    alertSectionBlocks_(output, lines);
  });

  return output;
}

/**
 * The text of one table cell as Slack mrkdwn.
 */
function tableCellToMrkdwn_(cell) {
  if (cell.type !== 'rich_text') {
    return escapeSlack_(cell.text);
  }

  return cell.elements[0].elements.map(function(element) {
    if (element.type === 'emoji') {
      return ':' + element.name + ':';
    }

    if (element.type === 'user') {
      return '<@' + element.user_id + '>';
    }

    if (element.type === 'link') {
      return '<' + element.url + '|' + escapeSlack_(element.text) + '>';
    }

    return escapeSlack_(element.text);
  }).join('');
}

/**
 * The whole alert as plain text, for previewPlannedAlert and testing.
 */
function alertPreviewText_(models) {
  return buildAlertMessages_(models).map(function(message, index) {
    return '=== message ' + (index + 1) + ' (notification: ' + message.text + ') ===\n' +
      blocksToPlainText_(message.blocks);
  }).join('\n\n');
}

/**
 * Renders Slack blocks as readable plain text, tables included.
 */
function blocksToPlainText_(blocks) {
  const plain = function(text) {
    return String(text)
      .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  };

  return blocks.map(function(block) {
    if (block.type === 'section') {
      return plain(block.text.text);
    }

    if (block.type === 'table') {
      const cells = block.rows.map(function(row) {
        return row.map(function(cell) {
          return plain(tableCellToMrkdwn_(cell));
        });
      });
      const widths = cells[0].map(function(header, column) {
        return Math.max.apply(null, cells.map(function(row) {
          return row[column].length;
        }));
      });

      return cells.map(function(row) {
        return '| ' + row.map(function(text, column) {
          return text + new Array(widths[column] - text.length + 1).join(' ');
        }).join(' | ') + ' |';
      }).join('\n');
    }

    return '';
  }).join('\n');
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
 * Debug helper: parses the newest digest in the current window (saved start
 * to now) and logs its evaluation without Slack. Never changes the saved
 * window.
 */
function testLatestDigest() {
  const spreadsheet = getBoundSpreadsheet_();
  const currentDigests = loadCurrentDigests_();

  if (currentDigests.length === 0) {
    throw new Error('No digest was found since the last run.');
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
      ? alertPreviewText_([buildProjectAlertModel_({ digest: latest, result: evaluation })])
      : 'No Slack alert.'
  }, null, 2));
}

/**
 * Debug helper: adds the digests of the current window to today's sheet
 * without posting anything to Slack. Never changes the saved window.
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
  console.log('Updated %s with %s digest(s) and %s report row(s).',
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
 * The alert models of the current window (earliest saved start to now),
 * built the same way a run builds them, without writing the sheet.
 */
function loadAlertModelsNow_(spreadsheet, sheetName) {
  const sheetHistory = loadHistoryFromDailySheets_(spreadsheet, sheetName);
  const evaluations = loadCurrentDigests_().map(function(digest) {
    return {
      digest: digest,
      result: evaluateDigest_(digest, getPriorHistory_(digest, sheetHistory))
    };
  });

  return buildAlertModels_(evaluations);
}

/**
 * Manual helper: posts the alerting digests of the current window (saved
 * start to now) to EVERY channel in SLACK_CHANNEL_ID right now, so the
 * layout can be checked without waiting for a trigger. It does not move the
 * saved window. To keep it out of the shared channel, put only a test
 * channel in SLACK_CHANNEL_ID first.
 */
function postAlertThreadNow() {
  const slack = getSlackBotConfig_();
  const spreadsheet = getBoundSpreadsheet_();
  const models = loadAlertModelsNow_(spreadsheet, dailySheetName_(new Date()));

  if (models.length === 0) {
    throw new Error('No alerting digests found in the current window to post.');
  }

  const outcome = postAlertToChannels_(slack, slack.channels, models);

  if (outcome.errors.length > 0) {
    throw new Error('Some posts failed: ' + outcome.errors.join(' | '));
  }
}

/**
 * Read only check: writes the alert the next run would post (digests since
 * the saved start) into the execution log as plain text. Posts nothing and
 * writes nothing.
 */
function previewPlannedAlert() {
  const spreadsheet = getBoundSpreadsheet_();
  const alertWindow = resolveAlertWindow_(new Date());
  const models = loadAlertModelsNow_(spreadsheet, dailySheetName_(new Date()));

  console.log('Window: %s to %s.', formatWindowTime_(alertWindow.start), formatWindowTime_(alertWindow.end));

  if (models.length === 0) {
    console.log('Nothing needs attention. Nothing would be posted.');
    return;
  }

  console.log(alertPreviewText_(models));
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

/**
 * Manual helper: sets where the next run's window starts, for every channel,
 * so a past period can be posted again.
 *
 * Usage: EDIT THE DATE BELOW FIRST, run this once, then run
 * monitorDigestAlerts (or wait for the next trigger). The time is read in
 * reportTimezone, format 'yyyy-MM-dd HH:mm'. The next run covers everything
 * from that time up to the moment it runs (capped at maximumWindowHours).
 * Times more than two days back or in the future are refused, so running it
 * by accident with an old date cannot flood the channel.
 */
function resetWindowTo() {
  const startText = '2026-10-08 10:00'; // <-- EDIT THIS
  const match = startText.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})$/);

  if (!match) {
    throw new Error('Use the format yyyy-MM-dd HH:mm, for example 2026-10-08 10:00.');
  }

  const now = new Date();
  const windowStart = localTimeToMilliseconds_(match[1], match[2], match[3]);

  if (windowStart > now.getTime() || now.getTime() - windowStart > 48 * 60 * 60 * 1000) {
    throw new Error('Pick a time within the last two days. ' + startText +
      ' is in the future or older than that. Edit startText first.');
  }

  saveAlertState_(PropertiesService.getScriptProperties(), windowStart, {}, now);
  console.log('Next run will start from %s (%s).', startText, CONFIG.reportTimezone);
}

/**
 * Read only check for report links. Looks at the digests of the last 24
 * hours and logs every report the alert would show without a link. Posts
 * nothing and writes nothing.
 */
function checkReportLinks() {
  const now = Date.now();
  const digests = loadCurrentDigests_({ start: now - 24 * 60 * 60 * 1000, end: now });
  const models = buildAlertModels_(digests.map(function(digest) {
    return { digest: digest, result: evaluateDigest_(digest, []) };
  }));
  let total = 0;
  let missing = 0;

  models.forEach(function(model) {
    model.items.concat(model.processing).forEach(function(row) {
      total++;

      if (!/^https?:\/\//i.test(String(row.reportUrl || '').trim())) {
        missing++;
        console.log('NO LINK | %s | %s', model.projectName, row.report);
      }
    });
  });

  console.log('%s of %s report(s) in the alert have a link.', total - missing, total);

  if (missing > 0) {
    console.log('For each report listed above, no table in its digest email has a link ' +
      'in that row. Open one of those digests in Gmail to confirm.');
  }
}
