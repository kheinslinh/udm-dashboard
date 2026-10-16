"""Simple UDM weekly report from ONE Rework MCP call (Project v3 `rework_pj_page` view `all-projects`).

Usage: python3 mcp/simple_report.py <all-projects.json> [--post]
  --post sends it to DISCORD_WEBHOOK_URL; without it the message is printed.

What one call can give (no per-person time logs through MCP in one call):
  - hours logged per client and scope, summed over each project's recorded effort to date
  - tasks done / total / overdue per client
"""

import json
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

MYT = timezone(timedelta(hours=8))
CONFIG = json.loads((Path(__file__).resolve().parents[1] / "udm_report" / "teams.json").read_text())


def build(page, now=None):
    now = now or datetime.now(MYT)
    groups = CONFIG["group_names"]
    internal = set(CONFIG["internal_groups"])
    svc = {s["id"]: s for s in page["services"]}
    hours, scope = defaultdict(float), defaultdict(lambda: defaultdict(float))
    done, total, overdue = defaultdict(int), defaultdict(int), defaultdict(int)
    active = 0
    for p in page["projects"]:
        s = svc.get(p["service_id"], {})
        client = groups.get(s.get("group_id"), "Other")
        data = p.get("data") or {}
        stats = data.get("stats") or {}
        h = (data.get("financials") or {}).get("effort_recorded", 0) * 8  # workload is in days, 8h/day
        if client not in internal:
            hours[client] += h
            scope[client][s.get("name", "?")] += h
        done[client] += stats.get("done", 0)
        total[client] += stats.get("total", 0)
        overdue[client] += stats.get("overdue", 0)
        active += p.get("status") in (0, 1)
    top = sorted(hours.items(), key=lambda kv: -kv[1])
    internal_h = sum((((p.get("data") or {}).get("financials") or {}).get("effort_recorded", 0) * 8)
                     for p in page["projects"] if groups.get(svc.get(p["service_id"], {}).get("group_id")) in internal)
    lines = [
        f"📊 **UDM Weekly Snapshot — {now:%-d %b %Y}**",
        "_From Rework Project · hours = time logged on each project to date_",
        "",
        "**💰 Client hours (logged on their projects)**",
    ]
    for i, (c, h) in enumerate(top[:5], 1):
        sc = sorted(scope[c].items(), key=lambda kv: -kv[1])[:3]
        lines.append(f"{i}. {c} — **{h:.1f}h**")
        lines.append("   └ " + " · ".join(f"{k} {v:.1f}h" for k, v in sc if v > 0))
    lines.append(f"Total client work: **{sum(hours.values()):.1f}h** · internal {internal_h:.1f}h")
    T, D, O = sum(total.values()), sum(done.values()), sum(overdue.values())
    worst = [f"{c} ({n})" for c, n in sorted(overdue.items(), key=lambda kv: -kv[1]) if n][:3]
    lines += [
        "",
        "**✅ Deliverables**",
        f"- {D} / {T} tasks done ({D / T:.0%}) across {active} open projects" if T else "- No tasks",
        f"- 🔴 **{O} overdue**" + (" · most: " + ", ".join(worst) if worst else ""),
    ]
    if CONFIG.get("dashboard_url"):
        lines.append(f"🔗 Dashboard: {CONFIG['dashboard_url']}")
    return "\n".join(lines)


def post(url, text):
    body = json.dumps({"content": text[:2000], "allowed_mentions": {"parse": []}}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", "User-Agent": "udm-report"})
    urllib.request.urlopen(req, timeout=30).read()


if __name__ == "__main__":
    import os
    msg = build(json.load(open(sys.argv[1])))
    if "--post" in sys.argv:
        url = os.environ.get("DISCORD_WEBHOOK_URL")
        if not url:
            sys.exit("DISCORD_WEBHOOK_URL is not set")
        post(url, msg)
        print("posted")
    else:
        print(msg)
