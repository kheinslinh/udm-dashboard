---
name: udm-discord-report
description: Set up, run or change UDM's weekly Rework report that is posted to a Discord channel every Friday morning. Use when someone asks to "send the weekly report to Discord", "set up the UDM weekly report", "post the Rework snapshot", "change the Discord report", or when a scheduled run of this report fails. Reads the Rework Project v3 connector (one call), builds a short message with client hours and deliverables, and posts it through a Discord webhook. Includes the full setup checklist, the script, and fixes for the errors already met.
---

# UDM weekly Discord report

A short message posted to a Discord channel every Friday at 08:57 (Malaysia time), built from
Rework Project with **two connector calls**:

- `rework_pj_page` view `all-projects`: every project with its service, task counts and logged effort
- `rework_pj_admin` action `group_list`: the service groups, i.e. client names

The message shows:

- **Client hours** — top 5 clients by hours logged on their projects (to date), with the top 3
  services (scopes) of each, plus total client and internal hours
- **Deliverables** — tasks done / total, open projects, overdue tasks and the clients with the most

Limits to state honestly when asked: hours are the total logged on each project **since it
started** (UDM's projects are mostly monthly, so this is close to month-to-date), timers left
running are **not** removed, and there is **no per-person, per-team or revision** breakdown.
Those need Rework's time-log API, which is not available yet.

## When asked to run the report now

1. Make sure the Rework Project v3 connector tools are available (load `rework_pj_page` and
   `rework_pj_admin` with ToolSearch if they are deferred). If they are missing, stop and say the
   connector is not enabled for this session (see Setup, step 4).
2. Check `DISCORD_WEBHOOK_URL` is set — print only "set" or "unset", never the value.
3. Call `rework_pj_page` with `view: "all-projects"`. The answer is large; it is saved to a file.
   Note that file's path.
4. Call `rework_pj_admin` with `action: "group_list"`. Save the answer to
   `groups.json` in the scratchpad (if it is saved to a file automatically, use that path).
5. Write the script below to `udm_report.py` in the scratchpad (exactly as given) and run
   `python3 udm_report.py <all-projects file> <groups file>` to preview, then add `--post` to send.
   It prints `posted` on success.
6. Never post a partial or made-up report. If any step fails, say which step and the exact error.
7. Finish with: posted or not, client hours total, tasks done / total, overdue.

## Setup from scratch (do once, about 15 minutes)

Walk the person through these in order; each needs their own clicks.

1. **Discord webhook.** In Discord: the channel → ⚙ Edit Channel → Integrations → Webhooks →
   New Webhook → name it "UDM report" → Copy Webhook URL. Treat the URL like a password: whoever
   has it can post in the channel. Never paste it into a chat; if it ever is, delete that webhook
   and make a new one.
2. **Claude Code cloud environment.** On claude.ai → Code, open the environment's settings
   (environment name in the session title bar → Edit):
   - **Network access**: allow `discord.com` (Allowed domains under the Limited level, keep
     "Allow package managers" ticked), or choose a broader level.
   - **Environment variables**: add one line, in `KEY=value` form with no spaces or line breaks:
     `DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...`
     (Pasting the URL alone gives "Couldn't parse … Use KEY=value format".)
   - Save. Variables only reach **new** sessions.
3. **Connector.** The Rework Project v3 connector must be connected to the account
   (claude.ai → Settings → Connectors), signed in to the UDM workspace.
4. **Scheduled task.** In Claude Code → Routines / Scheduled tasks → New:
   - Schedule: weekly, Friday, 08:57, Asia/Kuala_Lumpur (a few minutes before the hour avoids
     the busy 09:00 slot)
   - Environment: the one from step 2
   - **Connectors: tick Rework Project v3** — without it the run cannot read Rework
   - Each run starts a new session
   - Notifications: email on, so a failed run is noticed
   - Prompt: `Run the udm-discord-report skill: build the UDM weekly report and post it to Discord.`
     (If skills are not available to scheduled runs, paste the "When asked to run the report now"
     section and the script into the prompt instead.)
5. **Test.** Use "Run now" on the task. Check the channel and the run's summary.

## The script

Standard library only. Reads the two connector answers, prints the message, posts with `--post`.

```python
"""UDM weekly Discord report from two Rework Project v3 connector answers.

python3 udm_report.py <all-projects.json> <groups.json> [--post]
"""
import json
import os
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone

TZ = timezone(timedelta(hours=8))        # Malaysia
HOURS_PER_DAY = 8                        # Rework effort is in days
INTERNAL = {"Unravel", "Admin", "CLOCK IN"}  # service groups that are not client work
TOP_CLIENTS = 5
DASHBOARD_URL = ""                       # optional link shown at the end


def load(path):
    with open(path) as f:
        return json.load(f)


def build(page, groups_answer, now):
    groups = {g["id"]: g["name"] for g in groups_answer.get("groups", [])}
    services = {s["id"]: s for s in page["services"]}
    hours, scope = defaultdict(float), defaultdict(lambda: defaultdict(float))
    done, total, overdue = defaultdict(int), defaultdict(int), defaultdict(int)
    internal_h, open_projects = 0.0, 0
    for p in page["projects"]:
        svc = services.get(p["service_id"], {})
        client = groups.get(svc.get("group_id"), "Other")
        data = p.get("data") or {}
        stats = data.get("stats") or {}
        h = (data.get("financials") or {}).get("effort_recorded", 0) * HOURS_PER_DAY
        if client in INTERNAL:
            internal_h += h
        else:
            hours[client] += h
            scope[client][svc.get("name", "?")] += h
        done[client] += stats.get("done", 0)
        total[client] += stats.get("total", 0)
        overdue[client] += stats.get("overdue", 0)
        open_projects += p.get("status") in (0, 1)

    lines = [
        f"📊 **UDM Weekly Snapshot — {now:%-d %b %Y}**",
        "_From Rework Project · hours = time logged on each project to date_",
        "",
        "**💰 Client hours (logged on their projects)**",
    ]
    for i, (client, h) in enumerate(sorted(hours.items(), key=lambda kv: -kv[1])[:TOP_CLIENTS], 1):
        top = sorted(scope[client].items(), key=lambda kv: -kv[1])[:3]
        lines.append(f"{i}. {client} — **{h:.1f}h**")
        lines.append("   └ " + " · ".join(f"{k} {v:.1f}h" for k, v in top if v > 0))
    lines.append(f"Total client work: **{sum(hours.values()):.1f}h** · internal {internal_h:.1f}h")

    T, D, O = sum(total.values()), sum(done.values()), sum(overdue.values())
    worst = [f"{c} ({n})" for c, n in sorted(overdue.items(), key=lambda kv: -kv[1]) if n][:3]
    lines += [
        "",
        "**✅ Deliverables**",
        f"- {D} / {T} tasks done ({D / T:.0%}) across {open_projects} open projects" if T else "- No tasks",
        f"- 🔴 **{O} overdue**" + (" · most: " + ", ".join(worst) if worst else ""),
    ]
    if DASHBOARD_URL:
        lines.append(f"🔗 Dashboard: {DASHBOARD_URL}")
    return "\n".join(lines)


def post(url, text):
    body = json.dumps({"content": text[:2000], "allowed_mentions": {"parse": []}}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json",
                                                          "User-Agent": "udm-report"})
    urllib.request.urlopen(req, timeout=30).read()


if __name__ == "__main__":
    message = build(load(sys.argv[1]), load(sys.argv[2]), datetime.now(TZ))
    if "--post" not in sys.argv:
        print(message)
    else:
        url = os.environ.get("DISCORD_WEBHOOK_URL")
        if not url:
            sys.exit("DISCORD_WEBHOOK_URL is not set")
        post(url, message)
        print("posted")
```

## Changing the report

Edit the constants at the top of the script: `INTERNAL` when an internal service group is added
or renamed in Rework, `TOP_CLIENTS` for a longer list, `DASHBOARD_URL` to add a link. Client
names are the service-group names in Rework, so rename a group there to change how it shows.
Keep the message under Discord's 2,000-character limit (the script cuts at 2,000).

## When a run fails

| What the run reports | Cause | Fix |
|---|---|---|
| `rework_pj_page` / connector tools not available, `enabledInChat: false` | Connector not ticked on the scheduled task | Edit the task → Connectors → tick Rework Project v3 → Save |
| `DISCORD_WEBHOOK_URL` unset | Variable missing, or added after the session started | Add it to the environment (Setup step 2); the next run picks it up |
| `CONNECT tunnel failed, response 403` when posting | Environment blocks discord.com | Allow `discord.com` in the environment's network access |
| HTTP 401 / 404 from Discord | Webhook deleted or URL wrong | Make a new webhook and update the variable |
| Connector answers 401 / asks to sign in | Rework login expired | Reconnect the connector in claude.ai → Settings → Connectors |
| Numbers look too high for one client | A timer was left running for hours | Fix the time log in Rework; this report cannot filter it out |
