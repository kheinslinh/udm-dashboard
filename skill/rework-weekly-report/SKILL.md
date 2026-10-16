---
name: rework-weekly-report
description: Set up, from scratch, an automated weekly Discord report and a hosted time & delivery dashboard on a Rework customer's Project (v3) data — GitHub repo, GitHub Actions schedule, Discord webhook, Vercel/Netlify deploy. Use whenever a Rework CS person wants to walk a customer through "send our Rework report to Discord every week", "weekly time report", "deploy the dashboard", "report giờ công hằng tuần", "gửi report vào Discord", or to repeat the UDM setup for another client. Covers discovering their reporting needs, designing the report, scaffolding the repo from the bundled template, secrets, test runs, deploy and handover, plus the pitfalls already hit once.
---

# Rework weekly report + dashboard — setup playbook

You are guiding a Rework CS person (and through them, the customer) to the same end state that was
built for UDM:

1. **A weekly Discord message** (Fridays 09:00 local) with client hours month-to-date, team time vs
   benchmark, deliverables, revisions, internal time and data hygiene; on the first Friday of a month
   a second message with last month's hours per client and scope (retainer check).
2. **A hosted dashboard** (static site on Vercel or Netlify) with the same data and filters by month,
   week, client, service, team and person; data refreshed daily.
3. **One private GitHub repo per customer** holding both, run by GitHub Actions. No server, no Claude
   needed at run time.

Work through the phases in order. Each phase ends with something the person can see. Talk in the
person's language (UDM was set up in Vietnamese with an English report). Never ask anyone to paste a
token or webhook URL into the chat: they go into GitHub secrets only.

## Why this architecture (say this when asked)

- The Rework MCP connector is fine for looking around, but it has **no bulk time-log read**: time
  sessions come per service (`service-resource-items`), one call each. UDM had 80 services, ~1–2 MB a
  week. Doing that through Claude every week is slow, costly and not reproducible. A script calling the
  Rework API does the same arithmetic the same way every week, for free.
- GitHub Actions gives the schedule, the secrets store and the logs; the site redeploys when the
  daily data commit lands.

## Phase 1 — Understand the customer (30–60 min)

1. **Connect and orient.** With the customer's Rework Project v3 connector enabled, call
   `rework_pj_me` to confirm the workspace (system name, path, timezone, user list). Note the timezone:
   it drives the cron hours and `utc_offset_hours`.
2. **Map the data.** `rework_pj_admin` `group_list` = clients (service groups); `service_list`
   (model `project.project`; large, it lands in a file — read it with Python) = services, each with a
   `group_id`. Spot-check one service with `rework_pj_page` `service-resource-items`: workload items
   carry `data.recorded_meta.sessions[]` (`user_id`, `seconds`, `started_at`, `name` = log title).
   If items have no sessions, the team is logging time without a workload type — fix that in Rework
   first or the report will be empty.
3. **Get the reporting needs** from a meeting transcript or a short call. Read
   `references/report-design.md` for the questions to ask and how UDM's answers became sections.
   The usual priorities: (1) hours per client and scope month-to-date — profitability vs retainer,
   (2) team time vs benchmark, (3) deliverables and overdue, (4) revisions / comeback jobs,
   (5) internal time. Keep it short: managers read it in 30 seconds.
4. **Show a mock** of the Discord message (render it with the template, Phase 3 step 5) and agree on
   it before building anything else. Confirm: period (last 7 days + month-to-date), language,
   send time, whether to include the monthly summary.

## Phase 2 — Accounts and access (the person does these; give exact clicks)

Order matters; check each before moving on.

1. **GitHub repo.** Claude's GitHub integration usually **cannot create repos** (403 "Resource not
   accessible by integration"). Ask the person to create it: github.com/new → name e.g.
   `<client>-report` → **Private** → create (README optional). Then attach it to the session with
   `add_repo` (access `push`) and clone it.
2. **Claude GitHub App on the repo**, or pushes are refused:
   https://github.com/apps/claude/installations/select_target → account → Repository access → add the
   repo.
3. **Discord webhook.** In Discord: channel → Edit Channel → Integrations → Webhooks → New Webhook →
   Copy Webhook URL. It goes straight into a GitHub secret, never into chat. If a URL was ever
   pasted in chat, have them make a new one.
4. **Rework API access.** Ask the Rework dev team for: the API **base URL**, how to authenticate
   (the template sends `Authorization: Bearer <token>`), a **read-only token** for the customer's
   workspace, and the real endpoints for: service list, service groups, a service's workload records
   (with timer sessions), a service's tasks. The template's default paths are guesses named after the
   connector's page reads; override with `REWORK_PATH_*` secrets/env instead of editing code.
5. **GitHub secrets** (repo → Settings → Secrets and variables → Actions → **Repository secrets** →
   New repository secret; not "Environment secrets"):
   `REWORK_API_BASE`, `REWORK_API_TOKEN`, `DISCORD_WEBHOOK_URL`. Optional **variable**
   `DASHBOARD_URL` (Variables tab) adds a dashboard link to the report.

## Phase 3 — Build the repo from the template

