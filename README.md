# UDM weekly report

Every Friday at 09:00 Malaysia time a GitHub Action reads UDM's time logs and tasks from
Rework Project (v3) and posts a report to Discord. On the first Friday of a month it also posts
last month's hours per client and scope, for checking retainers.

## What the report shows

Built from the 15 Oct 2026 review with Matthew and Fiona, in their order of priority:

| Section | Numbers | Why |
|---|---|---|
| 💰 Client hours | Top 5 clients, month-to-date, hours added this week, top 3 scopes each | Client profitability against retainer hours |
| 👥 Team time | Hours this week vs last week, avg vs 8h/working-day benchmark, by team, top 5 people, who logged nothing | Is the team using its time well |
| ✅ Deliverables | Tasks completed this week, done of total, overdue by client | Delivery |
| 🔁 Revisions | Logs whose title or task says revision/amend/re-edit/changes, hours, most-revised tasks | Comeback jobs and scope creep |
| 🕘 Internal time | Hours on Unravel, Admin and Clock-in services | Secondary |
| 🧹 Data hygiene | Logs with no title of their own, timers over 12h left out | Keeps logging habits clean |

Rules: the week is the 7 days before the run day (Friday–Thursday); month-to-date runs to the
day before. One timer session over 12h counts as left running and is excluded. Teams come from
`udm_report/teams.json`, because Rework has no departments yet; update it when staff change.

## Setup

Repository secrets (Settings → Secrets and variables → Actions):

- `REWORK_API_BASE`, `REWORK_API_TOKEN`: Rework API base URL and a read-only token
- `DISCORD_WEBHOOK_URL`: the channel's webhook

Optional variable `DASHBOARD_URL` adds a link at the end. If the Rework API paths differ from
the defaults in `udm_report/source.py`, set `REWORK_PATH_*` the same way.

Run it once by hand from the Actions tab (**Weekly report → Run workflow**). It prints the
report in the log; untick *dry run* to post it.

## Dashboard

`site/` is the time & delivery dashboard (static: `index.html`, `app.js`, `style.css`, `vendor/d3`,
`data/*.json`). Tabs: **Dashboard** (hours by day/week/month, by project, by person, one person's
tasks), **Team report** (hours and tasks per person as a share of their own team), **Delivery**
(done / open / overdue by client), **Management** (client hours by scope, revisions, internal time)
and **Data quality** (timers left running, logs without a title). Filters: date range, client,
service, team, person. Everything is in hours.

`data/` holds the 1–9 Oct 2026 demo snapshot until Rework exposes time logs and task details
through its API; then `udm_report.export` refreshes it.

### Sign-in (Google, company accounts only)

`middleware.js` guards every page and data file; `api/auth/*` does the Google sign-in. Until these
are set in Vercel (Project → Settings → Environment Variables), the site shows a setup notice and
no data:

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud → APIs & Services → Credentials → OAuth client ID (Web application), redirect URI `https://<site>/api/auth/callback` |
| `SESSION_SECRET` | a long random string (changing it signs everyone out) |
| `ALLOWED_DOMAIN` | `unravel.com.my` |
| `ALLOWED_EMAILS` | optional, comma-separated extra addresses |

Sessions last 7 days. Tests: `node --test tests/auth.test.mjs`.

## Locally

```
python -m unittest discover -s tests
python -m udm_report --from-dir saved-responses/ --date 2026-10-16 --dry-run
```
