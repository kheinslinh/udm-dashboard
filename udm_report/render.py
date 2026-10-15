"""Discord text for the weekly report and the monthly client summary."""

import json
import urllib.request
from datetime import timedelta

DISCORD_LIMIT = 2000


def h(x):
    return f"{x:.1f}h"


def d(day):
    return f"{day.day} {day:%b}"


def span(w):
    last = w.end - timedelta(1)
    if w.start.month == last.month:
        return f"{w.start.day}–{last.day} {last:%b} {last.year}"
    return f"{d(w.start)} – {d(last)} {last.year}"


def weekly(r, dashboard_url=None, top_clients=5):
    week, mtd, c, t, dl, rv, hy = r["week"], r["mtd"], r["clients"], r["team"], r["delivery"], r["revisions"], r["hygiene"]
    iso_week = (week.end - timedelta(1)).isocalendar()[1]
    lines = [
        f"📊 **UDM Weekly Report — Week {iso_week}** ({span(week)})",
        f"_Rework time logs · month-to-date = {span(mtd)}_",
        "",
        "**💰 Client hours (month-to-date)**",
    ]
    for i, (client, hrs) in enumerate(list(c["mtd"].items())[:top_clients], 1):
        lines.append(f"{i}. {client} — **{h(hrs)}** (+{h(c['week'].get(client, 0))} this week)")
        scopes = list(c["scope"].get(client, {}).items())[:3]
        if scopes:
            lines.append("   └ " + " · ".join(f"{s} {h(v)}" for s, v in scopes))
    if c["week"]:
        top, hrs = next(iter(c["week"].items()))
        lines.append(f"📈 Most hours this week: {top} +{h(hrs)}")

    avg = t["hours"] / t["people_total"] if t["people_total"] else 0
    delta = t["hours"] - t["prev_hours"]
    lines += [
        "",
        "**👥 Team time (this week)**",
        f"- **{h(t['hours'])}** logged by {t['people_logged']}/{t['people_total']} people "
        f"({'+' if delta >= 0 else ''}{h(delta)} vs last week) · avg {h(avg)} vs {t['benchmark']}h benchmark",
        "- " + " · ".join(f"{k} {h(v)}" for k, v in t["by_team"].items()),
        "- Top: " + " · ".join(f"{k} {h(v)}" for k, v in list(t["by_person"].items())[:5]),
    ]
    if t["not_logged"]:
        lines.append("- ⚠️ No hours logged: " + ", ".join(t["not_logged"]))

    lines += [
        "",
        "**✅ Deliverables**",
        f"- {dl['done_week']} tasks completed this week · {dl['done']} done of {dl['total']} total",
        f"- 🔴 **{dl['overdue']} overdue**"
        + (" · most: " + ", ".join(f"{k} ({v})" for k, v in list(dl["overdue_by_client"].items())[:3]) if dl["overdue"] else ""),
        "",
        "**🔁 Revisions (this week)**",
        f"- {rv['logs']} revision logs on {rv['tasks']} tasks · {h(rv['hours'])}"
        + (f" ({rv['hours'] / t['hours']:.0%} of hours)" if t["hours"] else ""),
    ]
    if rv["top"]:
        lines.append("- Most revised: " + " · ".join(f"\"{task}\" ({client}, {n})" for (client, task), n in rv["top"]))
    lines += [
        "",
        f"**🕘 Internal time:** {h(r['internal_hours'])} (clock-in, admin, Unravel internal)",
        "",
        "**🧹 Data hygiene**",
        f"- {hy['untitled']} of {hy['logs']} time logs have no title"
        + (f" · {hy['runaway']} timers >12h left out ({h(hy['runaway_hours'])})" if hy["runaway"] else ""),
    ]
    if dashboard_url:
        lines.append(f"🔗 Full dashboard: {dashboard_url}")
    return "\n".join(lines)


def monthly(m, top_scopes=4):
    month = m["month"]
    lines = [
        f"🗓 **UDM Monthly Client Hours — {month.start:%B %Y}**",
        f"_Rework time logs · {h(m['total'])} total · {h(m['internal'])} internal_",
        "",
    ]
    for client, hrs in m["clients"].items():
        scopes = list(m["scope"].get(client, {}).items())[:top_scopes]
        lines.append(f"**{client}** — {h(hrs)}" + (": " + " · ".join(f"{s} {h(v)}" for s, v in scopes) if scopes else ""))
    return "\n".join(lines)


def chunks(text, limit=DISCORD_LIMIT):
    """Split on line breaks so each Discord message stays under the limit."""
    out, cur = [], ""
    for line in text.split("\n"):
        if len(cur) + len(line) + 1 > limit and cur:
            out.append(cur)
            cur = ""
        cur = f"{cur}\n{line}" if cur else line
    return out + [cur] if cur else out


def post(webhook_url, text):
    for part in chunks(text):
        body = json.dumps({"content": part, "allowed_mentions": {"parse": []}}).encode()
        req = urllib.request.Request(webhook_url, data=body, headers={"Content-Type": "application/json", "User-Agent": "udm-report"})
        urllib.request.urlopen(req, timeout=30).read()
