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

## Locally

```
python -m unittest discover -s tests
python -m udm_report --from-dir saved-responses/ --date 2026-10-16 --dry-run
```
