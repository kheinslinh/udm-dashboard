"""python -m rework_report.export [--from-dir DIR] [--out site/data] [--date YYYY-MM-DD]

Writes the dashboard's data files (sessions, projects, people, meta) from Rework,
covering the first day of last month up to the day before the run.
"""

import argparse
import functools
import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path

from . import compute
from .source import ApiSource, DirSource

CONFIG = json.loads((Path(__file__).parent / "config.json").read_text())


def week_fields(day):
    year, week, _ = day.isocalendar()
    mon = day - timedelta(day.weekday())
    sun = mon + timedelta(6)
    rng = f"{mon.day}–{sun.day} {sun:%b}" if mon.month == sun.month else f"{mon.day} {mon:%b}–{sun.day} {sun:%b}"
    return f"{year}-W{week:02d}", f"W{week} · {rng}"


def revision_type(s):
    m = compute.REVISION_RE.search(s.title) or compute.REVISION_RE.search(s.task)
    return m.group(1).capitalize() if m else ""


def clockin_type(s):
    if re.search(r"clockify", s.task, re.I):
        return "Clockify catch-all"
    return "Clock-in task" if compute.CLOCKIN_RE.search(s.task) else ""


def session_rows(sessions, users, start, end):
    rows = []
    for s in sorted(sessions, key=lambda s: s.started):
        if not start <= s.day < end:
            continue
        user = users.get(str(s.user_id), {})
        week, week_label = week_fields(s.day)
        rows.append({
            "session": s.id, "project_id": s.project_id, "item_id": s.item_id,
            "date": s.day.isoformat(), "week": week, "week_label": week_label,
            "month": f"{s.day:%Y-%m}", "month_label": f"{s.day:%b %Y}",
            "person": user.get("name", f"user {s.user_id}"), "team": user.get("team", "Other"),
            "service_group": s.client, "service": s.service, "project": s.project, "task": s.task,
            "log_name": s.title, "hours": round(s.hours, 2), "runaway": s.hours > compute.RUNAWAY_HOURS,
            "revision": s.is_revision, "revision_type": revision_type(s) if s.is_revision else "",
            "clockin": bool(clockin_type(s)), "clockin_type": clockin_type(s),
        })
    return rows


def project_rows(source, groups, today):
    rows = []
    for svc in source.services():
        if svc.get("status") != 1:
            continue
        for p in source.resource_items(svc["id"]).get("projects", []):
            stats = (p.get("data") or {}).get("stats") or {}
            total = stats.get("total", 0)
            if not total:
                continue
            rows.append({
                "project_id": p["id"], "project": p.get("name", ""),
                "service_group": groups.get(svc.get("group_id"), "(no client)"), "service": svc["name"],
                "done": stats.get("done", 0), "total": total, "overdue": stats.get("overdue", 0),
                "status": "Completed" if stats.get("done", 0) >= total else "Active", "updated": today.isoformat(),
            })
    return rows


class Cached:
    """Each service is fetched once even though sessions and projects both read it."""

    def __init__(self, source):
        self.source = source
        self.services = functools.cache(source.services)
        self.groups = functools.cache(source.groups)
        self.resource_items = functools.cache(source.resource_items)
        self.work_items = functools.cache(source.work_items)


def main(argv=None):
    p = argparse.ArgumentParser(prog="rework_report.export")
    p.add_argument("--from-dir")
    p.add_argument("--out", default="site/data")
    p.add_argument("--date", help="run day (default: today in the configured timezone)")
    args = p.parse_args(argv)

    compute.set_timezone(CONFIG.get("utc_offset_hours", 8))
    today = date.fromisoformat(args.date) if args.date else datetime.now(compute.TZ).date()
    end = today  # exclusive: data runs to yesterday
    start = (today.replace(day=1) - timedelta(1)).replace(day=1)
    source = Cached(DirSource(args.from_dir) if args.from_dir else ApiSource())
    sessions, _, _ = compute.load(source)
    groups = {g["id"]: g["name"] for g in source.groups()}
    users = CONFIG["users"]
    last = end - timedelta(1)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    files = {
        "sessions": session_rows(sessions, users, start, end),
        "projects": project_rows(source, groups, today),
        "people": [{"person": u["name"], "team": u["team"], "title": u.get("title", u["team"])} for u in users.values()],
        "meta": {
            "window_start": start.isoformat(), "window_end": last.isoformat(), "last_day_share": 1,
            "note": (f"Hours are Rework timer sessions logged on tasks, {start.day} {start:%b} – {last.day} {last:%b %Y} "
                     f"(updated {datetime.now(compute.TZ):%d %b %Y, %H:%M} local time). Benchmark: 8h per working day per person. "
                     "Timers left running over 12h are left out unless ticked below."),
        },
    }
    for name, data in files.items():
        (out / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, indent=0 if name == "meta" else None))
    print(f"wrote {len(files['sessions'])} sessions, {len(files['projects'])} projects to {out}")


if __name__ == "__main__":
    main()
