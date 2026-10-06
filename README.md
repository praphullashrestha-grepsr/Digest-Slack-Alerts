# Digest Monitor

Turns Grepsr digest emails into one Slack alert a day, sorted by urgency, with the details in a thread for each project.

## How it works

1. A script inside a Google Sheet checks your Gmail every 10 minutes.
2. Once a day, at or after 10:30, it reads the last 24 hours of Grepsr digests (daily, weekly and monthly).
3. It posts one message to Slack with three groups, Act now, Worth a look and Still running, and one thread per project.
4. It writes every report row to a tab in the Sheet, so you can see the data behind the alert.

## What you need

- A Google account that receives the Grepsr digest emails. The script reads the inbox of the account that owns it.
- A Slack workspace where you can add an app. Some workspaces need an admin to approve it.

## Setup

### 1. Create the Sheet and add the script

1. Create a new Google Sheet and open **Extensions > Apps Script**.
2. Replace everything in `Code.gs` with `src/Code.gs` from this repo.
3. Save.

The project should hold one file, `Code.gs`. Always create the script from inside a Sheet, never as a standalone project, because it writes its results to that Sheet.

### 2. Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps), click **Create New App > From scratch**, name it and pick your workspace.
2. In **OAuth & Permissions > Scopes > Bot Token Scopes**, add `chat:write`.
3. Click **Install to Workspace**, approve it, and copy the **Bot User OAuth Token** (it starts with `xoxb-`).
4. In Slack, open the channel you want alerts in and copy its **Channel ID** from the details panel (it looks like `C0123ABCD9`).
5. In that channel, run `/invite @YourAppName`.

### 3. Add the token and turn it on

In **Project Settings > Script properties**, add two properties:

| Property | Value |
| --- | --- |
| `SLACK_BOT_TOKEN` | The `xoxb-` token from step 2 |
| `SLACK_CHANNEL_ID` | The channel ID. For several channels, separate the IDs with commas |

Then pick `setupMonitoring` in the function dropdown and click **Run**. Add both properties first, or setup stops with an error. Approve the permission prompts for Gmail, Sheets and external requests. If Google says the app is not verified, click **Advanced** and continue. That is normal for your own script.

`setupMonitoring` creates a trigger that checks every 10 minutes. The script posts at most once a day, and only at or after 10:30, so almost every check does nothing. Setup posts nothing to Slack.

### 4. Test before trusting it

Run each from the function dropdown, in this order:

1. `testSlackBot` posts a test message with a thread reply to every channel in `SLACK_CHANNEL_ID`. Use a private test channel first, because everyone in the channel sees it.
2. `refreshDigestSheet` reads the last 24 hours of digests and fills today's tab in the Sheet. It posts nothing. Compare the tab with your inbox.
3. `postAlertThreadNow` posts the alert for the last 24 hours to every channel right now. It does not count as the day's alert, so the scheduled one still runs.

## What you will see

- One message a day, at or after 10:30, covering the last 24 hours of digests (from 10:30 yesterday). On a clean day it posts nothing.
- **Act now:** a report with 0 records, a failed run, failed QA rules (the digest's Data validation section), a failed child process (the Failed tasks section).
- **Worth a look:** every count alert and fill rate alert the digest raises, and long running crawlers.
- **Still running:** a report still in progress. A project shows up in this group only when that is all that was found for it. Otherwise the running reports appear as a note in its thread.
- A project takes the color of its worst report.
- One thread per project with the details. Weekly and monthly digests are labelled, for example "(weekly)".
- A digest that arrives after the alert shows up in the next day's alert.
- Left out on purpose: crawler and profiler anomalies, missed runs, JSON reports flagged only for fill rate, and ignored projects.

Silence means either a clean day or a problem with the script. To tell which, open **Executions** in Apps Script, open the latest `monitorDigestAlerts` run after 10:30 and read its log. It says whether it posted, found nothing to report, or had already handled the day.

Limits to know: the script only sees what the digest email contains, so the digest must be set up and must arrive. If the digest layout changes, the parsing needs a small update. A report with 0 records can be normal for some crawlers, so red still needs a quick check. The goal is to save time and manual work, not to be 100% sure an issue is real.

## Settings

Edit these near the top of `Code.gs`. Changes apply on the next check. Only changing `alertCheckEveryMinutes` needs `setupMonitoring` to be run again.

| Setting | What it does | Default |
| --- | --- | --- |
| `reportTimezone` | Timezone for the alert time and the Sheet | Asia/Kathmandu |
| `alertHour`, `alertMinute` | Earliest time the alert may post | 10 and 30 |
| `alertCheckEveryMinutes` | How often the script checks whether it is time to post | 10 |
| `windowHours` | How far back each alert looks | 24 |
| `currentGmailQuery` | Which emails count as digests. Change it if yours come from another sender or have another subject | The Grepsr sender, with this day, this week or this month |
| `ignoredProjects` | Projects to skip completely, written exactly as they appear in the alert. Good for crawlers that normally return 0 records | Empty |
| `ignoredSections` | Digest sections to skip | Crawler anomalies, profiler anomalies, missed runs |
| `PROJECT_OWNERS` | A project name and a Slack member ID, so the owner is tagged in that project's thread | Empty |
| `trendCheckEnabled` | An optional 7 day comparison that also catches slow declines | false (off) |

To find a Slack member ID, open the person's profile, click the three dots and choose **Copy member ID**.

## If something goes wrong

| You see | What to do |
| --- | --- |
| "Add SLACK_BOT_TOKEN and SLACK_CHANNEL_ID..." | A property is missing, or has a typo or a trailing space. Check step 3. |
| `not_in_channel` | Run `/invite @YourAppName` in that channel. |
| `invalid_auth` | Copy the `xoxb-` token again and save it. |
| `channel_not_found` | Use the channel ID (it starts with C), not the channel name. |
| "Identifier 'CONFIG' has already been declared" | The code was pasted twice, or another file holds a copy of it. The project should have one file, `Code.gs`, with the code once. |
| "Attach this Apps Script project to the destination Google Sheet" | The script was not created from inside a Sheet. Redo step 1. |
| No alert today | It is before 10:30, the day was clean, or today's alert was already posted. Check Triggers for `monitorDigestAlerts` every 10 minutes, and read the latest run in Executions. Run `postAlertThreadNow` to post one now. |
| A project is missing from the alert or the Sheet | Its digest arrived after the alert (it shows up tomorrow), is older than 24 hours, has a subject that does not end with the project name and then this day, this week or this month, or is in `ignoredProjects`. Open Executions and look for "Skipped unrecognized digest". |
| Weekly or monthly digests are missing | Run `checkWeeklyAndMonthlyDigests` and read the log. It lists them and says whether each one can be read. |

## Updating

Change `src/Code.gs` in this repo, then paste the new code into the Apps Script editor of each Sheet that uses it. Script properties and triggers stay as they are, but your edits to the settings above are replaced, so re-apply them after pasting.

## Keep secrets out of the repo

The Slack bot token lives only in each Sheet's Script properties. Never put it in the code, in a commit or in chat. Anyone who can edit a Sheet can read its Script properties, so share working Sheets as view only. If the token leaks, create a new one in the Slack app and replace it.

## Repo layout

```
src/Code.gs    The script: reads digests, decides what matters, posts to Slack
README.md      This guide
```