1. Copy everything under `template/` into the repo root.
2. Edit `rework_report/config.json`:
   - `report_name` — short client name shown in titles (e.g. "UDM").
   - `utc_offset_hours` — workspace timezone (Malaysia/Singapore 8, Vietnam/Thailand/Indonesia-West 7).
   - `users` — every Rework user id → `{name, team}`. Build it from the user list in `rework_pj_me`
     (ids are integers; use first names the team recognises). Teams come from titles/managers and
     must be confirmed with the customer: Rework has no departments yet.
   - `internal_groups` — service-group names that are internal work (admin, clock-in, the agency's
     own brand), shown as "Internal time" and kept out of client hours.
3. Replace `{{REPORT_NAME}}` in `site/index.html` (title and heading).
4. Set the cron hours in `.github/workflows/*.yml` for the timezone: weekly report Friday 09:00
   local = `0 (9 - offset) * * 5` UTC (wrap to the previous day if negative); dashboard refresh 07:00
   local daily. GitHub may start scheduled runs a few minutes late; say so.
5. Run the tests and a local preview of the message:
   `python -m unittest discover -s tests` — all must pass.
   To show the format before the API works, build sessions in Python and call
   `render.weekly(...)` (see `tests/test_report.py` for the shapes); label any such numbers as made up.
6. Commit and push to `main`. Commit messages say what the report does, not how it was made.

## Phase 4 — First real run

1. Actions tab → **Weekly report** → Run workflow (dry run ticked: prints, does not post). Or trigger
   it with the GitHub tools and read the job log.
2. Read the log and fix in this order:
   - `Missing REWORK_API_BASE / REWORK_API_TOKEN` → secret not added (or added as an environment
     secret).
   - `401/403` → token or auth scheme wrong. `404` → endpoint path wrong: set `REWORK_PATH_*`.
   - JSON shape errors → compare one real response with what `compute.load` expects and adapt
     `source.py`, not `compute.py`.
3. Sanity-check numbers against something the customer already trusts (a Rework workload view, or a
   one-off connector pull for one week). Hours per client and per person must match before anyone
   sees the report.
4. Run once with dry run unticked → message lands in Discord. Get the customer's OK on it.
5. Run **Refresh dashboard data** once so `site/data/` exists before the first deploy.

## Phase 5 — Deploy the dashboard

Claude's cloud environment usually cannot reach vercel.com/netlify.com and holds no deploy token,
so the person deploys (2 minutes), and every later data commit redeploys by itself:

- **Vercel**: vercel.com/new → sign in with GitHub → Import the repo (Adjust GitHub App Permissions if
  it is not listed) → keep defaults (`vercel.json` serves `site/`) → Deploy.
- **Netlify**: Add new site → Import from Git → repo → Deploy (`netlify.toml` publishes `site/`).

Then **protect it**: the data names staff and their hours. Vercel: Settings → Deployment Protection
(free: Vercel Authentication = team members only; Password Protection is paid). Netlify: Site
configuration → Access control (password is paid). If neither is possible, keep the link internal and
say so plainly.

Put the URL in the `DASHBOARD_URL` variable so the Discord report links to it. To check the deploy
without browsing to it: the page title is "<name> Time & Delivery" and `/data/meta.json` returns the
data window.

## Phase 6 — Handover

Give the customer, in their language:
- What arrives when (Friday 09:00 report; monthly summary on the first Friday; dashboard data daily
  07:00).
- How to run it by hand (Actions → Run workflow) and where errors show (Actions tab; GitHub emails
  the repo owner when a scheduled run fails).
- What to maintain: `config.json` when staff join/leave or change team; secrets when the token or
  webhook rotates.
- Logging habits that keep the numbers honest (from UDM): every timer linked to a task with a
  workload type; a log title on every session ("Revision 2 – client feedback"), which is what the
  revision count reads; stop timers (sessions over 12h are dropped as left running).

## Pitfalls already hit (check these first)

| Symptom | Cause | Fix |
|---|---|---|
| `curl: CONNECT tunnel failed, 403` posting to Discord from the Claude session | Environment network policy blocks discord.com | Add the host under the environment's Allowed domains, or just let GitHub Actions post |
| `create_repository` 403 | Claude's GitHub integration can't create repos | Person creates it; `add_repo` it |
| Push refused | Claude GitHub App not installed on the new repo | Install at github.com/apps/claude/installations/select_target |
| `unknown url type: '/admin/...'` | `REWORK_API_BASE` empty | Add the secret |
| Secret "added" but still empty in the log (`REWORK_API_BASE: ` blank) | Added under Environment secrets, or name typo | Repository secrets, exact name |
| Dashboard blank, "d3 is not defined" | CDN blocked | Template vendors d3 in `site/vendor/`; keep it |
| Dashboard says "Failed to load" | No `site/data/` yet | Run Refresh dashboard data once |
| Revision count looks low | People don't title their logs | Make the log title required (Rework feature request) and set a naming SOP |
| Report hours far below benchmark | Team tracks time but not linked to a workload type, or only part of the team logs | Check one service's resource items; fix setup before judging people |
