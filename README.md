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

- `REWORK_API_TOKEN`: the **Secret** of the Project key (Settings app → APIs → API keys), sent as `X-API-TOKEN`. `REWORK_API_KEY`: the **API key** of the same key, sent as `Authorization: Bearer`. `REWORK_API_BASE` is optional (default `https://api-v3.rework.com/project`)
- `DISCORD_WEBHOOK_URL`: the channel's webhook

Optional variable `DASHBOARD_URL` adds a link at the end. If the Rework API paths differ from
the defaults in `udm_report/source.py`, set `REWORK_PATH_*` the same way.

There is no workflow for the weekly report any more; run it by hand with
`python -m udm_report --dry-run` (prints) or without `--dry-run` (posts). To check the Rework API
connection, run **Refresh dashboard data** from the Actions tab with *ping only* ticked.

## Dashboard

`site/` is the time & delivery dashboard (static: `index.html`, `app.js`, `style.css`, `vendor/d3`,
`data/*.json`). Tabs: **Dashboard** (hours by day/week/month, by project, by person, one person's
tasks), **Team report** (hours and tasks per person as a share of their own team), **Delivery**
(done / open / overdue by client), **Management** (client hours by scope, revisions, internal time)
and **Data quality** (timers left running, logs without a title). Filters: date range, client,
service, team, person. Everything is in hours.

`data/` holds the 1–9 Oct 2026 demo snapshot until Rework exposes time logs and task details
through its API; then `udm_report.export` refreshes it.

### Password

`middleware.js` shows a password page before any page or data file; `api/auth/login` checks it and
sets a signed cookie for 7 days, `api/auth/logout` clears it. The default password is stored only as
a SHA-256 hash in `lib/session.js`. To change it, set `SITE_PASSWORD` in Vercel (Project → Settings →
Environment Variables) and redeploy; that also signs everyone out. Tests: `node --test tests/auth.test.mjs`.

## Locally

```
python -m unittest discover -s tests
python -m udm_report --from-dir saved-responses/ --date 2026-10-16 --dry-run
```
