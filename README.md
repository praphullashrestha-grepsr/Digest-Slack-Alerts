# Digest Monitor

A Google Apps Script that reads Grepsr digest emails from your Gmail and posts one Slack table of the reports that need attention, at the times your team picks.

| Project | Report | Status |
|---|---|---|
| Ventura TV (weekly) | Homedepot.com | 🔴 |
| Defensoria Salud | CO report V2 - Node | 🟡 |

🔴 act now (0 records, failed run, failed QA rules, failed child process) · 🟡 worth a look (count or fill rate alert, long run) · ⏳ still running

Each alert covers the digests since the previous one. Nothing is posted if nothing needs attention. Every digest is also logged to a daily tab in the sheet.

## Setup

Use the Google account that receives the digest emails.

1. In a new Google Sheet, open **Extensions > Apps Script**, paste `Code.gs` and save.
2. Invite the bot to your Slack channel (`/invite @[bot name]`) and copy the channel's **Channel ID** (click the channel name, it's at the bottom).
3. In **Project Settings > Script Properties**, add:

   | Property | Example |
   |---|---|
   | `SLACK_BOT_TOKEN` | `xoxb-...` (ask [owner]) |
   | `SLACK_CHANNEL_ID` | `C0123ABCD9` (several allowed, comma separated) |
   | `ALERT_TIMES` | `10:00, 13:00, 16:00` or `10am, 1pm, 4pm` |

4. Run **setupMonitoring** and allow the permissions. The log shows the booked runs.

**Upgrading from the old 10:30 version:** delete all triggers in the **Triggers** page, note your team's changes in `CONFIG`, paste the new `Code.gs`, put your changes back, add `ALERT_TIMES` (keep the other properties, including `LAST_ALERT_STATE`), then run **setupMonitoring**.

## Alert times

Don't add triggers by hand. `setupMonitoring` books one trigger per time in `ALERT_TIMES`, and each run books the next day's, weekends included. To change times, edit `ALERT_TIMES` and run **setupMonitoring** again. Don't delete the `runScheduledAlert` triggers; those are the bookings.

## Functions

| Function | Use |
|---|---|
| `setupMonitoring` | Start or repair the schedule, or apply new `ALERT_TIMES` |
| `previewPlannedAlert` | Show the next alert in the log without posting |
| `postAlertThreadNow` | Post the alert now (try a test channel first) |
| `checkReportLinks` | List recent reports with no link |
| `testSlackBot` | Check the bot can post in your channels |
| `checkWeeklyAndMonthlyDigests` | Check weekly and monthly digests can be read |
| `resetWindowTo` | Re-post a past period (edit the date inside first) |
| `testLatestDigest`, `testDailySummarySheet` | Debugging |

## Customizing

In `CONFIG` at the top of `Code.gs`:

* `ignoredProjects`: projects to skip, written as in the digest subject
* `reportTimezone`: change if your team isn't on Nepal time
* `ignoredSections`: digest sections that never alert

Below it, `PROJECT_OWNERS` tags a person next to their project (project name and Slack member ID).

## Troubleshooting

* **No message:** probably nothing was flagged. Check **Executions**.
* **`not_in_channel`:** invite the bot to the channel.
* **Wrong hour:** check `reportTimezone`.
* **Anything else:** send [owner] the error from **Executions**.
